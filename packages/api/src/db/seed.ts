import type { Sql } from 'postgres';
import { createContentType, getContentType, type FieldSpec } from './content-type.repository.ts';
import { ContentTypeExistsError } from './ddl.ts';

/**
 * The `article` demo content-type seed — the canonical fixture booted by {@link createConti}. A db-layer
 * concern (it goes through the validated content-type repository + DDL), moved out of the http entrypoint
 * so the composition root can import it downward (compose -> db) without a cycle.
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
 * Idempotently seed `article` as a dynamic content-type (content_types + fields + ct_article). A no-op when
 * it already exists; a benign peer-race (ContentTypeExistsError / a 23505 from the DB UNIQUE) is tolerated
 * and swallowed (the subsequent load re-reads the committed meta). Runs through createContentType's own
 * atomic transaction — NO outer transaction here. The live article data is owned by `ct_article`.
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
