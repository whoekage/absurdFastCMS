import { Bell } from 'lucide-react';
import type { ApiStatusResult } from '@/lib/api-status';
import { Breadcrumbs } from '@/components/shell/breadcrumbs';
import { ApiStatusBadge } from '@/components/shell/api-status';
import { ThemeToggle } from '@/components/shell/theme-toggle';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

/**
 * The top bar of the main content area: route-derived breadcrumbs on the left; on the right a latency
 * chip (a REAL measured probe round-trip, see {@link ApiStatusResult.latencyMs}, with a decorative
 * sparkline), a static locale chip, a bell, the folded-in API-status dot, and the theme toggle. The
 * shared {@link ApiStatusResult} is passed in so the chip + status dot + (sibling) banner read one query.
 */
export function Topbar({ apiStatus }: { apiStatus: ApiStatusResult }) {
  return (
    <header className="flex h-14 shrink-0 items-center gap-4 border-b bg-background px-6">
      <Breadcrumbs />
      <div className="ml-auto flex items-center gap-1.5">
        <LatencyChip latencyMs={apiStatus.latencyMs} offline={apiStatus.isOffline} />
        <LocaleChip />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="Notifications">
              <Bell className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Notifications</TooltipContent>
        </Tooltip>
        <ApiStatusBadge status={apiStatus} />
        <ThemeToggle />
      </div>
    </header>
  );
}

/**
 * A latency chip showing the REAL measured round-trip of the last health probe (`latencyMs`) in
 * monospace, preceded by a small DECORATIVE sparkline. The sparkline is a fixed ornamental shape — it is
 * NOT telemetry and carries no data — while the ms value is an honest measurement (or `…`/`offline`).
 */
function LatencyChip({ latencyMs, offline }: { latencyMs: number | null; offline: boolean }) {
  // Fixed decorative spark heights (ornamental, not data).
  const bars = [5, 8, 4, 9, 6, 10, 7];
  const label = offline ? 'offline' : latencyMs === null ? '…' : `${latencyMs}ms`;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="hidden items-center gap-1.5 rounded-md border bg-card px-2 py-1 sm:flex">
          <span className="flex h-3.5 items-end gap-px" aria-hidden>
            {bars.map((h, i) => (
              <span
                key={i}
                className="w-0.5 rounded-sm bg-info/60"
                style={{ height: `${h * 1.4}px` }}
              />
            ))}
          </span>
          <span
            className={cn(
              'font-mono text-[11px] tabular-nums',
              offline ? 'text-destructive' : 'text-muted-foreground',
            )}
          >
            {label}
          </span>
        </span>
      </TooltipTrigger>
      <TooltipContent>
        {offline
          ? 'API unreachable'
          : latencyMs === null
            ? 'Measuring API round-trip…'
            : 'Last API round-trip (measured client-side)'}
      </TooltipContent>
    </Tooltip>
  );
}

/** A static brand locale chip. The admin currently authors against the default locale — clearly not a switcher. */
function LocaleChip() {
  return (
    <span className="hidden items-center rounded-md border bg-card px-2 py-1 font-mono text-[11px] font-medium text-muted-foreground sm:flex">
      EN
    </span>
  );
}
