import { defineConfig } from 'tsup';

// npm-publishable build. The WORKSPACE keeps consuming `./src/index.ts` directly (no-build dev); this
// produces the JS that EXTERNAL installs run, because Node refuses to type-strip TypeScript under
// node_modules. Runtime deps (postgres / uWebSockets.js / better-auth / @aws-sdk / …) stay external — only
// @conti/core's own `src` is bundled. Declarations are emitted separately by `tsc --noCheck` (build:dts),
// which tolerates the pre-existing test-only type errors a full check would hard-fail on.
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: false,
  clean: true,
  sourcemap: true,
  target: 'es2024',
  treeshake: true,
});
