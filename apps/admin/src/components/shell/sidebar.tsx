import { Link } from '@tanstack/react-router';
import { useQueries, useQuery } from '@tanstack/react-query';
import { Boxes, FileStack, Image, LayoutDashboard, LogOut, Search } from 'lucide-react';
import { api } from '@/lib/api';
import { moduleKeys, errorMessage } from '@/lib/modules';
import { formatCount } from '@/lib/dashboard';
import { useSession, useSignOut } from '@/lib/session';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';

// Nav-item chrome (Lua design): 13.5px medium, 8px-radius, hover paper-fill; ACTIVE = darker text + a
// faint tint + a 3px×17px accent bar bleeding into the 10px nav gutter (-left-2.5). gap 11px, py 8px.
const navItem =
  'group relative flex items-center gap-[11px] rounded-md px-2.5 py-2 text-[13.5px] font-medium text-muted-foreground transition-colors hover:bg-accent ' +
  '[&.active]:bg-primary/[0.08] [&.active]:text-foreground ' +
  '[&.active]:before:absolute [&.active]:before:-left-2.5 [&.active]:before:top-1/2 [&.active]:before:h-[17px] [&.active]:before:w-[3px] [&.active]:before:-translate-y-1/2 [&.active]:before:rounded-r-[3px] [&.active]:before:bg-primary';

// Section caption (COLLECTIONS / SYSTEM): 10.5px bold, wide tracking, faint.
const groupLabel = 'px-2.5 pb-1.5 pt-3.5 text-[10.5px] font-bold uppercase tracking-[0.09em] text-foreground/40';

