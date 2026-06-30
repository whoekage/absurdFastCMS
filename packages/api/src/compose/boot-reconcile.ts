import { writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import type { Sql } from 'postgres';
import type { Schema } from '../db/schema/model.ts';
import { diff, type Change } from '../db/schema/diff.ts';
import { migrate, readAppliedSchemas, ensureAppliedTable } from '../db/schema/migrate.ts';
import { generateSchemaSource, BuilderCodegenError } from '../db/schema/codegen.ts';
import type { Hooks } from '../db/schema/define.ts';
import { AppError } from '../errors/app-error.ts';

/**
 * THE S3 BOOT RECONCILIATION GUARD (docs/research/builder-http-route.md §2.1/§3.4, s3-s4-impl-plan §S3).
 *
 * S2 made an `applySchemaEdit` all-or-nothing by writing the new `schema.ts` to a TEMP file and only
 * `rename`-ing it over the real file AFTER `migrate()` commits. That leaves ONE sub-millisecond crash window:
 * the process dies between the migrate COMMIT and the file rename → the DB (`_schema_applied`) is AHEAD of
 * the on-disk file (file BEHIND). On the next boot, naively migrating to the file would emit a DESTRUCTIVE
 * REVERSE change (a drop that UNDOES what `_schema_applied` records as applied) and make the loss durable.
 *
 * This guard runs BEFORE the served Engine/Registry is built. It compares the on-disk files (`filesIR`) to
 * the stored applied snapshot and:
 *   - empty DB (no snapshot) + files present → BASELINE: seed the tables, backfill the snapshot → `clean`.
 *   - diff empty → `clean` (steady state).
 *   - diff has ANY drop kind (`dropType`/`dropField`/`dropRelation`) in the applied→files direction → files
 *     are BEHIND (the crash window). Do NOT migrate the reverse drop. RECOVER-FORWARD: regenerate the
 *     affected `schema.ts` from the snapshot's canonical IR (or HALT LOUD if that IR is not round-trippable),
 *     and serve the snapshot IR.
 *   - otherwise (only forward changes) → files are legitimately AHEAD (a committed edit) → `migrate` forward
 *     with `allowDestructive: true` (the file is the already-acked post-edit truth) → `migrated`.
 *
 * Gate on the change KIND, not its `risk`: a legitimate forward drop and a reverse crash-window drop are both
 * `risk: 'destructive'`, so at boot ANY drop in the applied→files direction is treated as the crash signature
 * (v1 has no in-band "delete a field via boot" path — drops only reach files via a committed Builder edit,
 * whose snapshot would already match).
 */

/** Raised when the guard cannot safely reconcile (a non-round-trippable snapshot IR, or a codegen failure). */
export class SchemaReconcileHaltError extends AppError {
  constructor(message: string) {
    super('db.schema.reconcile_halt', { detail: message });
    this.name = 'SchemaReconcileHaltError';
  }
}

export interface ReconcileResult {
  outcome: 'clean' | 'migrated' | 'recovered-forward';
  /** moduleNames whose `modules/<name>/schema.ts` was regenerated from the snapshot (recover-forward). */
  recovered: readonly string[];
  /** The IR the served Engine MUST be built from (files after any recovery). */
  schemas: Schema[];
  /** The hooks Map after reconciliation (re-used as loaded — a recovered drop adds no new hooks.ts). */
  hooks: Map<string, Hooks>;
}

/** A drop in the applied→files direction — the crash-window signature (files behind the snapshot). */
function isReverseDestructive(c: Change): boolean {
  return c.kind === 'dropType' || c.kind === 'dropField' || c.kind === 'dropRelation';
}

/**
 * Whether `generateSchemaSource` can write `s` WITHOUT silent loss. The v1 DSL codegen drops two IR
 * properties without erroring — `field.localized` and `collectionName` — so regenerating a schema that
 * carries either would write a lossy file the next boot reads as `clean` (silently changing i18n /
 * table-name semantics). Recover-forward HALTs rather than write such a file. (`label` IS emitted by the
 * codegen now, so it round-trips. The loud cases — a field type the codegen can't emit — throw
 * `BuilderCodegenError` and are handled separately.)
 */
// Field types whose codegen builder cannot carry a constant `default` — a default on one of these would
// be silently dropped by generateSchemaSource (so it must veto recover-forward). Every other type emits it.
const DEFAULT_UNEMITTABLE_TYPES = new Set(['media', 'component', 'dynamiczone']);

function isRoundTrippable(s: Schema): boolean {
  if (s.collectionName !== undefined) return false;
  return s.fields.every(
    (f) => f.localized === undefined && !(f.options?.default !== undefined && DEFAULT_UNEMITTABLE_TYPES.has(f.type)),
  );
}

/** Atomic same-dir flip (mirror of applySchemaEdit's temp→rename) so a crash mid-recovery never half-writes. */
async function atomicWriteSchemaFile(modulesDir: string, schema: Schema): Promise<void> {
  const dir = path.join(modulesDir, schema.name);
  await mkdir(dir, { recursive: true });
  const target = path.join(dir, 'schema.ts');
  const tmp = `${target}.${process.pid}.recover.tmp`;
  await writeFile(tmp, generateSchemaSource(schema));
  await rename(tmp, target);
}

export async function reconcileBoot(
  sql: Sql,
  modulesDir: string,
  filesIR: Schema[],
  filesHooks: Map<string, Hooks>,
): Promise<ReconcileResult> {
  await ensureAppliedTable(sql);
  const appliedIR = await readAppliedSchemas(sql); // a corrupt snapshot row Zod-throws here → boot aborts (loud)

  // BASELINE: no snapshot yet but files exist (a fresh DB). One `migrate()` against an empty `_schema_applied`
  // diffs to all-`addType` ⇒ it CREATEs every ct_ table AND writes the snapshot in the SAME tx, so the NEXT
  // boot's diff is empty. (This replaces the legacy seedFromSchemas + writeAppliedSnapshot pair; because DDL
  // and snapshot now commit together, the old "ct_ table present but _schema_applied empty" state — which
  // needed create-if-absent — is unreachable in production.)
  if (appliedIR.length === 0) {
    if (filesIR.length === 0) return { outcome: 'clean', recovered: [], schemas: [], hooks: filesHooks };
    await migrate(sql, filesIR, { allowDestructive: true });
    return { outcome: 'clean', recovered: [], schemas: filesIR, hooks: filesHooks };
  }

  const cs = diff(appliedIR, filesIR); // arg order is diff(prev=applied, next=files); reversing inverts meaning
  if (cs.changes.length === 0) return { outcome: 'clean', recovered: [], schemas: filesIR, hooks: filesHooks };

  if (cs.changes.some(isReverseDestructive)) {
    // FILES BEHIND (crash window). Never let migrate apply the reverse drop. Regenerate each affected file
    // from the snapshot IR and serve the snapshot (DB already matches it).
    const affected = [...new Set(cs.changes.filter(isReverseDestructive).map((c) => c.name))];
    const appliedByName = new Map(appliedIR.map((s) => [s.name, s]));
    for (const name of affected) {
      const s = appliedByName.get(name);
      if (s === undefined) continue; // a reverse drop always has a snapshot entry; defensive
      if (!isRoundTrippable(s)) {
        throw new SchemaReconcileHaltError(
          `cannot recover-forward "${name}": its applied schema carries a non-round-trippable property ` +
            `(localized / collectionName / info) that generateSchemaSource would silently drop — refusing to write a lossy file`,
        );
      }
      try {
        await atomicWriteSchemaFile(modulesDir, s);
      } catch (e) {
        if (e instanceof BuilderCodegenError) {
          throw new SchemaReconcileHaltError(`cannot recover-forward "${name}": ${e.message}`);
        }
        throw e;
      }
    }
    // Serve the snapshot IR (self-consistent with the DB). Files not re-read (ESM cache would return the
    // already-imported lagging module); any type with only forward changes heals on the next boot.
    return { outcome: 'recovered-forward', recovered: affected, schemas: appliedIR, hooks: filesHooks };
  }

  // FILES AHEAD: only forward changes. Migrate to the files. allowDestructive:true because a data-dependent
  // forward change (NOT NULL add, rewrite retype, →NOT NULL) reached schema.ts ONLY via a prior acked edit;
  // replaying it without the ack would FALSE-HALT boot. No reverse drop can reach here (routed above).
  await migrate(sql, filesIR, { allowDestructive: true });
  return { outcome: 'migrated', recovered: [], schemas: filesIR, hooks: filesHooks };
}
