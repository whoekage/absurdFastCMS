import type { Sql, JSONValue, ParameterOrJSON } from 'postgres';
import type { CompiledQuery } from 'kysely';
import {
  deriveTableName,
  validateFieldName,
  compileCreateTable,
  compileAddColumn,
  compileRenameColumn,
  compileRenameTable,
  compileSetColumnNotNull,
  compileAlterColumnType,
  compileDropColumn,
  compileDropTable,
  compileCreateLinkTable,
} from '../ddl.ts';
import { resolveFields } from '../content-type.repository.ts';
import { contentTypeSchemaZ, type ContentTypeSchema } from './model.ts';
import { fieldSchemaToSpec } from './adapt.ts';
import { diff, type Change, type ChangeSet } from './diff.ts';

/**
 * THE MIGRATE ENGINE (§S4) — apply a files-first {@link ChangeSet} to Postgres, data-preserving, with a
 * per-op destructive gate. The STATE MODEL is declarative: we diff the committed files (`next`) against a
 * STORED applied-schema snapshot (`_schema_applied`, the last-applied catalog as canonical JSON), NOT
 * against introspected DB metadata. Comparing our own canonical JSON to our own canonical JSON sidesteps
 * the phantom-diff / churn class that plagues every introspection differ (Atlas's whole `--dev-url`
 * normalization layer exists to fight it; TypeORM #8167, Liquibase #499/#1850 are the symptom).
 *
 * Apply rules, distilled from the cross-ecosystem survey:
 *   - ONE TRANSACTION (Postgres DDL is transactional): a cast/constraint failure rolls the WHOLE migration
 *     back — never the partial-apply that hangs Directus/Payload mid-migration.
 *   - PER-OP ACK GATE (not one global `--force`, which Skeema #51 / Drizzle #3209 proved a footgun):
 *     `forbidden` ALWAYS blocks; `destructive`/`data-dependent` block unless `allowDestructive`.
 *   - rename is a real `RENAME COLUMN`/`RENAME TO` (lossless) — the Strapi #12626/#19141 fix.
 *   - REORDER is a NO-OP here: field order is owned by the schema FILE (the registry rebuilds from
 *     `fromSchemas`), never a physical column move / table rewrite.
 *   - `setTypeOption` (draft&publish / i18n toggle, which adds/drops system columns) is DEFERRED — a loud
 *     {@link MigrationUnsupportedError}, consistent with the S1/S3 relation+component deferral.
 *
 * Reuses the existing `ddl.ts` compile-only builders + one `sql.begin` tx (the same single-driver pattern
 * as the rest of the schema-change path). NO meta-table writes — files are the source; `_schema_applied`
 * is the only bookkeeping, created on-demand like `_migrations`.
 */

// Distinct from the per-file CREATE lock (db-per-file.ts) and the golden-build lock (global-setup.ts):
// serializes concurrent migrations (two instances booting) so they queue rather than corrupt each other.
const MIGRATE_LOCK_KEY = 0x5c_3e_a9_01;

/** Raised when the migration contains changes that need an explicit ack (or are forbidden outright). */
export class MigrationBlockedError extends Error {
  readonly blocked: readonly Change[];
  constructor(blocked: readonly Change[]) {
    super(
      `migration blocked: ${blocked.length} change(s) require --allow-destructive or are forbidden:\n` +
        blocked.map((c) => `  - ${describeChange(c)} [${c.risk}]`).join('\n'),
    );
    this.name = 'MigrationBlockedError';
    this.blocked = blocked;
  }
}

/** Raised for a change-set op whose apply is not yet implemented (draft&publish / i18n toggle). */
export class MigrationUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationUnsupportedError';
  }
}

export interface MigrateOptions {
  /** Allow `destructive` + `data-dependent` ops (drop, NOT NULL add, lossy cast). `forbidden` is NEVER allowed. */
  allowDestructive?: boolean;
}

export interface MigrateResult {
  /** True when prev === next (no change-set) — the idempotent re-run case. */
  noop: boolean;
  applied: readonly Change[];
}

