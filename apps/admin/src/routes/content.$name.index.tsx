import { useEffect, useMemo, useRef, useState } from 'react';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  type ColumnDef,
  type RowSelectionState,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from '@tanstack/react-table';
import { Pencil, Plus, Trash2, Eye, SlidersHorizontal, Rows3, Rows4 } from 'lucide-react';
import { NotFoundError, type Entry, type FieldDefinition } from '@conti/sdk';
import { api } from '@/lib/api';
import { contentKeys, errorMessage, fieldMap, listColumns } from '@/lib/content-manager';
import { formatValue } from '@/lib/field-types';
import {
  asRelatedRows,
  populateFromDef,
  relatedRowLabel,
  relationFieldsFromDef,
  type RelationFieldConfig,
} from '@/lib/relations';
import { mediaPopulateFromDef } from '@/lib/media';
import { useColumnVisibility, useDensity } from '@/lib/table-view';
import {
  EMPTY_LIST_SEARCH,
  PAGE_SIZES,
  listSearchSchema,
  searchField,
  sortDirFor,
  sortIndexFor,
  toQueryParams,
  toggleSort,
  type FilterRow,
  type ListSearch,
  type PageSize,
  type SortKey,
} from '@/lib/list-filters';
import { UnknownType } from '@/components/unknown-type';
import { SearchBox } from '@/components/list/search-box';
import { FilterBar } from '@/components/list/filter-bar';
import { SortableHeader } from '@/components/list/sortable-header';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { StatusPill } from '@/components/ui/status-pill';
import { Checkbox } from '@/components/ui/checkbox';
import { toast } from '@/components/ui/toast';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

export const Route = createFileRoute('/content/$name/')({
  // All list state (search / filters / sort / page / pageSize) is held in TYPED SEARCH PARAMS so the
  // URL is shareable and back/forward navigates between states. View prefs (column visibility /
  // density) and ephemeral row selection are NOT in the URL — they live in localStorage / component
  // state respectively. `.catch(...)` defaults in the schema keep a malformed URL from throwing.
  validateSearch: listSearchSchema,
  component: EntryListPage,
});

/** A non-data column id reserved for the row-selection checkbox column. */
const SELECT_COLUMN_ID = '__select__';

