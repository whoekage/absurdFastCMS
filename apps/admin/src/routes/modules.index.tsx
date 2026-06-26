import { createFileRoute, Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Plus, Boxes } from 'lucide-react';
import { listModules } from '@/lib/builder-client';
import { builderKeys } from '@/lib/module-draft';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

export const Route = createFileRoute('/modules/')({
  component: ModulesIndexPage,
});

function ModulesIndexPage() {
  const query = useQuery({
    queryKey: builderKeys.list(),
    queryFn: ({ signal }) => listModules(signal),
  });

  const schemas = query.data?.schemas ?? [];

  return (
    <section className="mx-auto max-w-4xl space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Modules</h1>
          <p className="text-sm text-muted-foreground">
            Create and edit content types. Saving writes a schema file and migrates the database.
          </p>
        </div>
        <Button asChild>
          <Link to="/modules/new">
            <Plus className="h-4 w-4" />
            New module
          </Link>
        </Button>
      </div>

      {query.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {query.isError && <p className="text-sm text-destructive">Failed to load modules.</p>}

      {!query.isLoading && schemas.length === 0 && (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            No modules yet. Create your first one.
          </CardContent>
        </Card>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        {schemas.map((schema) => (
          <Link key={schema.apiId} to="/modules/$apiId" params={{ apiId: schema.apiId }} className="block">
            <Card className="transition-colors hover:border-primary/50">
              <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Boxes className="h-4 w-4 text-muted-foreground" />
                  {schema.apiId}
                </CardTitle>
                <div className="flex gap-1">
                  {schema.options?.draftAndPublish && <Badge variant="secondary">D&amp;P</Badge>}
                  {schema.options?.i18n && <Badge variant="secondary">i18n</Badge>}
                </div>
              </CardHeader>
              <CardContent className="text-sm text-muted-foreground">
                {schema.fields.length} field{schema.fields.length === 1 ? '' : 's'}
                {schema.relations && schema.relations.length > 0
                  ? ` · ${schema.relations.length} relation${schema.relations.length === 1 ? '' : 's'}`
                  : ''}
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>
    </section>
  );
}
