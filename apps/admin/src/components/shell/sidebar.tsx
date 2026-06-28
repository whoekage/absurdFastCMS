import { Link } from '@tanstack/react-router';
import { useQueries, useQuery } from '@tanstack/react-query';
import { Boxes, FileStack, Image, LayoutDashboard, LogOut, Search, Sparkles } from 'lucide-react';
import { api } from '@/lib/api';
import { moduleKeys, errorMessage } from '@/lib/modules';
import { formatCount } from '@/lib/dashboard';
import { useSession, useSignOut } from '@/lib/session';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';

// Shared nav-item chrome: a soft indigo-tinted active state with a left accent bar (Lua).
const navItem =
  'group relative flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground ' +
  "[&.active]:bg-primary/10 [&.active]:font-medium [&.active]:text-foreground " +
  "[&.active]:before:absolute [&.active]:before:inset-y-1 [&.active]:before:-left-2 [&.active]:before:w-1 [&.active]:before:rounded-full [&.active]:before:bg-primary";

const groupLabel =
  'px-2.5 pb-1 pt-4 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/70';

/**
 * The persistent Lua left sidebar. A brand block (gradient glyph + product name), a styled
 * "Search or jump to… ⌘K" affordance, a top "Dashboard" link, a COLLECTIONS group listing every
 * module from `api.modules.list()` — each with a REAL right-aligned `api.count()` (a subtle
 * skeleton until it loads, never a fabricated number) — a SYSTEM group (Media Library),
 * and a user footer. The type list lives in a scroll-area so a long catalog never pushes SYSTEM
 * off-screen. The list refetches whenever module introspection invalidates `moduleKeys.all`.
 */
export function Sidebar() {
  const typesQuery = useQuery({
    queryKey: moduleKeys.list(),
    queryFn: ({ signal }) => api.modules.list(signal),
  });

  const defs = typesQuery.data ?? [];

  // One REAL row-count per type. Held under the dashboard count keys so the sidebar shares the
  // dashboard's count cache (no duplicate fetches when both are mounted).
  const counts = useQueries({
    queries: defs.map((def) => ({
      queryKey: ['dashboard', 'count', def.apiId] as const,
      queryFn: ({ signal }: { signal: AbortSignal }) => api.count(def.apiId, undefined, signal),
      staleTime: 30_000,
    })),
  });

  return (
    <aside className="flex h-full w-64 shrink-0 flex-col border-r bg-card">
      {/* Brand block */}
      <div className="flex items-center gap-2.5 px-4 pb-3 pt-4">
        <Link
          to="/"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-primary to-info text-primary-foreground shadow-card"
          aria-label="Home"
        >
          <Sparkles className="h-5 w-5" />
        </Link>
        <div className="min-w-0 leading-tight">
          <Link to="/" className="font-display text-base font-semibold tracking-tight">
            Lua
          </Link>
          <p className="truncate font-mono text-[10px] text-muted-foreground">v0.1 · edge</p>
        </div>
      </div>

      {/* Search affordance — styled placeholder (command surface lands in a later phase). */}
      <div className="px-3 pb-2">
        <button
          type="button"
          className="flex w-full items-center gap-2 rounded-lg border bg-background/60 px-2.5 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent"
        >
          <Search className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">Search or jump to…</span>
          <kbd className="ml-auto rounded border bg-muted px-1.5 font-mono text-[10px] text-muted-foreground">
            ⌘K
          </kbd>
        </button>
      </div>

      <nav className="space-y-0.5 px-3">
        <Link to="/dashboard" className={navItem} activeOptions={{ exact: true }}>
          <LayoutDashboard className="h-4 w-4 shrink-0" />
          Dashboard
        </Link>
      </nav>

      <div className={groupLabel}>Collections</div>
      <ScrollArea className="min-h-0 flex-1 px-3">
        <nav className="space-y-0.5 pb-1">
          {typesQuery.isLoading ? (
            <CollectionsSkeleton />
          ) : typesQuery.isError ? (
            <p
              className="px-2.5 py-1.5 text-sm text-destructive"
              title={errorMessage(typesQuery.error)}
            >
              Failed to load types
            </p>
          ) : defs.length === 0 ? (
            <p className="px-2.5 py-1.5 text-sm text-muted-foreground">No modules yet.</p>
          ) : (
            defs.map((def, i) => {
              const c = counts[i];
              return (
                <Link
                  key={def.apiId}
                  to="/content/$apiId"
                  params={{ apiId: def.apiId }}
                  className={navItem}
                >
                  <FileStack className="h-4 w-4 shrink-0" />
                  <span className="truncate">{def.apiId}</span>
                  <CountChip
                    loading={c?.isLoading ?? true}
                    errored={c?.isError ?? false}
                    value={c?.data}
                  />
                </Link>
              );
            })
          )}
        </nav>
      </ScrollArea>

      <div className={groupLabel}>System</div>
      <nav className="space-y-0.5 px-3 pb-2">
        {/* Files-first Module Builder: create/edit/delete types → writes modules/<apiId>/schema.ts + migrates. */}
        <Link to="/modules" className={navItem}>
          <Boxes className="h-4 w-4 shrink-0" />
          Modules
        </Link>
        <Link to="/media" className={navItem} activeOptions={{ exact: true }}>
          <Image className="h-4 w-4 shrink-0" />
          Media Library
        </Link>
      </nav>

      <UserFooter />
    </aside>
  );
}

