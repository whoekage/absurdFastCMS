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
 *   /content/$apiId/$id/edit  with { apiId: 'article', id: '3' }
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
  const apiId = params.apiId;
  const id = params.id;

  switch (routeId) {
    case '/':
    case '/dashboard/':
      return [{ label: 'Lua' }, { label: 'Dashboard', to: '/dashboard' }];

    // --- Generic content manager (schema-driven) ---
    case '/content/$apiId/':
      return [CONTENT, typeCrumb(apiId)];
    case '/content/$apiId/new':
      return [CONTENT, typeCrumb(apiId), { label: 'New' }];
    case '/content/$apiId/$id':
      return [CONTENT, typeCrumb(apiId), entryCrumb(apiId, id)];
    case '/content/$apiId/$id/edit':
      return [CONTENT, typeCrumb(apiId), entryCrumb(apiId, id), { label: 'Edit' }];

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

function typeCrumb(apiId: string | undefined): Crumb {
  if (!apiId) return { label: 'Content' };
  return { label: apiId, to: '/content/$apiId', params: { apiId } };
}

function entryCrumb(apiId: string | undefined, id: string | undefined): Crumb {
  if (!apiId || !id) return { label: idLabel(id) };
  return { label: idLabel(id), to: '/content/$apiId/$id', params: { apiId, id } };
}

function idLabel(id: string | undefined): string {
  return id ? `#${id}` : 'Entry';
}
