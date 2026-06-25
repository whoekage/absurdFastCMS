import { writeFile, mkdir, rename, unlink, rm } from 'node:fs/promises';
import path from 'node:path';
import type { Sql } from 'postgres';
import { mintId, type Schema, type FieldSchema, type RelationSchema } from '../db/schema/model.ts';
import { generateSchemaSource } from '../db/schema/codegen.ts';
import { validateFieldName, validateRelationKind, deriveTableName, SchemaChangeConflictError } from '../db/ddl.ts';
import { migrate, migrateLint, readAppliedSchemas, ensureAppliedTable } from '../db/schema/migrate.ts';
import type { Change } from '../db/schema/diff.ts';

/**
 * THE VISUAL BUILDER'S SERVER SIDE — apply a schema edit from the admin SPA to the files-first source.
 * The SPA can't touch the filesystem, so this is the bridge: it (1) resolves stable ids with an OWNERSHIP
 * guard (a client id is honored only if it already belongs to the addressed type — the fix that keeps a
 * rename lossless without letting a client forge a cross-type id steal), (2) PRE-FLIGHTs every emitted
 * identifier / relation target (a bad name is arbitrary-code injection into the generated schema.ts), (3)
 * GATES destructive/forbidden ops (a blocked edit changes NOTHING), and (4) writes `entities/<apiId>/
 * schema.ts` + migrates ATOMICALLY (temp-file → migrate → rename; unlink-on-throw).
 *
 * The desired full catalog (`next`) is keyed by STABLE ID, not apiId, so an apiId RENAME (same id, new
 * apiId) and a whole-type DELETE are both expressible — `swapFromIR` already dispatches renameType/dropType.
 * Create / update / rename / delete / preview all funnel through ONE apply core (`applyResolvedPlan`) so the
 * file+DB atomicity (and the S6 retry/idempotency) live in exactly one place.
 */

type Draft<T> = Omit<T, 'id'> & { id?: string };

/** A content-type edit from the SPA: ids are OPTIONAL (present = existing, kept; absent = new, minted). */
export interface ModuleDraft {
  id?: string;
  apiId: string;
  options?: Schema['options'];
  fields: Draft<FieldSchema>[];
  relations?: Draft<RelationSchema>[];
}

export interface SchemaEditResult {
  ok: boolean;
  /** ok=false: the changes that blocked the edit (need `allowDestructive`, or are forbidden). Nothing applied. */
  blocked?: readonly Change[];
  /** ok=true: the changes applied to the DB. */
  applied?: readonly Change[];
  /** ok=true: the resolved schema (with minted ids) that was written. Absent for a DELETE. */
  schema?: Schema;
  /** ok=true: the FULL desired catalog (applied with this type upserted/removed) the S4 swap rebuilds from. */
  next?: Schema[];
}

/** A pre-flight validation failure (bad identifier, reserved name, dangling relation target, id-ownership). → 422. */
export class BuilderValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BuilderValidationError';
  }
}

/** The addressed type does not exist (DELETE / id-addressed edit of an unknown type). → 404. */
export class BuilderNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BuilderNotFoundError';
  }
}

/** A second mutation arrived while one was in flight (single-writer mutex contended, programmatic path). → 409. */
export class BuilderBusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BuilderBusyError';
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Resolve a draft into a schema with stable ids, enforcing the OWNERSHIP guard against the addressed type's
 * applied snapshot (`appliedEntry`, matched by stable type id). Renames are legal (a field keeps its id,
 * changes its name) — the guard does NOT require name-equality. Throws {@link BuilderValidationError} on:
 *  (a) a client-supplied field/relation id NOT present in the addressed type's snapshot (cross-type theft /
 *      a new field carrying a foreign id), (b) a duplicate id within the draft, (c) `draft.id` addressing a
 *      type id that is not the resolved entry. An absent id is minted (collision-checked).
 */
