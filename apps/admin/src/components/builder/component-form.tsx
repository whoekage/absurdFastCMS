import { useQueryClient } from "@tanstack/react-query";
import { useBlocker } from "@tanstack/react-router";
import { AlertTriangle, Plus, Trash2 } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { FieldCard } from "@/components/builder/field-card";
import { TypePicker } from "@/components/builder/type-picker";
import { toast } from "@/components/ui/toast";
import { BuilderError, saveComponent } from "@/lib/builder-client";
import {
  type ComponentFormState,
  componentKeys,
  emptyFieldDraft,
  errorMessage,
  type FieldDraft,
  fieldStatus,
  formToComponentDraft,
  slugify,
  validateComponentForm,
} from "@/lib/module-draft";
import { builderKeys } from "@/lib/module-draft";
import type { BuilderFieldType } from "@/lib/field-types";

interface ComponentState {
  dirty: boolean;
  busy: boolean;
}

interface ComponentFormProps {
  mode: "create" | "edit";
  initial: ComponentFormState;
  version: string;
  /** Other component names — for the create-time uniqueness check. */
  allComponentNames: string[];
  onStateChange?: (state: ComponentState) => void;
  onCancel?: () => void;
  onDeleteComponent?: () => void;
  onSaved: () => void;
}

/**
 * The component editor body: a name (create only) + the nested-field list, reusing the SAME field cards /
 * config / type picker as the module builder (a component's fields are plain scalar/media fields). Unlike a
 * module, a component has no table — saving never migrates, so there is no destructive-change review: a valid
 * draft is written straight through `saveComponent`.
 */