/** A short human description of a change (for the blocked-migration error + `migrate lint` output). */
export function describeChange(c: Change): string {
  switch (c.kind) {
    case 'addType': return `create type ${c.apiId}`;
    case 'dropType': return `DROP type ${c.apiId}`;
    case 'renameType': return `rename type ${c.fromApiId} -> ${c.toApiId}`;
    case 'setTypeOption': return `set ${c.apiId}.${c.option}=${c.to}`;
    case 'addField': return `add ${c.apiId}.${c.field.name}`;
    case 'dropField': return `DROP ${c.apiId}.${c.name}`;
    case 'renameField': return `rename ${c.apiId}.${c.from} -> ${c.to}`;
    case 'retypeField': return `retype ${c.apiId}.${c.name} (${c.classification})`;
    case 'setFieldNullable': return `set ${c.apiId}.${c.name} ${c.to ? 'NULL' : 'NOT NULL'}`;
    case 'reorderFields': return `reorder ${c.apiId} fields (wire-only)`;
    case 'addRelation': return `add relation ${c.apiId}.${c.field} -> ${c.target} (${c.relKind})`;
    case 'dropRelation': return `DROP relation ${c.apiId}.${c.field}`;
  }
}

/**
 * Pure lint gate: the changes that BLOCK the migration. `forbidden` always blocks; `destructive` and
 * `data-dependent` block unless `allowDestructive`. Exposed for the `conti migrate lint` command path.
 */
export function lint(cs: ChangeSet, allowDestructive: boolean): readonly Change[] {
  return cs.changes.filter(
    (c) => c.risk === 'forbidden' || (!allowDestructive && (c.risk === 'destructive' || c.risk === 'data-dependent')),
  );
}

function run(tx: Sql, q: CompiledQuery): Promise<unknown> {
  return tx.unsafe(q.sql, q.parameters as ParameterOrJSON<never>[]);
}

/** Apply ONE change via the compile-only ddl builders. Throws for a deferred op (rolls back the whole tx). */
async function applyOne(tx: Sql, c: Change): Promise<void> {
  switch (c.kind) {
    case 'addType': {
      const fields = resolveFields(c.schema.fields.map(fieldSchemaToSpec));
      const dp = c.schema.options?.draftAndPublish ?? false;
      const i18n = c.schema.options?.i18n ?? false;
      await run(tx, compileCreateTable(deriveTableName(c.schema.apiId), fields, dp, i18n));
      return;
    }
    case 'renameType':
      await run(tx, compileRenameTable(deriveTableName(c.fromApiId), deriveTableName(c.toApiId)));
      return;
    case 'addField': {
      const rf = resolveFields([fieldSchemaToSpec(c.field)])[0]!;
      await run(tx, compileAddColumn(deriveTableName(c.apiId), rf));
      return;
    }
    case 'renameField':
      validateFieldName(c.to); // defense-in-depth: the new name becomes a SQL identifier.
      await run(tx, compileRenameColumn(deriveTableName(c.apiId), c.from, c.to));
      return;
    case 'retypeField':
      await run(tx, compileAlterColumnType(deriveTableName(c.apiId), c.name, c.to));
      return;
    case 'setFieldNullable':
      // c.to === true means the column becomes NULLABLE => NOT NULL is dropped.
      await run(tx, compileSetColumnNotNull(deriveTableName(c.apiId), c.name, !c.to));
      return;
    case 'dropField':
      await run(tx, compileDropColumn(deriveTableName(c.apiId), c.name));
      return;
    case 'dropType':
      await run(tx, compileDropTable(deriveTableName(c.apiId)));
      return;
    case 'addRelation':
      // The link table FKs both endpoint ct_ tables; the diff orders addRelation after every addType.
      await run(tx, compileCreateLinkTable(c.linkTable, deriveTableName(c.apiId), deriveTableName(c.target), c.relKind));
      return;
    case 'dropRelation':
      await run(tx, compileDropTable(c.linkTable)); // a link table is a plain table — drop it (edges lost).
      return;
    case 'reorderFields':
      // WIRE-ONLY: the file order drives the registry projection; there is no physical column position.
      return;
    case 'setTypeOption':
      throw new MigrationUnsupportedError(
        `toggling "${c.option}" (draft&publish / i18n) on the existing type "${c.apiId}" is deferred to a later slice`,
      );
  }
}

