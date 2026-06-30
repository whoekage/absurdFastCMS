import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { AlertTriangle, ListChecks, Trash2 } from "lucide-react";
import { useState } from "react";
import { BuilderShell } from "@/components/builder/builder-shell";
import { ModuleForm } from "@/components/builder/module-form";
import { toast } from "@/components/ui/toast";
import { BuilderError, deleteModule, listModules } from "@/lib/builder-client";
import { builderKeys, errorMessage, moduleToForm } from "@/lib/module-draft";
import { moduleKeys } from "@/lib/modules";

export const Route = createFileRoute("/modules/$name")({
  component: EditModulePage,
});

function EditModulePage() {
  const { name } = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [builderState, setBuilderState] = useState({ dirty: false, pendingCount: 0, busy: false });
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

interface DeleteModuleDialogProps {
  name: string;
  label?: string | undefined;
  version: string;
  onClose: () => void;
  onDeleted: () => Promise<void>;
}

function DeleteModuleDialog({ name, label, version, onClose, onDeleted }: DeleteModuleDialogProps) {
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirmed = input === name;

  async function doDelete(): Promise<void> {
    if (!confirmed) return;
    setError(null);
    setBusy(true);
    try {
      await deleteModule(name, version, { idempotencyKey: crypto.randomUUID() });
      await onDeleted();
    } catch (err) {
      const msg =
        err instanceof BuilderError && err.isStale
          ? "Schema changed elsewhere — reload and try again."
          : errorMessage(err);
      setError(msg);
      toast.error(msg);
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{
        background: "color-mix(in srgb,#241c12 42%,transparent)",
        backdropFilter: "blur(2px)",
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-[434px] max-w-[90vw] overflow-hidden rounded-[13px] border bg-card"
        style={{ boxShadow: "0 28px 64px rgba(40,30,10,.36)" }}
      >
        {/* Body */}
        <div className="p-[22px] pb-[18px]">
          <div className="mb-[13px] flex items-center gap-[10px]">
            <span
              className="flex h-[34px] w-[34px] items-center justify-center rounded-[9px]"
              style={{ background: "color-mix(in srgb,#d6456a 13%,transparent)", color: "#d6456a" }}
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
            Delete {label || name}
          </h3>

          <p className="mb-[18px] text-[13.5px] leading-[1.55] text-muted-foreground">
            Deletes module <span className="font-mono text-foreground">{name}</span>, its schema
            file, and all entries. Relations to it in other modules will be unlinked. This cannot be
            undone.
          </p>

          <p className="mb-[7px] font-mono text-[11px] text-muted-foreground">
            type <span style={{ color: "#d6456a" }}>{name}</span> to confirm
          </p>
          <input
            autoFocus
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void doDelete();
              if (e.key === "Escape") onClose();
            }}
            placeholder={name}
            className="h-[41px] w-full rounded-[8px] bg-background px-[13px] font-mono text-[13.5px] text-foreground outline-none placeholder:text-muted-foreground/40"
            style={{
              border: "1px solid color-mix(in srgb,#d6456a 32%,transparent)",
              boxShadow: "0 0 0 3px color-mix(in srgb,#d6456a 11%,transparent)",
            }}
          />

          {error && (
            <p
              className="mt-2.5 flex items-center gap-1.5 text-[12px]"
              style={{ color: "#d6456a" }}
            >
              <AlertTriangle className="h-3 w-3 flex-shrink-0" />
              {error}
            </p>
          )}
        </div>

        {/* Footer */}
        <div className="flex gap-[10px] border-t bg-muted/30 px-[22px] py-[15px]">
          <button
            type="button"
            disabled={!confirmed || busy}
            onClick={() => void doDelete()}
            className="flex-1 rounded-[8px] py-[11px] text-[13.5px] font-bold text-white transition-opacity disabled:opacity-40"
            style={{
              background: "#d6456a",
              boxShadow: "0 5px 14px color-mix(in srgb,#d6456a 34%,transparent)",
            }}
          >
            {busy ? "Deleting…" : "Delete forever"}
          </button>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-[8px] border px-[17px] py-[11px] text-[13.5px] font-semibold text-muted-foreground transition-colors hover:text-foreground disabled:opacity-60"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
