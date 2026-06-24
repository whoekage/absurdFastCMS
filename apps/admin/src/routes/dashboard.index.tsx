import { createFileRoute, Link } from '@tanstack/react-router';
import { useQuery, useQueries } from '@tanstack/react-query';
import {
  Boxes,
  FileStack,
  Activity,
  BarChart3,
  ArrowUpRight,
  type LucideIcon,
} from 'lucide-react';
import type { ContentTypeDefinition } from '@conti/sdk';
import { api } from '@/lib/api';
import {
  dashboardKeys,
  errorMessage,
  statCardTypes,
  resumeSourceTypes,
  toRecentEntry,
  mergeRecent,
  relativeTime,
  formatCount,
  titleInitial,
  type RecentEntry,
} from '@/lib/dashboard';
import { Card } from '@/components/ui/card';
import { StatusPill } from '@/components/ui/status-pill';

export const Route = createFileRoute('/dashboard/')({
  component: DashboardPage,
});

/**
 * The Lua DASHBOARD — a light, warm-paper home screen built from REAL SDK data only (no fabricated
 * numbers, no fake history). Stat cards = `api.count()` per type; the resume strip = the globally-newest
 * `updated_at` entries across a few types. The throughput + activity panels have NO backend yet, so they
 * render honest empty states (never a fake chart / feed) while keeping the Lua panel chrome.
 */
function DashboardPage() {
  return (
    <div className="space-y-8">
      <header className="space-y-1">
        <h1 className="font-display text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p className="text-sm text-muted-foreground">
          Your content at a glance — counts, recent edits, and signals.
        </p>
      </header>

      <StatCards />

      <section className="space-y-4">
        <h2 className="font-display text-lg font-semibold tracking-tight">
          Pick up where you left off
        </h2>
        <ResumeStrip />
      </section>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <ThroughputPanel />
        <ActivityPanel />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ stat cards */

/**
 * The 4-card stat row. The 1st card is always the live content-type count (catalog length); the next
 * three are per-type row counts from `api.count()` for the preferred/first types. Real numbers only —
 * loading skeletons, error tile, and a single empty tile when no types exist.
 */
function StatCards() {
  const typesQuery = useQuery({
    queryKey: dashboardKeys.types(),
    queryFn: ({ signal }) => api.contentTypes.list(signal),
  });

  const defs = typesQuery.data ?? [];
  const cardTypes = statCardTypes(defs);

  const counts = useQueries({
    queries: cardTypes.map((apiId) => ({
      queryKey: dashboardKeys.count(apiId),
      queryFn: ({ signal }: { signal: AbortSignal }) => api.count(apiId, undefined, signal),
    })),
  });

  if (typesQuery.isLoading) {
    return (
      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <StatCardSkeleton key={i} />
        ))}
      </div>
    );
  }

  if (typesQuery.isError) {
    return (
      <Card className="shadow-card p-5 text-sm text-destructive" title={errorMessage(typesQuery.error)}>
        Failed to load content types.
      </Card>
    );
  }

  if (defs.length === 0) {
    return (
      <Card className="shadow-card flex items-center justify-between p-5">
        <div>
          <p className="font-display text-lg font-semibold">No content types yet</p>
          <p className="text-sm text-muted-foreground">
            Create your first type to start seeing live counts here.
          </p>
        </div>
        <Link
          to="/content-types/new"
          className="text-sm font-medium text-primary hover:underline"
        >
          New content type
        </Link>
      </Card>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-4">
      <StatCard
        icon={Boxes}
        value={formatCount(defs.length)}
        unit={defs.length === 1 ? 'type' : 'types'}
        label="Content types"
        caption="Defined in the builder"
      />
      {cardTypes.map((apiId, i) => {
        const q = counts[i];
        return (
          <StatCard
            key={apiId}
            icon={FileStack}
            to={apiId}
            value={
              q?.isLoading
                ? null
                : q?.isError
                  ? 'error'
                  : formatCount(q?.data ?? 0)
            }
            errored={q?.isError ?? false}
            errorTitle={q?.isError ? errorMessage(q.error) : undefined}
            unit="entries"
            label={apiId}
            caption="Total entries"
          />
        );
      })}
    </div>
  );
}

