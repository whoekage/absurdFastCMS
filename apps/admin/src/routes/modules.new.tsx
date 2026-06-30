import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { listModules } from '@/lib/builder-client';
import { builderKeys, emptyModuleForm } from '@/lib/module-draft';
import { ModuleForm } from '@/components/builder/module-form';
import { BuilderShell } from '@/components/builder/builder-shell';

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
    <BuilderShell mode="create" name="">
      {query.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {query.isError && <p className="text-sm text-destructive">Failed to load the schema catalog.</p>}
      {query.data && (
        <ModuleForm
          mode="create"
          initial={emptyModuleForm()}
          version={query.data.version}
          allModuleNames={query.data.schemas.map((s) => s.name)}
          moduleLabels={Object.fromEntries(query.data.schemas.map((s) => [s.name, s.label ?? s.name]))}
          moduleFields={Object.fromEntries(query.data.schemas.map((s) => [s.name, s.fields.map((f) => f.name)]))}
          onSaved={(result) => {
            const name = result.schema?.name;
            if (name) void navigate({ to: '/modules/$name', params: { name } });
            else void navigate({ to: '/modules' });
          }}
        />
      )}
    </BuilderShell>
  );
}
