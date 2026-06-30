import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { DeleteModuleDialog } from "@/components/builder/delete-module-dialog";
import { toast } from "@/components/ui/toast";
import { listModules } from "@/lib/builder-client";
import { builderKeys } from "@/lib/module-draft";
import { moduleKeys } from "@/lib/modules";

export const Route = createFileRoute("/modules/")({
  component: ModulesIndexPage,
});

// Deterministic colour palette for module avatar chips.
const PALETTE = [
  { bg: "color-mix(in srgb,#5b53e6 14%,transparent)", color: "#5b53e6" },
  { bg: "color-mix(in srgb,#0f9d8f 14%,transparent)", color: "#0f9d8f" },
  { bg: "color-mix(in srgb,#c77d1a 14%,transparent)", color: "#c77d1a" },
  { bg: "color-mix(in srgb,#d6456a 14%,transparent)", color: "#d6456a" },
  { bg: "color-mix(in srgb,#8b5cf6 14%,transparent)", color: "#8b5cf6" },
  { bg: "color-mix(in srgb,#10b981 14%,transparent)", color: "#10b981" },
];

function paletteFor(name: string) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) & 0xffff;
  return PALETTE[h % PALETTE.length]!;
}

function glyphOf(name: string, label?: string): string {
  const src = ((label?.trim() || name) + name).replace(/[^a-zA-Z0-9]/g, "");
  const two = src.slice(0, 2) || "??";
  return two.charAt(0).toUpperCase() + (two[1] ?? "").toLowerCase();
}

function ModulesIndexPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: builderKeys.list(),
    queryFn: ({ signal }) => listModules(signal),
  });
  const schemas = query.data?.schemas ?? [];
  const totalFields = schemas.reduce((s, m) => s + m.fields.length, 0);

  // Hub-level delete quick action (shares the type-to-confirm dialog with the edit screen).
  const [deletingName, setDeletingName] = useState<string | null>(null);

  return (
    <section className="mx-auto max-w-4xl">
      {/* ── Page header ── */}
      <div className="mb-[17px] flex items-end justify-between border-b pb-[17px]">
        <div>
          <p className="mb-[5px] font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/60">
            Content Model
          </p>
          <h1 className="font-display text-[31px] font-semibold leading-none tracking-[-0.03em]">
            Modules
          </h1>
        </div>
        <div className="flex items-center gap-4">
          {schemas.length > 0 && (
            <span className="font-mono text-[12px] text-muted-foreground">
              {schemas.length} type{schemas.length === 1 ? "" : "s"} · {totalFields} field
              {totalFields === 1 ? "" : "s"}
            </span>
          )}
          <Link
            to="/modules/new"
            className="inline-flex items-center gap-2 rounded-[8px] px-4 py-[10px] text-[13px] font-semibold text-background shadow-md transition-opacity hover:opacity-90"
            style={{ background: "hsl(var(--foreground))" }}
          >
            <Plus className="h-[14px] w-[14px]" />
            New module
          </Link>
        </div>
      </div>

      {/* ── Loading / error ── */}
      {query.isLoading && <p className="py-4 text-[13px] text-muted-foreground">Loading…</p>}
      {query.isError && (
        <p className="py-4 text-[13px] text-destructive">Failed to load modules.</p>
      )}

      {/* ── Empty state ── */}
      {!query.isLoading && schemas.length === 0 && (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <div
            className="mb-5 flex h-[62px] w-[62px] items-center justify-center rounded-[17px] border shadow-md"
            style={{ background: "hsl(var(--card))" }}
          >
            <svg
              width="29"
              height="29"
              viewBox="0 0 24 24"
              fill="none"
              stroke="hsl(var(--primary))"
              strokeWidth="1.7"
            >
              <rect x="3" y="3" width="7" height="7" rx="1.6" />
              <rect x="14" y="3" width="7" height="7" rx="1.6" />
              <rect x="3" y="14" width="7" height="7" rx="1.6" />
              <path d="M17.5 14.5v6M14.5 17.5h6" />
            </svg>
          </div>
          <h2 className="mb-[9px] font-display text-[24px] font-semibold tracking-[-0.02em]">
            No modules yet
          </h2>
          <p className="mx-auto mb-6 max-w-[430px] text-[14px] leading-[1.55] text-muted-foreground">
            A module describes a content type — its fields, relations and options. Start here to
            define your schema.
          </p>
          <Link
            to="/modules/new"
            className="inline-flex items-center gap-2 rounded-[9px] px-5 py-3 text-[14px] font-semibold text-background shadow-lg transition-opacity hover:opacity-90"
            style={{ background: "hsl(var(--foreground))" }}
          >
            <Plus className="h-[15px] w-[15px]" />
            Create your first module
          </Link>
        </div>
      )}

      {/* ── Module row list ── */}
      {schemas.length > 0 && (
        <div className="overflow-hidden rounded-[13px] border">
          {schemas.map((schema, idx) => {
            const pal = paletteFor(schema.name);
            const glyph = glyphOf(schema.name, schema.label);
            const fieldNames = schema.fields
              .map((f) => f.name)
              .slice(0, 6)
              .join(" · ");
            const isSingle = schema.options?.single === true;
            return (
              <div
                key={schema.name}
                className="group relative flex items-center gap-5 border-b px-[28px] py-[14px] last:border-b-0 transition-colors hover:bg-primary/[0.04]"
              >
                {/* Index */}
                <span className="w-5 flex-shrink-0 font-mono text-[12px] text-muted-foreground/50">
                  {String(idx + 1).padStart(2, "0")}
                </span>

                {/* Avatar chip */}
                <span
                  className="flex h-[42px] w-[42px] flex-shrink-0 items-center justify-center rounded-[10px] font-display text-[18px] font-semibold"
                  style={{ background: pal.bg, color: pal.color }}
                >
                  {glyph}
                </span>

                {/* Name + api_id */}
                <div className="w-[180px] flex-shrink-0 min-w-0">
                  <div className="flex items-center gap-2">
                    <Link
                      to="/modules/$name"
                      params={{ name: schema.name }}
                      className="font-display text-[18px] font-semibold leading-tight tracking-[-0.01em] hover:text-primary"
                    >
                      {schema.label || schema.name}
                    </Link>
                    {isSingle && (
                      <span
                        className="rounded-[4px] border px-[5px] py-[1px] font-mono text-[9.5px] font-semibold uppercase tracking-[0.05em]"
                        style={{
                          color: "#c77d1a",
                          borderColor: "color-mix(in srgb,#c77d1a 40%,transparent)",
                        }}
                      >
                        Single
                      </span>
                    )}
                  </div>
                  <div className="mt-[2px] font-mono text-[11.5px] text-muted-foreground">
                    {schema.name}
                  </div>
                </div>

                {/* Field preview */}
                <div className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-muted-foreground/60">
                  {fieldNames || <span className="italic">no fields</span>}
                </div>

                {/* Count */}
                <span className="w-[58px] flex-shrink-0 text-right font-mono text-[12px] text-muted-foreground">
                  {schema.fields.length} field{schema.fields.length === 1 ? "" : "s"}
                </span>

                {/* Hover actions */}
                <div className="flex flex-shrink-0 items-center gap-[6px] opacity-0 transition-opacity group-hover:opacity-100">
                  <button
                    type="button"
                    aria-label={`Edit ${schema.label || schema.name}`}
                    onClick={() =>
                      void navigate({ to: "/modules/$name", params: { name: schema.name } })
                    }
                    className="flex h-[29px] w-[29px] items-center justify-center rounded-[7px] border bg-card text-muted-foreground transition-colors hover:text-foreground"
                  >
                    <Pencil className="h-[13px] w-[13px]" />
                  </button>
                  <button
                    type="button"
                    aria-label={`Delete ${schema.label || schema.name}`}
                    onClick={() => setDeletingName(schema.name)}
                    className="flex h-[29px] w-[29px] items-center justify-center rounded-[7px] border transition-colors"
                    style={{
                      borderColor: "color-mix(in srgb,#d6456a 32%,transparent)",
                      color: "#d6456a",
                    }}
                  >
                    <Trash2 className="h-[13px] w-[13px]" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ── Delete confirmation modal (shared with the edit screen) ── */}
      {deletingName && query.data && (
        <DeleteModuleDialog
          name={deletingName}
          label={schemas.find((s) => s.name === deletingName)?.label}
          version={query.data.version}
          onClose={() => setDeletingName(null)}
          onDeleted={async () => {
            await queryClient.invalidateQueries({ queryKey: moduleKeys.all });
            await queryClient.invalidateQueries({ queryKey: builderKeys.all });
            toast.success(`Module "${deletingName}" deleted`);
            setDeletingName(null);
          }}
        />
      )}
    </section>
  );
}