interface StatCardProps {
  icon: LucideIcon;
  value: string | null;
  unit: string;
  label: string;
  caption: string;
  to?: string;
  errored?: boolean;
  errorTitle?: string | undefined;
}

function StatCard({ icon: Icon, value, unit, label, caption, to, errored, errorTitle }: StatCardProps) {
  const body = (
    <Card className="shadow-card flex h-full flex-col gap-3 p-5 transition-shadow hover:shadow-pop">
      <div className="flex items-center justify-between">
        <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Icon className="h-5 w-5" />
        </span>
        {to ? <ArrowUpRight className="h-4 w-4 text-muted-foreground" /> : null}
      </div>
      <div>
        <div className="flex items-baseline gap-1.5">
          {value === null ? (
            <span className="inline-block h-8 w-20 animate-pulse rounded bg-muted" />
          ) : errored ? (
            <span className="font-display text-lg font-semibold text-destructive" title={errorTitle}>
              —
            </span>
          ) : (
            <span className="font-display font-mono text-3xl font-semibold tabular-nums tracking-tight">
              {value}
            </span>
          )}
          {value !== null && !errored ? (
            <span className="text-xs text-muted-foreground">{unit}</span>
          ) : null}
        </div>
        <p className="mt-1 truncate text-sm font-medium text-foreground">{label}</p>
        <p className="text-xs text-muted-foreground">{errored ? 'Count unavailable' : caption}</p>
      </div>
    </Card>
  );

  return to ? (
    <Link to="/content/$apiId" params={{ apiId: to }} className="block">
      {body}
    </Link>
  ) : (
    body
  );
}

function StatCardSkeleton() {
  return (
    <Card className="shadow-card flex flex-col gap-3 p-5">
      <span className="h-9 w-9 animate-pulse rounded-lg bg-muted" />
      <div className="space-y-2">
        <span className="block h-8 w-24 animate-pulse rounded bg-muted" />
        <span className="block h-4 w-16 animate-pulse rounded bg-muted" />
      </div>
    </Card>
  );
}

/* --------------------------------------------------------------- resume strip */

/**
 * The "pick up where you left off" strip: real, newest-edited entries merged across a few types. For
 * each source type we fetch its 3 most-recently-updated rows (sort `updated_at:desc`), map them to a
 * flat {@link RecentEntry} (deriving status from `published_at` only on a D&P type), then surface the
 * globally-newest 3 as cards linking to the entry edit route.
 */
function ResumeStrip() {
  const typesQuery = useQuery({
    queryKey: dashboardKeys.types(),
    queryFn: ({ signal }) => api.contentTypes.list(signal),
  });

  const defs = typesQuery.data ?? [];
  const sourceTypes = resumeSourceTypes(defs);
  const defByApiId = new Map<string, ContentTypeDefinition>(defs.map((d) => [d.apiId, d]));

  const recentQueries = useQueries({
    queries: sourceTypes.map((apiId) => ({
      queryKey: dashboardKeys.recent(apiId),
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        api.list(apiId, { sort: ['updated_at:desc'], pagination: { pageSize: 3 } }, signal),
    })),
  });

  if (typesQuery.isLoading || recentQueries.some((q) => q.isLoading)) {
    return (
      <div className="grid grid-cols-1 gap-5 md:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <ResumeCardSkeleton key={i} />
        ))}
      </div>
    );
  }

  if (typesQuery.isError) {
    return (
      <Card className="shadow-card p-5 text-sm text-destructive" title={errorMessage(typesQuery.error)}>
        Failed to load content types.
      </Card>
    );
  }

  const groups: RecentEntry[][] = recentQueries.map((q, i) => {
    const apiId = sourceTypes[i];
    const def = apiId ? defByApiId.get(apiId) : undefined;
    if (!def || !q.data) return [];
    return q.data.data.map((entry) => toRecentEntry(entry, def));
  });

  const recent = mergeRecent(groups, 3);

  if (recent.length === 0) {
    return (
      <Card className="shadow-card flex flex-col items-center justify-center gap-2 p-10 text-center">
        <FileStack className="h-8 w-8 text-muted-foreground" />
        <p className="font-display font-medium">Nothing to resume yet</p>
        <p className="max-w-sm text-sm text-muted-foreground">
          Once you create or edit entries, your most recent work shows up here.
        </p>
      </Card>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-5 md:grid-cols-3">
      {recent.map((entry) => (
        <ResumeCard key={`${entry.apiId}:${entry.id}`} entry={entry} />
      ))}
    </div>
  );
}

