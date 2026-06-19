import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { X, Search, Check } from 'lucide-react';
import type { Entry, QueryParams, RelationId } from '@absurd/sdk';
import { api } from '@/lib/api';
import {
  relatedRowLabel,
  targetLabelField,
  type RelationFieldConfig,
  type RelatedRow,
} from '@/lib/relations';
import { contentKeys } from '@/lib/content-manager';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

// ──────────────────────────────────────────────────────────────────────────────────────────────
// Relation picker.
//
// Searches the TARGET content-type (api.list with a `$containsi` on its label field), shows the
// currently-linked entries, and lets the operator connect/disconnect (to-many) or select-one (to-one).
// It is a CONTROLLED widget over the SELECTED ID SET: the parent owns `value` (an array of related-row
// ids) and gets `onChange(ids)` back. The entry form lowers that id set into the relation-op write body
// (a `{ set }` op) — see lib/relations.ts#buildSetOp.
//
// We display already-linked rows by their full row (label), so on the EDIT form the picker is seeded
// with the populated relation rows; freshly-picked rows come from the search results. We therefore keep
// a small id→row cache so a selected id always has a label to show even after the search box clears.
// ──────────────────────────────────────────────────────────────────────────────────────────────

interface RelationPickerProps {
  id: string;
  config: RelationFieldConfig;
  /** Currently-selected related-row ids (the parent owns this set). */
  value: RelationId[];
  /** Pre-known related rows (e.g. the populated rows from the edit form) used to label selected ids. */
  initialRows?: RelatedRow[];
  onChange: (ids: RelationId[]) => void;
  disabled?: boolean;
}

export function RelationPicker({
  id,
  config,
  value,
  initialRows,
  onChange,
  disabled,
}: RelationPickerProps) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [search, setSearch] = useState('');

  // id → row label cache. Seeded with the initial populated rows; grown as the user picks from results.
  const labelCache = useRef<Map<string, RelatedRow>>(new Map());
  useEffect(() => {
    for (const row of initialRows ?? []) labelCache.current.set(String(row.id), row);
    // Intentionally only seed from initialRows once they arrive; selections add to the same cache.
  }, [initialRows]);

  // Debounce the search box into the query (200ms), mirroring the list SearchBox behavior.
  useEffect(() => {
    const t = setTimeout(() => setSearch(draft.trim()), 200);
    return () => clearTimeout(t);
  }, [draft]);

  // Resolve the target type's definition so we can pick a sensible label/search column.
  const targetDefQuery = useQuery({
    queryKey: contentKeys.definition(config.target),
    queryFn: ({ signal }) => api.contentTypes.get(config.target, signal),
  });

  const labelField = useMemo(
    () => targetLabelField(targetDefQuery.data, config.labelField),
    [targetDefQuery.data, config.labelField],
  );

  // Search the target type. When the label field is `id` we cannot `$containsi` (numeric) — so we list
  // unfiltered and let the operator scan. Otherwise we `$containsi` the label column.
  const searchParams = useMemo<QueryParams>(() => {
    const params: QueryParams = { pagination: { page: 1, pageSize: 20 } };
    if (search !== '' && labelField !== 'id') {
      params.filters = { [labelField]: { $containsi: search } };
    }
    return params;
  }, [search, labelField]);

  const resultsQuery = useQuery({
    queryKey: [...contentKeys.list(config.target, searchParams), 'relation-picker'],
    queryFn: ({ signal }) => api.list(config.target, searchParams, signal),
    enabled: open && targetDefQuery.isSuccess,
  });

  const results: RelatedRow[] = useMemo(() => {
    const rows = resultsQuery.data?.data ?? [];
    return rows.filter((r): r is RelatedRow => isRow(r));
  }, [resultsQuery.data]);

  const selectedSet = useMemo(() => new Set(value.map((v) => String(v))), [value]);

  /** Resolve a label for a selected id from the cache (or a bare `#id` fallback). */
  function labelFor(rowId: RelationId): string {
    const row = labelCache.current.get(String(rowId));
    return row ? relatedRowLabel(row, config.labelField) : `#${String(rowId)}`;
  }

  function pick(row: RelatedRow): void {
    labelCache.current.set(String(row.id), row);
    const rid = Number(row.id) as RelationId;
    if (config.cardinality === 'toOne') {
      onChange([rid]);
      setOpen(false);
      setDraft('');
      return;
    }
    if (selectedSet.has(String(rid))) {
      onChange(value.filter((v) => v !== rid)); // toggle off if already linked
    } else {
      onChange([...value, rid]);
    }
  }

  function remove(rowId: RelationId): void {
    onChange(value.filter((v) => v !== rowId));
  }

  return (
    <div className="space-y-2">
      {/* Currently-linked entries. */}
      {value.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {value.map((rid) => (
            <Badge key={rid} variant="secondary" className="gap-1 pr-1">
              {labelFor(rid)}
              {!disabled && (
                <button
                  type="button"
                  aria-label={`Remove ${labelFor(rid)}`}
                  className="rounded-sm opacity-60 hover:opacity-100"
                  onClick={() => remove(rid)}
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </Badge>
          ))}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">No linked {config.target} entries.</p>
      )}

      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          id={id}
          className={buttonVariants({ variant: 'outline', size: 'sm' })}
          {...(disabled !== undefined ? { disabled } : {})}
        >
          <Search className="h-4 w-4" />
          {config.cardinality === 'toOne'
            ? value.length > 0
              ? `Change ${config.target}`
              : `Select ${config.target}`
            : `Add ${config.target}`}
        </PopoverTrigger>
        <PopoverContent className="w-72">
          <div className="border-b p-2">
            <Input
              autoFocus
              placeholder={
                labelField === 'id' ? `Browse ${config.target}…` : `Search ${labelField}…`
              }
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
            />
          </div>
          <div className="max-h-60 overflow-auto p-1">
            {resultsQuery.isLoading ? (
              <p className="p-2 text-sm text-muted-foreground">Searching…</p>
            ) : resultsQuery.isError ? (
              <p className="p-2 text-sm text-destructive">Could not load {config.target}.</p>
            ) : results.length === 0 ? (
              <p className="p-2 text-sm text-muted-foreground">No matches.</p>
            ) : (
              results.map((row) => {
                const rid = Number(row.id) as RelationId;
                const isSelected = selectedSet.has(String(rid));
                return (
                  <button
                    key={String(row.id)}
                    type="button"
                    className="flex w-full items-center justify-between gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent"
                    onClick={() => pick(row)}
                  >
                    <span className="truncate">
                      {relatedRowLabel(row, config.labelField)}
                      <span className="ml-1.5 text-xs text-muted-foreground">#{String(row.id)}</span>
                    </span>
                    {isSelected && <Check className="h-4 w-4 shrink-0 text-primary" />}
                  </button>
                );
              })
            )}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}

function isRow(v: Entry): v is RelatedRow {
  const idv = (v as { id?: unknown }).id;
  return typeof idv === 'number' || typeof idv === 'string';
}
