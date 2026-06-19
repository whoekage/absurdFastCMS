import type { ApiStatusResult } from '@/lib/api-status';
import { Breadcrumbs } from '@/components/shell/breadcrumbs';
import { ApiStatusBadge } from '@/components/shell/api-status';
import { ThemeToggle } from '@/components/shell/theme-toggle';

/**
 * The top bar of the main content area: route-derived breadcrumbs on the left, the API connection
 * badge + dark-mode toggle on the right. The shared {@link ApiStatusResult} is passed in so the
 * badge and the (sibling) banner read the same health query.
 */
export function Topbar({ apiStatus }: { apiStatus: ApiStatusResult }) {
  return (
    <header className="flex h-14 shrink-0 items-center gap-4 border-b bg-background px-6">
      <Breadcrumbs />
      <div className="ml-auto flex items-center gap-1">
        <ApiStatusBadge status={apiStatus} />
        <ThemeToggle />
      </div>
    </header>
  );
}
