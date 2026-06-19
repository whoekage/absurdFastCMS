import { lazy, Suspense } from 'react';

/**
 * DEV-only TanStack devtools. Guarded by `import.meta.env.DEV` so the panels (and their bundles) are
 * tree-shaken out of the production build entirely — the dynamic imports live behind the constant
 * `false` branch in prod, which Vite drops. Both are lazy so they never block first paint in dev.
 */

const ReactQueryDevtools = import.meta.env.DEV
  ? lazy(() =>
      import('@tanstack/react-query-devtools').then((m) => ({ default: m.ReactQueryDevtools })),
    )
  : null;

const RouterDevtools = import.meta.env.DEV
  ? lazy(() =>
      import('@tanstack/react-router-devtools').then((m) => ({ default: m.TanStackRouterDevtools })),
    )
  : null;

export function Devtools() {
  if (!import.meta.env.DEV || !ReactQueryDevtools || !RouterDevtools) return null;
  return (
    <Suspense fallback={null}>
      <ReactQueryDevtools initialIsOpen={false} buttonPosition="bottom-left" />
      <RouterDevtools position="bottom-right" />
    </Suspense>
  );
}
