import { createFileRoute, redirect } from '@tanstack/react-router';

// Legacy path → the generic content manager for the `article` type (no regression: identical UX).
export const Route = createFileRoute('/articles/')({
  beforeLoad: () => {
    throw redirect({ to: '/content/$apiId', params: { apiId: 'article' } });
  },
});
