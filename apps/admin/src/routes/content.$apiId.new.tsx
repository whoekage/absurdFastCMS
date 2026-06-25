import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft } from 'lucide-react';
import { NotFoundError, type WriteBody } from '@conti/sdk';
import { api } from '@/lib/api';
import { contentKeys, errorMessage } from '@/lib/content-manager';
import { relationFieldsFromDef } from '@/lib/relations';
import { buildInitialRelations, buildInitialValues, EntryForm } from '@/components/entry-form';
import { UnknownType } from '@/components/unknown-type';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { toast } from '@/components/ui/toast';

export const Route = createFileRoute('/content/$apiId/new')({
  component: NewEntryPage,
});

function NewEntryPage() {
  const { apiId } = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const defQuery = useQuery({
    queryKey: contentKeys.definition(apiId),
    queryFn: ({ signal }) => api.modules.get(apiId, signal),
    retry: (count, err) => !(err instanceof NotFoundError) && count < 3,
  });

  // Relations are discovered straight from the API-projected definition (def.relations).
  const relationFields = relationFieldsFromDef(defQuery.data);

  const createMutation = useMutation({
    mutationFn: (body: WriteBody) => api.create(apiId, body),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: contentKeys.all(apiId) });
      toast.success('Entry created');
      void navigate({ to: '/content/$apiId', params: { apiId } });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  if (defQuery.error instanceof NotFoundError) {
    return <UnknownType apiId={apiId} />;
  }

  return (
    <section className="mx-auto max-w-2xl space-y-6">
      <div>
        <Button asChild variant="ghost" size="sm" className="-ml-2">
          <Link to="/content/$apiId" params={{ apiId }}>
            <ChevronLeft className="h-4 w-4" />
            Back to {apiId}
          </Link>
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>New {apiId}</CardTitle>
        </CardHeader>
        <CardContent>
          {defQuery.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading form…</p>
          ) : defQuery.isError || !defQuery.data ? (
            <div className="text-sm">
              <p className="font-medium text-destructive">Could not load the schema</p>
              <p className="mt-1 text-muted-foreground">{errorMessage(defQuery.error)}</p>
            </div>
          ) : (
            <EntryForm
              def={defQuery.data}
              initialValues={buildInitialValues(defQuery.data)}
              relationFields={relationFields}
              initialRelations={buildInitialRelations(relationFields)}
              submitLabel={`Create ${apiId}`}
              pending={createMutation.isPending}
              onSubmit={(body) => createMutation.mutate(body)}
              onCancel={() => void navigate({ to: '/content/$apiId', params: { apiId } })}
            />
          )}
        </CardContent>
      </Card>
    </section>
  );
}
