import { createFileRoute, Link } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, Pencil, Eye, EyeOff } from 'lucide-react';
import { NotFoundError } from '@conti/sdk';
import { api } from '@/lib/api';
import { contentKeys, errorMessage } from '@/lib/content-manager';
import { toast } from '@/components/ui/toast';
import { formatValue } from '@/lib/field-types';
import {
  asRelatedRows,
  populateFromDef,
  relatedRowLabel,
  relationFieldsFromDef,
} from '@/lib/relations';
import { mediaPopulateFromDef } from '@/lib/media';
import { UnknownType } from '@/components/unknown-type';
import { LocaleSwitcher } from '@/components/locale-switcher';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { StatusPill } from '@/components/ui/status-pill';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export const Route = createFileRoute('/content/$name/$id')({
  component: ViewEntryPage,
});

function ViewEntryPage() {
  const { name, id } = Route.useParams();
  const queryClient = useQueryClient();

  const defQuery = useQuery({
    queryKey: contentKeys.definition(name),
    queryFn: ({ signal }) => api.modules.get(name, signal),
    retry: (count, err) => !(err instanceof NotFoundError) && count < 3,
  });

  // Relations discovered from the API-projected definition (def.relations).
  const relationFields = relationFieldsFromDef(defQuery.data);
  const relationByField = new Map(relationFields.map((r) => [r.field, r]));
  // Populate folds relation names AND media-field names so the detail view shows asset thumbnails
  // (formatValue renders a populated media value as a <MediaThumb>).
  const populateNames = [...(populateFromDef(defQuery.data) ?? []), ...mediaPopulateFromDef(defQuery.data)];
  const populate = populateNames.length > 0 ? populateNames : undefined;

  const isDraftPublish = defQuery.data?.draftPublish === true;
  const isI18n = defQuery.data?.i18n === true;

  const detailQuery = useQuery({
    queryKey: [...contentKeys.detail(name, id), { populate, dp: isDraftPublish, i18n: isI18n }],
    queryFn: async ({ signal }) => {
      // For an i18n type the detail is addressed by a physical row id that belongs to SOME locale, so we
      // must NOT constrain to the default locale (which would 404 a non-default variant): locale='*'
      // drops the locale predicate so the addressed variant resolves regardless of its locale.
      const base = { ...(populate ? { populate } : {}), ...(isI18n ? { locale: '*' as const } : {}) };
      if (!isDraftPublish) return api.findOne(name, id, base, signal);
      // Model A is single-row: an entry is EITHER published OR a draft. Try published first, fall back
      // to draft so the admin can view (and then publish) a draft. The status badge is derived from
      // published_at on the returned row.
      const pub = await api.findOneOrNull(name, id, { ...base, status: 'published' }, signal);
      if (pub !== null) return pub;
      return api.findOne(name, id, { ...base, status: 'draft' }, signal);
    },
    enabled: defQuery.isSuccess,
    retry: (count, err) => !(err instanceof NotFoundError) && count < 3,
  });

  const published =
    isDraftPublish && detailQuery.data?.data != null && detailQuery.data.data.published_at != null;

  const publishMutation = useMutation({
    mutationFn: () => (published ? api.unpublish(name, id) : api.publish(name, id)),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: contentKeys.detail(name, id) });
      await queryClient.invalidateQueries({ queryKey: ['content', name, 'list'] });
      toast.success(published ? 'Entry unpublished' : 'Entry published');
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  if (defQuery.error instanceof NotFoundError) {
    return <UnknownType name={name} />;
  }

  const def = defQuery.data;
  const row = detailQuery.data?.data;
  const loading = defQuery.isLoading || (defQuery.isSuccess && detailQuery.isLoading);
  const failed = defQuery.isError || detailQuery.isError || !def || !row;

  return (
    <section className="mx-auto max-w-5xl space-y-6">
      <div className="flex items-center justify-between">
        <Button asChild variant="ghost" size="sm" className="-ml-2">
          <Link to="/content/$name" params={{ name }}>
            <ChevronLeft className="h-4 w-4" />
            Back to {name}
          </Link>
        </Button>
        <Button asChild variant="outline" size="sm">
          <Link to="/content/$name/$id/edit" params={{ name, id }}>
            <Pencil className="h-4 w-4" />
            Edit
          </Link>
        </Button>
      </div>

      <h1 className="font-display text-2xl font-semibold tracking-tight">
        {name} <span className="font-mono text-muted-foreground">#{id}</span>
      </h1>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_18rem]">
        {/* Main column — the entry's fields. */}
        <Card className="shadow-card">
          <CardHeader>
            <CardTitle className="font-display">Fields</CardTitle>
          </CardHeader>
          <CardContent>
            {loading ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : failed ? (
              <div className="text-sm">
                <p className="font-medium text-destructive">Could not load this entry</p>
                <p className="mt-1 text-muted-foreground">
                  {errorMessage(detailQuery.error ?? defQuery.error)}
                </p>
              </div>
            ) : (
              <dl className="divide-y">
                {def.fields.map((field) => (
                  <div key={field.name} className="grid grid-cols-3 gap-4 py-3">
                    <dt className="text-sm font-medium text-muted-foreground">
                      {field.name}
                      {field.system && (
                        <span className="ml-1 text-xs text-muted-foreground/70">(system)</span>
                      )}
                      {isI18n && !field.system && field.localized === false && (
                        <span className="ml-1 text-xs text-muted-foreground/70">(shared)</span>
                      )}
                      {field.private && (
                        <span className="ml-1 text-xs text-muted-foreground/70">(write-only)</span>
                      )}
                    </dt>
                    <dd className="col-span-2 break-words text-sm">
                      {field.private ? (
                        <span className="text-muted-foreground">•••• (hidden)</span>
                      ) : (
                        formatValue(row[field.name], field)
                      )}
                    </dd>
                  </div>
                ))}
              </dl>
            )}
          </CardContent>
        </Card>

        {/* Right column — Lua STATUS + RELATIONS panels. */}
        <div className="space-y-6">
          {/* STATUS panel: i18n locale tabs + the draft/publish control. Only shown for an opted-in type. */}
          {row != null && (isI18n || isDraftPublish) && (
            <Card className="shadow-card">
              <CardContent className="space-y-4 p-5">
                <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/70">
                  Status
                </p>
                {isI18n && <LocaleSwitcher name={name} row={row} />}
                {isDraftPublish && (
                  <div className="space-y-3">
                    <StatusPill status={published ? 'published' : 'draft'} />
                    {published ? (
                      <Button
                        variant="outline"
                        size="sm"
                        className="w-full"
                        onClick={() => publishMutation.mutate()}
                        disabled={publishMutation.isPending}
                      >
                        <EyeOff className="h-4 w-4" />
                        Unpublish
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        className="w-full bg-success text-white hover:bg-success/90"
                        onClick={() => publishMutation.mutate()}
                        disabled={publishMutation.isPending}
                      >
                        <Eye className="h-4 w-4" />
                        Publish now
                      </Button>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {/* RELATIONS panel — populated via ?populate; rendered from client-side relation config. */}
          {row != null && relationFields.length > 0 && (
            <Card className="shadow-card">
              <CardContent className="space-y-3 p-5">
                <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/70">
                  Relations
                </p>
                {relationFields.map((rel) => {
                  const rows = asRelatedRows(row[rel.field]);
                  return (
                    <div key={rel.field} className="space-y-1.5">
                      <p className="text-xs font-medium text-muted-foreground">
                        {rel.field}
                        <span className="ml-1 text-muted-foreground/70">(→ {rel.target})</span>
                      </p>
                      {rows.length === 0 ? (
                        <span className="text-sm text-muted-foreground">—</span>
                      ) : (
                        <div className="flex flex-wrap gap-1.5">
                          {rows.map((r) => (
                            <Link
                              key={String(r.id)}
                              to="/content/$name/$id"
                              params={{ name: rel.target, id: String(r.id) }}
                            >
                              <Badge variant="secondary" className="hover:bg-secondary/70">
                                {relatedRowLabel(r, relationByField.get(rel.field)?.labelField)}
                                <span className="ml-1 text-xs text-muted-foreground">
                                  #{String(r.id)}
                                </span>
                              </Badge>
                            </Link>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </section>
  );
}
