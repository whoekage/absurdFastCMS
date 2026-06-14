import type { Sql } from 'postgres';
import { Engine } from '../store/engine.ts';
import { defineArticle } from '../store/content-type.ts';
import type { Store } from '../store/store.ts';
import { createSql } from './client.ts';

/** Rows pulled per cursor batch — bounds peak memory so a multi-million-row table never buffers whole. */
const LOAD_BATCH = 5000;

/**
 * {@link Store} backed by Postgres (the source of truth). `load()` builds an Engine, CURSOR-STREAMS
 * the `articles` table in batches (never buffering the whole table), serialize-on-write inserts each
 * row, then warms the indexes once. The Postgres `id` (serial PK) becomes the engine's public `id`.
 *
 * Connection ownership: construct with a `DATABASE_URL` string (or nothing, to read it from the env)
 * and the store OWNS the postgres.js handle — call {@link close} when done. Construct with an existing
 * `Sql` handle (e.g. a test sharing one connection) and the caller keeps ownership.
 */
export class PostgresStore implements Store {
  private readonly sql: Sql;
  private readonly ownsSql: boolean;

  constructor(source?: string | Sql) {
    if (typeof source === 'function') {
      // postgres.js `Sql` handles are callable (tagged-template) functions.
      this.sql = source;
      this.ownsSql = false;
    } else {
      this.sql = createSql(source);
      this.ownsSql = true;
    }
  }

  async load(): Promise<Engine> {
    const engine = new Engine();
    const table = defineArticle(engine);

    const cursor = this.sql<ArticleDbRow[]>`
      SELECT id, title, body, status, views, rating, active, published_at
      FROM articles
      ORDER BY id
    `.cursor(LOAD_BATCH);

    for await (const rows of cursor) {
      for (const r of rows) {
        // Map snake_case storage columns onto the engine's camelCase FieldDef names. NULLs pass
        // through as null (the engine renders them as JSON null); `published_at` is a JS Date.
        engine.insert('article', {
          id: r.id,
          title: r.title,
          body: r.body,
          status: r.status,
          views: r.views,
          rating: r.rating,
          active: r.active,
          publishedAt: r.published_at,
        });
      }
    }

    table.warmIndexes();
    return engine;
  }

  /** Close the owned connection (no-op when an external `Sql` handle was injected). */
  async close(): Promise<void> {
    if (this.ownsSql) await this.sql.end();
  }
}

/** Raw row shape as returned by postgres.js for the SELECT above (snake_case, Date for timestamptz). */
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