function EntryListPage() {
  const { name } = Route.useParams();
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const queryClient = useQueryClient();

  // Single-row delete target (the per-row trash button still works alongside bulk delete).
  const [deleteTarget, setDeleteTarget] = useState<Entry | null>(null);
  // Bulk-delete confirmation flag — the actual ids come from the live rowSelection state.
  const [confirmBulk, setConfirmBulk] = useState(false);
  const [bulkPending, setBulkPending] = useState(false);

  // View prefs persisted per type (localStorage keyed by name). Row selection is intentionally
  // ephemeral (cleared on delete / page change / unmount).
  const [columnVisibility, setColumnVisibility] = useColumnVisibility(name);
  const [density, setDensity] = useDensity(name);
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  // Draft & Publish status filter (D&P types only). 'draft' is the admin default so newly-created
  // drafts are immediately visible to publish; 'published' switches to the live view.
  const [statusFilter, setStatusFilter] = useState<'draft' | 'published'>('draft');
  // i18n locale filter (i18n types only). '*' (all variants) is the admin default so EVERY locale is
  // listed; a slug narrows to one locale. Sent verbatim to the SDK `locale` param.
  const [localeFilter, setLocaleFilter] = useState<string>('*');

  // Row selection is scoped to the exact result set: when ANYTHING that changes which rows are shown
  // changes — the module (the route reuses this component instance, so name can change without
  // a remount), the page, OR the query (q/filters/sort/pageSize, which can mutate the result set while
  // staying on page 1) — drop selection. Otherwise stale ids leak: getRowId uses the per-type public
  // id, so ids collide across types/filters and a row could render pre-selected against the wrong set.
  // Tracked via a ref so the effect only fires on an actual transition (not initial mount).
  const selectionScope = `${name}|${JSON.stringify(search)}`;
  const lastSelectionScope = useRef(selectionScope);
  useEffect(() => {
    if (lastSelectionScope.current !== selectionScope) {
      lastSelectionScope.current = selectionScope;
      setRowSelection({});
    }
  }, [selectionScope]);

  /** Patch the URL search params. Any change that affects the result set resets `page` to 1. */
  const setSearch = (patch: Partial<ListSearch>, resetPage = true) => {
    void navigate({
      search: (prev) => ({ ...prev, ...patch, ...(resetPage ? { page: 1 } : {}) }),
    });
  };

  const defQuery = useQuery({
    queryKey: contentKeys.definition(name),
    queryFn: ({ signal }) => api.modules.get(name, signal),
    retry: (count, err) => !(err instanceof NotFoundError) && count < 3,
  });

  const def = defQuery.data;
  // Relations + the populate spec are discovered from the API-projected definition (def.relations).
  const relationByField = useMemo(
    () => new Map(relationFieldsFromDef(def).map((r) => [r.field, r])),
    [def],
  );
  // Populate folds relation names AND media-field names so list cells show linked rows + asset thumbnails.
  const populateNames = [...(populateFromDef(def) ?? []), ...mediaPopulateFromDef(def)];
  const populate = populateNames.length > 0 ? populateNames : undefined;
  const byName = def ? fieldMap(def) : new Map<string, FieldDefinition>();
  // The SDK query params derived from the URL state — also the basis of the query key. Populate the
  // configured relations so list cells can show the linked rows.
  const isDraftPublish = def?.draftPublish === true;
  const isI18n = def?.i18n === true;
  const queryParams = def
    ? {
        ...toQueryParams(search, def, byName),
        ...(populate ? { populate } : {}),
        ...(isDraftPublish ? { status: statusFilter } : {}),
        ...(isI18n ? { locale: localeFilter } : {}),
      }
    : null;

  const listQuery = useQuery({
    queryKey: contentKeys.list(name, queryParams),
    queryFn: ({ signal }) => api.list(name, queryParams ?? {}, signal),
    placeholderData: keepPreviousData,
    enabled: defQuery.isSuccess && queryParams !== null,
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number | string) => api.delete(name, id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: contentKeys.all(name) });
      toast.success(`Entry deleted`);
      setDeleteTarget(null);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const dataColumns = def ? listColumns(def) : [];
  // Append the configured relation fields as extra (non-sortable) columns after the scalar columns.
  const relationColumns = useMemo(() => relationByField, [relationByField]);
  const rows = useMemo(() => listQuery.data?.data ?? [], [listQuery.data]);

  // i18n: accumulate the locales seen across loads so narrowing to one locale doesn't drop the others
  // from the switcher. Seeded from whatever the current page returned (the default `*` shows all).
  const [seenLocales, setSeenLocales] = useState<string[]>([]);
  useEffect(() => {
    if (!isI18n) return;
    const present = new Set(seenLocales);
    let changed = false;
    for (const r of rows) {
      const loc = r['locale'];
      if (typeof loc === 'string' && !present.has(loc)) {
        present.add(loc);
        changed = true;
      }
    }
    if (changed) setSeenLocales([...present].sort());
  }, [rows, isI18n, seenLocales]);

  // Build the TanStack column model: a leading selection column, the data columns, and a trailing
  // actions column. Header labels for data columns render the existing URL-driven SortableHeader so
  // server-side sorting is preserved; TanStack Table only manages selection + column visibility here.
  const columns = useMemo<ColumnDef<Entry>[]>(() => {
    const select: ColumnDef<Entry> = {
      id: SELECT_COLUMN_ID,
      enableHiding: false,
      header: ({ table }) => (
        <Checkbox
          aria-label="Select all rows on this page"
          checked={
            table.getIsAllPageRowsSelected()
              ? true
              : table.getIsSomePageRowsSelected()
                ? 'indeterminate'
                : false
          }
          onCheckedChange={(v) => table.toggleAllPageRowsSelected(v)}
        />
      ),
      cell: ({ row }) => (
        <Checkbox
          aria-label={`Select row ${String(row.original.id)}`}
          checked={row.getIsSelected()}
          onCheckedChange={(v) => row.toggleSelected(v)}
        />
      ),
    };

    const data: ColumnDef<Entry>[] = dataColumns.map((col) => ({
      id: col,
      accessorFn: (r) => r[col],
      header: () => (
        <SortableHeader
          label={col}
          dir={sortDirFor(search, col)}
          index={sortIndexFor(search, col)}
          multi={search.sort.length > 1}
          onToggle={(replace) =>
            setSearch({ sort: toggleSort(search.sort as SortKey[], col, replace) })
          }
        />
      ),
      cell: ({ row }) => <ListCell column={col} row={row.original} field={byName.get(col)} />,
    }));

    // Relation columns: no server-side sort (relations aren't scalar columns); render linked rows.
    const relationCols: ColumnDef<Entry>[] = [...relationColumns.values()].map((rel) => ({
      id: `rel:${rel.field}`,
      header: () => <span className="text-sm font-medium">{rel.field}</span>,
      cell: ({ row }) => <RelationCell value={row.original[rel.field]} config={rel} />,
    }));

    // D&P lifecycle column (D&P types only): a Lua status pill derived from the row's published_at.
    const statusCol: ColumnDef<Entry>[] = isDraftPublish
      ? [
          {
            id: '__status__',
            enableHiding: false,
            header: () => <span className="text-sm font-medium">status</span>,
            cell: ({ row }) => (
              <StatusPill status={row.original.published_at != null ? 'published' : 'draft'} />
            ),
          },
        ]
      : [];

    const actions: ColumnDef<Entry> = {
      id: '__actions__',
      enableHiding: false,
      header: () => <span className="sr-only">Actions</span>,
      cell: ({ row }) => {
        const id = String(row.original.id);
        return (
          <div className="flex justify-end gap-1">
            <Button asChild variant="ghost" size="icon" title="View">
              <Link to="/content/$name/$id" params={{ name, id }}>
                <Eye className="h-4 w-4" />
              </Link>
            </Button>
            <Button asChild variant="ghost" size="icon" title="Edit">
              <Link to="/content/$name/$id/edit" params={{ name, id }}>
                <Pencil className="h-4 w-4" />
              </Link>
            </Button>
            <Button
              variant="ghost"
              size="icon"
              title="Delete"
              onClick={() => setDeleteTarget(row.original)}
            >
              <Trash2 className="h-4 w-4 text-destructive" />
            </Button>
          </div>
        );
      },
    };

    return [select, ...data, ...relationCols, ...statusCol, actions];
    // `search` drives header sort indicators; `byName`/`dataColumns` derive from the loaded def.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataColumns, byName, relationColumns, search, name, isDraftPublish]);

  const table = useReactTable({
    data: rows,
    columns,
    state: { rowSelection, columnVisibility },
    // Use the public id as the stable row id so selection survives reordering / page refetches.
    getRowId: (row) => String(row.id),
    enableRowSelection: true,
    onRowSelectionChange: setRowSelection,
    onColumnVisibilityChange: setColumnVisibility,
    getCoreRowModel: getCoreRowModel(),
  });

  // Unknown module → friendly 404-ish state.
  if (defQuery.error instanceof NotFoundError) {
    return <UnknownType name={name} />;
  }

  if (defQuery.isLoading) {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }

  if (defQuery.isError || !def) {
    return (
      <div className="rounded-md border border-destructive/40 bg-destructive/5 p-6 text-sm">
        <p className="font-medium text-destructive">Could not load this module</p>
        <p className="mt-1 text-muted-foreground">{errorMessage(defQuery.error)}</p>
        <Button className="mt-3" variant="outline" size="sm" onClick={() => defQuery.refetch()}>
          Retry
        </Button>
      </div>
    );
  }

  const sf = searchField(def);
  const selectedIds = Object.keys(rowSelection).filter((id) => rowSelection[id]);
  const selectedCount = selectedIds.length;
  const colCount = table.getVisibleLeafColumns().length;
  const cellPad = density === 'compact' ? 'py-1' : 'py-2.5';

  const meta = listQuery.data?.meta.pagination;
  const total = meta && 'total' in meta ? meta.total : undefined;
  const pageCount = meta && 'pageCount' in meta ? meta.pageCount : undefined;

  const hasActiveState =
    search.q !== '' || search.filters.length > 0 || search.sort.length > 0 || search.page > 1;

  // Bulk delete: fire one api.delete per selected id, tolerate partial failures, then invalidate the
  // list, toast a summary, and reconcile selection. Promise.allSettled keeps one failure from
  // aborting the rest. The results array is index-aligned with selectedIds, so we can recover exactly
  // which ids failed: those rows stay selected (so the operator can retry) and are named in the toast,
  // while successfully-deleted rows are dropped from the selection.
  async function runBulkDelete() {
    setBulkPending(true);
    const results = await Promise.allSettled(selectedIds.map((id) => api.delete(name, id)));
    const failedIds = selectedIds.filter((_, i) => results[i]?.status === 'rejected');
    const failed = failedIds.length;
    const ok = results.length - failed;

    await queryClient.invalidateQueries({ queryKey: contentKeys.all(name) });
    // Keep only the failed rows selected so the operator can immediately retry the exact set.
    setRowSelection(Object.fromEntries(failedIds.map((id) => [id, true])));
    setConfirmBulk(false);
    setBulkPending(false);

    if (failed === 0) {
      toast.success(`Deleted ${ok} entr${ok === 1 ? 'y' : 'ies'}`);
    } else {
      const idList = failedIds.join(', ');
      const lead =
        ok === 0
          ? `Failed to delete ${failed} entr${failed === 1 ? 'y' : 'ies'}`
          : `Deleted ${ok}, but ${failed} failed`;
      // Name the failed ids so the operator knows what to retry; the rows also stay selected.
      toast.error(`${lead}: ${idList}`);
    }
  }

  return (
    <section className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-display text-2xl font-semibold tracking-tight">{def?.label || name}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {total !== undefined ? (
              <>
                <span className="font-mono">{total}</span> entr{total === 1 ? 'y' : 'ies'}
              </>
            ) : (
              `Manage ${name} entries`
            )}
          </p>
        </div>
        <Button asChild>
          <Link to="/content/$name/new" params={{ name }}>
            <Plus className="h-4 w-4" />
            New entry
          </Link>
        </Button>
      </div>

      {/* Toolbar: search box + view controls (columns / density) + page-size + reset. */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          {sf ? (
            <SearchBox
              value={search.q}
              onChange={(q) => setSearch({ q })}
              placeholder={`Search ${sf.name}…`}
            />
          ) : null}
          {hasActiveState ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                void navigate({ search: () => ({ ...EMPTY_LIST_SEARCH, pageSize: search.pageSize }) })
              }
            >
              Reset
            </Button>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          {/* Draft & Publish status filter (D&P types only). */}
          {isDraftPublish ? (
            <div className="w-32">
              <Select
                value={statusFilter}
                onValueChange={(v) => setStatusFilter(v as 'draft' | 'published')}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="draft">Drafts</SelectItem>
                  <SelectItem value="published">Published</SelectItem>
                </SelectContent>
              </Select>
            </div>
          ) : null}

          {/* i18n locale filter (i18n types only). '*' = all variants. */}
          {isI18n ? (
            <div className="w-32">
              <Select value={localeFilter} onValueChange={(v) => setLocaleFilter(v)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="*">All locales</SelectItem>
                  {seenLocales.map((loc) => (
                    <SelectItem key={loc} value={loc}>
                      {loc}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}

          {/* Density toggle (comfortable/compact). */}
          <Button
            variant="outline"
            size="sm"
            title={density === 'compact' ? 'Switch to comfortable rows' : 'Switch to compact rows'}
            onClick={() => setDensity(density === 'compact' ? 'comfortable' : 'compact')}
          >
            {density === 'compact' ? (
              <Rows3 className="h-4 w-4" />
            ) : (
              <Rows4 className="h-4 w-4" />
            )}
            <span className="hidden sm:inline">
              {density === 'compact' ? 'Compact' : 'Comfortable'}
            </span>
          </Button>

          {/* Column-visibility dropdown — toggles persist per type. */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm">
                <SlidersHorizontal className="h-4 w-4" />
                <span className="hidden sm:inline">Columns</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuLabel>Toggle columns</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {table
                .getAllLeafColumns()
                .filter((col) => col.getCanHide())
                .map((col) => (
                  <DropdownMenuCheckboxItem
                    key={col.id}
                    checked={col.getIsVisible()}
                    onCheckedChange={(v) => col.toggleVisibility(v)}
                    onSelect={(e) => e.preventDefault()}
                  >
                    {col.id}
                  </DropdownMenuCheckboxItem>
                ))}
            </DropdownMenuContent>
          </DropdownMenu>

          <span className="text-sm text-muted-foreground">Per page</span>
          <div className="w-24">
            <Select
              value={String(search.pageSize)}
              onValueChange={(v) => setSearch({ pageSize: Number(v) as PageSize })}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PAGE_SIZES.map((n) => (
                  <SelectItem key={n} value={String(n)}>
                    {n}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>

      {/* Filter bar — add/remove rows, operators gated per cmsType. */}
      <FilterBar
        def={def}
        byName={byName}
        rows={search.filters}
        onChange={(rows: FilterRow[]) => setSearch({ filters: rows })}
      />

      {/* Selection action bar — only present when rows are selected. */}
      {selectedCount > 0 ? (
        <div className="flex items-center justify-between rounded-md border bg-muted/40 px-4 py-2 text-sm">
          <span className="font-medium">
            {selectedCount} selected
          </span>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => setRowSelection({})}>
              Clear
            </Button>
            <Button variant="destructive" size="sm" onClick={() => setConfirmBulk(true)}>
              <Trash2 className="h-4 w-4" />
              Delete selected
            </Button>
          </div>
        </div>
      ) : null}

      {listQuery.isError ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-6 text-sm">
          <p className="font-medium text-destructive">Could not load entries</p>
          <p className="mt-1 text-muted-foreground">{errorMessage(listQuery.error)}</p>
          <Button className="mt-3" variant="outline" size="sm" onClick={() => listQuery.refetch()}>
            Retry
          </Button>
        </div>
      ) : (
        <div className="max-h-[70vh] overflow-auto rounded-md border">
          <Table>
            {/* Sticky header so column labels + the select-all box stay visible on long lists. */}
            <TableHeader className="sticky top-0 z-10 bg-background shadow-[inset_0_-1px_0_hsl(var(--border))]">
              {table.getHeaderGroups().map((hg) => (
                <TableRow key={hg.id}>
                  {hg.headers.map((header) => (
                    <TableHead
                      key={header.id}
                      className={header.column.id === '__actions__' ? 'text-right' : undefined}
                    >
                      {header.isPlaceholder
                        ? null
                        : flexRender(header.column.columnDef.header, header.getContext())}
                    </TableHead>
                  ))}
                </TableRow>
              ))}
            </TableHeader>
            <TableBody>
              {listQuery.isLoading ? (
                <TableRow>
                  <TableCell colSpan={colCount} className="py-10 text-center text-muted-foreground">
                    Loading…
                  </TableCell>
                </TableRow>
              ) : rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={colCount} className="py-10 text-center text-muted-foreground">
                    No entries match.
                  </TableCell>
                </TableRow>
              ) : (
                table.getRowModel().rows.map((row) => (
                  <TableRow key={row.id} data-state={row.getIsSelected() ? 'selected' : undefined}>
                    {row.getVisibleCells().map((cell) => (
                      <TableCell
                        key={cell.id}
                        className={
                          cell.column.id === '__actions__' ? `${cellPad} text-right` : cellPad
                        }
                      >
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      )}

      <div className="flex items-center justify-between">
        <span className="text-sm text-muted-foreground">
          Page {search.page}
          {pageCount !== undefined ? ` of ${Math.max(pageCount, 1)}` : ''}
        </span>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={search.page <= 1 || listQuery.isFetching}
            onClick={() => setSearch({ page: Math.max(1, search.page - 1) }, false)}
          >
            Previous
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={
              listQuery.isFetching ||
              (pageCount !== undefined
                ? search.page >= pageCount
                : rows.length < search.pageSize)
            }
            onClick={() => setSearch({ page: search.page + 1 }, false)}
          >
            Next
          </Button>
        </div>
      </div>

      {/* Single-row delete confirm. */}
      <Dialog open={deleteTarget !== null} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete entry</DialogTitle>
            <DialogDescription>
              Delete {name} #{deleteTarget ? String(deleteTarget.id) : ''}? This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeleteTarget(null)}
              disabled={deleteMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={deleteMutation.isPending}
              onClick={() =>
                deleteTarget && deleteMutation.mutate(deleteTarget.id as number | string)
              }
            >
              {deleteMutation.isPending ? 'Deleting…' : 'Delete'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Bulk delete confirm. */}
      <Dialog open={confirmBulk} onOpenChange={(open) => !bulkPending && setConfirmBulk(open)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {selectedCount} selected</DialogTitle>
            <DialogDescription>
              Delete {selectedCount} {name} entr{selectedCount === 1 ? 'y' : 'ies'}? This cannot be
              undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmBulk(false)} disabled={bulkPending}>
              Cancel
            </Button>
            <Button variant="destructive" disabled={bulkPending} onClick={() => void runBulkDelete()}>
              {bulkPending ? 'Deleting…' : `Delete ${selectedCount}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function ListCell({
  column,
  row,
  field,
}: {
  column: string;
  row: Entry;
  field: FieldDefinition | undefined;
}) {
  const value = row[column];

  // Enumeration columns render as badges for at-a-glance scanning.
  if (field?.cmsType === 'enumeration' && typeof value === 'string') {
    return <Badge variant="secondary">{value}</Badge>;
  }

  if (field) return <>{formatValue(value, field)}</>;
  return <>{value === null || value === undefined ? '—' : String(value)}</>;
}

/** A compact list-cell renderer for a populated relation: the linked rows as small badges. */
function RelationCell({ value, config }: { value: unknown; config: RelationFieldConfig }) {
  const rows = asRelatedRows(value);
  if (rows.length === 0) return <span className="text-muted-foreground">—</span>;
  const shown = rows.slice(0, 3);
  const extra = rows.length - shown.length;
  return (
    <div className="flex flex-wrap gap-1">
      {shown.map((r) => (
        <Badge key={String(r.id)} variant="secondary">
          {relatedRowLabel(r, config.labelField)}
        </Badge>
      ))}
      {extra > 0 && <Badge variant="outline">+{extra}</Badge>}
    </div>
  );
}
