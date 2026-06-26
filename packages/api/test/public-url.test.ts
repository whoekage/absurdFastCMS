import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePublicUrl } from '../src/compose/config.ts';

/**
 * server.publicUrl (CONTI_PUBLIC_URL) validation — it must be an absolute http(s) ORIGIN, returned in its
 * canonical form. Guards the cross-origin admin against the serverURL footguns other CMSes hit (Payload's
 * doubled-origin #14900 / path-in-serverURL #24): a bad value fails the boot loud instead of silently
 * serving an admin that calls the wrong API. Pure-function test, no server/DB.
 */

test('accepts a bare origin and returns it canonically (trailing slash + default port normalized)', () => {
  assert.equal(normalizePublicUrl('https://example.com'), 'https://example.com');
  assert.equal(normalizePublicUrl('https://example.com/'), 'https://example.com'); // trailing slash dropped
  assert.equal(normalizePublicUrl('https://example.com:443'), 'https://example.com'); // default port dropped
  assert.equal(normalizePublicUrl('https://example.com:8443'), 'https://example.com:8443'); // non-default kept
  assert.equal(normalizePublicUrl('http://localhost:3000'), 'http://localhost:3000');
  assert.equal(normalizePublicUrl('HTTPS://Example.COM'), 'https://example.com'); // scheme/host lowercased
});

for (const [value, why] of [
  ['example.com', 'no protocol → browser treats it as a relative path'],
  ['//example.com', 'protocol-relative is not absolute'],
  ['ftp://example.com', 'wrong protocol'],
  ['https://example.com/cms', 'a path implies sub-path mounting (unsupported)'],
  ['https://example.com/api', 'any path is rejected'],
  ['https://example.com?x=1', 'query string'],
  ['https://example.com#frag', 'fragment'],
  ['https://user:pass@example.com', 'embedded credentials'],
  ['not a url at all', 'unparseable'],
  ['', 'empty'],
] as const) {
  test(`rejects ${JSON.stringify(value)} — ${why}`, () => {
    assert.throws(
      () => normalizePublicUrl(value),
      (e: unknown) => e instanceof Error && /CONTI_PUBLIC_URL/.test(e.message),
      `expected a descriptive throw for ${JSON.stringify(value)}`,
    );
  });
}
