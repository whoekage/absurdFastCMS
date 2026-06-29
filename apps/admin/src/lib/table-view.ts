import * as React from 'react';
import type { VisibilityState } from '@tanstack/react-table';

// ──────────────────────────────────────────────────────────────────────────────────────────────
// Per-type persistence of TABLE VIEW preferences (column visibility + density). Unlike list state
// (filters/sort/page) — which lives in the shareable URL — these are *operator preferences* about
// how the table is rendered, so they belong in localStorage, scoped per module `name`. A
// hand-edited / corrupt blob is tolerated: parsing falls back to the supplied default.
// ──────────────────────────────────────────────────────────────────────────────────────────────

export type Density = 'comfortable' | 'compact';

const VISIBILITY_PREFIX = 'absurd.admin.colvis.';
const DENSITY_PREFIX = 'absurd.admin.density.';

function readJSON<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined') return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeJSON(key: string, value: unknown): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Quota / privacy-mode failures are non-fatal — the in-memory state still drives the table.
  }
}

/**
 * A localStorage-backed `useState` keyed by `name`. Reads the persisted value lazily on mount and
 * writes back on every change. Keying the initializer + effect on `storageKey` means switching to a
 * different module re-hydrates that type's saved view.
 */
function usePersistentState<T>(storageKey: string, initial: T): [T, React.Dispatch<React.SetStateAction<T>>] {
  const [state, setState] = React.useState<T>(() => readJSON(storageKey, initial));

  // Re-hydrate when the key (name) changes — without this, navigating between types would keep the
  // previous type's view until a manual toggle.
  const lastKey = React.useRef(storageKey);
  if (lastKey.current !== storageKey) {
    lastKey.current = storageKey;
    // Synchronous re-read keeps render output in lockstep with the new key (no flash of old view).
    setState(readJSON(storageKey, initial));
  }

  React.useEffect(() => {
    writeJSON(storageKey, state);
  }, [storageKey, state]);

  return [state, setState];
}

/** Column-visibility map persisted per type. Default = everything visible. */
export function useColumnVisibility(
  name: string,
): [VisibilityState, React.Dispatch<React.SetStateAction<VisibilityState>>] {
  return usePersistentState<VisibilityState>(`${VISIBILITY_PREFIX}${name}`, {});
}

/** Row density persisted per type. Default = comfortable. */
export function useDensity(name: string): [Density, React.Dispatch<React.SetStateAction<Density>>] {
  return usePersistentState<Density>(`${DENSITY_PREFIX}${name}`, 'comfortable');
}
