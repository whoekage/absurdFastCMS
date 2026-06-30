import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Boxes, Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "@/components/ui/toast";
import { BuilderError, deleteComponent, listComponents } from "@/lib/builder-client";
import { builderKeys, componentKeys, errorMessage } from "@/lib/module-draft";

export const Route = createFileRoute("/components/")({
  component: ComponentsIndexPage,
});

function ComponentsIndexPage() {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: componentKeys.list(),
    queryFn: ({ signal }) => listComponents(signal),
  });
  const components = query.data?.components ?? [];

  async function doDelete(name: string): Promise<void> {
    if (!window.confirm(`Delete component "${name}"? This cannot be undone.`)) return;
    try {
      await deleteComponent(name, query.data!.version, { idempotencyKey: crypto.randomUUID() });
      await queryClient.invalidateQueries({ queryKey: componentKeys.all });
      await queryClient.invalidateQueries({ queryKey: builderKeys.all });
      toast.success(`Component "${name}" deleted`);
    } catch (err) {
      const msg =
        err instanceof BuilderError && err.isStale
          ? "Catalog changed elsewhere — reload and try again."
          : errorMessage(err);
      toast.error(msg);
    }
  }

  return (
    <section className="mx-auto max-w-4xl">
      <div className="mb-[17px] flex items-end justify-between border-b pb-[17px]">
        <div>
          <p className="mb-[5px] font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/60">
            Content Model
          </p>
          <h1 className="font-display text-[31px] font-semibold leading-none tracking-[-0.03em]">Components</h1>
        </div>
        <Link
          to="/components/new"
          className="inline-flex items-center gap-2 rounded-[8px] px-4 py-[10px] text-[13px] font-semibold text-background shadow-md transition-opacity hover:opacity-90"
          style={{ background: "hsl(var(--foreground))" }}
        >
          <Plus className="h-[14px] w-[14px]" />
          New component
        </Link>
      </div>

      {query.isLoading && <p className="py-4 text-[13px] text-muted-foreground">Loading…</p>}
      {query.isError && <p className="py-4 text-[13px] text-destructive">Failed to load components.</p>}

      {!query.isLoading && components.length === 0 && (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <div className="mb-5 flex h-[62px] w-[62px] items-center justify-center rounded-[17px] border shadow-md" style={{ background: "hsl(var(--card))" }}>
            <Boxes className="h-[29px] w-[29px]" style={{ color: "hsl(var(--primary))" }} strokeWidth={1.6} />
          </div>
          <h2 className="mb-[9px] font-display text-[24px] font-semibold tracking-[-0.02em]">No components yet</h2>
          <p className="mx-auto mb-6 max-w-[430px] text-[14px] leading-[1.55] text-muted-foreground">
            A component is a reusable group of fields (e.g. an SEO block) you attach to a module. Define one here,
            then add it as a component field on any module.
          </p>
          <Link
            to="/components/new"
            className="inline-flex items-center gap-2 rounded-[9px] px-5 py-3 text-[14px] font-semibold text-background shadow-lg transition-opacity hover:opacity-90"
            style={{ background: "hsl(var(--foreground))" }}
          >
            <Plus className="h-[15px] w-[15px]" />
            Create your first component
          </Link>
        </div>
      )}

      {components.length > 0 && (
        <div className="overflow-hidden rounded-[13px] border">
          {components.map((c, idx) => (
            <div
              key={c.name}
              className="group relative flex items-center gap-5 border-b px-[28px] py-[14px] last:border-b-0 transition-colors hover:bg-primary/[0.04]"
            >
              <span className="w-5 flex-shrink-0 font-mono text-[12px] text-muted-foreground/50">{String(idx + 1).padStart(2, "0")}</span>
              <Link
                to="/components/$name"
                params={{ name: c.name }}
                className="w-[200px] flex-shrink-0 font-display text-[18px] font-semibold leading-tight tracking-[-0.01em] hover:text-primary"
              >
                {c.name}
              </Link>
              <div className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-muted-foreground/60">
                {c.fields.map((f) => f.name).slice(0, 6).join(" · ") || <span className="italic">no fields</span>}
              </div>
              <span className="w-[58px] flex-shrink-0 text-right font-mono text-[12px] text-muted-foreground">
                {c.fields.length} field{c.fields.length === 1 ? "" : "s"}
              </span>
              <div className="flex flex-shrink-0 items-center gap-[6px] opacity-0 transition-opacity group-hover:opacity-100">
                <Link
                  to="/components/$name"
                  params={{ name: c.name }}
                  className="flex h-[29px] w-[29px] items-center justify-center rounded-[7px] border bg-card text-muted-foreground transition-colors hover:text-foreground"
                  aria-label={`Edit ${c.name}`}
                >
                  <Pencil className="h-[13px] w-[13px]" />
                </Link>
                <button
                  type="button"
                  aria-label={`Delete ${c.name}`}
                  onClick={() => void doDelete(c.name)}
                  className="flex h-[29px] w-[29px] items-center justify-center rounded-[7px] border transition-colors"
                  style={{ borderColor: "color-mix(in srgb,#d6456a 32%,transparent)", color: "#d6456a" }}
                >
                  <Trash2 className="h-[13px] w-[13px]" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
