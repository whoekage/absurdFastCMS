import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { BuilderShell } from "@/components/builder/builder-shell";
import { ModuleForm } from "@/components/builder/module-form";
import { listModules } from "@/lib/builder-client";
import { builderKeys, emptyModuleForm } from "@/lib/module-draft";

export const Route = createFileRoute("/modules/new")({
  component: NewModulePage,
});

function NewModulePage() {
  const navigate = useNavigate();
  const [builderState, setBuilderState] = useState({ dirty: false, pendingCount: 0, busy: false });

  const query = useQuery({
    queryKey: builderKeys.list(),
    queryFn: ({ signal }) => listModules(signal),
  });

  return (
    <BuilderShell mode="create" name="" dirty={builderState.dirty} busy={builderState.busy}>
      {query.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {query.isError && (
        <p className="text-sm text-destructive">Failed to load the schema catalog.</p>
      )}
      {query.data && (
        <ModuleForm
          mode="create"
          initial={emptyModuleForm()}
          version={query.data.version}
          allModuleNames={query.data.schemas.map((s) => s.name)}
          moduleLabels={Object.fromEntries(
            query.data.schemas.map((s) => [s.name, s.label ?? s.name]),
          )}
          moduleFields={Object.fromEntries(
            query.data.schemas.map((s) => [s.name, s.fields.map((f) => f.name)]),
          )}
          onStateChange={setBuilderState}
          onCancel={() => void navigate({ to: "/modules" })}
          onSaved={(result) => {
            const name = result.schema?.name;
            if (name) void navigate({ to: "/modules/$name", params: { name } });
            else void navigate({ to: "/modules" });
          }}
        />
      )}
    </BuilderShell>
  );
}