function resolveSchema(draft: ModuleDraft, appliedEntry: Schema | undefined): Schema {
  if (draft.id !== undefined && (appliedEntry === undefined || appliedEntry.id !== draft.id)) {
    throw new BuilderValidationError(`unknown content-type id "${draft.id}"`);
  }
  const existingFieldIds = new Set((appliedEntry?.fields ?? []).map((f) => f.id));
  const existingRelIds = new Set((appliedEntry?.relations ?? []).map((r) => r.id));
  const allIds = new Set<string>([appliedEntry?.id, ...existingFieldIds, ...existingRelIds].filter(Boolean) as string[]);
  const seen = new Set<string>();

  const claimId = (clientId: string | undefined, known: Set<string>, prefix: 'f' | 'rel', label: string): string => {
    if (clientId !== undefined) {
      if (!known.has(clientId)) throw new BuilderValidationError(`${label} id "${clientId}" is not owned by this type`);
      if (seen.has(clientId)) throw new BuilderValidationError(`duplicate id "${clientId}" in the draft`);
      seen.add(clientId);
      return clientId;
    }
    let id = mintId(prefix);
    while (allIds.has(id) || seen.has(id)) id = mintId(prefix);
    seen.add(id);
    allIds.add(id);
    return id;
  };

  const typeId = appliedEntry?.id ?? draft.id ?? mintId('ct');
  const schema: Schema = {
    id: typeId,
    apiId: draft.apiId,
    fields: draft.fields.map((f) => ({ ...f, id: claimId(f.id, existingFieldIds, 'f', `field "${f.name}"`) })),
  };
  if (draft.options !== undefined) schema.options = draft.options;
  if (draft.relations !== undefined) {
    schema.relations = draft.relations.map((r) => ({ ...r, id: claimId(r.id, existingRelIds, 'rel', `relation "${r.field}"`) }));
  }
  return schema;
}

/**
 * Pre-flight every emitted identifier + relation target BEFORE the file is written. Each violation is a
 * {@link BuilderValidationError} (→ 422). Self-contained (validates against `schema` + the desired catalog
 * `next`); component-ref existence is left to the registry build. Reuses the same throwing identifier
 * validators the meta path uses, so an injection payload in a name can never reach codegen.
 */
function preflightValidate(schema: Schema, next: Schema[]): void {
  try {
    deriveTableName(schema.apiId); // identifier + reserved + ct_/_-leading + 63-byte assembly
    const names = new Set<string>();
    for (const f of schema.fields) {
      validateFieldName(f.name);
      const lower = f.name.toLowerCase();
      if (names.has(lower)) throw new BuilderValidationError(`duplicate field name "${f.name}"`);
      names.add(lower);
      if (f.type === 'enumeration') {
        for (const v of f.options?.values ?? []) {
          if (/[\x00-\x1f]/.test(v)) throw new BuilderValidationError(`enumeration value ${JSON.stringify(v)} contains a control character`);
        }
      }
    }
    const apiIds = new Set(next.map((s) => s.apiId.toLowerCase()));
    for (const r of schema.relations ?? []) {
      validateFieldName(r.field);
      validateRelationKind(r.kind);
      if (r.inverseField !== undefined) validateFieldName(r.inverseField);
      if (names.has(r.field.toLowerCase())) throw new BuilderValidationError(`relation field "${r.field}" collides with another field`);
      names.add(r.field.toLowerCase());
      if (r.target.toLowerCase() === schema.apiId.toLowerCase() && r.inverseField === r.field) {
        throw new BuilderValidationError(`self-referential relation "${r.field}" needs a distinct inverseField`);
      }
      if (!apiIds.has(r.target.toLowerCase())) throw new BuilderValidationError(`relation target "${r.target}" does not exist`);
    }
  } catch (e) {
    if (e instanceof BuilderValidationError) throw e;
    throw new BuilderValidationError(e instanceof Error ? e.message : String(e)); // wrap ddl identifier/reserved errors
  }
}

interface ResolvedPlan {
  next: Schema[];
  /** PUT: write `source` to the absolute `target` (`entities/<apiId>/schema.ts`) — temp → rename on commit. */
  write?: { target: string; source: string };
  /** DELETE: remove this source dir AFTER the migrate commits (mirror the temp-file discipline). */
  removeDir?: string;
  /** PUT: the addressed schema (with ids), echoed back. DELETE: undefined. */
  schema?: Schema;
}

/**
 * THE SINGLE APPLY CORE — gate, write the source atomically (or remove the dir), migrate, return the result.
 * The only caller of `migrate()`; the only place file+DB atomicity lives (and where S6's lock-contention
 * retry + idempotency-in-tx will land). Both the edit and the delete builders delegate here.
 */