export function ComponentForm({ mode, initial, version, allComponentNames, onStateChange, onCancel, onDeleteComponent, onSaved }: ComponentFormProps) {
  const queryClient = useQueryClient();
  const [state, setState] = useState<ComponentFormState>(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [overKey, setOverKey] = useState<string | null>(null);
  const armed = useRef(false);
  const nameManuallyEdited = useRef(false);

  const isEdit = mode === "edit";

  const patch = (p: Partial<ComponentFormState>) => setState((s) => ({ ...s, ...p }));
  const setFieldAt = (key: string, next: FieldDraft) =>
    setState((s) => ({ ...s, fields: s.fields.map((f) => (f.key === key ? next : f)) }));

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

  // Drag-reorder (mirrors the module builder).
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

  const dirty = useMemo(
    () => JSON.stringify(formToComponentDraft(state)) !== JSON.stringify(formToComponentDraft(initial)),
    [state, initial],
  );

  // Report state to the parent (drives the header Save CTA).
  const reportRef = useRef<ComponentState>({ dirty: false, busy: false });
  if (reportRef.current.dirty !== dirty || reportRef.current.busy !== busy) {
    reportRef.current = { dirty, busy };
    queueMicrotask(() => onStateChange?.({ dirty, busy }));
  }

  const guarded = dirty;
  useBlocker({
    shouldBlockFn: () => !window.confirm("You have unsaved changes. Leave without saving them?"),
    enableBeforeUnload: false,
    disabled: !guarded,
  });

  async function save(): Promise<void> {
    setError(null);
    const validationError = validateComponentForm(state, allComponentNames);
    if (validationError) {
      setError(validationError);
      return;
    }
    setBusy(true);
    try {
      await saveComponent(state.name.trim(), formToComponentDraft(state), version, { idempotencyKey: crypto.randomUUID() });
      await queryClient.invalidateQueries({ queryKey: componentKeys.all });
      await queryClient.invalidateQueries({ queryKey: builderKeys.all }); // a module may reference this component
      toast.success(isEdit ? `Component "${state.name}" updated` : `Component "${state.name}" created`);
      onSaved();
    } catch (err) {
      if (err instanceof BuilderError && err.isStale) {
        setError("The catalog changed elsewhere since you opened this. Reload and try again.");
      } else {
        setError(errorMessage(err));
      }
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const live = state.fields.filter((f) => !f.deleted && !f.raw);
  const rawFields = state.fields.filter((f) => f.raw);

  return (
    <form
      id="component-builder"
      className="space-y-5"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      {/* name (create only — the api name is locked once the file exists) */}
      {!isEdit && (
        <div className="rounded-[14px] border bg-card p-[26px] shadow-lg">
          <p className="mb-[7px] font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/60">
            Define component
          </p>
          <h2 className="mb-[18px] font-display text-[22px] font-semibold tracking-[-0.025em]">New component</h2>
          <label className="mb-1.5 block font-mono text-[11px] text-muted-foreground">name</label>
          <input
            autoFocus
            value={state.name}
            onChange={(e) => {
              nameManuallyEdited.current = true;
              patch({ name: nameManuallyEdited.current ? e.target.value : slugify(e.target.value) });
            }}
            placeholder="e.g. seo"
            className="h-[43px] w-full max-w-[320px] rounded-[9px] border bg-background px-[13px] font-mono text-[14px] text-foreground outline-none"
          />
        </div>
      )}

      {/* fields */}
      <div data-builder>
        <div className="mx-[2px] mb-[11px] flex items-baseline gap-2.5">
          <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/60">
            Component fields
          </span>
          <span className="font-mono text-[12px] text-muted-foreground/60">{live.length}</span>
        </div>

        <div className="flex flex-col gap-[7px]">
          {state.fields
            .filter((f) => !f.raw)
            .map((draft) => (
              <FieldCard
                key={draft.key}
                draft={draft}
                status={fieldStatus(draft, state.baseline)}
                i18n={false}
                siblingNames={live
                  .filter((f) => f.key !== draft.key)
                  .map((f) => f.name)
                  .filter((n) => n.trim() !== "")}
                componentNames={allComponentNames}
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

          {pickerOpen && <TypePicker onPick={pickType} onClose={() => setPickerOpen(false)} />}

          {!pickerOpen && (
            <button
              type="button"
              onClick={() => setPickerOpen(true)}
              className="flex w-full items-center justify-center gap-2 rounded-[11px] border-[1.5px] border-dashed py-[13px] font-mono text-[12.5px] font-semibold transition-colors hover:bg-primary/5"
              style={{ borderColor: "color-mix(in srgb,hsl(var(--primary)) 30%,transparent)", color: "hsl(var(--primary))" }}
            >
              <Plus className="h-[14px] w-[14px]" />
              add field
            </button>
          )}
        </div>

        {rawFields.length > 0 && (
          <p className="mt-3 text-[11.5px] text-muted-foreground">
            {rawFields.length} field{rawFields.length === 1 ? "" : "s"} authored in code (nested component / relation) are
            preserved on save.
          </p>
        )}
      </div>

      {error && (
        <p className="flex items-center gap-1.5 text-[13px]" style={{ color: "hsl(var(--destructive))" }}>
          <AlertTriangle className="h-3.5 w-3.5" />
          {error}
        </p>
      )}

      {/* actions */}
      <div className="flex items-center gap-[11px] border-t pt-5">
        <button
          type="submit"
          disabled={busy || !dirty}
          className="inline-flex items-center gap-[7px] rounded-[9px] px-[18px] py-[11px] text-[14px] font-semibold text-background transition-opacity hover:opacity-90 disabled:opacity-50"
          style={{ background: "hsl(var(--foreground))" }}
        >
          {busy ? "Saving…" : isEdit ? "Save changes" : "Create component"}
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
        <div className="flex-1" />
        {onDeleteComponent && (
          <button
            type="button"
            onClick={onDeleteComponent}
            className="inline-flex items-center gap-1.5 rounded-[8px] border px-[11px] py-[7px] text-[12.5px] font-semibold transition-colors hover:bg-destructive/5"
            style={{ borderColor: "color-mix(in srgb,hsl(var(--destructive)) 30%,transparent)", color: "hsl(var(--destructive))" }}
          >
            <Trash2 className="h-[13px] w-[13px]" />
            Delete component
          </button>
        )}
      </div>
    </form>
  );
}
