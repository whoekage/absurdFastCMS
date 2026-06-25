import { writeFile, mkdir, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { Sql } from 'postgres';
import { mintId, type ContentTypeSchema, type FieldSchema, type RelationSchema } from '../db/schema/model.ts';
import { generateSchemaSource } from '../db/schema/codegen.ts';
import { migrate, migrateLint, readAppliedSchemas, ensureAppliedTable } from '../db/schema/migrate.ts';
import type { Change } from '../db/schema/diff.ts';

/**
 * THE VISUAL BUILDER'S SERVER SIDE — apply a schema edit from the admin SPA to the files-first source.
 * The SPA can't touch the filesystem, so this is the bridge: it (1) mints stable ids for genuinely-new
 * fields (existing ids are PRESERVED — that is how a rename stays lossless), (2) GATES destructive/forbidden
 * ops (a blocked edit changes NOTHING — no file, no DB), (3) regenerates `entities/<apiId>/schema.ts`
 * WHOLESALE (codegen, no AST), and (4) migrates the DB. Dev-only (the prod Builder is OFF, Strapi-style).
 *
 * State: the desired full catalog = the stored applied catalog with this apiId replaced by the edit, so a
 * create (apiId absent) and an update (apiId present) are the same operation. NOTE: this writes the file +
 * migrates; making the change LIVE in the running process (registry/engine hot-swap) is a follow-up — in
 * dev, `conti dev`'s watcher restarts on the file write and the fresh boot reads the new file + migrated DB.
 */

type Draft<T> = Omit<T, 'id'> & { id?: string };

/** A content-type edit from the SPA: ids are OPTIONAL (present = existing, kept; absent = new, minted). */
export interface ContentTypeDraft {
  id?: string;
  apiId: string;
  options?: ContentTypeSchema['options'];
  fields: Draft<FieldSchema>[];
  relations?: Draft<RelationSchema>[];
}

export interface SchemaEditResult {
  ok: boolean;
  /** ok=false: the changes that blocked the edit (need `allowDestructive`, or are forbidden). Nothing applied. */
  blocked?: readonly Change[];
  /** ok=true: the changes applied to the DB. */
  applied?: readonly Change[];
  /** ok=true: the resolved schema (with minted ids) that was written. */
  schema?: ContentTypeSchema;
}

/** Mint ids for the type + any field/relation lacking one; existing ids are preserved (rename-safety). */
function mintMissingIds(draft: ContentTypeDraft): ContentTypeSchema {
  const schema: ContentTypeSchema = {
    id: draft.id ?? mintId('ct'),
    apiId: draft.apiId,
    fields: draft.fields.map((f) => ({ ...f, id: f.id ?? mintId('f') })),
  };
  if (draft.options !== undefined) schema.options = draft.options;
  if (draft.relations !== undefined) schema.relations = draft.relations.map((r) => ({ ...r, id: r.id ?? mintId('rel') }));
  return schema;
}

/**
 * Apply a content-type edit: mint ids → gate → (write `entities/<apiId>/schema.ts` + migrate). Returns the
 * blocked changes (and applies NOTHING) when a destructive/forbidden op is present without `allowDestructive`.
 */
export async function applySchemaEdit(
  sql: Sql,
  entitiesDir: string,
  draft: ContentTypeDraft,
  opts: { allowDestructive?: boolean } = {},
): Promise<SchemaEditResult> {
  const schema = mintMissingIds(draft);
  await ensureAppliedTable(sql); // a fresh DB has no _schema_applied yet; the applied catalog is then empty
  const applied = await readAppliedSchemas(sql);
  const next = [...applied.filter((s) => s.apiId !== schema.apiId), schema];

  // GATE FIRST: a blocked edit must change nothing (no file, no DB).
  const { blocked } = await migrateLint(sql, next, opts);
  if (blocked.length > 0) return { ok: false, blocked };

  // ATOMICITY (S2): the file flip + the DB migrate must be all-or-nothing. Write the generated source to a
  // TEMP file FIRST, run migrate(), and only on a successful commit `rename` the temp over `schema.ts` (an
  // atomic same-dir flip). If migrate() throws, the DB tx rolls back AND the temp is unlinked, leaving the
  // existing `schema.ts` UNTOUCHED — never the file-ahead-of-DB drift the old write-then-migrate order risked.
  // (The sub-ms crash window between commit and rename — file BEHIND the DB — is handled by the boot guard, S3.)
  const dir = path.join(entitiesDir, schema.apiId);
  await mkdir(dir, { recursive: true });
  const target = path.join(dir, 'schema.ts');
  const tmp = `${target}.${process.pid}.tmp`;
  await writeFile(tmp, generateSchemaSource(schema));
  let result: Awaited<ReturnType<typeof migrate>>;
  try {
    result = await migrate(sql, next, opts);
  } catch (err) {
    await unlink(tmp).catch(() => {}); // best-effort cleanup; never mask the original migrate error
    throw err;
  }
  await rename(tmp, target); // commit succeeded — flip the source of truth into place
  return { ok: true, applied: result.applied, schema };
}
