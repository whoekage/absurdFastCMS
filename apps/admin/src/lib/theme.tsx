import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

/**
 * Dark-mode mechanism (standard shadcn approach):
 *   - The user picks one of three THEMES: 'light' | 'dark' | 'system'.
 *   - 'system' follows the OS `prefers-color-scheme` media query (and live-updates with it).
 *   - The RESOLVED theme ('light' | 'dark') is applied by toggling the `.dark` class on <html>,
 *     which flips the shadcn CSS variables defined in index.css.
 *   - The chosen theme is persisted to localStorage under {@link THEME_STORAGE_KEY}.
 *   - A tiny inline script in index.html reads the same key and applies `.dark` BEFORE React mounts,
 *     so there is no flash of the wrong theme on first paint (no-FOUC). This provider re-applies the
 *     same logic once React is live, and keeps it in sync on changes / OS theme switches.
 */
export type Theme = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

/** localStorage key — MUST match the bootstrap script in index.html. */
export const THEME_STORAGE_KEY = 'absurd-admin-theme';

const DARK_QUERY = '(prefers-color-scheme: dark)';

function isTheme(value: unknown): value is Theme {
  return value === 'light' || value === 'dark' || value === 'system';
}

/** Read the persisted theme, defaulting to 'system' (and tolerating no/blocked localStorage). */
function readStoredTheme(): Theme {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (isTheme(stored)) return stored;
  } catch {
    /* localStorage unavailable */
  }
  return 'system';
}

/** Does the OS currently prefer dark? (false when matchMedia is unavailable.) */
function systemPrefersDark(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(DARK_QUERY).matches
    : false;
}

/** Resolve a theme choice to the concrete 'light' | 'dark' to render. */
function resolveTheme(theme: Theme): ResolvedTheme {
  if (theme === 'system') return systemPrefersDark() ? 'dark' : 'light';
  return theme;
}

/** Apply (or clear) the `.dark` class on <html> to match the resolved theme. */
function applyResolvedTheme(resolved: ResolvedTheme): void {
  document.documentElement.classList.toggle('dark', resolved === 'dark');
}

interface ThemeContextValue {
  /** The user's choice. */
  theme: Theme;
  /** The concrete theme currently applied to <html>. */
  resolvedTheme: ResolvedTheme;
  /** Set (and persist) the theme choice. */
  setTheme: (theme: Theme) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(readStoredTheme);
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>(() => resolveTheme(theme));

  // Apply the resolved theme to <html> whenever the choice changes.
  useEffect(() => {
    const resolved = resolveTheme(theme);
    setResolvedTheme(resolved);
    applyResolvedTheme(resolved);
  }, [theme]);

  // When following the system, react live to OS theme changes.
  useEffect(() => {
    if (theme !== 'system') return;
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia(DARK_QUERY);
    const onChange = (): void => {
      const resolved: ResolvedTheme = mql.matches ? 'dark' : 'light';
      setResolvedTheme(resolved);
      applyResolvedTheme(resolved);
    };
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [theme]);

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      /* localStorage unavailable — keep the in-memory choice anyway */
    }
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({ theme, resolvedTheme, setTheme }),
    [theme, resolvedTheme, setTheme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within a <ThemeProvider>');
  return ctx;
}
