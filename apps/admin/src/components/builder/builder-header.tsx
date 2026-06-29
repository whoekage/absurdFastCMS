import type { ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { Boxes, ChevronRight, Moon, Sun } from 'lucide-react';
import { useTheme } from '@/lib/theme';

interface BuilderHeaderProps {
  mode: 'create' | 'edit';
  /** Machine name (empty on a brand-new module). */
  name: string;
  label?: string | undefined;
  /** Slot for the Review CTA / undo-redo / switcher (wired in later stages). */
  right?: ReactNode;
}

/** A short mono glyph for the module chip (e.g. "Ar" for "article"). */
function glyphOf(s: string): string {
  const base = s.trim().slice(0, 2) || 'M';
  return base.charAt(0).toUpperCase() + base.slice(1);
}

/**
 * The full-screen builder's own 56px top bar (brand · Modules breadcrumb · module chip+name ·
 * collection-type pill on edit · spacer · theme toggle + `right` slot). Replaces the app sidebar
 * while building. Module-switcher / undo-redo / Review CTA land in the `right` slot in later stages.
 */
export function BuilderHeader({ mode, name, label, right }: BuilderHeaderProps) {
  const { resolvedTheme, setTheme } = useTheme();
  const display = label || name || 'Untitled';
  return (
    <header
      className="flex h-14 flex-shrink-0 items-center gap-3.5 border-b px-[18px]"
      style={{ background: 'color-mix(in srgb, hsl(var(--background)) 86%, transparent)', backdropFilter: 'blur(12px)' }}
    >
      <div
        className="flex h-7 w-7 items-center justify-center rounded-[9px] text-white shadow-card"
        style={{ background: 'linear-gradient(150deg, hsl(var(--primary)), var(--violet))' }}
      >
        <Boxes className="h-4 w-4" />
      </div>

      <Link to="/modules" className="text-[13px] text-muted-foreground transition-colors hover:text-foreground">
        Modules
      </Link>
      <ChevronRight className="h-3.5 w-3.5" style={{ color: 'var(--faint)' }} />

      <div className="flex items-center gap-2">
        <span
          className="flex h-[18px] min-w-[18px] items-center justify-center rounded-md px-1 font-mono text-[10px] font-semibold"
          style={{ background: 'color-mix(in srgb, hsl(var(--primary)) 13%, transparent)', color: 'hsl(var(--primary))' }}
        >
          {glyphOf(name || display)}
        </span>
        <span className="font-display text-[15px] font-semibold">{display}</span>
      </div>

      {mode === 'edit' && (
        <span
          className="rounded-full px-2.5 py-0.5 font-mono text-[11px]"
          style={{ background: 'color-mix(in srgb, hsl(var(--muted)) 70%, transparent)', color: 'var(--mutedfg, hsl(var(--muted-foreground)))' }}
        >
          Collection type
        </span>
      )}

      <div className="flex-1" />

      {right}

      <button
        type="button"
        aria-label="Toggle theme"
        onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}
        className="flex h-[34px] w-[34px] items-center justify-center rounded-lg border text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        {resolvedTheme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
      </button>
    </header>
  );
}
