import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Sql } from 'postgres';

const { createFileDatabase, dropFileDatabase } = await import('./db-per-file.ts');
const { assembleAuth } = await import('./helpers.ts');
const { closeAuth } = await import('../src/auth/auth.dialect.ts');
const { pwnedBreachCount, pwnedVerdict } = await import('../src/auth/pwned-passwords.ts');

/**
 * HIBP Pwned Passwords — NO MOCKS. The breach-count + verdict are exercised against the REAL HIBP range API
 * (a known-pwned vs a long-random password) and a REAL unreachable host (the fail-open path); the wired
 * better-auth hook is driven through the REAL `auth.handler` over a per-file Postgres. The real-HIBP cases
 * skip gracefully if HIBP is unreachable (no egress) — they are NEVER stubbed.
 */

/** A long, high-entropy password that is (overwhelmingly) absent from the breach corpus. */
const STRONG = 'cw7$Zq9-conti-Px2!nVb6mLk0RtY8';

// ── pure unit: the count → verdict mapping (no network) ───────────────────────────────────────
test('pwnedVerdict maps count → verdict, honoring the threshold and the unavailable (null) case', () => {
  assert.equal(pwnedVerdict(5), 'compromised');
  assert.equal(pwnedVerdict(1), 'compromised');
  assert.equal(pwnedVerdict(0), 'ok');
  assert.equal(pwnedVerdict(null), 'unavailable'); // HIBP gave no answer → caller decides (we fail open)
  assert.equal(pwnedVerdict(3, 10), 'ok'); // below the threshold
  assert.equal(pwnedVerdict(10, 10), 'compromised');
});

// ── real HIBP (no mocks): a known-pwned password vs a strong one ──────────────────────────────
test('pwnedBreachCount: real HIBP — "password" is massively pwned; a long-random one is not', async (t) => {
  const pwned = await pwnedBreachCount('password');
  if (pwned === null) {
    t.skip('HIBP unreachable (no egress) — skipping the real-API assertions');
    return;
  }
  assert.ok(pwned > 1000, `"password" should appear in many breaches (got ${pwned})`);
  assert.equal(await pwnedBreachCount(STRONG), 0, 'a long-random password is not in the corpus');
});

// ── fail-open primitive: an unreachable HIBP endpoint returns null (no mock — a real connect failure) ──
test('pwnedBreachCount: an unreachable HIBP endpoint returns null (the fail-open signal)', async () => {
  const r = await pwnedBreachCount('password', { endpoint: 'http://127.0.0.1:1/range', timeoutMs: 500 });
  assert.equal(r, null);
});

// ── e2e through the wired better-auth handler ─────────────────────────────────────────────────
let sql: Sql;
let db: Awaited<ReturnType<typeof createFileDatabase>>;
before(async () => {
  db = await createFileDatabase('pwned');
  sql = db.sql;
});
after(async () => {
  closeAuth();
  if (sql) await sql.end();
  if (db) await dropFileDatabase(db.name);
});

async function signUp(
  auth: { handler: (req: Request) => Promise<Response> },
  email: string,
  password: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await auth.handler(
    new Request('http://localhost/auth/sign-up/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://localhost' },
      body: JSON.stringify({ email, password, name: 'U' }),
    }),
  );
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

test('e2e: sign-up REJECTS a pwned password (PASSWORD_COMPROMISED) and ACCEPTS a strong one', async (t) => {
  if ((await pwnedBreachCount('password')) === null) {
    t.skip('HIBP unreachable (no egress)');
    return;
  }
  const { auth, sessionCache } = await assembleAuth(sql, 'http://localhost', undefined, { pwnedPasswords: true });
  try {
    const bad = await signUp(auth, `pwned-${Date.now()}@test.local`, 'password');
    assert.equal(bad.status, 400, `pwned password rejected (got ${bad.status} ${JSON.stringify(bad.body)})`);
    assert.equal(bad.body['code'], 'PASSWORD_COMPROMISED');

    const good = await signUp(auth, `ok-${Date.now()}@test.local`, STRONG);
    assert.ok(good.status === 200 || good.status === 201, `strong password accepted (got ${good.status} ${JSON.stringify(good.body)})`);
  } finally {
    sessionCache.stop();
  }
});

test('e2e: FAIL-OPEN — an unreachable HIBP lets even a pwned password through (auth stays up)', async () => {
  const { auth, sessionCache } = await assembleAuth(sql, 'http://localhost', undefined, {
    pwnedPasswords: true,
    pwnedEndpoint: 'http://127.0.0.1:1/range', // refused → the guard can't run → fail open
    pwnedTimeoutMs: 500,
  });
  try {
    const r = await signUp(auth, `failopen-${Date.now()}@test.local`, 'password');
    assert.ok(r.status === 200 || r.status === 201, `fail-open allowed the sign-up (got ${r.status} ${JSON.stringify(r.body)})`);
  } finally {
    sessionCache.stop();
  }
});
