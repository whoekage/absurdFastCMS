import { defineConfig } from 'tsup';

// Slice 10 — npm-publishable build. The workspace keeps consuming `./src/index.ts`
// (via the `source`/dev export condition); this only produces the artifacts that
// external npm users need: one ESM file. tsup rewrites the internal `.ts` import
// extensions on the way out, so the shipped JS imports nothing but itself.
//
// Declarations are emitted separately by `tsc -p tsconfig.build.json` (the `build:dts`
// script): tsup's bundled-dts worker and a full `tsc` check both hard-fail on two
// pre-existing latent type errors in product source (filters.ts populate-narrowing,
// client.ts exactOptionalPropertyTypes), which are out of scope for a packaging slice
// to rewrite. `tsc --noCheck` emits faithful per-file declarations regardless; a tiny
// post-emit pass rewrites the `.ts` import specifiers `--noCheck` leaves untouched.
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: false,
  clean: true,
  sourcemap: true,
  target: 'es2023',
  treeshake: true,
  // Zero runtime deps — nothing to bundle in; tsup must never pull a dep into dist.
  external: [],
});
