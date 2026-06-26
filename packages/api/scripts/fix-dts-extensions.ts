// Post-emit declaration fixup. `tsc --noCheck` (used so the dts build is not blocked by the pre-existing
// test-only type errors) skips `rewriteRelativeImportExtensions`, leaving `from './x.ts'` in the emitted
// `.d.ts`. A published `.d.ts` must reference the sibling `.js`/`.d.ts`, so rewrite every relative `.ts`
// specifier to `.js`. Pure string work over the dist tree; no runtime dependency. (Ported from @conti/sdk.)
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const DIST = new URL('../dist/', import.meta.url).pathname;
// Matches `from './foo.ts'` / `import('./bar/baz.ts')` for relative specifiers only.
const RE = /(from\s*|import\(\s*)(['"])(\.[^'"]+)\.ts\2/g;

async function* walk(dir: string): AsyncGenerator<string> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.name.endsWith('.d.ts')) yield p;
  }
}

let changed = 0;
for await (const file of walk(DIST)) {
  const src = await readFile(file, 'utf8');
  const out = src.replace(RE, (_m, kw, q, spec) => `${kw}${q}${spec}.js${q}`);
  if (out !== src) {
    await writeFile(file, out);
    changed++;
  }
}
console.log(`fix-dts-extensions: rewrote ${changed} declaration file(s)`);
