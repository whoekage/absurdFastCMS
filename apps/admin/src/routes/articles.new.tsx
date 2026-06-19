import { createFileRoute, redirect } from '@tanstack/react-router';

// Legacy path → the generic content manager's create page for the `article` type.
export const Route = createFileRoute('/articles/new')({
  beforeLoad: () => {
    throw redirect({ to: '/content/$apiId/new', params: { apiId: 'article' } });
  },
});
