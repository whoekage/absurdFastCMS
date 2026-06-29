import { useMatches, type LinkProps } from '@tanstack/react-router';

/**
 * A single breadcrumb crumb. `to` + `params` make it a TanStack Router link target; the last crumb
 * (the current page) is rendered as plain text (no link).
 */
export interface Crumb {
  label: string;
  to?: LinkProps['to'];
  params?: Record<string, string>;
}

/**
 * Derive breadcrumbs from the current matched route + its params, e.g.:
 *   /content/$name/$id/edit  with { name: 'article', id: '3' }
 *     -> Content / article / #3 / Edit
 *
 * We read the LEAF match (the most specific route) — its `routeId` selects a builder below and its
 * `params` fill in the dynamic segments. Static-data on routes is intentionally avoided so this stays
 * the single source of truth and survives route-tree regeneration.
 */
export function useBreadcrumbs(): Crumb[] {
  const matches = useMatches();
  const leaf = matches[matches.length - 1];
  if (!leaf) return [];
  const params = leaf.params as Record<string, string | undefined>;
  return crumbsForRoute(leaf.routeId, params);
}

const CONTENT: Crumb = { label: 'Content', to: '/' };
// The Module Builder crumb was removed with the Builder routes (schema is files-first).

/** Map a leaf route id (from routeTree.gen) + its params to an ordered crumb list. */
function crumbsForRoute(routeId: string, params: Record<string, string | undefined>): Crumb[] {
  const name = params.name;
  const id = params.id;

  switch (routeId) {
    case '/':
    case '/dashboard/':
      return [{ label: 'Lua' }, { label: 'Dashboard', to: '/dashboard' }];

    // --- Generic content manager (schema-driven) ---
    case '/content/$name/':
      return [CONTENT, typeCrumb(name)];
    case '/content/$name/new':
      return [CONTENT, typeCrumb(name), { label: 'New' }];
    case '/content/$name/$id':
      return [CONTENT, typeCrumb(name), entryCrumb(name, id)];
    case '/content/$name/$id/edit':
      return [CONTENT, typeCrumb(name), entryCrumb(name, id), { label: 'Edit' }];

    // --- Legacy article routes ---
    case '/articles/':
      return [CONTENT, { label: 'Articles' }];
    case '/articles/new':
      return [CONTENT, { label: 'Articles', to: '/articles' }, { label: 'New' }];
    case '/articles/$id':
      return [CONTENT, { label: 'Articles', to: '/articles' }, { label: idLabel(id) }];
    case '/articles/$id/edit':
      return [
        CONTENT,
        { label: 'Articles', to: '/articles' },
        { label: idLabel(id) },
        { label: 'Edit' },
      ];

    // (The Module Builder routes were removed — schema is files-first.)

    default:
      return [CONTENT];
  }
}

function typeCrumb(name: string | undefined): Crumb {
  if (!name) return { label: 'Content' };
  return { label: name, to: '/content/$name', params: { name } };
}

function entryCrumb(name: string | undefined, id: string | undefined): Crumb {
  if (!name || !id) return { label: idLabel(id) };
  return { label: idLabel(id), to: '/content/$name/$id', params: { name, id } };
}

function idLabel(id: string | undefined): string {
  return id ? `#${id}` : 'Entry';
}
