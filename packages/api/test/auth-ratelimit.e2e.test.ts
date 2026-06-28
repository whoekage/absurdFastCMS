import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Sql } from 'postgres';
import { createFileDatabase, dropFileDatabase } from './db-per-file.ts';
import { assembleAuth } from './helpers.ts';
import { closeAuth } from '../src/auth/auth.dialect.ts';

/**
 * Per-IP login rate limiting (better-auth built-in, wired in buildAuth). NO MOCKS — drives the REAL
 * `auth.handler` over a per-file Postgres. The strict rule is 5 / 5 min per client IP on `/sign-in/email`;
 * the 6th attempt from the same IP is 429 + a retry-after cooldown (the "too many attempts" state the UI
 * counts down), while a DIFFERENT IP keeps its own budget — proving the key is per-IP via the
 * bridge-injected `x-conti-client-ip` header (NOT a per-account lockout, which would be a DoS vector).
 */

let sql: Sql;
let db: Awaited<ReturnType<typeof createFileDatabase>>;
let auth: { handler: (req: Request) => Promise<Response> };
let stop: (() => void) | undefined;

before(async () => {
  db = await createFileDatabase('ratelimit');
  sql = db.sql;
  const a = await assembleAuth(sql, 'http://localhost', undefined, { rateLimit: true });
  auth = a.auth;
  stop = () => a.sessionCache.stop();
});
after(async () => {
  stop?.();
  closeAuth();
  if (sql) await sql.end();
  if (db) await dropFileDatabase(db.name);
});

function signIn(ip: string): Promise<Response> {
  return auth.handler(
    new Request('http://localhost/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://localhost', 'x-conti-client-ip': ip },
      body: JSON.stringify({ email: 'nobody@test.local', password: 'wrong-password-9aZ' }),
    }),
  );
}

test('the 6th sign-in from one IP is 429 with a retry-after cooldown', async () => {
  let res: Response | undefined;
  for (let i = 0; i < 6; i++) res = await signIn('203.0.113.5');
  assert.equal(res?.status, 429, 'the 6th attempt is rate-limited');
  const retry = res?.headers.get('x-retry-after') ?? res?.headers.get('retry-after');
  assert.ok(retry && Number(retry) > 0, `a retry-after cooldown header is present (got ${JSON.stringify(retry)})`);
});

test('a different IP is NOT throttled — the limit is per client IP, not per account', async () => {
  const res = await signIn('198.51.100.7');
  assert.notEqual(res.status, 429, 'a fresh IP has its own budget');
});
