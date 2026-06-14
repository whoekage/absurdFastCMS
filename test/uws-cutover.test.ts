import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * uWS-MIGRATION SLICE 2 — Hono CUTOVER guard.
 *
 * Doctrine: NO mocks. This walks the REAL `src/` tree on disk and asserts that, after the cutover to
 * uWebSockets.js, NO source file imports or references Hono in any form (`hono`, `@hono/node-server`).
 * uWS is the one and only HTTP server. The router (`uws-router.test.ts`, pure core) and the server
 * (`uws-server.test.ts`, real uWS over a socket) tests remain the source of truth for behavior; this
 * test only pins that the Hono implementation is gone from `src/`.
 *
 * The deleted `slice3-http.test.ts`'s assertions are FULLY PRESERVED:
 *   - list pagination + brute oracle + meta            -> uws-router #1/#1b, uws-server #1
 *   - filter + sort vs oracle                          -> uws-router #2, uws-server #2
 *   - nested $or vs oracle                             -> uws-router #3
 *   - single-item envelope deep-equal                  -> uws-router #4, uws-server #3
 *   - 200 list/single body byte-identical to engine    -> uws-router #1/#4, uws-server #1/#3/#4
 *   - unknown content-type -> 404 + { error }          -> uws-router #5, uws-server #5
 *   - out-of-range / non-int / leading-zero id -> 404  -> uws-router #6, uws-server #6 (+ boundary)
 *   - malformed / unknown-field query -> 400 + { error } -> uws-router #8, uws-server #6
 *   - no-query -> all rows deep-equal                  -> uws-router #10, uws-server #7
 *   - empty result -> []                               -> uws-router #10, uws-server #7
 */

const SRC = fileURLToPath(new URL('../src/', import.meta.url));

/** Recursively collect every `.ts` file path under `dir`. */
async function tsFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const ent of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...(await tsFiles(full)));
    else if (ent.isFile() && ent.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

test('no source file under src/ imports or references Hono after the uWS cutover', async () => {
  const files = await tsFiles(SRC);
  assert.ok(files.length > 0, 'found source files to scan');

  // Any `import ... from '...hono...'` (covers both `hono` and `@hono/node-server`).
  const honoImport = /import[^;]*?from\s*['"][^'"]*hono[^'"]*['"]/;

  const offenders: string[] = [];
  for (const f of files) {
    const text = await readFile(f, 'utf8');
    if (honoImport.test(text) || /\bfrom\s*['"]hono['"]/.test(text)) {
      offenders.push(path.relative(SRC, f));
    }
  }
  assert.deepEqual(offenders, [], `Hono import(s) still present under src/: ${offenders.join(', ')}`);
});
