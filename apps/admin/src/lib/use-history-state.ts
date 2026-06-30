import { useCallback, useRef, useState } from 'react';

/**
 * A state hook with undo/redo. Backs the module builder's draft so ⌘Z / ⌘⇧Z and the header
 * undo/redo buttons can step through edits. Rapid successive `set`s (e.g. typing a field name)
 * COALESCE into one history entry so undo isn't one-keystroke-at-a-time, and the past stack is
 * capped so a long session can't grow unbounded.
 */
export interface HistoryState<T> {
  state: T;
  /** Apply a new value (or updater). Coalesces with the previous set when they land <COALESCE_MS apart. */
  set: (updater: T | ((prev: T) => T)) => void;
  /** Replace the value and CLEAR history (e.g. load a different module, or Discard all). */
  reset: (next: T) => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
}

interface History<T> {
  past: T[];
  present: T;
  future: T[];
}

const COALESCE_MS = 400;
const MAX_DEPTH = 50;

export function useHistoryState<T>(initial: T): HistoryState<T> {
  const [history, setHistory] = useState<History<T>>({ past: [], present: initial, future: [] });
  // Timestamp of the last committed `set`; -Infinity forces the next set to push a fresh entry.
  const lastSetAt = useRef(Number.NEGATIVE_INFINITY);

  const set = useCallback((updater: T | ((prev: T) => T)) => {
    setHistory((h) => {
      const next = typeof updater === 'function' ? (updater as (prev: T) => T)(h.present) : updater;
      if (Object.is(next, h.present)) return h;
      const now = Date.now();
      const coalesce = now - lastSetAt.current < COALESCE_MS && h.past.length > 0;
      lastSetAt.current = now;
      // Coalesce: keep `present` moving but don't grow `past`. Otherwise snapshot the old present.
      const past = coalesce ? h.past : [...h.past, h.present].slice(-MAX_DEPTH);
      return { past, present: next, future: [] };
    });
  }, []);

  const reset = useCallback((next: T) => {
    lastSetAt.current = Number.NEGATIVE_INFINITY;
    setHistory({ past: [], present: next, future: [] });
  }, []);

  const undo = useCallback(() => {
    lastSetAt.current = Number.NEGATIVE_INFINITY;
    setHistory((h) => {
      if (h.past.length === 0) return h;
      const prev = h.past[h.past.length - 1]!;
      return { past: h.past.slice(0, -1), present: prev, future: [h.present, ...h.future] };
    });
  }, []);

  const redo = useCallback(() => {
    lastSetAt.current = Number.NEGATIVE_INFINITY;
    setHistory((h) => {
      if (h.future.length === 0) return h;
      const next = h.future[0]!;
      return { past: [...h.past, h.present], present: next, future: h.future.slice(1) };
    });
  }, []);

  return {
    state: history.present,
    set,
    reset,
    undo,
    redo,
    canUndo: history.past.length > 0,
    canRedo: history.future.length > 0,
  };
}
