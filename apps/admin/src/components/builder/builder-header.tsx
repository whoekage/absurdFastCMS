import type { ReactNode } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Boxes, ChevronRight, ChevronDown, Moon, Sun, Plus, Check } from 'lucide-react';
import { useTheme } from '@/lib/theme';
import { listModules } from '@/lib/builder-client';
import { builderKeys } from '@/lib/module-draft';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';

interface BuilderHeaderProps {
  mode: 'create' | 'edit';
  /** Machine name (empty on a brand-new module). */
  name: string;
  label?: string | undefined;
  /** Slot for the Review CTA / undo-redo (wired in later stages). */
  right?: ReactNode;
}

/** A short mono glyph for the module chip (e.g. "Ar" for "article"). */
function glyphOf(s: string): string {
  const base = s.trim().slice(0, 2) || 'M';
  return base.charAt(0).toUpperCase() + base.slice(1);
}

/**
 * The full-screen builder's 56px top bar (brand · Modules breadcrumb · a module-SWITCHER dropdown ·
 * collection-type pill on edit · spacer · `right` slot · theme toggle). The switcher lists every module
 * (alpha-sorted, deterministic) + "New module"; navigation rides the router so the editor's
 * unsaved-changes blocker intercepts it. Replaces the app sidebar while building.
 */
export function BuilderHeader({ mode, name, label, right }: BuilderHeaderProps) {
  const { resolvedTheme, setTheme } = useTheme();
  const navigate = useNavigate();
  const display = label || name || 'Untitled';
  const query = useQuery({ queryKey: builderKeys.list(), queryFn: ({ signal }) => listModules(signal) });
  const modules = [...(query.data?.schemas ?? [])].sort((a, b) => (a.label ?? a.name).localeCompare(b.label ?? b.name));

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

      {/* module switcher */}
      <DropdownMenu>
        <DropdownMenuTrigger className="flex items-center gap-2 rounded-lg px-1.5 py-1 outline-none transition-colors hover:bg-accent">
          <span
            className="flex h-[18px] min-w-[18px] items-center justify-center rounded-md px-1 font-mono text-[10px] font-semibold"
            style={{ background: 'color-mix(in srgb, hsl(var(--primary)) 13%, transparent)', color: 'hsl(var(--primary))' }}
          >
            {glyphOf(name || display)}
          </span>
          <span className="font-display text-[15px] font-semibold">{display}</span>
          <ChevronDown className="h-3.5 w-3.5" style={{ color: 'var(--faint)' }} />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-[220px]">
          {modules.map((m) => (
            <DropdownMenuItem
              key={m.name}
              onSelect={() => void navigate({ to: '/modules/$name', params: { name: m.name } })}
              className="flex items-center gap-2"
            >
              <span
                className="flex h-[18px] min-w-[18px] items-center justify-center rounded-md px-1 font-mono text-[10px] font-semibold"
                style={{ background: 'color-mix(in srgb, hsl(var(--primary)) 13%, transparent)', color: 'hsl(var(--primary))' }}
              >
                {glyphOf(m.name)}
              </span>
              <span className="flex-1 truncate">{m.label ?? m.name}</span>
              {m.name === name && <Check className="h-3.5 w-3.5 text-primary" />}
            </DropdownMenuItem>
          ))}
          {modules.length > 0 && <DropdownMenuSeparator />}
          <DropdownMenuItem onSelect={() => void navigate({ to: '/modules/new' })} className="flex items-center gap-2 text-primary">
            <Plus className="h-3.5 w-3.5" />
            New module
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {mode === 'edit' && (
        <span
          className="rounded-full px-2.5 py-0.5 font-mono text-[11px]"
          style={{ background: 'color-mix(in srgb, hsl(var(--muted)) 70%, transparent)', color: 'hsl(var(--muted-foreground))' }}
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