async function applyResolvedPlan(
  sql: Sql,
  plan: ResolvedPlan,
  opts: { allowDestructive?: boolean },
): Promise<SchemaEditResult> {
  // GATE FIRST: a blocked edit must change nothing (no file, no DB).
  const { blocked } = await migrateLint(sql, plan.next, opts);
  if (blocked.length > 0) return { ok: false, blocked };

  // Atomicity (S2): temp-write → migrate → rename-on-commit; unlink-on-throw leaves schema.ts untouched.
  let tmp: string | undefined;
  if (plan.write) {
    await mkdir(path.dirname(plan.write.target), { recursive: true });
    tmp = `${plan.write.target}.${process.pid}.tmp`;
    await writeFile(tmp, plan.write.source);
  }
  // S6: bounded retry on lock contention ONLY (Postgres 55P03 lock_timeout). The single-writer mutex +
  // advisory lock serialize schema writes within the instance, so 55P03 means a STRAY holder (second process
  // / dev watcher); 3 short attempts then a loud SchemaChangeConflictError → 409. The temp file is kept across
  // attempts and unlinked ONCE on final failure (never per-attempt — a retried rename target would be gone).
  let result: Awaited<ReturnType<typeof migrate>> | undefined;
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      result = await migrate(sql, plan.next, opts);
      lastErr = undefined;
      break;
    } catch (err) {
      if ((err as { code?: string }).code === '55P03') {
        lastErr = err;
        await sleep(50 * 2 ** attempt + Math.random() * 25);
        continue;
      }
      if (tmp) await unlink(tmp).catch(() => {}); // a real failure (cast/constraint/etc.) — clean up + rethrow
      throw err;
    }
  }
  if (lastErr !== undefined || result === undefined) {
    if (tmp) await unlink(tmp).catch(() => {});
    throw new SchemaChangeConflictError('builder migrate lock contended; retry');
  }
  if (plan.write && tmp) await rename(tmp, plan.write.target);
  if (plan.removeDir) await rm(plan.removeDir, { recursive: true, force: true });
  return plan.schema !== undefined
    ? { ok: true, applied: result.applied, schema: plan.schema, next: plan.next }
    : { ok: true, applied: result.applied, next: plan.next };
}

/** Read the applied catalog (ensuring the on-demand snapshot table exists) — the `prev` every plan diffs against. */
async function readApplied(sql: Sql): Promise<Schema[]> {
  await ensureAppliedTable(sql);
  return readAppliedSchemas(sql);
}

/** Resolve a draft → (schema with ids, id-keyed next), shared by apply + preview. */
function resolveEdit(draft: ModuleDraft, applied: Schema[]): { schema: Schema; next: Schema[] } {
  const appliedEntry = (draft.id !== undefined ? applied.find((s) => s.id === draft.id) : undefined) ?? applied.find((s) => s.apiId === draft.apiId);
  const schema = resolveSchema(draft, appliedEntry);
  const next = [...applied.filter((s) => s.id !== schema.id), schema];
  preflightValidate(schema, next);
  return { schema, next };
}

/**
 * Apply a content-type CREATE / UPDATE / apiId-RENAME: resolve ids (ownership-guarded) → id-keyed next →
 * pre-flight → atomic write+migrate. Returns blocked changes (applying NOTHING) when a destructive/forbidden
 * op is present without `allowDestructive`.
 */
export async function applySchemaEdit(
  sql: Sql,
  entitiesDir: string,
  draft: ModuleDraft,
  opts: { allowDestructive?: boolean } = {},
): Promise<SchemaEditResult> {
  const applied = await readApplied(sql);
  const { schema, next } = resolveEdit(draft, applied);
  const target = path.join(entitiesDir, schema.apiId, 'schema.ts');
  return applyResolvedPlan(sql, { next, write: { target, source: generateSchemaSource(schema) }, schema }, opts);
}

/** Drop a whole content-type (always destructive). Blocks if a surviving type still targets it by relation. */
export async function applySchemaDelete(sql: Sql, entitiesDir: string, apiId: string): Promise<SchemaEditResult> {
  const applied = await readApplied(sql);
  const target = applied.find((s) => s.apiId === apiId);
  if (target === undefined) throw new BuilderNotFoundError(`content-type "${apiId}" does not exist`);
  // Inbound-relation safety: a surviving type whose relation targets this one would dangle (and its link
  // table FKs ct_<apiId>, so DROP TABLE would error). Block with a clear message — remove the relation first.
  const inbound = applied
    .filter((s) => s.id !== target.id)
    .flatMap((s) => (s.relations ?? []).filter((r) => r.target.toLowerCase() === apiId.toLowerCase()).map((r) => `${s.apiId}.${r.field}`));
  if (inbound.length > 0) {
    throw new BuilderValidationError(`type "${apiId}" is referenced by ${inbound.join(', ')}; remove the relation(s) first`);
  }
  const next = applied.filter((s) => s.id !== target.id);
  return applyResolvedPlan(sql, { next, removeDir: path.join(entitiesDir, apiId) }, { allowDestructive: true });
}

/** Dry-run a CREATE/UPDATE: resolve + pre-flight + lint + codegen, writing NOTHING and migrating NOTHING. */
export async function previewSchemaEdit(
  sql: Sql,
  draft: ModuleDraft,
  opts: { allowDestructive?: boolean } = {},
): Promise<{ ok: boolean; blocked: readonly Change[]; changes: readonly Change[]; schema: Schema; generatedSource: string }> {
  const applied = await readApplied(sql);
  const { schema, next } = resolveEdit(draft, applied);
  const { changes, blocked } = await migrateLint(sql, next, opts);
  return { ok: blocked.length === 0, blocked, changes, schema, generatedSource: generateSchemaSource(schema) };
}
