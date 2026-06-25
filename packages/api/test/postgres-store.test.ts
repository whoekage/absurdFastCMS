import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Sql } from 'postgres';
import { PostgresStore } from '../src/db/postgres.store.ts';
import { migrate } from '../src/db/schema/migrate.ts';
import type { ContentTypeSchema } from '../src/db/schema/model.ts';
import { handleRequest } from '../src/http/read.router.ts';
import { createFileDatabase, dropFileDatabase } from './db-per-file.ts';
import { ct } from './helpers.ts';

/**
 * POSTGRES-STORE SLICE — the boot load path, end-to-end against a REAL Postgres (no mocks), on the
 * GENERIC content-type path: `article` is now a dynamic content-type (ct_article) seeded via the
 * step-2 createContentType path. We migrate, seed the type, insert known rows over a real connection
 * into ct_article (registry column names incl. "publishedAt"), load through {@link PostgresStore}, and
 * prove the engine serves them: PK lookup (now incl. created_at/updated_at), NULL rendering,
 * surrogate-pair text, and a filtered+sorted list vs a hand oracle.
 */

let sql: Sql;
let db: Awaited<ReturnType<typeof createFileDatabase>>;
let articleSchema: ContentTypeSchema;

interface SeedRow {
  title: string | null;
  body: string;
  status: string;
  views: number | null;
  rating: number | null;
  active: boolean;
  publishedAt: string;
}

// Deterministic fixtures. After TRUNCATE ... RESTART IDENTITY the serial PKs are 1..N in this order.
const ROWS: SeedRow[] = [
  { title: 'Hello', body: 'b1', status: 'published', views: 100, rating: 4.5, active: true, publishedAt: '2021-01-01T00:00:00.000Z' },
  { title: null, body: 'b2', status: 'draft', views: null, rating: null, active: false, publishedAt: '2021-02-01T00:00:00.000Z' },
  { title: 'World \u{1F600}', body: 'b3', status: 'published', views: 5, rating: 2, active: true, publishedAt: '2021-03-01T00:00:00.000Z' },
  { title: 'Archived one', body: 'b4', status: 'archived', views: 50, rating: 3.25, active: false, publishedAt: '2021-04-01T00:00:00.000Z' },
];

before(async () => {
  db = await createFileDatabase('ps');
  sql = db.sql;
  articleSchema = ct({
    apiId: 'article',
    fields: [
      { name: 'title', cmsType: 'string', options: { length: 512, nullable: true } },
      { name: 'body', cmsType: 'text', options: { nullable: false } },
      { name: 'status', cmsType: 'string', options: { nullable: false } },
      { name: 'views', cmsType: 'integer', options: { nullable: true } },
      { name: 'rating', cmsType: 'decimal', options: { precision: 10, scale: 2, nullable: true } },
      { name: 'active', cmsType: 'boolean', options: { nullable: false } },
      { name: 'publishedAt', cmsType: 'datetime', options: { nullable: false } },
    ],
  });
  await migrate(sql, [articleSchema], { allowDestructive: true });
  for (const r of ROWS) {
    await sql`
      INSERT INTO ct_article (title, body, status, views, rating, active, "publishedAt")
      VALUES (${r.title}, ${r.body}, ${r.status}, ${r.views}, ${r.rating}, ${r.active}, ${r.publishedAt})
    `;
  }
});

after(async () => {
  // Guard so a failing before() (db/sql undefined) surfaces the real error, not a deref of undefined.
  if (sql) await sql.end();
  if (db) await dropFileDatabase(db.name);
});

test('load() builds an engine with every row, PK addressable, NULLs as JSON null', async () => {
  const engine = (await new PostgresStore(sql).loadFromSchemas([articleSchema])).engine;
  assert.equal(engine.rowCount('article'), ROWS.length);

  // PK lookup hits the right row (PKs are 1-based); the all-null row renders title/views/rating null.
  // The response now ALSO includes the system created_at/updated_at fields (registry projection).
  const two = JSON.parse(engine.respondById('article', 2)!.toString('utf8'));
  // Field order is [id, created_at, updated_at, ...user]; created_at/updated_at are ISO strings.
  assert.deepEqual(Object.keys(two.data), ['id', 'created_at', 'updated_at', 'title', 'body', 'status', 'views', 'rating', 'active', 'publishedAt']);
  assert.equal(typeof two.data.created_at, 'string');
  assert.equal(typeof two.data.updated_at, 'string');
  assert.ok(!Number.isNaN(Date.parse(two.data.created_at)));
  const { created_at, updated_at, ...rest } = two.data;
  void created_at;
  void updated_at;
  assert.deepEqual(rest, {
    id: 2,
    title: null,
    body: 'b2',
    status: 'draft',
    views: null,
    rating: null,
    active: false,
    publishedAt: '2021-02-01T00:00:00.000Z',
  });

  // Surrogate-pair text round-trips through the byte arena unscathed.
  const three = JSON.parse(engine.respondById('article', 3)!.toString('utf8'));
  assert.equal(three.data.title, 'World \u{1F600}');

  // A PK with no row is a miss.
  assert.equal(engine.respondById('article', 999), null);
});

test('loaded engine answers a filtered + sorted list like a hand oracle', async () => {
  const engine = (await new PostgresStore(sql).loadFromSchemas([articleSchema])).engine;
  const res = handleRequest(engine, {
    method: 'GET',
    path: '/article',
    query: 'filters[status][$eq]=published&sort=views:desc',
  });
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body.toString('utf8'));

  // Oracle: published rows are PK 1 (views 100) and PK 3 (views 5), views desc -> [1, 3].
  assert.deepEqual(body.data.map((d: { id: number }) => d.id), [1, 3]);
  assert.ok(body.data.every((d: { status: string }) => d.status === 'published'));
});
