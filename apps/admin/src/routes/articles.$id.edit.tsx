import { createFileRoute, redirect } from '@tanstack/react-router';

// Legacy `/articles/$id/edit` → the generic content manager's edit page for `article`.
export const Route = createFileRoute('/articles/$id/edit')({
  beforeLoad: ({ params }) => {
    throw redirect({
      to: '/content/$name/$id/edit',
      params: { name: 'article', id: params.id },
    });
  },
});