function ResumeCard({ entry }: { entry: RecentEntry }) {
  const edited = relativeTime(entry.updatedAt);
  return (
    <Link
      to="/content/$apiId/$id/edit"
      params={{ apiId: entry.apiId, id: entry.id }}
      className="block"
    >
      <Card className="shadow-card flex h-full flex-col gap-3 p-5 transition-shadow hover:shadow-pop">
        <div className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            <FileStack className="h-3.5 w-3.5" />
            {entry.apiId}
          </span>
          {entry.status !== null && <StatusPill status={entry.status} />}
        </div>
        <p className="line-clamp-2 font-semibold leading-snug">{entry.title}</p>
        <div className="mt-auto flex items-center gap-2 pt-1 text-xs text-muted-foreground">
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary/10 text-[10px] font-semibold text-primary">
            {titleInitial(entry.title)}
          </span>
          <span className="font-mono">{edited ? `edited ${edited}` : 'never edited'}</span>
        </div>
      </Card>
    </Link>
  );
}

function ResumeCardSkeleton() {
  return (
    <Card className="shadow-card flex flex-col gap-3 p-5">
      <div className="flex items-center justify-between">
        <span className="h-3.5 w-20 animate-pulse rounded bg-muted" />
        <span className="h-5 w-16 animate-pulse rounded bg-muted" />
      </div>
      <span className="h-5 w-3/4 animate-pulse rounded bg-muted" />
      <span className="h-4 w-1/2 animate-pulse rounded bg-muted" />
    </Card>
  );
}

/* ----------------------------------------------------------------- bottom row */

/**
 * Request-throughput panel. There is NO metrics endpoint on the API, so we render an honest empty state
 * (a decorative baseline, never a fabricated chart) inside the Lua panel chrome. The faint baseline is
 * clearly ornamental — it is not labeled as data and carries no numbers.
 */
function ThroughputPanel() {
  return (
    <Card className="shadow-card flex flex-col p-5 lg:col-span-2">
      <PanelHeading icon={BarChart3} title="Request throughput" />
      <div className="flex flex-1 flex-col items-center justify-center gap-3 py-10 text-center">
        {/* Decorative, non-data flourish: a flat baseline, never labeled as a metric. */}
        <div className="flex h-16 w-full max-w-md items-end gap-1.5 opacity-30" aria-hidden>
          {Array.from({ length: 24 }).map((_, i) => (
            <span key={i} className="flex-1 rounded-sm bg-muted" style={{ height: '4px' }} />
          ))}
        </div>
        <p className="text-sm font-medium text-muted-foreground">
          Request metrics not available yet
        </p>
        <p className="max-w-xs text-xs text-muted-foreground">
          Throughput charts arrive once the API exposes a metrics endpoint.
        </p>
      </div>
    </Card>
  );
}

/**
 * Activity panel. There is NO activity/audit endpoint yet, so this is an honest empty state inside the
 * Lua panel chrome — no fabricated feed.
 */
function ActivityPanel() {
  return (
    <Card className="shadow-card flex flex-col p-5">
      <PanelHeading icon={Activity} title="Activity" />
      <div className="flex flex-1 flex-col items-center justify-center gap-3 py-10 text-center">
        <Activity className="h-7 w-7 text-muted-foreground" aria-hidden />
        <p className="text-sm font-medium text-muted-foreground">No activity to show</p>
        <p className="max-w-xs text-xs text-muted-foreground">
          The activity feed arrives with webhooks &amp; content versioning.
        </p>
      </div>
    </Card>
  );
}

function PanelHeading({ icon: Icon, title }: { icon: LucideIcon; title: string }) {
  return (
    <div className="mb-2 flex items-center gap-2">
      <Icon className="h-4 w-4 text-muted-foreground" />
      <h3 className="font-display text-sm font-semibold tracking-tight">{title}</h3>
    </div>
  );
}
