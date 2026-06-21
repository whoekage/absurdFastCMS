import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { Sql } from 'postgres';

import { runMigrations } from '../src/db/migration.runner.ts';
import { createFileDatabase, dropFileDatabase } from './db-per-file.ts';
import { OffHeapSessionStore } from '../src/auth/session.store.ts';

/**
 * SCALE proof — 10,000,000 sessions, REAL in Postgres AND REAL in our off-heap engine, cross-verified.
 * NO MOCKS: 10M rows are bulk-COPYed into the better-auth `session` table (durable PG truth), then
 * STREAMED back out via a server-side cursor and loaded into the {@link OffHeapSessionStore} (the engine
 * side the SessionCache wraps). We then assert both counts are exactly 10M and spot-check a deterministic
 * spread of tokens against PG row-for-row. This is the "to be sure" run: a plain `Map` would be near its
 * V8 2^24 ceiling here and pay major-GC tracing on every cycle; the off-heap arena holds all 10M in a
 * handful of ArrayBuffers with zero per-session heap objects.
 *
 * HEAVY (minutes + ~2 GB RSS), so it is OPT-IN behind SESSION_SCALE_TEST=1 to keep the default suite fast.
 * Run it explicitly:
 *   SESSION_SCALE_TEST=1 node --env-file=.env.test --test \
 *     --test-global-setup=./test/global-setup.ts test/auth.session.scale.test.ts
 * Override the count with SESSION_SCALE_N (default 10_000_000).
 */

const SCALE = process.env.SESSION_SCALE_TEST === '1';
const N = Number(process.env.SESSION_SCALE_N ?? 10_000_000);
// Sessions per user: 1 (default) => a DISTINCT real user per session (N users — max userId diversity,
// the most honest stress of the userId arena). Set >1 to model multi-device (e.g. 3 => N/3 users).
const SESSIONS_PER_USER = Number(process.env.SESSION_SCALE_PER_USER ?? 1);
const USERS = Math.max(1, Math.ceil(N / SESSIONS_PER_USER));

let db: Awaited<ReturnType<typeof createFileDatabase>>;
let sql: Sql;

/** Deterministic, unique, base64url-ish token for row i — reconstructable for spot-checks. */
function tokenFor(i: number): string {
  const h = (Math.imul(i ^ 0x9e3779b1, 2654435761) >>> 0).toString(36);
  return `sess_${i}_${h}`;
}
/** Deterministic, realistic-length (better-auth-like) user id for user index k. */
function userIdOf(k: number): string {
  const h = (Math.imul(k ^ 0x85ebca6b, 0xc2b2ae35) >>> 0).toString(36);
  return `usr_${k}_${h}`;
}
/** The user that owns session row i (round-robin across USERS distinct users). */
const userIdFor = (i: number): string => userIdOf(i % USERS);

before(async () => {
  if (!SCALE) return;
  db = await createFileDatabase('sessionscale');
  await runMigrations(db.url);
  sql = db.sql;
});

after(async () => {
  if (!SCALE) return;
  await sql.end();
  await db.sql.end?.();
  await dropFileDatabase(db.name);
});

