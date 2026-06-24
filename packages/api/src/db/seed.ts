import type { Sql } from 'postgres';
import { createContentType, getContentType, type FieldSpec } from './content-type.repository.ts';
import { ContentTypeExistsError } from './ddl.ts';
import type { ContentTypeSchema } from './schema/model.ts';
import { schemaToFieldSpecs } from './schema/adapt.ts';

/**
 * The files-first SEED — materialize each committed `schema/<apiId>.json` as a `ct_<apiId>` table + meta if
 * it is not already present (the bridge until S4's `conti migrate` owns table creation from files). A
 * db-layer concern (it goes through the validated content-type repository + DDL), imported downward by the
 * composition root (compose -> db).
 *
 * {@link ARTICLE_SEED_FIELDS} is retained as the demo type's IN-CODE shape — now mirrored by the committed
 * `schema/article.json` and exercised by the meta↔file equivalence oracle.
 */

export const STATUSES = ['draft', 'published', 'archived'];

/**
 * The `article` seed spec. `status` is an `enumeration` (members `['draft','published','archived']`) so it
 * is eq-indexed and materializes byte-identically to a varchar. `publishedAt` is the FIELD NAME so the
 * physical column AND the wire key are both `publishedAt` (renaming it is a BREAKING wire change).
 *
 * Nullability: title/views/rating nullable; body/status/active/publishedAt NOT NULL — the resulting engine
 * types carry no i64/decimal/json field, so the table keeps the fast JSON.stringify path (byte-identical).
 */
export const ARTICLE_SEED_FIELDS: FieldSpec[] = [
  { name: 'title', cmsType: 'string', options: { length: 512, nullable: true } },
  { name: 'body', cmsType: 'text', options: { nullable: false } },
  { name: 'status', cmsType: 'enumeration', options: { values: STATUSES, nullable: false } },
  { name: 'views', cmsType: 'integer', options: { nullable: true } },
  { name: 'rating', cmsType: 'float', options: { nullable: true } },
  { name: 'active', cmsType: 'boolean', options: { nullable: false } },
  // WIRE CONTRACT: the field NAME is `publishedAt`, so the physical column AND the wire key are both
  // `publishedAt`. RENAMING this field is a BREAKING wire change for existing clients.
  { name: 'publishedAt', cmsType: 'datetime', options: { nullable: false } },
];

/**
 * Materialize every schema in `schemas` whose `ct_` table/meta is absent (the file-driven boot seed).
 * Each type is created from its FILE declaration via createContentType's own atomic transaction. A benign
 * peer-race (ContentTypeExistsError / a 23505 from the DB UNIQUE) is tolerated and swallowed. Relations are
 * deferred to a later slice, so a relation-bearing schema would seed its scalar fields only (and would in
 * any case fail loud at registry build) — the demo catalog has none.
 */
export async function seedFromSchemas(sql: Sql, schemas: ContentTypeSchema[]): Promise<void> {
  for (const schema of schemas) await seedSchemaIfAbsent(sql, schema);
}

/**
 * Idempotently seed `article` from the in-code {@link ARTICLE_SEED_FIELDS} (a per-file-DB test convenience;
 * createConti itself now seeds from `schema/*.json`). A no-op when it exists; a benign peer-race
 * (ContentTypeExistsError / 23505) is swallowed.
 */
export async function seedArticleIfAbsent(sql: Sql): Promise<void> {
  if (await getContentType(sql, 'article')) return;
  try {
    await createContentType(sql, { apiId: 'article', fields: ARTICLE_SEED_FIELDS });
  } catch (e) {
    if (e instanceof ContentTypeExistsError) return;
    if ((e as { code?: string }).code === '23505') return;
    throw e;
  }
}

async function seedSchemaIfAbsent(sql: Sql, schema: ContentTypeSchema): Promise<void> {
  if (await getContentType(sql, schema.apiId)) return;
  try {
    await createContentType(sql, {
      apiId: schema.apiId,
      fields: schemaToFieldSpecs(schema),
      draftPublish: schema.options?.draftAndPublish ?? false,
      i18n: schema.options?.i18n ?? false,
    });
  } catch (e) {
    if (e instanceof ContentTypeExistsError) return;
    if ((e as { code?: string }).code === '23505') return;
    throw e;
  }
}