/** Title-case a module's machine name for display ("blog_post" → "Blog Post"); prefer its label. */
function displayName(label: string | undefined, name: string): string {
  if (label && label.trim()) return label;
  return name
    .split(/[_\-\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/**
 * The persistent Lua left sidebar (258px). Brand (diamond mark + product), a "Search… ⌘K" affordance,
 * a Dashboard link, a COLLECTIONS group listing every module from `api.modules.list()` — each with a
 * REAL right-aligned `api.count()` (subtle skeleton until loaded, never a fabricated number) — a SYSTEM
 * group (Modules / Media Library), and a user footer with a live indicator. Module names render
 * title-cased (or their label). The type list scrolls so a long catalog never pushes SYSTEM off-screen.
 */
export function Sidebar() {
  const typesQuery = useQuery({
    queryKey: moduleKeys.list(),
    queryFn: ({ signal }) => api.modules.list(signal),
  });

  const defs = typesQuery.data ?? [];

  // One REAL row-count per type, under the dashboard count keys so the sidebar shares that cache.
  const counts = useQueries({
    queries: defs.map((def) => ({
      queryKey: ['dashboard', 'count', def.name] as const,
      queryFn: ({ signal }: { signal: AbortSignal }) => api.count(def.name, undefined, signal),
      staleTime: 30_000,
    })),
  });

  return (
    <aside className="flex h-full w-[258px] shrink-0 flex-col border-r bg-background/95 backdrop-blur-xl">
      {/* Brand block */}
      <div className="flex items-center gap-[11px] px-[18px] pb-3.5 pt-1.5">
        <Link
          to="/"
          aria-label="Home"
          className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-[9px]"
          style={{
            backgroundImage: 'linear-gradient(145deg, hsl(var(--primary)), var(--teal))',
            boxShadow: '0 2px 8px color-mix(in srgb, hsl(var(--primary)) 28%, transparent)',
          }}
        >
          <span className="h-[11px] w-[11px] rotate-45 rounded-[3px] bg-white" />
        </Link>
        <div className="min-w-0 leading-[1.1]">
          <Link to="/" className="font-display text-[15px] font-bold tracking-[-0.01em]">
            Lua
          </Link>
          <p className="truncate font-mono text-[10px] tracking-[0.02em] text-muted-foreground">v0.1 · edge</p>
        </div>
      </div>

      {/* Search affordance — styled placeholder (command surface lands in a later phase). */}
      <div className="px-3.5 pb-3 pt-0.5">
        <button
          type="button"
          className="flex w-full items-center gap-[9px] rounded-[9px] border bg-foreground/[0.04] px-[11px] py-2 text-[13px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <Search className="h-3.5 w-3.5 shrink-0" />
          <span className="flex-1 truncate text-start">Search or jump to…</span>
          <kbd className="rounded-[5px] border px-1.5 font-mono text-[11px] text-muted-foreground/70">⌘K</kbd>
        </button>
      </div>

      <nav className="px-2.5">
        <Link to="/dashboard" className={navItem} activeOptions={{ exact: true }}>
          <LayoutDashboard className="h-4 w-4 shrink-0" strokeWidth={1.9} />
          Dashboard
        </Link>
      </nav>

      <div className={groupLabel}>Collections</div>
      <ScrollArea className="min-h-0 flex-1 px-2.5">
        <nav className="space-y-px pb-1">
          {typesQuery.isLoading ? (
            <CollectionsSkeleton />
          ) : typesQuery.isError ? (
            <p className="px-2.5 py-2 text-[13.5px] text-destructive" title={errorMessage(typesQuery.error)}>
              Failed to load types
            </p>
          ) : defs.length === 0 ? (
            <p className="px-2.5 py-2 text-[13.5px] text-muted-foreground">No modules yet.</p>
          ) : (
            defs.map((def, i) => {
              const c = counts[i];
              return (
                <Link key={def.name} to="/content/$name" params={{ name: def.name }} className={navItem}>
                  <FileStack className="h-[18px] w-[18px] shrink-0" strokeWidth={1.9} />
                  <span className="flex-1 truncate">{displayName(def.label, def.name)}</span>
                  <CountChip loading={c?.isLoading ?? true} errored={c?.isError ?? false} value={c?.data} />
                </Link>
              );
            })
          )}
        </nav>
      </ScrollArea>

      <div className={groupLabel}>System</div>
      <nav className="space-y-px px-2.5 pb-2">
        {/* Files-first Module Builder: create/edit/delete types → writes modules/<name>/schema.ts + migrates. */}
        <Link to="/modules" className={navItem}>
          <Boxes className="h-4 w-4 shrink-0" strokeWidth={1.9} />
          Modules
        </Link>
        <Link to="/media" className={navItem} activeOptions={{ exact: true }}>
          <Image className="h-4 w-4 shrink-0" strokeWidth={1.9} />
          Media Library
        </Link>
      </nav>

      <UserFooter />
    </aside>
  );
}

/** The signed-in user (avatar + name + role) with a live indicator, then a full-width sign-out — real session data. */
function UserFooter() {
  const session = useSession();
  const signOut = useSignOut();
  const user = session.data;
  const label = user?.name || user?.email || 'Admin';
  const initial = (user?.name || user?.email || 'A').trim().charAt(0).toUpperCase();
  return (
    <div className="space-y-2 border-t px-3.5 py-3">
      <div className="flex items-center gap-2.5">
        <span
          className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-full text-[12px] font-bold text-white"
          style={{ backgroundImage: 'linear-gradient(135deg, #5b8cff, #b78cff)' }}
        >
          {initial}
        </span>
        <div className="min-w-0 flex-1 leading-tight">
          <p className="truncate text-[13px] font-semibold text-foreground">{label}</p>
          <p className="truncate text-[11px] text-muted-foreground">{roleLabel(user?.role) ?? user?.email ?? ''}</p>
        </div>
        <span className="flex items-center gap-1.5 font-mono text-[10px]" style={{ color: 'var(--success)' }}>
          <span
            className="h-1.5 w-1.5 animate-pulse rounded-full"
            style={{ background: 'var(--success)', boxShadow: '0 0 7px var(--success)' }}
          />
          live
        </span>
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

/** A right-aligned per-type count — faint mono text (no pill), accent when the row is active. Skeleton until loaded. */
function CountChip({ loading, errored, value }: { loading: boolean; errored: boolean; value: number | undefined }) {
  if (loading) {
    return <span className="ml-auto h-4 w-6 shrink-0 animate-pulse rounded bg-muted" aria-hidden />;
  }
  return (
    <span className={cn('ml-auto shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground/55', 'group-[.active]:text-primary')}>
      {errored || value === undefined ? '—' : formatCount(value)}
    </span>
  );
}

function CollectionsSkeleton() {
  return (
    <div className="space-y-px">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="flex items-center gap-[11px] px-2.5 py-2">
          <span className="h-[18px] w-[18px] shrink-0 animate-pulse rounded bg-muted" />
          <span className="h-4 w-24 animate-pulse rounded bg-muted" />
          <span className="ml-auto h-4 w-6 animate-pulse rounded bg-muted" />
        </div>
      ))}
    </div>
  );
}
