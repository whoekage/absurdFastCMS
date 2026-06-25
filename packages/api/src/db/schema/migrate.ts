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
  compileAddCheck,
  compileDropConstraint,
  compileCountTooLong,
  compileCountScaleLoss,
  compileDropColumn,
  compileDropTable,
  compileCreateLinkTable,
} from '../ddl.ts';
import { resolveFields } from '../content-type.repository.ts';
import type { ResolvedType } from '../type.catalog.ts';
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

/**
 * Raised when a lossy SHRINK (varchar shorten / numeric scale reduce) WOULD truncate/round real rows. The
 * `allowDestructive` ack permits *attempting* such a cast, but the engine still refuses to SILENTLY destroy
 * data: a pre-flight COUNT runs before the `ALTER TYPE`, and if any row would lose information the whole
 * migrate rolls back with this loud error (vs PG's silent `::varchar(n)` truncation / scale rounding). To
 * proceed, widen the target or clean the offending rows first. A shrink that fits ALL rows applies cleanly.
 */
export class MigrationDataLossError extends Error {
  readonly table: string;
  readonly column: string;
  readonly affected: number;
  constructor(table: string, column: string, affected: number, detail: string) {
    super(`migration would lose data: ${affected} row(s) in ${table}.${column} ${detail} — refusing to silently truncate/round (widen the target or clean the rows first)`);
    this.name = 'MigrationDataLossError';
    this.table = table;
    this.column = column;
    this.affected = affected;
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

/** Drop every CHECK constraint that references `col` on `tableName` (the enum value-set CHECK), by its real
 *  name discovered from the catalog — robust to PG's auto-naming/truncation, no name assumption. */
async function dropColumnChecks(tx: Sql, tableName: string, col: string): Promise<void> {
  const rows = await tx<{ conname: string }[]>`
    SELECT con.conname FROM pg_constraint con
    WHERE con.conrelid = ${tableName}::regclass AND con.contype = 'c'
      AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = con.conrelid AND a.attnum = ANY(con.conkey) AND a.attname = ${col})
  `;
  for (const { conname } of rows) await run(tx, compileDropConstraint(tableName, conname));
}

/**
 * Classify a retype's data-loss risk PURELY from the resolved types: a SHRINK that PG would apply silently.
 *   - `length` — varchar/text -> a SHORTER varchar(N): rows with `length(value) > N` truncate.
 *   - `scale`  — numeric(p,s) -> a SMALLER scale s': rows with more fractional digits ROUND.
 * Returns null for any non-shrink (grow / widen / int overflow / impossible cast) — PG either coerces it
 * losslessly or raises its OWN loud error (int out-of-range, numeric overflow), so no pre-flight is needed.
 */
function truncationGuard(from: ResolvedType, to: ResolvedType): { kind: 'length' | 'scale'; value: number } | null {
  if (to.pgType.startsWith('varchar')) {
    const toLen = Number(to.params['length']);
    if (!Number.isFinite(toLen)) return null;
    if (from.pgType === 'text') return { kind: 'length', value: toLen }; // unbounded -> bounded
    if (from.pgType.startsWith('varchar')) {
      const fromLen = Number(from.params['length']);
      if (Number.isFinite(fromLen) && toLen < fromLen) return { kind: 'length', value: toLen };
    }
    return null;
  }
  if (from.pgType.startsWith('numeric') && to.pgType.startsWith('numeric')) {
    const fromScale = Number(from.params['scale']);
    const toScale = Number(to.params['scale']);
    if (Number.isFinite(fromScale) && Number.isFinite(toScale) && toScale < fromScale) return { kind: 'scale', value: toScale };
  }
  return null;
}

/**
 * PRE-FLIGHT against silent data loss: before a (potentially) lossy `ALTER TYPE`, COUNT the rows the shrink
 * would truncate/round. If any exist, throw {@link MigrationDataLossError} (rolls the whole tx back). A shrink
 * that fits every row passes through — turning a blanket-blocked op into a safe, data-checked one.
 */
async function assertNoTruncation(tx: Sql, tbl: string, col: string, from: ResolvedType, to: ResolvedType): Promise<void> {
  const guard = truncationGuard(from, to);
  if (!guard) return;
  const q = guard.kind === 'length' ? compileCountTooLong(tbl, col, guard.value) : compileCountScaleLoss(tbl, col, guard.value);
  const rows = (await tx.unsafe(q.sql, q.parameters as ParameterOrJSON<never>[])) as unknown as { n: number }[];
  const affected = Number(rows[0]?.n ?? 0);
  if (affected > 0) {
    const detail = guard.kind === 'length' ? `exceed varchar(${guard.value})` : `round at scale ${guard.value}`;
    throw new MigrationDataLossError(tbl, col, affected, detail);
  }
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
      // Renames are NOT applied here — they are BATCHED per table in applyChangeSet so a name SWAP / rename
      // cycle (which a naive in-order apply hits with 42701 duplicate_column) is staged through a temp name.
      throw new Error('internal: renameField is applied in applyChangeSet (batched), not applyOne');
    case 'retypeField': {
      const tbl = deriveTableName(c.apiId);
      const fromEnum = Array.isArray(c.from.params['values']);
      const toEnum = Array.isArray(c.to.params['values']);
      if (!fromEnum && !toEnum) {
        // Plain non-enum retype (int->bigint, varchar resize, decimal): the column-type cast. Pre-flight a
        // lossy SHRINK (varchar shorten / scale reduce) so real truncation/rounding fails LOUD, not silently.
        await assertNoTruncation(tx, tbl, c.name, c.from, c.to);
        await run(tx, compileAlterColumnType(tbl, c.name, c.to));
        return;
      }
      // Enum membership lives in a CHECK, not the column type, so an enum value-set change is a CHECK SWAP —
      // never a lossy ALTER TYPE that would shrink the varchar (which truncated an in-use member before).
      // Drop the old CHECK; ALTER the base type only when the category changes (enum<->non-enum); add the
      // new CHECK (it VALIDATES existing rows -> a row using a removed member fails the ADD -> tx rollback,
      // data intact — you cannot remove an in-use member; adding a member always succeeds).
      if (fromEnum) await dropColumnChecks(tx, tbl, c.name);
      // ALTER the base type when the CATEGORY changes (enum<->non-enum), OR when an enum->enum GROWS its
      // varchar (a new longer member needs room). NEVER shrink an enum's varchar — the CHECK is the real
      // constraint, and a shrink would truncate an in-use value.
      const grows = fromEnum && toEnum && Number(c.to.params['length'] ?? 0) > Number(c.from.params['length'] ?? 0);
      if ((fromEnum !== toEnum && c.from.pgType !== c.to.pgType) || grows) {
        // A category change (enum<->non-enum) can shrink the varchar — pre-flight it like the plain path.
        await assertNoTruncation(tx, tbl, c.name, c.from, c.to);
        await run(tx, compileAlterColumnType(tbl, c.name, c.to));
      }
      if (toEnum) await run(tx, compileAddCheck(tbl, c.name, c.to.params['values'] as string[]));
      return;
    }
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
export async function ensureAppliedTable(sql: Sql): Promise<void> {
  await sql`CREATE TABLE IF NOT EXISTS _schema_applied (
    type_id text PRIMARY KEY,
    api_id text NOT NULL,
    schema jsonb NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`;
}

/** The last-applied catalog, reconstructed from `_schema_applied` (Zod-validated against corruption). */
export async function readAppliedSchemas(sql: Sql): Promise<ContentTypeSchema[]> {
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

/** A single physical `RENAME COLUMN` step. `from`/`to` may be a temp name mid-sequence when breaking a cycle. */
interface RenameStep {
  readonly from: string;
  readonly to: string;
}

/**
 * Order a set of column renames into a COLLISION-SAFE sequence of physical `RENAME COLUMN` steps. Within one
 * table the source names are distinct and the target names are distinct (both are unique field names), so the
 * rename graph has in/out-degree <= 1 at every node and decomposes into disjoint CHAINS and CYCLES:
 *   - a CHAIN (a->b->c, c free) resolves by repeatedly applying the rename whose target nobody still holds;
 *   - a CYCLE (a->b->a — the field-name SWAP — or longer) has NO free target, so Postgres rejects a direct
 *     rename with 42701 duplicate_column. Break it by parking ONE source under a unique temp name, which frees
 *     its old name for the predecessor; the cycle then unwinds as a chain and the temp lands last.
 * This is the temp-name staging that makes a swap lossless inside the ONE migrate transaction.
 */
export function planRenameSteps(renames: readonly { from: string; to: string; fieldId: string }[]): RenameStep[] {
  const steps: RenameStep[] = [];
  const occupied = new Set(renames.map((r) => r.from)); // names still held by a not-yet-applied source column
  const universe = new Set<string>(); // every name in play — keeps a generated temp from colliding
  for (const r of renames) { universe.add(r.from); universe.add(r.to); }
  const pending = renames.map((r) => ({ from: r.from, to: r.to, fieldId: r.fieldId }));

  while (pending.length > 0) {
    const i = pending.findIndex((r) => !occupied.has(r.to)); // a target nobody still occupies => safe right now
    if (i >= 0) {
      const r = pending.splice(i, 1)[0]!;
      steps.push({ from: r.from, to: r.to });
      occupied.delete(r.from); // r.from is now free for whoever targets it
      continue;
    }
    // No free target => every remaining rename sits in a cycle. Park ONE source under a unique temp name to
    // free its old name (its predecessor's target), turning the cycle into a resolvable chain.
    const r = pending[0]!;
    let tmp = `__conti_tmp_${r.fieldId}`;
    for (let n = 0; universe.has(tmp) || occupied.has(tmp); n++) tmp = `__conti_tmp_${r.fieldId}_${n}`;
    steps.push({ from: r.from, to: tmp });
    occupied.delete(r.from);
    occupied.add(tmp);
    universe.add(tmp);
    r.from = tmp; // r becomes tmp -> r.to, still pending until r.to frees up as the cycle unwinds
  }
  return steps;
}

/**
 * Seed/overwrite the applied snapshot to EXACTLY `schemas` WITHOUT any DDL — used by the S3 boot guard to
 * BACKFILL `_schema_applied` after a baseline seed materialized the tables out-of-band (so the next boot's
 * diff is empty). Reuses the same upsert as a migrate's reconcile, in its own tx.
 */
export async function writeAppliedSnapshot(sql: Sql, schemas: ContentTypeSchema[]): Promise<void> {
  await ensureAppliedTable(sql);
  await sql.begin(async (tx) => {
    await reconcileApplied(tx as unknown as Sql, schemas);
  });
}

/** Apply the change-set + reconcile the applied snapshot in ONE serialized transaction (all-or-nothing). */
async function applyChangeSet(sql: Sql, cs: ChangeSet, next: ContentTypeSchema[]): Promise<void> {
  // Pre-plan per-table column renames into a collision-safe step sequence (handles the field-name SWAP /
  // rename-cycle that a naive in-order apply hits with 42701). The plan executes as a block at the FIRST
  // renameField of each table; the logical `applied` list (cs.changes) is unaffected.
  const renamePlans = new Map<string, RenameStep[]>();
  const byTable = new Map<string, { from: string; to: string; fieldId: string }[]>();
  for (const c of cs.changes) {
    if (c.kind !== 'renameField') continue;
    validateFieldName(c.to); // defense-in-depth: the new name becomes a SQL identifier.
    const arr = byTable.get(c.apiId) ?? [];
    arr.push({ from: c.from, to: c.to, fieldId: c.fieldId });
    byTable.set(c.apiId, arr);
  }
  for (const [apiId, rs] of byTable) renamePlans.set(apiId, planRenameSteps(rs));

  await sql.begin(async (tx) => {
    await tx`SET LOCAL lock_timeout = '5s'`;
    await tx`SET LOCAL standard_conforming_strings = on`;
    await tx`SELECT pg_advisory_xact_lock(${MIGRATE_LOCK_KEY})`;
    const handle = tx as unknown as Sql;
    const renamedTables = new Set<string>();
    for (const c of cs.changes) {
      if (c.kind === 'renameField') {
        // Run this table's WHOLE rename plan at its first renameField (before that table's retypes/nullables,
        // which reference the post-rename name); skip the rest — they are already in the plan.
        if (renamedTables.has(c.apiId)) continue;
        renamedTables.add(c.apiId);
        const tbl = deriveTableName(c.apiId);
        for (const step of renamePlans.get(c.apiId)!) await run(handle, compileRenameColumn(tbl, step.from, step.to));
        continue;
      }
      await applyOne(handle, c);
    }
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
  const prev = await readAppliedSchemas(sql);
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
  const prev = await readAppliedSchemas(sql);
  const cs = diff(prev, next);
  return { changes: cs.changes, blocked: lint(cs, opts.allowDestructive ?? false) };
}
