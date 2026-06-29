import { createFileRoute, Outlet, redirect } from '@tanstack/react-router';

// Legacy `/articles/$id` (and its `/edit` child) → the generic content manager for `article`.
// The leaf view redirects to the generic view; the `/edit` child has its own redirect, so this
// parent renders an <Outlet/> and only redirects when matched as the leaf (no child active).
export const Route = createFileRoute('/articles/$id')({
  beforeLoad: ({ params, matches }) => {
    const isLeaf = matches[matches.length - 1]?.routeId === '/articles/$id';
    if (isLeaf) {
      throw redirect({
        to: '/content/$name/$id',
        params: { name: 'article', id: params.id },
      });
    }
  },
  component: Outlet,
});