/** Ensure the bookkeeping table exists (on-demand, like `_migrations` — no hand-written migration file). */
async function ensureAppliedTable(sql: Sql): Promise<void> {
  await sql`CREATE TABLE IF NOT EXISTS _schema_applied (
    type_id text PRIMARY KEY,
    api_id text NOT NULL,
    schema jsonb NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`;
}

/** The last-applied catalog, reconstructed from `_schema_applied` (Zod-validated against corruption). */
async function readApplied(sql: Sql): Promise<ContentTypeSchema[]> {
  const rows = await sql<{ schema: unknown }[]>`SELECT schema FROM _schema_applied ORDER BY api_id`;
  return rows.map((r) => contentTypeSchemaZ.parse(r.schema) as ContentTypeSchema);
}

/** Set `_schema_applied` to EXACTLY `next` (delete dropped types, upsert the rest) — within the apply tx. */
async function reconcileApplied(tx: Sql, next: ContentTypeSchema[]): Promise<void> {
  const ids = next.map((s) => s.id);
  if (ids.length > 0) await tx`DELETE FROM _schema_applied WHERE type_id <> ALL(${ids})`;
  else await tx`DELETE FROM _schema_applied`;
  for (const s of next) {
    await tx`
      INSERT INTO _schema_applied (type_id, api_id, schema)
      VALUES (${s.id}, ${s.apiId}, ${tx.json(s as unknown as JSONValue)})
      ON CONFLICT (type_id) DO UPDATE SET api_id = EXCLUDED.api_id, schema = EXCLUDED.schema, applied_at = now()
    `;
  }
}

/** Apply the change-set + reconcile the applied snapshot in ONE serialized transaction (all-or-nothing). */
async function applyChangeSet(sql: Sql, cs: ChangeSet, next: ContentTypeSchema[]): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`SET LOCAL lock_timeout = '5s'`;
    await tx`SET LOCAL standard_conforming_strings = on`;
    await tx`SELECT pg_advisory_xact_lock(${MIGRATE_LOCK_KEY})`;
    const handle = tx as unknown as Sql;
    for (const c of cs.changes) await applyOne(handle, c);
    await reconcileApplied(handle, next);
  });
}

/**
 * Migrate the database to match the desired catalog (`next`, the IR the EDGE loader produced from the
 * `schema/*.ts` modules). Diffs the stored applied snapshot against `next`, gates destructive ops, and
 * applies the rest atomically. Idempotent: a second run with no change is a no-op. Throws
 * {@link MigrationBlockedError} when a destructive/forbidden op is present without `allowDestructive`.
 *
 * Takes the IR (not a directory) so it is decoupled from the source format — the loader lives at the edge
 * (`compose/migrate.ts` / `createConti`), and tests drive it with IR directly.
 */
export async function migrate(sql: Sql, next: ContentTypeSchema[], opts: MigrateOptions = {}): Promise<MigrateResult> {
  await ensureAppliedTable(sql);
  const prev = await readApplied(sql);
  const cs = diff(prev, next);
  const blocked = lint(cs, opts.allowDestructive ?? false);
  if (blocked.length > 0) throw new MigrationBlockedError(blocked);
  if (cs.changes.length === 0) return { noop: true, applied: [] };
  await applyChangeSet(sql, cs, next);
  return { noop: false, applied: cs.changes };
}

/**
 * The `conti migrate lint` engine: compute the change-set + the blocked subset WITHOUT applying. Read-only
 * (it still ensures the bookkeeping table so a fresh DB lints cleanly).
 */
export async function migrateLint(
  sql: Sql,
  next: ContentTypeSchema[],
  opts: MigrateOptions = {},
): Promise<{ changes: readonly Change[]; blocked: readonly Change[] }> {
  await ensureAppliedTable(sql);
  const prev = await readApplied(sql);
  const cs = diff(prev, next);
  return { changes: cs.changes, blocked: lint(cs, opts.allowDestructive ?? false) };
}
