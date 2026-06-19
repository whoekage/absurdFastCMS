import { Fragment } from 'react';
import { Link } from '@tanstack/react-router';
import { ChevronRight } from 'lucide-react';
import { useBreadcrumbs } from '@/lib/breadcrumbs';

/**
 * Route-derived breadcrumbs for the top bar (e.g. "Content / article / #3 / Edit"). Every crumb but
 * the last is a navigable link; the last is the current page (plain, aria-current).
 */
export function Breadcrumbs() {
  const crumbs = useBreadcrumbs();
  if (crumbs.length === 0) return null;

  return (
    <nav aria-label="Breadcrumb" className="min-w-0">
      <ol className="flex items-center gap-1 text-sm">
        {crumbs.map((crumb, i) => {
          const isLast = i === crumbs.length - 1;
          return (
            <Fragment key={`${crumb.label}-${i}`}>
              {i > 0 && (
                <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/50" aria-hidden />
              )}
              {isLast || !crumb.to ? (
                <span
                  className="truncate font-medium text-foreground"
                  aria-current={isLast ? 'page' : undefined}
                >
                  {crumb.label}
                </span>
              ) : (
                <Link
                  to={crumb.to}
                  {...(crumb.params ? { params: crumb.params } : {})}
                  className="truncate text-muted-foreground transition-colors hover:text-foreground"
                >
                  {crumb.label}
                </Link>
              )}
            </Fragment>
          );
        })}
      </ol>
    </nav>
  );
}