/** The signed-in user + the Lua sign-out button (design: tinted #c0561f, full-width) — real session data. */
function UserFooter() {
  const session = useSession();
  const signOut = useSignOut();
  const user = session.data;
  const label = user?.name || user?.email || 'Admin';
  const initial = (user?.name || user?.email || 'A').trim().charAt(0).toUpperCase();
  return (
    <div className="space-y-2 border-t px-3 py-3">
      <div className="flex items-center gap-2.5 px-1">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 font-display text-sm font-semibold text-primary">
          {initial}
        </span>
        <div className="min-w-0 flex-1 leading-tight">
          <p className="truncate text-[13px] font-semibold text-foreground">{label}</p>
          <p className="truncate text-[11px] text-muted-foreground">{roleLabel(user?.role) ?? user?.email ?? ''}</p>
        </div>
      </div>
      <button
        type="button"
        onClick={() => void signOut()}
        className="flex w-full items-center gap-2.5 rounded-[9px] bg-[#c0561f]/[0.08] px-2.5 py-2.5 text-[13px] font-semibold text-[#c0561f] transition-colors hover:bg-[#c0561f]/[0.14] dark:bg-orange-400/10 dark:text-orange-400 dark:hover:bg-orange-400/20"
      >
        <LogOut className="h-4 w-4" />
        Sign out
      </button>
    </div>
  );
}

/** Human-readable role for the sidebar (the super-admin reads as the workspace Owner, matching the design). */
function roleLabel(role?: string | null): string | undefined {
  if (!role) return undefined;
  return role === 'super-admin' ? 'Owner · Super Admin' : role.charAt(0).toUpperCase() + role.slice(1);
}

/** A right-aligned per-type count: a subtle skeleton until loaded, a dash when the count errors. */
function CountChip({
  loading,
  errored,
  value,
}: {
  loading: boolean;
  errored: boolean;
  value: number | undefined;
}) {
  if (loading) {
    return (
      <span className="ml-auto h-4 w-7 shrink-0 animate-pulse rounded bg-muted" aria-hidden />
    );
  }
  return (
    <span
      className={cn(
        'ml-auto shrink-0 rounded-md px-1.5 font-mono text-[11px] tabular-nums',
        'bg-muted text-muted-foreground group-[.active]:bg-primary/15 group-[.active]:text-primary',
      )}
    >
      {errored || value === undefined ? '—' : formatCount(value)}
    </span>
  );
}

function CollectionsSkeleton() {
  return (
    <div className="space-y-0.5">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="flex items-center gap-2.5 px-2.5 py-1.5">
          <span className="h-4 w-4 shrink-0 animate-pulse rounded bg-muted" />
          <span className="h-4 w-24 animate-pulse rounded bg-muted" />
          <span className="ml-auto h-4 w-7 animate-pulse rounded bg-muted" />
        </div>
      ))}
    </div>
  );
}
