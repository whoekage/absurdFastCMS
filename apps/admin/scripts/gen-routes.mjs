// One-shot TanStack Router route-tree generator (no dev server).
// Mirrors what the vite plugin does on build start, so `tsc --noEmit` sees a current tree.
import { Generator, getConfig } from '@tanstack/router-generator';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const config = getConfig({ target: 'react', autoCodeSplitting: true }, root);
const generator = new Generator({ config, root });
await generator.run();
console.log('routeTree.gen.ts regenerated');
