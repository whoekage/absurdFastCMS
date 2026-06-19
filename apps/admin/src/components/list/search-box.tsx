import { useEffect, useRef, useState } from 'react';
import { Search, X } from 'lucide-react';
import { Input } from '@/components/ui/input';

// ──────────────────────────────────────────────────────────────────────────────────────────────
// A debounced search box. Holds a LOCAL draft so typing is responsive, then commits to the parent
// (→ URL search param `q`) after `delay` ms of quiet. The committed value is mapped to a
// `$containsi` on the type's search field by `buildFilters`. Kept controlled-from-above: when the
// external value changes (e.g. cleared via "Clear filters"), the draft re-syncs.
// ──────────────────────────────────────────────────────────────────────────────────────────────

interface SearchBoxProps {
  /** The committed search value from the URL. */
  value: string;
  /** Commit a (debounced) new value to the URL. */
  onChange: (value: string) => void;
  placeholder?: string;
  delay?: number;
}

export function SearchBox({ value, onChange, placeholder, delay = 300 }: SearchBoxProps) {
  const [draft, setDraft] = useState(value);
  // Track the last value WE committed so an external reset re-syncs the draft, but our own debounced
  // commits don't clobber what the user is mid-typing.
  const lastCommitted = useRef(value);

  // Re-sync the draft when the external value changes for a reason other than our own commit.
  useEffect(() => {
    if (value !== lastCommitted.current) {
      lastCommitted.current = value;
      setDraft(value);
    }
  }, [value]);

  // Debounce the draft → onChange commit.
  useEffect(() => {
    if (draft === lastCommitted.current) return;
    const t = setTimeout(() => {
      lastCommitted.current = draft;
      onChange(draft);
    }, delay);
    return () => clearTimeout(t);
  }, [draft, delay, onChange]);

  return (
    <div className="relative w-72">
      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        className="pl-8 pr-8"
        type="search"
        placeholder={placeholder ?? 'Search…'}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
      />
      {draft !== '' ? (
        <button
          type="button"
          className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
          onClick={() => {
            setDraft('');
            lastCommitted.current = '';
            onChange('');
          }}
          aria-label="Clear search"
        >
          <X className="h-4 w-4" />
        </button>
      ) : null}
    </div>
  );
}
