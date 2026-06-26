import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft } from 'lucide-react';
import { listModules } from '@/lib/builder-client';
import { builderKeys, emptyModuleForm } from '@/lib/module-draft';
import { ModuleForm } from '@/components/builder/module-form';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export const Route = createFileRoute('/modules/new')({
  component: NewModulePage,
});

function NewModulePage() {
  const navigate = useNavigate();
  const query = useQuery({
    queryKey: builderKeys.list(),
    queryFn: ({ signal }) => listModules(signal),
  });

  return (
    <section className="mx-auto max-w-3xl space-y-6">
      <Button asChild variant="ghost" size="sm" className="-ml-2">
        <Link to="/modules">
          <ChevronLeft className="h-4 w-4" />
          Back to modules
        </Link>
      </Button>

      <Card>
        <CardHeader>
          <CardTitle>New module</CardTitle>
        </CardHeader>
        <CardContent>
          {query.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
          {query.isError && <p className="text-sm text-destructive">Failed to load the schema catalog.</p>}
          {query.data && (
            <ModuleForm
              mode="create"
              initial={emptyModuleForm()}
              version={query.data.version}
              allModuleApiIds={query.data.schemas.map((s) => s.apiId)}
              onSaved={(result) => {
                const apiId = result.schema?.apiId;
                if (apiId) void navigate({ to: '/modules/$apiId', params: { apiId } });
                else void navigate({ to: '/modules' });
              }}
            />
          )}
        </CardContent>
      </Card>
    </section>
  );
}
