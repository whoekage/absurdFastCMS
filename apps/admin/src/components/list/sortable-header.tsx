import { ArrowDown, ArrowUp, ChevronsUpDown } from 'lucide-react';
import type { SortDir } from '@/lib/list-filters';

// ──────────────────────────────────────────────────────────────────────────────────────────────
// A clickable column header. Click toggles the column's sort (asc → desc → off); SHIFT-click builds
// a MULTI-KEY sort (append / cycle this key, keeping the others). The active direction renders an
// arrow; a multi-key ordinal badge shows the key's position when more than one column is sorted.
// ──────────────────────────────────────────────────────────────────────────────────────────────

interface SortableHeaderProps {
  label: string;
  dir: SortDir | null;
  /** 1-based position within the multi-key sort (only shown when > 1 keys active). */
  index: number;
  multi: boolean;
  onToggle: (replace: boolean) => void;
}

export function SortableHeader({ label, dir, index, multi, onToggle }: SortableHeaderProps) {
  return (
    <button
      type="button"
      className="-mx-1 inline-flex items-center gap-1 rounded px-1 py-0.5 hover:bg-muted"
      onClick={(e) => onToggle(!e.shiftKey)}
      title="Click to sort · Shift-click to add a sort key"
    >
      <span>{label}</span>
      {dir === 'asc' ? (
        <ArrowUp className="h-3.5 w-3.5" />
      ) : dir === 'desc' ? (
        <ArrowDown className="h-3.5 w-3.5" />
      ) : (
        <ChevronsUpDown className="h-3.5 w-3.5 opacity-40" />
      )}
      {multi && dir ? (
        <span className="rounded bg-muted px-1 text-[10px] font-medium text-muted-foreground">
          {index}
        </span>
      ) : null}
    </button>
  );
}
