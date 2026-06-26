import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { loadAdminBundle } from '../src/http/static.ts';

/**
 * RUNTIME ADMIN CONFIG — the admin bundle is PREBUILT + shipped, so the API location is discovered at
 * SERVE time, not baked at build time. `loadAdminBundle(dir, apiBase)` injects `window.__CONTI__.apiBase`
 * into index.html; without an apiBase (same-origin) the HTML is left byte-for-byte unchanged. Pure-function
 * test over a real on-disk fixture (no mocks, no server, no DB).
 */

function fixtureDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'conti-rtcfg-'));
  writeFileSync(
    path.join(dir, 'index.html'),
    '<!doctype html><html><head><title>admin</title><script type="module" src="/assets/app.js"></script></head><body><div id="root"></div></body></html>',
  );
  mkdirSync(path.join(dir, 'assets'), { recursive: true });
  writeFileSync(path.join(dir, 'assets', 'app.js'), 'export{}');
  return dir;
}

const bodyOf = (b: ReturnType<typeof loadAdminBundle>, key: string): string => b!.get(key)!.body.toString('utf8');

test('same-origin (no apiBase): index.html is served unchanged — no injected config', () => {
  const bundle = loadAdminBundle(fixtureDir());
  assert.ok(bundle);
  assert.doesNotMatch(bodyOf(bundle, '/'), /__CONTI__/);
  assert.doesNotMatch(bodyOf(bundle, '/index.html'), /__CONTI__/);
});

test('cross-origin (apiBase): window.__CONTI__.apiBase is injected into / and /index.html', () => {
  const apiBase = 'https://example.com/api';
  const bundle = loadAdminBundle(fixtureDir(), apiBase);
  assert.ok(bundle);
  for (const key of ['/', '/index.html']) {
    const html = bodyOf(bundle, key);
    assert.match(html, /<script>window\.__CONTI__=\{"apiBase":"https:\/\/example\.com\/api"\};<\/script>/);
    // Injected as a CLASSIC inline script inside <head> (no type=module) — it runs during parse, before the
    // app's deferred module, regardless of textual position. Just assert it lands before </head>.
    assert.ok(html.indexOf('window.__CONTI__') < html.indexOf('</head>'), `${key}: config must precede </head>`);
  }
});

test('the injected apiBase is escaped so it cannot break out of the <script> tag', () => {
  // A pathological value must not terminate the inline tag or inject markup ("<" -> unicode escape).
  const bundle = loadAdminBundle(fixtureDir(), 'https://x/</script><img src=x>');
  const html = bodyOf(bundle, '/');
  assert.doesNotMatch(html, /<\/script><img/, 'no real closing-script + markup breakout');
  assert.doesNotMatch(html, /<img src=x>/, 'the payload must not appear as live markup');
  assert.match(html, /\\u003c\/script>/, 'the "<" in the value is escaped to its unicode form');
});
