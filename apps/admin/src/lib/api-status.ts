import { useQuery } from '@tanstack/react-query';
import { ApiError } from '@conti/sdk';
import { api } from '@/lib/api';

/**
 * API connection status, derived from a lightweight health probe.
 *
 * Derivation rule: the SDK throws an {@link ApiError} (with an HTTP `status`) for ANY non-2xx
 * response — which means the server ANSWERED, i.e. it is reachable. A thrown value that is NOT an
 * `ApiError` (a rejected `fetch`: DNS failure, connection refused, CORS, timeout-abort) means the
 * transport failed and the API is unreachable. So:
 *   - probe resolves            -> 'online'
 *   - probe throws ApiError     -> 'online'  (server reachable, just returned an error status)
 *   - probe throws anything else-> 'offline' (network/transport error)
 *
 * The probe itself is the cheapest reachable GET the SDK offers: `modules.list()`. The admin
 * already calls it for the sidebar, so this adds no new endpoint and reuses the same query-cache
 * semantics. We do NOT need its data here — only whether the request reached the server.
 */
export type ApiStatus = 'online' | 'offline' | 'checking';

/** Is a thrown value a transport/network failure (as opposed to a server HTTP error)? */
function isNetworkError(err: unknown): boolean {
  return err != null && !(err instanceof ApiError);
}

const apiHealthKey = ['api-health'] as const;

const HEALTH_REFETCH_MS = 30_000;

export interface ApiStatusResult {
  status: ApiStatus;
  /** True only when we have positively determined the API is unreachable. */
  isOffline: boolean;
  /** The transport error that made us offline, if any (never an ApiError). */
  error: unknown;
  /**
   * The REAL wall-clock duration (ms) of the most recent health probe, measured client-side around the
   * `fetch`. `null` until the first probe resolves, or while offline (no meaningful timing). This is an
   * honest measured value — NOT a fabricated live telemetry stream.
   */
  latencyMs: number | null;
  /** Imperatively re-run the probe (used by the banner's "Retry" action). */
  refetch: () => void;
}

/**
 * Poll the API health probe and reduce it to a connection status. Retries are disabled for the
 * probe so a network failure surfaces immediately (rather than after the global retry budget),
 * and it refetches on an interval + on window focus + on reconnect so recovery is detected.
 */
export function useApiStatus(): ApiStatusResult {
  const query = useQuery({
    queryKey: apiHealthKey,
    queryFn: async ({ signal }) => {
      // We only care that the request reaches the server; the payload is irrelevant. We time the probe
      // around the fetch so the top bar can show a REAL measured round-trip (never a fabricated number).
      const started = performance.now();
      await api.modules.list(signal);
      return { latencyMs: Math.round(performance.now() - started) };
    },
    retry: false,
    refetchInterval: HEALTH_REFETCH_MS,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    staleTime: 0,
    gcTime: HEALTH_REFETCH_MS,
  });

  // A request that failed with an ApiError still proves the server is reachable -> treat as online.
  const offline = query.isError && isNetworkError(query.error);

  let status: ApiStatus;
  if (offline) status = 'offline';
  else if (query.isSuccess || (query.isError && !offline)) status = 'online';
  else status = 'checking';

  return {
    status,
    isOffline: offline,
    error: offline ? query.error : null,
    latencyMs: offline ? null : (query.data?.latencyMs ?? null),
    refetch: () => void query.refetch(),
  };
}
