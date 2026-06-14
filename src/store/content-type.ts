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

// --- write-path metadata -----------------------------------------------------

/** Fields a client may write — everything except the server-assigned primary key. */
export const ARTICLE_WRITABLE = ARTICLE_FIELDS.filter((f) => f.name !== 'id');

/** Writable fields that accept `null` (the rest are NOT NULL in Postgres). */
export const ARTICLE_NULLABLE: ReadonlySet<string> = new Set(['title', 'views', 'rating']);

/** Fields that MUST be present on create (NOT NULL, no DB default). */
export const ARTICLE_REQUIRED_ON_CREATE: readonly string[] = ['body', 'status', 'active', 'publishedAt'];

/** Engine field name -> Postgres column name (only `publishedAt` differs from its column). */
export const ARTICLE_COLUMN: Readonly<Record<string, string>> = {
  id: 'id',
  title: 'title',
  body: 'body',
  status: 'status',
  views: 'views',
  rating: 'rating',
  active: 'active',
  publishedAt: 'published_at',
};

/**
 * Render a plain `article` row (keyed by engine field names, values being JS `Date`/string/number/
 * boolean/null) into the SAME JSON object the read engine's `materialize` produces: fields in schema
 * order, a `date` as an ISO-8601 UTC string, missing/null as `null`. Used to shape write responses so
 * they match GET byte-for-byte.
 */
export function materializeRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of ARTICLE_FIELDS) {
    const v = row[f.name];
    if (v === null || v === undefined) {
      out[f.name] = null;
      continue;
    }
    out[f.name] = f.type === 'date' ? new Date(v as string | number | Date).toISOString() : v;
  }
  return out;
}
