import type { Sql } from 'postgres';
import { Engine } from '../store/engine.ts';
import type { FieldDef } from '../store/table.ts';
import { PostgresStore } from '../db/postgres.store.ts';
import { runMigrations } from '../db/migration.runner.ts';
import { createContentType, getContentType, type FieldSpec } from '../db/content-type.repository.ts';
import { ContentTypeExistsError } from '../db/ddl.ts';
import { createServer } from './uws.adapter.ts';
import { cursorCodecFromEnv } from '../db/engine.loader.ts';
import { config } from '../config.ts';

/**
 * The PRODUCTION entrypoint: a SINGLE process that migrates, seeds the `article` content-type as a
 * DYNAMIC content-type (via the validated step-2 path) when absent, loads its in-memory {@link Engine}
 * + {@link Registry} from Postgres at boot, and serves the uWebSockets.js app over it.
 *
 * SHARED-NOTHING, single-instance: the process builds its OWN Engine (columns, indexes, response
 * cache) — a self-contained read replica. FUTURE: the ChangeBus becomes a Redis pub/sub bus so a
 * write in a multi-instance deployment invalidates every instance's response cache. {@link seed}
 * remains an in-code data generator for benchmarks/fixtures (NOT the boot path).
 *
 * Server construction ({@link createServer}) is intentionally SEPARATE from listening so tests drive
 * a real uWS server on a free port and never go through this entrypoint.
 */

const STATUSES = ['draft', 'published', 'archived'];

/**
 * The `article` content-type seed spec — the canonical demo fixture. `status` is seeded as an
 * `enumeration` (members `['draft','published','archived']`) rather than a free-form varchar(32), so it
 * is eq-indexed — every test fixture status is a member, and an enum materializes byte-identically to a
 * varchar. `publishedAt` is the FIELD NAME so the physical column is `"publishedAt"` and the wire key
 * matches.
 *
 * Nullability: title/views/rating nullable; body/status/active/publishedAt NOT NULL. The resulting
 * engine types (i32/date/date | string/text/string/i32/f64/bool/date) carry no i64/decimal/json field,
 * so the table keeps the fast JSON.stringify path -> byte-identical reads.
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
 * Idempotently seed `article` as a dynamic content-type (content_types + fields + ct_article). A no-op
 * when it already exists; a benign peer-race (ContentTypeExistsError / a 23505 from the DB UNIQUE) is
 * tolerated and swallowed (the subsequent load re-reads the committed meta). Runs through
 * createContentType's own atomic transaction — NO outer transaction here. The live article data is
 * owned by `ct_article`.
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

/** The static engine FieldDef[] mirroring {@link ARTICLE_SEED_FIELDS} for the in-memory bench generator. */
const ARTICLE_BENCH_FIELDS: FieldDef[] = [
  { name: 'id', type: 'i32' },
  { name: 'created_at', type: 'date' },
  { name: 'updated_at', type: 'date' },
  { name: 'title', type: 'string' },
  { name: 'body', type: 'text' },
  { name: 'status', type: 'string' },
  { name: 'views', type: 'i32' },
  { name: 'rating', type: 'f64' },
  { name: 'active', type: 'bool' },
  { name: 'publishedAt', type: 'date' },
];

function lcg(seedNum: number): () => number {
  let s = seedNum >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/**
 * Build an Engine and fill the `article` content-type with `n` deterministic rows — a benchmark /
 * fixture generator, NOT the production boot path (the process loads from {@link PostgresStore}). `id`
 * is a dense 1-based serial so it matches a freshly-seeded Postgres table. Uses a static in-memory
 * schema (mirroring the seed spec) + the same index plan — no DB.
 */
export function seed(n: number, seedNum = 1): Engine {
  const engine = new Engine();
  const t = engine.define('article', ARTICLE_BENCH_FIELDS);
  t.createEqIndex('id');
  t.createEqIndex('status');
  t.createSortedIndex('views');
  t.createSortedIndex('publishedAt');
  const rng = lcg(seedNum);
  const base = Date.UTC(2021, 0, 1);
  for (let i = 0; i < n; i++) {
    engine.insert('article', {
      id: i + 1,
      created_at: base + i * 3_600_000,
      updated_at: base + i * 3_600_000,
      title: rng() < 0.1 ? null : `Title "${i}" e zh`,
      body: `Body text for row ${i}, lorem ipsum dolor sit amet.`,
      status: STATUSES[(rng() * STATUSES.length) | 0]!,
      views: rng() < 0.08 ? null : (rng() * 100000) | 0,
      rating: rng() < 0.08 ? null : Math.round(rng() * 1000) / 100,
      active: rng() < 0.5,
      publishedAt: base + i * 3_600_000,
    });
  }
  t.warmIndexes();
  return engine;
}

/** Boot the server: migrate, seed article, load the Engine + Registry from Postgres, listen on `port`. */
export async function start(port: number): Promise<void> {
  await runMigrations();
  const store = new PostgresStore();
  await seedArticleIfAbsent(store.sql);
  // Wire the keyset cursor codec (HMAC over CURSOR_SECRET) once at the composition root.
  const { engine, registry } = await store.loadWithRegistry({ cursorCodec: cursorCodecFromEnv() });
  const server = createServer(engine, store, registry); // store + registry enable POST/PUT/DELETE
  await server.listen(port);
  const rows = engine.has('article') ? engine.rowCount('article') : 0;
  console.log(`ready on ${port} (${rows} article rows from postgres)`);
}

/** The entrypoint. Run directly: `node --env-file=.env src/http/server.ts [port]`. */
export function main(): void {
  const port = config.port(process.argv[2]);
  void start(port);
}

// Run only when invoked as the entrypoint (not when imported by a test/bench).
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
