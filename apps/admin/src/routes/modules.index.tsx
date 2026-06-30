import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { AlertTriangle, Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "@/components/ui/toast";
import { BuilderError, deleteModule, listModules } from "@/lib/builder-client";
import { builderKeys, errorMessage } from "@/lib/module-draft";
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

  // Inline delete (hub-level quick action).
  const [deletingName, setDeletingName] = useState<string | null>(null);
  const [deleteConfirmInput, setDeleteConfirmInput] = useState("");
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  function openDelete(name: string) {
    setDeletingName(name);
    setDeleteConfirmInput("");
    setDeleteError(null);
  }
  function closeDelete() {
    setDeletingName(null);
    setDeleteConfirmInput("");
    setDeleteError(null);
  }

  async function doDelete(name: string): Promise<void> {
    setDeleteError(null);
    setDeleteBusy(true);
    try {
      await deleteModule(name, query.data!.version, { idempotencyKey: crypto.randomUUID() });
      await queryClient.invalidateQueries({ queryKey: moduleKeys.all });
      await queryClient.invalidateQueries({ queryKey: builderKeys.all });
      toast.success(`Module "${name}" deleted`);
      closeDelete();
    } catch (err) {
      const msg =
        err instanceof BuilderError && err.isStale
          ? "Schema changed elsewhere — reload and try again."
          : errorMessage(err);
      setDeleteError(msg);
      toast.error(msg);
    } finally {
      setDeleteBusy(false);
    }
  }

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
            const isSingle = (schema as { kind?: string }).kind === "single";
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
                    onClick={() => openDelete(schema.name)}
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

      {/* ── Delete confirmation modal ── */}
      {deletingName && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center"
          style={{
            background: "color-mix(in srgb,#241c12 42%,transparent)",
            backdropFilter: "blur(2px)",
          }}
          onClick={closeDelete}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-[434px] max-w-[90vw] overflow-hidden rounded-[13px] border bg-card"
            style={{ boxShadow: "0 28px 64px rgba(40,30,10,.36)" }}
          >
            <div className="p-[22px] pb-[18px]">
              <div className="mb-[13px] flex items-center gap-[10px]">
                <span
                  className="flex h-[34px] w-[34px] items-center justify-center rounded-[9px]"
                  style={{
                    background: "color-mix(in srgb,#d6456a 13%,transparent)",
                    color: "#d6456a",
                  }}
                >
                  <Trash2 className="h-[17px] w-[17px]" />
                </span>
                <span
                  className="font-mono text-[11px] font-semibold uppercase tracking-[0.1em]"
                  style={{ color: "#d6456a" }}
                >
                  Destructive · Irreversible
                </span>
              </div>
              <h3 className="mb-[11px] font-display text-[22px] font-semibold tracking-[-0.02em]">
                Delete {schemas.find((s) => s.name === deletingName)?.label || deletingName}
              </h3>
              <p className="mb-[18px] text-[13.5px] leading-[1.55] text-muted-foreground">
                Deletes module <span className="font-mono text-foreground">{deletingName}</span>,
                its schema, and all its entries. This cannot be undone.
              </p>
              <p className="mb-[7px] font-mono text-[11px] text-muted-foreground">
                type <span style={{ color: "#d6456a" }}>{deletingName}</span> to confirm
              </p>
              <input
                autoFocus
                value={deleteConfirmInput}
                onChange={(e) => setDeleteConfirmInput(e.target.value)}
                className="h-[41px] w-full rounded-[8px] bg-background px-[13px] font-mono text-[13.5px] outline-none"
                style={{
                  border: "1px solid color-mix(in srgb,#d6456a 32%,transparent)",
                  boxShadow: "0 0 0 3px color-mix(in srgb,#d6456a 11%,transparent)",
                }}
              />
              {deleteError && (
                <p className="mt-2 text-[12px]" style={{ color: "#d6456a" }}>
                  <AlertTriangle className="mr-1 inline h-3 w-3" />
                  {deleteError}
                </p>
              )}
            </div>
            <div className="flex gap-[10px] border-t bg-muted/30 px-[22px] py-[15px]">
              <button
                type="button"
                disabled={deleteConfirmInput !== deletingName || deleteBusy}
                onClick={() => void doDelete(deletingName)}
                className="flex-1 rounded-[8px] py-[11px] text-[13.5px] font-bold text-white transition-opacity disabled:opacity-40"
                style={{
                  background: "#d6456a",
                  boxShadow: "0 5px 14px color-mix(in srgb,#d6456a 34%,transparent)",
                }}
              >
                {deleteBusy ? "Deleting…" : "Delete forever"}
              </button>
              <button
                type="button"
                onClick={closeDelete}
                disabled={deleteBusy}
                className="rounded-[8px] border px-[17px] py-[11px] text-[13.5px] font-semibold text-muted-foreground transition-colors hover:text-foreground disabled:opacity-60"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
