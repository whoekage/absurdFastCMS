import { useState } from 'react';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, Trash2, AlertTriangle } from 'lucide-react';
import { deleteModule, listModules, BuilderError } from '@/lib/builder-client';
import { builderKeys, errorMessage, moduleToForm } from '@/lib/module-draft';
import { moduleKeys } from '@/lib/modules';
import { ModuleForm } from '@/components/builder/module-form';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { toast } from '@/components/ui/toast';

export const Route = createFileRoute('/modules/$name')({
  component: EditModulePage,
});

function EditModulePage() {
  const { name } = Route.useParams();
  const navigate = useNavigate();
  const query = useQuery({
    queryKey: builderKeys.list(),
    queryFn: ({ signal }) => listModules(signal),
  });

  const schema = query.data?.schemas.find((s) => s.name === name);

  return (
    <section className="mx-auto max-w-3xl space-y-6">
      <Button asChild variant="ghost" size="sm" className="-ml-2">
        <Link to="/modules">
          <ChevronLeft className="h-4 w-4" />
          Back to modules
        </Link>
      </Button>

      {query.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {query.isError && <p className="text-sm text-destructive">Failed to load the schema catalog.</p>}
      {query.data && !schema && (
        <p className="text-sm text-destructive">Module &quot;{name}&quot; does not exist.</p>
      )}

      {query.data && schema && (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Edit module: {schema.label || schema.name}</CardTitle>
            </CardHeader>
            <CardContent>
              <ModuleForm
                mode="edit"
                initial={moduleToForm(schema)}
                version={query.data.version}
                allModuleNames={query.data.schemas.map((s) => s.name).filter((id) => id !== name)}
                onSaved={() => void navigate({ to: '/modules' })}
              />
            </CardContent>
          </Card>

          <DeleteModuleCard name={name} version={query.data.version} />
        </>
      )}
    </section>
  );
}

function DeleteModuleCard({ name, version }: { name: string; version: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function doDelete(): Promise<void> {
    setError(null);
    setBusy(true);
    try {
      await deleteModule(name, version, { idempotencyKey: crypto.randomUUID() });
      await queryClient.invalidateQueries({ queryKey: moduleKeys.all });
      await queryClient.invalidateQueries({ queryKey: builderKeys.all });
      toast.success(`Module "${name}" deleted`);
      void navigate({ to: '/modules' });
    } catch (err) {
      // 409 with a relation message ("referenced by …; remove the relation(s) first"), 412 stale, etc.
      const msg =
        err instanceof BuilderError && err.isStale
          ? 'The schema changed elsewhere — reload and try again.'
          : errorMessage(err);
      setError(msg);
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="border-destructive/40">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base text-destructive">
          <AlertTriangle className="h-4 w-4" />
          Danger zone
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          Deleting a module drops its table and all its entries. This can&apos;t be undone. A module that other
          modules relate to can&apos;t be deleted until those relations are removed.
        </p>
        {error && <p className="text-sm text-destructive">{error}</p>}
        {confirming ? (
          <div className="flex items-center gap-2">
            <Button variant="destructive" onClick={() => void doDelete()} disabled={busy}>
              <Trash2 className="h-4 w-4" />
              {busy ? 'Deleting…' : `Yes, delete "${name}"`}
            </Button>
            <Button variant="outline" onClick={() => setConfirming(false)} disabled={busy}>
              Cancel
            </Button>
          </div>
        ) : (
          <Button variant="destructive" onClick={() => setConfirming(true)}>
            <Trash2 className="h-4 w-4" />
            Delete module
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
