import { createRootRoute, Outlet } from '@tanstack/react-router';
import { Sidebar } from '@/components/shell/sidebar';
import { Topbar } from '@/components/shell/topbar';
import { ApiStatusBanner, useSharedApiStatus } from '@/components/shell/api-status';
import { Devtools } from '@/components/shell/devtools';
import {
  RouteErrorComponent,
  RouteNotFoundComponent,
} from '@/components/shell/error-boundary';

export const Route = createRootRoute({
  component: RootLayout,
  errorComponent: RouteErrorComponent,
  notFoundComponent: RouteNotFoundComponent,
});

/**
 * The app shell: a fixed full-height SIDEBAR on the left + a main column (top bar over a scrolling
 * content area) on the right. A single API-health query (`useSharedApiStatus`) feeds both the top-bar
 * status badge and the offline banner. The route's matched component renders into <Outlet />.
 */
function RootLayout() {
  const apiStatus = useSharedApiStatus();

  return (
    <div className="flex h-screen overflow-hidden bg-background text-foreground">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar apiStatus={apiStatus} />
        <ApiStatusBanner status={apiStatus} />
        <main className="min-h-0 flex-1 overflow-auto">
          <div className="container py-6">
            <Outlet />
          </div>
        </main>
      </div>
      <Devtools />
    </div>
  );
}
