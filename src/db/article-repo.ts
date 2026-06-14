import type { Sql } from 'postgres';
import { ARTICLE_COLUMN } from '../store/content-type.ts';

/**
 * The write repository for `article` — Postgres is the SOURCE OF TRUTH, so every create/update/delete
 * commits here FIRST (single statement, `RETURNING *`), and the caller then rebuilds the RAM engine.
 *
 * Boundary mapping: callers speak ENGINE field names (camelCase, e.g. `publishedAt`); this module
 * translates to/from the snake_case Postgres columns via {@link ARTICLE_COLUMN}. postgres.js binds
 * every value as a parameter (no string interpolation), and accepts a JS `Date` for `timestamptz`.
 */

/** A DB row (snake_case) as returned by `RETURNING *`. */
interface ArticleDbRow {
  id: number;
  title: string | null;
  body: string;
  status: string;
  views: number | null;
  rating: number | null;
  active: boolean;
  published_at: Date;
}

/** DB row (snake_case) -> plain engine-named row (camelCase). */
function fromDb(r: ArticleDbRow): Record<string, unknown> {
  return {
    id: r.id,
    title: r.title,
    body: r.body,
    status: r.status,
    views: r.views,
    rating: r.rating,
    active: r.active,
    publishedAt: r.published_at,
  };
}

/** Engine-named data -> snake_case columns for SQL (only the keys present are written). */
function toDb(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(data)) out[ARTICLE_COLUMN[key]!] = data[key];
  return out;
}

/** INSERT one article, returning the stored row (with its serial PK). */
export async function insertArticle(sql: Sql, data: Record<string, unknown>): Promise<Record<string, unknown>> {
  const dbData = toDb(data);
  const cols = Object.keys(dbData);
  const rows = await sql<ArticleDbRow[]>`INSERT INTO articles ${sql(dbData, ...cols)} RETURNING *`;
  return fromDb(rows[0]!);
}

/** UPDATE the given fields of article `id`; `null` when no row has that id. */
export async function updateArticle(sql: Sql, id: number, data: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  const dbData = toDb(data);
  const cols = Object.keys(dbData);
  const rows = await sql<ArticleDbRow[]>`UPDATE articles SET ${sql(dbData, ...cols)} WHERE id = ${id} RETURNING *`;
  return rows.length ? fromDb(rows[0]!) : null;
}

/** DELETE article `id`, returning the deleted row; `null` when no row had that id. */
export async function deleteArticle(sql: Sql, id: number): Promise<Record<string, unknown> | null> {
  const rows = await sql<ArticleDbRow[]>`DELETE FROM articles WHERE id = ${id} RETURNING *`;
  return rows.length ? fromDb(rows[0]!) : null;
}
