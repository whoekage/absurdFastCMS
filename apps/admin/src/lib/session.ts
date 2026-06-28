import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import {
  getSession,
  getNeedsSetup,
  signOut as apiSignOut,
  SESSION_KEY,
  NEEDS_SETUP_KEY,
  AUTH_CHANNEL,
  type SessionUser,
} from './auth.ts';

/** The single source of truth for "who am I": cached, refetch-free across the app, retry-less (no session = null). */
export function useSession() {
  return useQuery<SessionUser | null>({ queryKey: SESSION_KEY, queryFn: getSession, staleTime: 60_000, retry: false });
}

/** Whether the instance still needs its first admin. Stable for the session (only the first sign-up flips it). */
export function useNeedsSetup() {
  return useQuery<boolean>({ queryKey: NEEDS_SETUP_KEY, queryFn: getNeedsSetup, staleTime: Number.POSITIVE_INFINITY, retry: false });
}

/** Sign out: revoke the session server-side, purge local state, tell other tabs, then go to /sign-in. */
export function useSignOut() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  return async (): Promise<void> => {
    await apiSignOut();
    qc.setQueryData(SESSION_KEY, null);
    try {
      new BroadcastChannel(AUTH_CHANNEL).postMessage('signed-out');
    } catch {
      /* BroadcastChannel unsupported — single-tab logout still works */
    }
    await navigate({ to: '/sign-in' });
  };
}
