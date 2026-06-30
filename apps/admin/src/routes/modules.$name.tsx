import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ListChecks } from "lucide-react";
import { useState } from "react";
import { BuilderShell } from "@/components/builder/builder-shell";
import { DeleteModuleDialog } from "@/components/builder/delete-module-dialog";
import { ModuleForm } from "@/components/builder/module-form";
import { toast } from "@/components/ui/toast";
import { listModules } from "@/lib/builder-client";
import { builderKeys, moduleToForm } from "@/lib/module-draft";
import { moduleKeys } from "@/lib/modules";

export const Route = createFileRoute("/modules/$name")({
  component: EditModulePage,
});

function EditModulePage() {
  const { name } = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [builderState, setBuilderState] = useState({
    dirty: false,
    pendingCount: 0,
    busy: false,
    canUndo: false,
    canRedo: false,
    undo: () => {},
    redo: () => {},
  });
  const [showDelete, setShowDelete] = useState(false);

  const query = useQuery({
    queryKey: builderKeys.list(),
    queryFn: ({ signal }) => listModules(signal),
  });

  const schema = query.data?.schemas.find((s) => s.name === name);

  const reviewCta = (
    <button
      type="submit"
      form="module-builder"
      disabled={builderState.busy || !builderState.dirty}
      className="inline-flex items-center gap-[7px] rounded-[9px] px-[14px] py-[8px] text-[13px] font-semibold text-white transition-opacity disabled:cursor-not-allowed disabled:opacity-40"
      style={{
        background: "hsl(var(--primary))",
        boxShadow: "0 4px 12px color-mix(in srgb,hsl(var(--primary)) 30%,transparent)",
      }}
    >
      <ListChecks className="h-[14px] w-[14px]" />
      {builderState.busy ? "Reviewing…" : "Review changes"}
    </button>
  );

  return (
    <>
      <BuilderShell
        mode="edit"
        name={name}
        label={schema?.label}
        dirty={builderState.dirty}
        busy={builderState.busy}
        pendingCount={builderState.pendingCount}
        modules={(query.data?.schemas ?? []).map((s) => ({ name: s.name, label: s.label }))}
        canUndo={builderState.canUndo}
        canRedo={builderState.canRedo}
        onUndo={builderState.undo}
        onRedo={builderState.redo}
        headerRight={reviewCta}
      >
        {query.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
        {query.isError && (
          <p className="text-sm text-destructive">Failed to load the schema catalog.</p>
        )}
        {query.data && !schema && (
          <p className="text-sm text-destructive">Module &quot;{name}&quot; does not exist.</p>
        )}

        {query.data && schema && (
          <ModuleForm
            key={name}
            mode="edit"
            initial={moduleToForm(schema)}
            version={query.data.version}
            allModuleNames={query.data.schemas.map((s) => s.name).filter((id) => id !== name)}
            moduleLabels={Object.fromEntries(
              query.data.schemas.map((s) => [s.name, s.label ?? s.name]),
            )}
            moduleFields={Object.fromEntries(
              query.data.schemas.map((s) => [s.name, s.fields.map((f) => f.name)]),
            )}
            onStateChange={setBuilderState}
            onDeleteModule={() => setShowDelete(true)}
            onSaved={() => void navigate({ to: "/modules" })}
          />
        )}
      </BuilderShell>

      {showDelete && query.data && (
        <DeleteModuleDialog
          name={name}
          label={schema?.label}
          version={query.data.version}
          onClose={() => setShowDelete(false)}
          onDeleted={async () => {
            await queryClient.invalidateQueries({ queryKey: moduleKeys.all });
            await queryClient.invalidateQueries({ queryKey: builderKeys.all });
            toast.success(`Module "${name}" deleted`);
            void navigate({ to: "/modules" });
          }}
        />
      )}
    </>
  );
}
