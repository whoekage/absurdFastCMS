import { useEffect } from 'react';
import { createRootRoute, Outlet, Navigate, useRouterState } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { Sidebar } from '@/components/shell/sidebar';
import { Topbar } from '@/components/shell/topbar';
import { ApiStatusBanner, useSharedApiStatus } from '@/components/shell/api-status';
import { Devtools } from '@/components/shell/devtools';
import {
  RouteErrorComponent,
  RouteNotFoundComponent,
} from '@/components/shell/error-boundary';
import { useSession } from '@/lib/session';
import { SESSION_KEY, AUTH_CHANNEL } from '@/lib/auth';

export const Route = createRootRoute({
  component: RootLayout,
  errorComponent: RouteErrorComponent,
  notFoundComponent: RouteNotFoundComponent,
});

/**
 * The app shell + the AUTH GATE. `/sign-in` renders standalone (no shell, no session needed). Every other
 * route requires a valid session: while it loads we show a spinner; with no session we redirect to /sign-in
 * (preserving the intended path). The gate is driven by the cached `useSession` query, so a 401 anywhere
 * (which purges that query — see lib/api.ts) flips the active tab to the sign-in screen immediately, instead
 * of leaving a stale "logged in" view (the bug Strapi #26163 / Directus #4883 describe). A BroadcastChannel
 * keeps tabs in lock-step: a sign-out/expiry in one tab clears the session in the others.
 */
function RootLayout() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const qc = useQueryClient();
  const session = useSession();

  useEffect(() => {
    let channel: BroadcastChannel | undefined;
    try {
      channel = new BroadcastChannel(AUTH_CHANNEL);
      channel.onmessage = () => qc.setQueryData(SESSION_KEY, null);
    } catch {
      /* BroadcastChannel unsupported — cross-tab sync is a best-effort enhancement */
    }
    return () => channel?.close();
  }, [qc]);

  // Standalone screens render OUTSIDE the gate — bare (no sidebar/topbar), no session required.
  if (pathname === '/sign-in' || pathname === '/auth-gallery') return <Outlet />;

  if (session.isLoading) {
    return (
      <div className="flex h-screen items-center justify-center bg-background text-muted-foreground">
        <Loader2 className="h-6 w-6 animate-spin" aria-label="Loading" />
      </div>
    );
  }
  if (!session.data) return <Navigate to="/sign-in" />;

  // The module BUILDER (/modules/new + /modules/:name) is a full-viewport app with its own header —
  // it renders OUTSIDE the sidebar shell but still INSIDE the auth gate. The list (/modules) stays in
  // the shell. The builder component supplies its own height:100vh layout.
  if (isBuilderRoute(pathname)) return <Outlet />;

  return <AppShell />;
}

/** The full-screen builder routes: create + edit a module. `/modules` (the list) stays in the shell. */
function isBuilderRoute(pathname: string): boolean {
  // Normalize a trailing slash so `/modules/` (the list) isn't mistaken for a builder route.
  const p = pathname !== '/' && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
  return p === '/modules/new' || (p.startsWith('/modules/') && p !== '/modules');
}

function AppShell() {
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
