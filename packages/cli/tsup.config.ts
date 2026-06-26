import { defineConfig } from 'tsup';

// npm-publishable build of the `conti` bin. The workspace runs `./src/cli.ts` directly (no-build dev);
// this produces `dist/cli.js` that an external install runs, since Node won't type-strip TS under
// node_modules. `@conti/core` stays external (a dependency). esbuild preserves the entry's `#!` shebang at
// the top of the bundle, so `dist/cli.js` is a runnable bin (no manual banner — that would duplicate it).
export default defineConfig({
  entry: ['src/cli.ts'],
  format: ['esm'],
  dts: false,
  clean: true,
  sourcemap: true,
  target: 'es2024',
});
