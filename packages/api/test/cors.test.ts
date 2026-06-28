import { test } from 'node:test';
import assert from 'node:assert/strict';
import type uWS from 'uWebSockets.js';
import {
  buildCorsPolicy,
  corsHeaders,
  preflightHeaders,
  isWriteOriginAllowed,
  captureCors,
  writeCapturedCors,
  type CorsPolicy,
} from '../src/http/cors.ts';
import { normalizeTrustedOrigins } from '../src/compose/config.ts';

/**
 * CORS + cross-origin CSRF policy — pure logic (no server/DB). Verifies the safe-by-default invariants from
 * the vuln-class audit: off when no trusted origins; exact-match ACAO echo (never reflect-arbitrary, never
 * `*`); always `Vary: Origin`; writes gated on an allowlisted Origin (incl. the API's own); no Origin = allow
 * (non-browser). Plus the boot-time validation of the allowlist.
 */

const ADMIN = 'https://admin.example.com';
const API = 'https://example.com';
const EVIL = 'https://evil.example.com.attacker.com';
const policy = buildCorsPolicy([ADMIN], API) as CorsPolicy;

test('buildCorsPolicy: empty allowlist → null (CORS entirely off)', () => {
  assert.equal(buildCorsPolicy([], API), null);
});

test('buildCorsPolicy: read = allowlist, write = allowlist ∪ own origin', () => {
  assert.ok(policy.read.has(ADMIN));
  assert.ok(!policy.read.has(API), 'own origin is NOT auto-readable cross-origin');
  assert.ok(policy.write.has(ADMIN) && policy.write.has(API), 'writes allowed from admin + the API itself');
});

test('corsHeaders: trusted origin → exact ACAO echo + credentials + Vary', () => {
  assert.deepEqual(corsHeaders(policy, ADMIN), {
    'Access-Control-Allow-Origin': ADMIN,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Expose-Headers': 'X-Retry-After',
    Vary: 'Origin',
  });
});

test('corsHeaders: untrusted or missing origin → no grant, still Vary (cache safety)', () => {
  assert.deepEqual(corsHeaders(policy, EVIL), { Vary: 'Origin' });
  assert.deepEqual(corsHeaders(policy, null), { Vary: 'Origin' });
  assert.equal('Access-Control-Allow-Origin' in corsHeaders(policy, EVIL), false);
});

test('preflightHeaders: trusted → allow-set; untrusted → just Vary', () => {
  const ok = preflightHeaders(policy, ADMIN);
  assert.equal(ok['Access-Control-Allow-Origin'], ADMIN);
  assert.match(ok['Access-Control-Allow-Methods'] ?? '', /POST/);
  assert.ok(ok['Access-Control-Allow-Headers'] && ok['Access-Control-Max-Age']);
  assert.deepEqual(preflightHeaders(policy, EVIL), { Vary: 'Origin' });
});

test('isWriteOriginAllowed: own + trusted allowed; untrusted blocked; no-origin allowed', () => {
  assert.equal(isWriteOriginAllowed(policy, ADMIN), true);
  assert.equal(isWriteOriginAllowed(policy, API), true, 'same-origin write (API origin)');
  assert.equal(isWriteOriginAllowed(policy, EVIL), false);
  assert.equal(isWriteOriginAllowed(policy, null), true, 'non-browser request (no Origin) is not a CSRF vector');
});

test('captureCors/writeCapturedCors: stash on the handler, emit in the cork', () => {
  const written: Record<string, string> = {};
  const res = { writeHeader: (k: string, v: string) => (written[k] = v) } as unknown as uWS.HttpResponse;

  captureCors(res, ADMIN, policy);
  writeCapturedCors(res);
  assert.equal(written['Access-Control-Allow-Origin'], ADMIN);
  assert.equal(written['Access-Control-Allow-Credentials'], 'true');

  // policy off → nothing captured, nothing written
  const written2: Record<string, string> = {};
  const res2 = { writeHeader: (k: string, v: string) => (written2[k] = v) } as unknown as uWS.HttpResponse;
  captureCors(res2, ADMIN, null);
  writeCapturedCors(res2);
  assert.deepEqual(written2, {});
});

test('normalizeTrustedOrigins: canonicalizes + dedups', () => {
  assert.deepEqual(normalizeTrustedOrigins(['https://admin.example.com/', 'https://admin.example.com', 'https://a.com:443']), [
    'https://admin.example.com',
    'https://a.com',
  ]);
});

for (const bad of ['admin.example.com', '*', 'https://*.example.com', 'null', 'https://example.com/app', 'ftp://x.com']) {
  test(`normalizeTrustedOrigins: rejects ${JSON.stringify(bad)}`, () => {
    assert.throws(
      () => normalizeTrustedOrigins([bad]),
      (e: unknown) => e instanceof Error && /CONTI_TRUSTED_ORIGINS/.test(e.message),
    );
  });
}
