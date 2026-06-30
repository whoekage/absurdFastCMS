import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useBlocker } from "@tanstack/react-router";
import { AlertTriangle, Code2, Lock, Plus, RotateCcw, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { CodeMode } from "@/components/builder/code-mode";
import { FieldCard } from "@/components/builder/field-card";
import { type BuilderMode, ModeSwitcher } from "@/components/builder/mode-switcher";
import { PreviewMode } from "@/components/builder/preview-mode";
import { RelationsEditor } from "@/components/builder/relations-editor";
import { ReviewModal } from "@/components/builder/review-modal";
import { TypePicker } from "@/components/builder/type-picker";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/toast";
import {
  BuilderError,
  type PreviewResult,
  previewModule,
  type SaveResult,
  saveModule,
  listComponents,
} from "@/lib/builder-client";
import {
  builderKeys,
  componentKeys,
  emptyFieldDraft,
  errorMessage,
  type FieldDraft,
  fieldStatus,
  formToModuleDraft,
  type ModuleFormState,
  relationStatus,
  slugify,
  validateModuleForm,
} from "@/lib/module-draft";
import type { BuilderFieldType } from "@/lib/field-types";
import { moduleKeys } from "@/lib/modules";
import { generateSchemaSourceMirror } from "@/lib/schema-codegen-mirror";
import { useHistoryState } from "@/lib/use-history-state";

interface BuilderState {
  dirty: boolean;
  pendingCount: number;
  busy: boolean;
  canUndo: boolean;
  canRedo: boolean;
  undo: () => void;
  redo: () => void;
}

interface ModuleFormProps {
  mode: "create" | "edit";
  initial: ModuleFormState;
  version: string;
  allModuleNames: string[];
  moduleLabels: Record<string, string>;
  moduleFields: Record<string, string[]>;
  /** Called when dirty/busy/pendingCount changes so the parent can drive the header. */
  onStateChange?: (state: BuilderState) => void;
  /** Called when the user clicks "Cancel" on the create form. */
  onCancel?: () => void;
  /** Called to open the delete dialog (edit mode only). */
  onDeleteModule?: () => void;
  onSaved: (result: SaveResult) => void;
}

export function ModuleForm({
  mode,
  initial,
  version,
  allModuleNames,
  moduleLabels,
  moduleFields,
  onStateChange,
  onCancel,
  onDeleteModule,
  onSaved,
}: ModuleFormProps) {
  const queryClient = useQueryClient();
  const history = useHistoryState<ModuleFormState>(initial);
  const state = history.state;
  const setState = history.set;
  const [phase, setPhase] = useState<"editing" | "reviewing">("editing");
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [allowDestructive, setAllowDestructive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [canvasMode, setCanvasMode] = useState<BuilderMode>("build");
  const armed = useRef(false);
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [overKey, setOverKey] = useState<string | null>(null);
  // Track whether the user has manually edited the name field (for auto-slugify on create).
  const nameManuallyEdited = useRef(false);

  const isEdit = mode === "edit";

  // Defined components — the options for a component field's reference picker.
  const componentsQuery = useQuery({
    queryKey: componentKeys.list(),
    queryFn: ({ signal }) => listComponents(signal),
  });
  const componentNames = (componentsQuery.data?.components ?? []).map((c) => c.name);

  const targets = [...new Set([state.name.trim(), ...allModuleNames])].filter((t) => t !== "");
  const targetLabels: Record<string, string> = {
    ...moduleLabels,
    ...(state.name.trim() ? { [state.name.trim()]: state.label.trim() || state.name.trim() } : {}),
  };
  const moduleDisplayName = state.label.trim() || state.name.trim() || "Untitled";
  const moduleGlyph = (() => {
    const two = moduleDisplayName.replace(/[^a-zA-Z0-9]/g, "").slice(0, 2) || "?";
    return two.charAt(0).toUpperCase() + two.slice(1);
  })();

  const patch = (p: Partial<ModuleFormState>) => setState((s) => ({ ...s, ...p }));
  const setFieldAt = (key: string, next: FieldDraft) =>
    setState((s) => ({ ...s, fields: s.fields.map((f) => (f.key === key ? next : f)) }));

  /** On create: auto-set name from label unless the user has manually overridden it. */
  function onLabelChange(label: string) {
    if (!isEdit && !nameManuallyEdited.current) {
      patch({ label, name: slugify(label) });
    } else {
      patch({ label });
    }
  }

  const pickType = (type: BuilderFieldType) => {
    const draft = emptyFieldDraft(type);
    setState((s) => ({ ...s, fields: [...s.fields, draft] }));
    setExpandedKey(draft.key);
    setPickerOpen(false);
  };

  const deleteField = (key: string) =>
    setState((s) => ({
      ...s,
      fields: s.fields.flatMap((f) => {
        if (f.key !== key) return [f];
        return f.id === undefined ? [] : [{ ...f, deleted: true }];
      }),
    }));
  const restoreField = (key: string) =>
    setFieldAt(key, { ...state.fields.find((f) => f.key === key)!, deleted: false });
  const toggleExpand = (key: string) => setExpandedKey((cur) => (cur === key ? null : key));

  // Drag-reorder
  const grabHandle = (key: string) => {
    armed.current = true;
    setExpandedKey((cur) => (cur === key ? null : cur));
    const release = () => {
      armed.current = false;
      window.removeEventListener("pointerup", release);
    };
    window.addEventListener("pointerup", release);
  };
  const reorderField = (fromKey: string, toKey: string) => {
    if (fromKey === toKey) return;
    setState((s) => {
      const arr = [...s.fields];
      const fromIdx = arr.findIndex((f) => f.key === fromKey);
      if (fromIdx < 0) return s;
      const [moved] = arr.splice(fromIdx, 1);
      const toIdx = arr.findIndex((f) => f.key === toKey);
      if (toIdx < 0 || !moved) return s;
      arr.splice(toIdx, 0, moved);
      return { ...s, fields: arr };
    });
  };
  const endDrag = () => {
    armed.current = false;
    setDragKey(null);
    setOverKey(null);
  };

  // Dirty / pending-changes tracking
  const dirty = useMemo(
    () => JSON.stringify(formToModuleDraft(state)) !== JSON.stringify(formToModuleDraft(initial)),
    [state, initial],
  );
  const pendingCount =
    state.fields.filter((f) => !f.raw && fieldStatus(f, state.baseline) !== "clean").length +
    state.relations.filter((r) => relationStatus(r, state.relationBaseline) !== "clean").length;

  // Report builder state to the parent (drives header CTA disabled state + status dot + undo/redo).
  useEffect(() => {
    onStateChange?.({
      dirty,
      pendingCount,
      busy,
      canUndo: history.canUndo,
      canRedo: history.canRedo,
      undo: history.undo,
      redo: history.redo,
    });
  }, [dirty, pendingCount, busy, history.canUndo, history.canRedo, history.undo, history.redo, onStateChange]);

  // ⌘Z / ⌘⇧Z undo-redo (edit mode). Skipped while a text input is focused so native field undo wins.
  useEffect(() => {
    if (!isEdit) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "z") return;
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      e.preventDefault();
      if (e.shiftKey) history.redo();
      else history.undo();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isEdit, history.undo, history.redo]);

  const discard = () => {
    if (!dirty) return;
    if (!window.confirm("Discard all unsaved changes to this module?")) return;
    history.reset(initial);
    setExpandedKey(null);
    setPickerOpen(false);
    setError(null);
  };

  const guarded = dirty && phase === "editing";
  useBlocker({
    shouldBlockFn: () => !window.confirm("You have unsaved changes. Leave without applying them?"),
    enableBeforeUnload: false,
    disabled: !guarded,
  });
  useEffect(() => {
    if (!guarded) return undefined;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [guarded]);

  async function review(): Promise<void> {
    setError(null);
    const validationError = validateModuleForm(state, allModuleNames);
    if (validationError) {
      setError(validationError);
      return;
    }
    setBusy(true);
    try {
      const result = await previewModule(state.name.trim(), formToModuleDraft(state), false);
      setPreview(result);
      setAllowDestructive(false);
      setPhase("reviewing");
    } catch (err) {
      setError(errorMessage(err));
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function apply(): Promise<void> {
    setError(null);
    setBusy(true);
    try {
      const result = await saveModule(state.name.trim(), formToModuleDraft(state), version, {
        allowDestructive,
        idempotencyKey: crypto.randomUUID(),
      });
      await queryClient.invalidateQueries({ queryKey: moduleKeys.all });
      await queryClient.invalidateQueries({ queryKey: builderKeys.all });
      toast.success(
        isEdit
          ? `Module "${state.label || state.name}" updated`
          : `Module "${state.label || state.name}" created`,
      );
      onSaved(result);
    } catch (err) {
      if (err instanceof BuilderError && err.isStale) {
        setError("The schema changed elsewhere since you opened this. Reload and try again.");
      } else if (err instanceof BuilderError && err.isBusy) {
        setError("Another schema change is in progress — wait a moment and apply again.");
      } else {
        setError(errorMessage(err));
      }
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const authorable = state.fields.filter((f) => !f.raw);
  const rawFields = state.fields.filter((f) => f.raw);
  const liveAuthorable = authorable.filter((f) => !f.deleted);

  const reviewModal =
    phase === "reviewing" && preview ? (
      <ReviewModal
        preview={preview}
        name={state.name.trim()}
        isEdit={isEdit}
        allowDestructive={allowDestructive}
        onAllowDestructiveChange={setAllowDestructive}
        busy={busy}
        error={error}
        onCancel={() => {
          setPhase("editing");
          setError(null);
        }}
        onApply={() => void apply()}
      />
    ) : null;

  // Preview / Code canvas: render them in a standalone wrapper (the form is NOT in the DOM).
  if (canvasMode !== "build") {
    const liveRelations = state.relations.filter((r) => !r.deleted);
    return (
      <>
        {canvasMode === "preview" ? (
          <PreviewMode
            moduleName={moduleDisplayName}
            moduleGlyph={moduleGlyph}
            fields={liveAuthorable}
            relations={liveRelations}
            i18n={state.i18n}
            draftAndPublish={state.draftAndPublish}
          />
        ) : (
          <CodeMode
            source={generateSchemaSourceMirror(formToModuleDraft(state))}
            filename={`${state.name.trim() || "untitled"}/schema.ts`}
          />
        )}
        <ModeSwitcher mode={canvasMode} onChange={setCanvasMode} />
        {reviewModal}
      </>
    );
  }

  // ── CREATE mode: centered card ─────────────────────────────────────────────────────────────────
  if (!isEdit) {
    return (
      <>
        <div className="flex justify-center pt-4">
          <form
            id="module-builder"
            className="w-full max-w-[540px] rounded-[14px] border bg-card p-[26px] shadow-lg"
            onSubmit={(e) => {
              e.preventDefault();
              void review();
            }}
          >
            <p className="mb-[7px] font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/60">
              Define module
            </p>
            <h2 className="mb-[22px] font-display text-[25px] font-semibold tracking-[-0.025em]">
              New module
            </h2>

            {/* display_name + api_id */}
            <div className="mb-[22px] grid grid-cols-2 gap-[18px]">
              <div>
                <label className="mb-[7px] block font-mono text-[11px] text-muted-foreground">
                  display_name
                </label>
                <input
                  autoFocus
                  value={state.label}
                  onChange={(e) => onLabelChange(e.target.value)}
                  placeholder="e.g. Article"
                  className="h-[43px] w-full rounded-[9px] bg-background px-[13px] font-display text-[17px] font-semibold text-foreground outline-none ring-[3px] transition-shadow placeholder:text-muted-foreground/40"
                  style={{
                    border: "1.5px solid hsl(var(--primary))",
                    boxShadow: "0 0 0 3px color-mix(in srgb,hsl(var(--primary)) 15%,transparent)",
                  }}
                />
              </div>
              <div>
                <label className="mb-[7px] flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
                  api_id
                  <Lock className="h-[10px] w-[10px] text-muted-foreground/50" />
                </label>
                <input
                  value={state.name}
                  onChange={(e) => {
                    nameManuallyEdited.current = true;
                    patch({ name: e.target.value });
                  }}
                  placeholder="auto"
                  className="h-[43px] w-full rounded-[9px] border bg-muted/40 px-[13px] font-mono text-[14px] text-muted-foreground outline-none"
                />
              </div>
            </div>

            {/* Multiple / Single */}
            <label className="mb-[9px] block font-mono text-[11px] text-muted-foreground">
              type
            </label>
            <div className="mb-[22px] flex gap-[10px]">
              {[
                ["collection", "Multiple", "Many entries — articles, products, authors"] as const,
                ["single", "Single", "One entry — homepage, settings"] as const,
              ].map(([val, title, desc]) => {
                const sel = state.kind === val;
                return (
                  <button
                    key={val}
                    type="button"
                    onClick={() => patch({ kind: val })}
                    className="flex-1 rounded-[11px] p-[14px] text-left transition-colors"
                    style={{
                      border: sel
                        ? "1.5px solid hsl(var(--primary))"
                        : "1px solid hsl(var(--border))",
                      background: sel
                        ? "color-mix(in srgb,hsl(var(--primary)) 6%,transparent)"
                        : "transparent",
                    }}
                  >
                    <div className="mb-[5px] flex items-center justify-between">
                      <span
                        className="font-display text-[15px] font-semibold"
                        style={{ color: sel ? undefined : "hsl(var(--muted-foreground))" }}
                      >
                        {title}
                      </span>
                      {sel ? (
                        <svg
                          width="17"
                          height="17"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="hsl(var(--primary))"
                          strokeWidth="2.4"
                        >
                          <circle cx="12" cy="12" r="9" />
                          <path d="M8 12l3 3 5-6" />
                        </svg>
                      ) : (
                        <span
                          className="h-[17px] w-[17px] rounded-full border-[1.5px]"
                          style={{ borderColor: "hsl(var(--border))" }}
                        />
                      )}
                    </div>
                    <p className="text-[12px] leading-[1.4] text-muted-foreground">{desc}</p>
                  </button>
                );
              })}
            </div>

            {/* D&P + i18n toggles */}
            <div className="mb-[24px] flex gap-[28px] border-t pt-[18px]">
              <div className="flex items-center gap-[9px]">
                <Switch
                  id="dp-new"
                  checked={state.draftAndPublish}
                  onCheckedChange={(v) => patch({ draftAndPublish: v })}
                />
                <label htmlFor="dp-new" className="cursor-pointer text-[13px] font-medium">
                  Draft &amp; Publish
                </label>
              </div>
              <div className="flex items-center gap-[9px]">
                <Switch
                  id="i18n-new"
                  checked={state.i18n}
                  onCheckedChange={(v) => patch({ i18n: v })}
                />
                <label htmlFor="i18n-new" className="cursor-pointer text-[13px] font-medium">
                  i18n
                </label>
              </div>
            </div>

            {error && (
              <p
                className="mb-3 flex items-center gap-1.5 text-[13px]"
                style={{ color: "hsl(var(--destructive))" }}
              >
                <AlertTriangle className="h-3.5 w-3.5" />
                {error}
              </p>
            )}

            {/* Actions */}
            <div className="flex gap-[11px]">
              <button
                type="submit"
                disabled={busy}
                className="inline-flex items-center gap-[7px] rounded-[9px] px-[18px] py-[11px] text-[14px] font-semibold text-background transition-opacity hover:opacity-90 disabled:opacity-50"
                style={{ background: "hsl(var(--foreground))" }}
              >
                {busy ? "Creating…" : "Create module"}
                {!busy && (
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.2"
                  >
                    <path d="M5 12h14M13 6l6 6-6 6" />
                  </svg>
                )}
              </button>
              {onCancel && (
                <button
                  type="button"
                  onClick={onCancel}
                  disabled={busy}
                  className="rounded-[9px] border px-[18px] py-[11px] text-[14px] font-semibold text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
                >
                  Cancel
                </button>
              )}
            </div>
          </form>
        </div>
        {reviewModal}
      </>
    );
  }

  // ── EDIT mode ─────────────────────────────────────────────────────────────────────────────────
  const pendingReviewCount = state.fields.filter(
    (f) => !f.raw && fieldStatus(f, state.baseline) !== "clean",
  ).length;

  return (
    <>
      <form
        id="module-builder"
        className="space-y-5"
        onSubmit={(e) => {
          e.preventDefault();
          void review();
        }}
      >
        {/* ── Amber dirty banner ── */}
        {dirty && (
          <div
            className="flex items-center gap-3 rounded-lg px-[14px] py-[11px]"
            style={{
              background: "color-mix(in srgb,var(--amber,#c77d1a) 8%,transparent)",
              borderBottom: "1px solid color-mix(in srgb,var(--amber,#c77d1a) 26%,transparent)",
            }}
          >
            <AlertTriangle
              className="h-4 w-4 flex-shrink-0"
              style={{ color: "var(--amber,#c77d1a)" }}
            />
            <span className="text-[13px] text-foreground">
              <strong className="font-bold">
                {pendingCount > 0
                  ? `${pendingCount} unsaved change${pendingCount === 1 ? "" : "s"}`
                  : "Unsaved edits"}
              </strong>{" "}
              <span className="text-muted-foreground">— draft not yet applied to the database</span>
            </span>
            <div className="flex-1" />
            <button
              type="button"
              onClick={discard}
              disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-[8px] border bg-card px-[13px] py-[7px] text-[12.5px] font-semibold text-muted-foreground transition-colors hover:text-foreground disabled:opacity-60"
            >
              <RotateCcw className="h-[13px] w-[13px]" />
              Discard all
            </button>
          </div>
        )}

        {/* ── Locked module options (2-col grid) ── */}
        <div
          className="grid grid-cols-2 gap-px overflow-hidden rounded-[12px] border"
          style={{ background: "hsl(var(--border))" }}
        >
          {(
            [
              {
                id: "dp",
                label: "Draft & Publish",
                desc: "Two-step publish flow",
                value: state.draftAndPublish,
                color: "var(--teal, #0f9d8f)",
              },
              {
                id: "i18n",
                label: "Internationalization",
                desc: "Per-locale content variants",
                value: state.i18n,
                color: "hsl(var(--primary))",
              },
            ] as const
          ).map((opt) => (
            <div key={opt.id} className="flex items-center gap-[11px] bg-card p-[13px]">
              <span
                className="flex h-[30px] w-[30px] flex-shrink-0 items-center justify-center rounded-[8px]"
                style={{
                  background: `color-mix(in srgb,${opt.color} 14%,transparent)`,
                  color: opt.color,
                }}
              >
                {opt.id === "dp" ? (
                  <svg
                    width="15"
                    height="15"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.9"
                  >
                    <path d="M12 2v6M12 8l3-2M12 8l-3-2M5 12h14v8a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2z" />
                  </svg>
                ) : (
                  <svg
                    width="15"
                    height="15"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.9"
                  >
                    <path d="M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18M3 12h18M4 7h16M4 17h16" />
                  </svg>
                )}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 text-[13px] font-semibold">
                  {opt.label}
                  <Lock className="h-[11px] w-[11px] text-muted-foreground/40" />
                </div>
                <div className="mt-[1px] text-[11.5px] text-muted-foreground">{opt.desc}</div>
              </div>
              <span
                className="relative flex h-[22px] w-[38px] flex-shrink-0 rounded-[12px]"
                style={{
                  background: opt.value ? "hsl(var(--primary))" : "hsl(var(--border))",
                  opacity: 0.6,
                }}
              >
                <span
                  className="absolute top-[2.5px] h-[17px] w-[17px] rounded-full bg-white shadow-sm transition-[left]"
                  style={{ left: opt.value ? "18px" : "2.5px" }}
                />
              </span>
            </div>
          ))}
        </div>

        {/* ── Fields section ── */}
        <div data-builder>
          {liveAuthorable.length === 0 && !pickerOpen ? (
            <EmptyFieldsState onAdd={() => setPickerOpen(true)} />
          ) : (
            <>
              {/* Fields header */}
              <div className="mx-[2px] mb-[11px] flex items-center justify-between">
                <div className="flex items-baseline gap-2.5">
                  <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/60">
                    Fields
                  </span>
                  <span className="font-mono text-[12px] text-muted-foreground/60">
                    {liveAuthorable.length}
                  </span>
                  {pendingReviewCount > 0 && (
                    <span
                      className="rounded-[5px] px-[7px] py-[2px] font-mono text-[11px]"
                      style={{
                        color: "var(--amber,#c77d1a)",
                        background: "color-mix(in srgb,var(--amber,#c77d1a) 12%,transparent)",
                      }}
                    >
                      {pendingReviewCount} in review
                    </span>
                  )}
                </div>
                {liveAuthorable.length > 1 && (
                  <span className="flex items-center gap-1 text-[11.5px] text-muted-foreground/50">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                      <circle cx="9" cy="6" r="1.4" />
                      <circle cx="15" cy="6" r="1.4" />
                      <circle cx="9" cy="12" r="1.4" />
                      <circle cx="15" cy="12" r="1.4" />
                      <circle cx="9" cy="18" r="1.4" />
                      <circle cx="15" cy="18" r="1.4" />
                    </svg>
                    {dragKey ? "dragging…" : "drag to reorder"}
                  </span>
                )}
              </div>

              {/* Field rows */}
              <div className="flex flex-col gap-[7px]">
                {authorable.map((draft) => (
                  <FieldCard
                    key={draft.key}
                    draft={draft}
                    status={fieldStatus(draft, state.baseline)}
                    i18n={state.i18n}
                    siblingNames={liveAuthorable
                      .filter((f) => f.key !== draft.key)
                      .map((f) => f.name)
                      .filter((n) => n.trim() !== "")}
                    componentNames={componentNames}
                    expanded={expandedKey === draft.key}
                    onToggle={() => toggleExpand(draft.key)}
                    onChange={(next) => setFieldAt(draft.key, next)}
                    onDelete={() => {
                      deleteField(draft.key);
                      setExpandedKey(null);
                    }}
                    onRestore={() => restoreField(draft.key)}
                    drag={{
                      draggable: true,
                      isDragging: dragKey === draft.key,
                      isOver: overKey === draft.key && dragKey !== null && dragKey !== draft.key,
                      onHandlePointerDown: () => grabHandle(draft.key),
                      onDragStart: (e) => {
                        if (!armed.current) {
                          e.preventDefault();
                          return;
                        }
                        e.dataTransfer.effectAllowed = "move";
                        setDragKey(draft.key);
                      },
                      onDragOver: (e) => {
                        if (dragKey === null) return;
                        e.preventDefault();
                        if (overKey !== draft.key) setOverKey(draft.key);
                      },
                      onDrop: () => {
                        if (dragKey) reorderField(dragKey, draft.key);
                        endDrag();
                      },
                      onDragEnd: endDrag,
                    }}
                  />
                ))}

                {pickerOpen && (
                  <TypePicker onPick={pickType} onClose={() => setPickerOpen(false)} />
                )}

                {!pickerOpen && (
                  <button
                    type="button"
                    onClick={() => setPickerOpen(true)}
                    className="flex w-full items-center justify-center gap-2 rounded-[11px] border-[1.5px] border-dashed py-[13px] font-mono text-[12.5px] font-semibold transition-colors hover:bg-primary/5"
                    style={{
                      borderColor: "color-mix(in srgb,hsl(var(--primary)) 30%,transparent)",
                      color: "hsl(var(--primary))",
                    }}
                  >
                    <Plus className="h-[14px] w-[14px]" />
                    add field
                  </button>
                )}
              </div>
            </>
          )}

          {rawFields.length > 0 && <AuthoredInCode fields={rawFields} />}
        </div>

        <RelationsEditor
          relations={state.relations}
          relationBaseline={state.relationBaseline}
          onChange={(relations) => patch({ relations })}
          moduleName={moduleDisplayName}
          targets={targets}
          targetLabels={targetLabels}
          targetFields={{
            ...moduleFields,
            ...(state.name.trim()
              ? {
                  [state.name.trim()]: liveAuthorable
                    .map((f) => f.name)
                    .filter((n) => n.trim() !== ""),
                }
              : {}),
          }}
        />

        {error && (
          <p
            className="flex items-center gap-1.5 text-[13px]"
            style={{ color: "hsl(var(--destructive))" }}
          >
            <AlertTriangle className="h-3.5 w-3.5" />
            {error}
          </p>
        )}

        {/* ── Danger zone (delete module) ── */}
        {onDeleteModule && (
          <div className="border-t pt-5">
            <button
              type="button"
              onClick={onDeleteModule}
              className="inline-flex items-center gap-1.5 rounded-[8px] border px-[11px] py-[7px] text-[12.5px] font-semibold transition-colors hover:bg-destructive/5"
              style={{
                borderColor: "color-mix(in srgb,hsl(var(--destructive)) 30%,transparent)",
                color: "hsl(var(--destructive))",
              }}
            >
              <Trash2 className="h-[13px] w-[13px]" />
              Delete module
            </button>
          </div>
        )}
      </form>
      <ModeSwitcher mode={canvasMode} onChange={setCanvasMode} />
      {reviewModal}
    </>
  );
}

/** Empty fields state: "Clean slate" — centered prompt with dashed add-first-field CTA. */
function EmptyFieldsState({ onAdd }: { onAdd: () => void }) {
  return (
    <div
      className="flex flex-col items-center justify-center py-12 text-center"
      style={{ animation: "lmbUp .4s ease" }}
    >
      <p className="mb-[15px] font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/60">
        Fields · 0
      </p>
      <h2 className="mb-[9px] font-display text-[23px] font-semibold tracking-[-0.02em]">
        Clean slate
      </h2>
      <p className="mx-auto mb-[21px] max-w-[410px] text-[13.5px] leading-[1.55] text-muted-foreground">
        Module created. Add your first field — string, relation, media, and more.
      </p>
      <button
        type="button"
        onClick={onAdd}
        className="inline-flex items-center gap-2 rounded-[10px] px-[19px] py-[13px] text-[14px] font-semibold transition-colors"
        style={{
          border: "1.5px dashed color-mix(in srgb,hsl(var(--primary)) 34%,transparent)",
          color: "hsl(var(--primary))",
        }}
      >
        <Plus className="h-[15px] w-[15px]" />
        Add your first field
      </button>
    </div>
  );
}

/** Read-only "Authored in code" zone for components / dynamic zones / inline relations. */
function AuthoredInCode({ fields }: { fields: FieldDraft[] }) {
  return (
    <div className="mt-7">
      <div
        className="overflow-hidden rounded-[13px] border"
        style={{
          background:
            "repeating-linear-gradient(45deg,hsl(var(--card)),hsl(var(--card)) 9px,color-mix(in srgb,hsl(var(--border)) 40%,transparent) 9px,color-mix(in srgb,hsl(var(--border)) 40%,transparent) 18px)",
        }}
      >
        {/* Zone header */}
        <div className="flex items-center gap-[10px] border-b bg-card px-[15px] py-[12px]">
          <span
            className="flex h-[28px] w-[28px] flex-shrink-0 items-center justify-center rounded-[7px]"
            style={{
              background: "color-mix(in srgb,hsl(var(--muted-foreground)) 14%,transparent)",
              color: "hsl(var(--muted-foreground))",
            }}
          >
            <Code2 className="h-[14px] w-[14px]" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-semibold">Authored in code</div>
            <div className="text-[11.5px] text-muted-foreground">
              preserved on save · visual editing coming soon
            </div>
          </div>
          <span className="rounded-[6px] border bg-card px-[8px] py-[3px] font-mono text-[10px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
            READ-ONLY
          </span>
        </div>
        {/* Field rows */}
        <div className="bg-card">
          {fields.map((f) => (
            <div
              key={f.key}
              className="flex items-center gap-3 border-b px-[15px] py-3 last:border-b-0"
            >
              <div className="min-w-0 flex-1">
                <div className="font-mono text-[13px] font-medium">{f.raw?.name}</div>
              </div>
              <span className="rounded-md bg-muted px-2 py-[3px] font-mono text-[11px] text-muted-foreground">
                {f.raw?.type}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