test(
  `${N.toLocaleString()} sessions live in Postgres AND in the off-heap engine, cross-verified`,
  { skip: SCALE ? false : 'set SESSION_SCALE_TEST=1 to run the 10M scale proof', timeout: 1_200_000 },
  async () => {
    // ── 0. bulk-load tuning for a THROWAWAY test DB ─────────────────────────────────────────────
    // Drop the session→user FK so the 10M session COPY doesn't do a per-row index probe into the N-row
    // user table (the bulk-load killer once both tables are large — it's what blew the 20-min budget).
    // Re-added NOT VALID afterwards so the schema still documents the relationship; we don't pay PG to
    // validate 10M rows that are valid by construction. (UNLOGGED was rejected: `user` is referenced by
    // several logged tables — account/session — so it can't change persistence without dropping all FKs.)
    await sql`alter table "session" drop constraint if exists "session_userId_fkey"`;

    // ── 1. bulk-COPY the real users (the session FK target) — one COPY, scales to millions ──────
    {
      const uw = await sql`
        copy "user" ("id", "name", "email", "emailVerified") from stdin
      `.writable();
      const FLUSH_U = 20_000;
      let ubuf = '';
      for (let k = 0; k < USERS; k++) {
        const id = userIdOf(k);
        ubuf += `${id}\tUser ${k}\t${id}@scale.test\tt\n`; // emailVerified = t (true), email unique via id
        if (k % FLUSH_U === FLUSH_U - 1) {
          if (!uw.write(ubuf)) await once(uw, 'drain');
          ubuf = '';
        }
      }
      if (ubuf.length > 0) uw.write(ubuf);
      uw.end();
      await once(uw, 'finish');
    }
    const [{ count: pgUsers }] = await sql`select count(*)::bigint as count from "user"`;
    assert.equal(Number(pgUsers), USERS, `Postgres must hold exactly ${USERS} users`);

    // ── 2. bulk-COPY 10M real session rows into Postgres ────────────────────────────────────────
    const expiresIso = new Date(Date.now() + 7 * 86_400_000).toISOString(); // +7d, all live
    const nowIso = new Date().toISOString();
    const t0 = performance.now();
    const writable = await sql`
      copy "session" ("id", "expiresAt", "token", "updatedAt", "userId") from stdin
    `.writable();
    const FLUSH = 20_000; // rows per write() chunk
    let buf = '';
    for (let i = 0; i < N; i++) {
      // COPY text format: tab-separated, newline-terminated. No value here contains a tab/newline/backslash.
      buf += `s${i}\t${expiresIso}\t${tokenFor(i)}\t${nowIso}\t${userIdFor(i)}\n`;
      if (i % FLUSH === FLUSH - 1) {
        if (!writable.write(buf)) await once(writable, 'drain');
        buf = '';
      }
    }
    if (buf.length > 0) writable.write(buf);
    writable.end();
    await once(writable, 'finish');
    const copyMs = performance.now() - t0;

    // ── 3. assert Postgres truly holds N rows ───────────────────────────────────────────────────
    const [{ count: pgCount }] = await sql`select count(*)::bigint as count from "session"`;
    assert.equal(Number(pgCount), N, `Postgres must hold exactly ${N} session rows`);

    // Re-document the FK (NOT VALID => no 10M-row validation scan; the data is valid by construction).
    await sql`
      alter table "session" add constraint "session_userId_fkey"
        foreign key ("userId") references "user" ("id") on delete cascade not valid
    `;

    // ── 4. stream PG → off-heap engine (load the store FROM the durable truth) ───────────────────
    // Pre-size the slot table for N so the load avoids repeated grow-rebuilds at this scale.
    const store = new OffHeapSessionStore(N * 2); // ceilPow2(2N) slots -> stays under 0.5 load, no rebuild
    const t1 = performance.now();
    for await (const rows of sql`
      select "token", "userId", "expiresAt" from "session"
    `.cursor(50_000)) {
      for (const r of rows) {
        store.set(r.token as string, r.userId as string, +new Date(r.expiresAt as string));
      }
    }
    const loadMs = performance.now() - t1;

    // ── 5. assert the engine holds exactly N live sessions ──────────────────────────────────────
    assert.equal(store.size(), N, `the off-heap store must hold exactly ${N} live sessions`);

    // ── 5b. measure the RAM held PURELY by the off-heap ArrayBuffer storage ──────────────────────
    if (typeof globalThis.gc === 'function') globalThis.gc(); // drop transient cursor buffers first
    const mem = store.memoryBytes();
    const mu = process.memoryUsage();
    const mb = (b: number) => (b / 1024 / 1024).toFixed(1) + ' MB';
    console.log(
      `\n[scale] off-heap STORE footprint for ${store.size().toLocaleString()} sessions:\n` +
        `  total ArrayBuffers   ${mb(mem.total)}  (${(mem.total / store.size()).toFixed(1)} bytes/session)\n` +
        `    hash slots         ${mb(mem.slots)}\n` +
        `    record lanes       ${mb(mem.lanes)}   (expiresAt + token/user offsets + alive)\n` +
        `    token arena        ${mb(mem.tokenArena)}\n` +
        `    userId arena       ${mb(mem.userArena)}\n` +
        `  process.arrayBuffers ${mb(mu.arrayBuffers)}  (Node accounting, all ArrayBuffers)\n` +
        `  process.rss          ${mb(mu.rss)}   heapUsed ${mb(mu.heapUsed)}`,
    );

    // ── 6. cross-verify a deterministic spread of tokens: engine == PG == expected ──────────────
    const expMs = +new Date(expiresIso);
    const SAMPLES = 1000;
    const stride = Math.max(1, Math.floor(N / SAMPLES));
    for (let i = 0; i < N; i += stride) {
      const tok = tokenFor(i);
      const hit = store.get(tok);
      assert.ok(hit !== null, `token for row ${i} must be resident in the engine`);
      assert.equal(hit.userId, userIdFor(i));
      assert.equal(hit.expiresAt, expMs);
      const [pgRow] = await sql`select "userId", "expiresAt" from "session" where "token" = ${tok}`;
      assert.ok(pgRow, `token for row ${i} must exist in Postgres`);
      assert.equal(pgRow.userId, hit.userId, 'engine userId must match the PG row');
      assert.equal(+new Date(pgRow.expiresAt as string), hit.expiresAt, 'engine expiresAt must match PG');
    }

    // a token that was never inserted misses in the engine
    assert.equal(store.get(tokenFor(N + 12345)), null);

    console.log(
      `[scale] ${N.toLocaleString()} sessions across ${USERS.toLocaleString()} users — ` +
        `COPY ${(copyMs / 1000).toFixed(1)}s, PG→engine load ${(loadMs / 1000).toFixed(1)}s, ` +
        `engine size ${store.size().toLocaleString()}`,
    );
  },
);
