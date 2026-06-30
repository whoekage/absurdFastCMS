import { useMemo, useRef, useState, useEffect } from 'react';
import { Search } from 'lucide-react';
import {
  BUILDER_TYPE_CATALOG,
  BUILDER_TYPE_GROUP_ORDER,
  type BuilderFieldType,
  TONE_VAR,
  type BuilderTypeEntry,
} from '@/lib/field-types';

interface TypePickerProps {
  /** Pick a (creatable) field type → the builder appends a fresh field and opens its config. */
  onPick: (type: BuilderFieldType) => void;
  /** Dismiss the picker (Esc / the esc button / picking). */
  onClose: () => void;
}

/** Case-insensitive match of a query against a type's name / description / id. */
function matches(t: BuilderTypeEntry, q: string): boolean {
  if (q === '') return true;
  const needle = q.toLowerCase();
  return t.name.toLowerCase().includes(needle) || t.desc.toLowerCase().includes(needle) || t.id.includes(needle);
}

/**
 * The inline field-type gallery (Lua design): a search box (Esc to close) over a grouped, two-column
 * grid of every type — 32px glyph chip + name + one-line description, tinted per group. `soon` types
 * (rich text / blocks) render disabled. Picking a real type calls `onPick`.
 */
export function TypePicker({ onPick, onClose }: TypePickerProps) {
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const groups = useMemo(() => {
    return BUILDER_TYPE_GROUP_ORDER.map((label) => ({
      label,
      types: BUILDER_TYPE_CATALOG.filter((t) => t.group === label && matches(t, query)),
    })).filter((g) => g.types.length > 0);
  }, [query]);

  const noResults = groups.length === 0;

  return (
    <div
      className="overflow-hidden rounded-[13px] border bg-card"
      style={{
        borderColor: 'color-mix(in srgb, hsl(var(--primary)) 34%, transparent)',
        boxShadow: '0 10px 30px color-mix(in srgb, hsl(var(--primary)) 14%, transparent)',
        animation: 'lmbPop .2s cubic-bezier(.2,.7,.3,1)',
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="flex items-center gap-2.5 border-b px-3.5 py-3">
        <Search className="h-4 w-4" style={{ color: 'hsl(var(--muted-foreground))' }} />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search field types…"
          className="flex-1 border-none bg-transparent text-[14.5px] text-foreground outline-none placeholder:text-muted-foreground"
        />
        <button
          type="button"
          onClick={onClose}
          className="flex h-[26px] w-[26px] items-center justify-center rounded-md border-none bg-muted font-mono text-[11px] text-muted-foreground"
        >
          esc
        </button>
      </div>

      <div className="max-h-[340px] overflow-y-auto px-3 pb-3.5 pt-2.5">
        {groups.map((g) => (
          <div key={g.label}>
            <div className="mb-[7px] mt-1.5 px-1 text-[10.5px] font-bold uppercase tracking-[0.07em]" style={{ color: 'var(--faint)' }}>
              {g.label}
            </div>
            <div className="mb-1.5 grid grid-cols-2 gap-[7px]">
              {g.types.map((t) => {
                const tone = TONE_VAR[t.tone];
                return (
                  <button
                    key={t.id}
                    type="button"
                    disabled={t.soon}
                    onClick={() => {
                      if (!t.soon) onPick(t.id as BuilderFieldType);
                    }}
                    className="flex items-center gap-2.5 rounded-[10px] border px-[11px] py-2.5 text-start transition-colors enabled:hover:bg-[var(--fill)] disabled:cursor-not-allowed disabled:opacity-55"
                    style={{ borderColor: 'hsl(var(--border))', background: 'hsl(var(--card))' }}
                  >
                    <span
                      className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-[9px] font-mono text-[13px] font-semibold"
                      style={{ background: `color-mix(in srgb, ${tone} 13%, transparent)`, color: tone }}
                    >
                      {t.glyph}
                    </span>
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="text-[13px] font-semibold text-foreground">{t.name}</span>
                        {t.soon && (
                          <span className="rounded-[4px] border bg-muted px-1.5 py-px text-[8.5px] font-bold uppercase tracking-[0.05em] text-muted-foreground">
                            soon
                          </span>
                        )}
                      </div>
                      <div className="truncate text-[11px] text-muted-foreground">{t.desc}</div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
        {noResults && (
          <div className="p-[26px] text-center text-[13px]" style={{ color: 'var(--faint)' }}>
            No field type matches “{query}”
          </div>
        )}
      </div>
    </div>
  );
}
