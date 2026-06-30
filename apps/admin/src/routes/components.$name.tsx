import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ComponentForm } from "@/components/builder/component-form";
import { toast } from "@/components/ui/toast";
import { BuilderError, deleteComponent, listComponents } from "@/lib/builder-client";
import { builderKeys, componentKeys, componentToForm, errorMessage } from "@/lib/module-draft";

export const Route = createFileRoute("/components/$name")({
  component: EditComponentPage,
});

function EditComponentPage() {
  const { name } = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: componentKeys.list(),
    queryFn: ({ signal }) => listComponents(signal),
  });
  const component = query.data?.components.find((c) => c.name === name);

  async function doDelete(): Promise<void> {
    if (!query.data) return;
    if (!window.confirm(`Delete component "${name}"? This cannot be undone.`)) return;
    try {
      await deleteComponent(name, query.data.version, { idempotencyKey: crypto.randomUUID() });
      await queryClient.invalidateQueries({ queryKey: componentKeys.all });
      await queryClient.invalidateQueries({ queryKey: builderKeys.all });
      toast.success(`Component "${name}" deleted`);
      void navigate({ to: "/components" });
    } catch (err) {
      const msg =
        err instanceof BuilderError && err.isStale
          ? "Catalog changed elsewhere — reload and try again."
          : errorMessage(err);
      toast.error(msg);
    }
  }

  return (
    <section className="mx-auto max-w-3xl">
      <div className="mb-5 flex items-baseline gap-3 border-b pb-4">
        <button
          type="button"
          onClick={() => void navigate({ to: "/components" })}
          className="font-mono text-[12px] text-muted-foreground transition-colors hover:text-foreground"
        >
          ← components
        </button>
        <h1 className="font-display text-[22px] font-semibold tracking-[-0.02em]">{name}</h1>
      </div>

      {query.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {query.isError && <p className="text-sm text-destructive">Failed to load the component catalog.</p>}
      {query.data && !component && <p className="text-sm text-destructive">Component &quot;{name}&quot; does not exist.</p>}

      {query.data && component && (
        <ComponentForm
          key={name}
          mode="edit"
          initial={componentToForm(component)}
          version={query.data.version}
          allComponentNames={query.data.components.map((c) => c.name).filter((n) => n !== name)}
          onDeleteComponent={() => void doDelete()}
          onSaved={() => void navigate({ to: "/components" })}
        />
      )}
    </section>
  );
}
