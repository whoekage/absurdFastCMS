import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import { fileURLToPath, URL } from 'node:url';

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    tanstackRouter({ target: 'react', autoCodeSplitting: true }),
    react(),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
    // Resolve @conti/sdk to its TypeScript source (packages/sdk/src/index.ts) via its
    // "source" export condition — no SDK build step required for dev or prod build.
    conditions: ['source'],
  },
  server: {
    proxy: {
      // The conti dev API serves UNDER /api (createConti sets basePath '/api'), so forward verbatim —
      // do NOT strip the prefix (prod is single-process: the API serves itself at /api and the admin at root).
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
});
