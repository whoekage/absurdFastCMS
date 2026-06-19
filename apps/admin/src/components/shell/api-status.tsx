import { useState } from 'react';
import { AlertTriangle, RefreshCw, Wifi, WifiOff, X } from 'lucide-react';
import { useApiStatus, type ApiStatusResult } from '@/lib/api-status';
import { errorMessage } from '@/lib/errors';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

/**
 * A small status dot for the top bar. Green when the API is reachable, amber while the first probe
 * is in flight, red when it is unreachable. Hover reveals the human-readable state.
 */
export function ApiStatusBadge({ status }: { status: ApiStatusResult }) {
  const { status: state } = status;
  const dot =
    state === 'offline'
      ? 'bg-destructive'
      : state === 'online'
        ? 'bg-emerald-500'
        : 'bg-amber-500 animate-pulse';
  const Icon = state === 'offline' ? WifiOff : Wifi;
  const label =
    state === 'offline' ? 'API offline' : state === 'online' ? 'API connected' : 'Checking API…';

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground">
          <span className={cn('h-2 w-2 rounded-full', dot)} aria-hidden />
          <Icon className="h-3.5 w-3.5" aria-hidden />
          <span className="sr-only">{label}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * A dismissible banner shown ONLY while the API is unreachable. Reappears if the API goes offline
 * again after being dismissed (the dismissal is keyed to the current offline episode via a reset on
 * recovery). Offers a "Retry" that re-runs the health probe immediately.
 */
export function ApiStatusBanner({ status }: { status: ApiStatusResult }) {
  const [dismissed, setDismissed] = useState(false);

  // Recovery re-arms the banner so a later outage shows again.
  if (!status.isOffline && dismissed) setDismissed(false);
  if (!status.isOffline || dismissed) return null;

  return (
    <div
      role="alert"
      className="flex items-center gap-3 border-b border-destructive/40 bg-destructive/10 px-6 py-2 text-sm text-destructive"
    >
      <AlertTriangle className="h-4 w-4 shrink-0" />
      <div className="min-w-0 flex-1">
        <span className="font-medium">Cannot reach the API.</span>{' '}
        <span className="text-destructive/80">
          {status.error ? errorMessage(status.error) : 'The server is unreachable.'} Data may be
          stale.
        </span>
      </div>
      <Button
        variant="outline"
        size="sm"
        className="h-7 border-destructive/40 text-destructive hover:bg-destructive/10"
        onClick={status.refetch}
      >
        <RefreshCw className="h-3.5 w-3.5" />
        Retry
      </Button>
      <button
        type="button"
        aria-label="Dismiss"
        className="rounded-md p-1 text-destructive/70 transition-colors hover:bg-destructive/10 hover:text-destructive"
        onClick={() => setDismissed(true)}
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

/** Convenience: drive both the badge and the banner from one shared health query. */
export function useSharedApiStatus(): ApiStatusResult {
  return useApiStatus();
}
