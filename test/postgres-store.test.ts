import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createSql } from '../src/db/client.ts';
import { runMigrations } from '../src/db/migrate.ts';
import { PostgresStore } from '../src/db/postgres-store.ts';
import { handleRequest } from '../src/http/router.ts';

/**
 * POSTGRES-STORE SLICE — the boot load path, end-to-end against a REAL Postgres (no mocks).
 *
 * Requires the docker-compose Postgres up and `.env.test` -> the isolated `absurd_test` database
 * (the test runner is launched with `--env-file=.env.test`). We migrate, insert known rows over a
 * real connection, load them through {@link PostgresStore}, and prove the engine serves them: PK
 * lookup, NULL rendering, surrogate-pair text, and a filtered+sorted list vs a hand oracle.
 */

const sql = createSql(); // DATABASE_URL from .env.test

interface SeedRow {
  title: string | null;
  body: string;
  status: string;
  views: number | null;
  rating: number | null;
  active: boolean;
  publishedAt: Date;
}

// Deterministic fixtures. After TRUNCATE ... RESTART IDENTITY the serial PKs are 1..N in this order.
const ROWS: SeedRow[] = [
  { title: 'Hello', body: 'b1', status: 'published', views: 100, rating: 4.5, active: true, publishedAt: new Date('2021-01-01T00:00:00.000Z') },
  { title: null, body: 'b2', status: 'draft', views: null, rating: null, active: false, publishedAt: new Date('2021-02-01T00:00:00.000Z') },
  { title: 'World \u{1F600}', body: 'b3', status: 'published', views: 5, rating: 2, active: true, publishedAt: new Date('2021-03-01T00:00:00.000Z') },
  { title: 'Archived one', body: 'b4', status: 'archived', views: 50, rating: 3.25, active: false, publishedAt: new Date('2021-04-01T00:00:00.000Z') },
];

before(async () => {
  await runMigrations();
  await sql`TRUNCATE articles RESTART IDENTITY`;
  for (const r of ROWS) {
    await sql`
      INSERT INTO articles (title, body, status, views, rating, active, published_at)
      VALUES (${r.title}, ${r.body}, ${r.status}, ${r.views}, ${r.rating}, ${r.active}, ${r.publishedAt})
    `;
  }
});

after(async () => {
  await sql`TRUNCATE articles RESTART IDENTITY`;
  await sql.end();
});

test('load() builds an engine with every row, PK addressable, NULLs as JSON null', async () => {
  const engine = await new PostgresStore(sql).load();
  assert.equal(engine.rowCount('article'), ROWS.length);

  // PK lookup hits the right row (PKs are 1-based); the all-null row renders title/views/rating null.
  const two = JSON.parse(engine.respondById('article', 2)!.toString('utf8'));
  assert.deepEqual(two.data, {
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
  const engine = await new PostgresStore(sql).load();
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
