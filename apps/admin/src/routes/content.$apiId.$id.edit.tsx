import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft } from 'lucide-react';
import { NotFoundError, type WriteBody } from '@conti/sdk';
import { api } from '@/lib/api';
import { contentKeys, errorMessage } from '@/lib/content-manager';
import { populateFromDef, relationFieldsFromDef } from '@/lib/relations';
import {
  mediaFieldsFromDef,
  mediaPopulateFromDef,
  buildInitialMedia,
  buildInitialMediaAssets,
} from '@/lib/media';
import {
  buildInitialRelations,
  buildInitialRelationRows,
  buildInitialValues,
  EntryForm,
} from '@/components/entry-form';
import { UnknownType } from '@/components/unknown-type';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { toast } from '@/components/ui/toast';

export const Route = createFileRoute('/content/$apiId/$id/edit')({
  component: EditEntryPage,
});

function EditEntryPage() {
  const { apiId, id } = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const defQuery = useQuery({
    queryKey: contentKeys.definition(apiId),
    queryFn: ({ signal }) => api.contentTypes.get(apiId, signal),
    retry: (count, err) => !(err instanceof NotFoundError) && count < 3,
  });

  // Relations + media + the populate spec are derived from the API-projected definition. The populate
  // spec folds relation names AND media-field names so the edit row arrives with both inlined (the media
  // picker seeds its thumbnails from the populated FileAsset records).
  const relationFields = relationFieldsFromDef(defQuery.data);
  const mediaFields = mediaFieldsFromDef(defQuery.data);
  const populateNames = [...(populateFromDef(defQuery.data) ?? []), ...mediaPopulateFromDef(defQuery.data)];
  const populate = populateNames.length > 0 ? populateNames : undefined;
  const isI18n = defQuery.data?.i18n === true;

  const detailQuery = useQuery({
    // Key includes the populate spec so the edit row (with related rows) caches separately from the
    // bare detail-view fetch.
    queryKey: [...contentKeys.detail(apiId, id), { populate, i18n: isI18n }],
    // i18n: address the variant by physical id without a locale predicate (locale='*'), else a
    // non-default-locale variant would 404 under the default-locale single-item gate.
    queryFn: ({ signal }) =>
      api.findOne(apiId, id, { ...(populate ? { populate } : {}), ...(isI18n ? { locale: '*' as const } : {}) }, signal),
    enabled: defQuery.isSuccess,
    retry: (count, err) => !(err instanceof NotFoundError) && count < 3,
  });

  const updateMutation = useMutation({
    mutationFn: (body: WriteBody) => api.update(apiId, id, body),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: contentKeys.all(apiId) });
      toast.success('Entry updated');
      void navigate({ to: '/content/$apiId/$id', params: { apiId, id } });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  if (defQuery.error instanceof NotFoundError) {
    return <UnknownType apiId={apiId} />;
  }

  const def = defQuery.data;
  const row = detailQuery.data?.data;
  const ready = def !== undefined && row !== undefined;
  const loading = defQuery.isLoading || (defQuery.isSuccess && detailQuery.isLoading);

  return (
    <section className="mx-auto max-w-2xl space-y-6">
      <div>
        <Button asChild variant="ghost" size="sm" className="-ml-2">
          <Link to="/content/$apiId/$id" params={{ apiId, id }}>
            <ChevronLeft className="h-4 w-4" />
            Back
          </Link>
        </Button>
      </div>

      <Card className="shadow-card">
        <CardHeader>
          <CardTitle className="font-display">
            Edit {apiId} <span className="font-mono text-muted-foreground">#{id}</span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : defQuery.isError || detailQuery.isError || !ready ? (
            <div className="text-sm">
              <p className="font-medium text-destructive">Could not load this entry</p>
              <p className="mt-1 text-muted-foreground">
                {errorMessage(detailQuery.error ?? defQuery.error)}
              </p>
            </div>
          ) : (
            <EntryForm
              def={def}
              initialValues={buildInitialValues(def, row)}
              relationFields={relationFields}
              initialRelations={buildInitialRelations(relationFields, row)}
              initialRelationRows={buildInitialRelationRows(relationFields, row)}
              initialMedia={buildInitialMedia(mediaFields, row)}
              initialMediaAssets={buildInitialMediaAssets(mediaFields, row)}
              submitLabel="Save changes"
              pending={updateMutation.isPending}
              onSubmit={(body) => updateMutation.mutate(body)}
              onCancel={() =>
                void navigate({ to: '/content/$apiId/$id', params: { apiId, id } })
              }
            />
          )}
        </CardContent>
      </Card>
    </section>
  );
}
