import type { Engine } from './engine.ts';
import type { FieldDef } from './table.ts';
import type { Table } from './table.ts';

/**
 * The SHARED definition of the `article` content-type — the single place its field schema and index
 * plan live, used by BOTH the in-memory seed (bench/fixtures) and the {@link PostgresStore} boot load.
 * Keeping it here means "what is an article" is defined once; a loader just supplies the rows.
 *
 * `id` is the FIRST field and the public PRIMARY KEY (the real Postgres serial), eq-indexed so
 * `GET /article/:id` resolves by key, not by dense row position. Field NAMES are the camelCase the
 * API exposes (`publishedAt`); a loader maps its storage columns onto these names.
 */
export const ARTICLE_FIELDS: FieldDef[] = [
  { name: 'id', type: 'i32' },
  { name: 'title', type: 'string' },
  { name: 'body', type: 'text' },
  { name: 'status', type: 'string' },
  { name: 'views', type: 'i32' },
  { name: 'rating', type: 'f64' },
  { name: 'active', type: 'bool' },
  { name: 'publishedAt', type: 'date' },
];

/**
 * Define `article` on a fresh Engine and register its (still-empty) indexes: eq on `id` (PK lookup)
 * and `status`, sorted on `views` and `publishedAt`. Callers then `engine.insert('article', …)` the
 * rows and finish with `engine.table('article').warmIndexes()`.
 */
export function defineArticle(engine: Engine): Table {
  const t = engine.define('article', ARTICLE_FIELDS);
  t.createEqIndex('id');
  t.createEqIndex('status');
  t.createSortedIndex('views');
  t.createSortedIndex('publishedAt');
  return t;
}
