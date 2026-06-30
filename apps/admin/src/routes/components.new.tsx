import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ComponentForm } from "@/components/builder/component-form";
import { listComponents } from "@/lib/builder-client";
import { componentKeys, emptyComponentForm } from "@/lib/module-draft";

export const Route = createFileRoute("/components/new")({
  component: NewComponentPage,
});

function NewComponentPage() {
  const navigate = useNavigate();
  const query = useQuery({
    queryKey: componentKeys.list(),
    queryFn: ({ signal }) => listComponents(signal),
  });

  return (
    <section className="mx-auto max-w-3xl">
      {query.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {query.isError && <p className="text-sm text-destructive">Failed to load the component catalog.</p>}
      {query.data && (
        <ComponentForm
          mode="create"
          initial={emptyComponentForm()}
          version={query.data.version}
          allComponentNames={query.data.components.map((c) => c.name)}
          onCancel={() => void navigate({ to: "/components" })}
          onSaved={() => void navigate({ to: "/components" })}
        />
      )}
    </section>
  );
}
