import { useState, useRef, useEffect, useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useBlocker } from '@tanstack/react-router';
import { Plus, Eye, LayoutGrid, Lock, RotateCcw } from 'lucide-react';
import type { CmsType } from '@conti/sdk';
import {
  type ModuleFormState,
  type FieldDraft,
  emptyFieldDraft,
  fieldStatus,
  relationStatus,
  formToModuleDraft,
  validateModuleForm,
  errorMessage,
  builderKeys,
} from '@/lib/module-draft';
import {
  type PreviewResult,
  type SaveResult,
  BuilderError,
  previewModule,
  saveModule,
} from '@/lib/builder-client';
import { moduleKeys } from '@/lib/modules';
import { FieldCard } from '@/components/builder/field-card';
import { TypePicker } from '@/components/builder/type-picker';
import { RelationsEditor } from '@/components/builder/relations-editor';
import { ModeSwitcher, type BuilderMode } from '@/components/builder/mode-switcher';
import { PreviewMode } from '@/components/builder/preview-mode';
import { CodeMode } from '@/components/builder/code-mode';
import { generateSchemaSourceMirror } from '@/lib/schema-codegen-mirror';
import { ReviewModal } from '@/components/builder/review-modal';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { toast } from '@/components/ui/toast';

interface ModuleFormProps {
  mode: 'create' | 'edit';
  initial: ModuleFormState;
  /** Current catalog version (ETag) for the optimistic-concurrency If-Match. */
  version: string;
  /** Every existing module name (relation targets + name-uniqueness check). */
  allModuleNames: string[];
  /** name → human label for every existing module, so relation targets can show the label. */
  moduleLabels: Record<string, string>;
  /** name → its field names for every existing module (relation display-field chips). */
  moduleFields: Record<string, string[]>;
  /** Called after a successful apply with the save result (route navigates / refreshes). */
  onSaved: (result: SaveResult) => void;
}

/**
 * The shared module editor (create + edit) with the files-first SAVE flow:
 *   edit → Review (dry-run preview) → see the diff (safe vs destructive) → Apply (PUT: write schema.ts +
 *   migrate + live-swap). Destructive changes are gated behind an explicit ack; FORBIDDEN ones can't apply.
 * Optimistic concurrency rides the catalog `version` (If-Match); a 412 means someone else edited.
 */
export function ModuleForm({ mode, initial, version, allModuleNames, moduleLabels, moduleFields, onSaved }: ModuleFormProps) {
  const queryClient = useQueryClient();
  const [state, setState] = useState<ModuleFormState>(initial);
  const [phase, setPhase] = useState<'editing' | 'reviewing'>('editing');
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [allowDestructive, setAllowDestructive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Which field card is expanded (by key), and whether the type picker is open. */
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  /** Canvas mode: the fields/relations editor, the entry-form preview, or the schema.ts code. */
  const [canvasMode, setCanvasMode] = useState<BuilderMode>('build');
  /** Drag-reorder state. `armed` is a ref so dragstart fires reliably (no state-flush race). */
  const armed = useRef(false);
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [overKey, setOverKey] = useState<string | null>(null);

  const isEdit = mode === 'edit';
  // Relation targets: every module plus this one (self-ref); on create the name isn't saved yet.
  const targets = [...new Set([state.name.trim(), ...allModuleNames])].filter((t) => t !== '');
  // name → label for the target picker: other modules + this one (its own label, falling back to name).
  const targetLabels: Record<string, string> = {
    ...moduleLabels,
    ...(state.name.trim() ? { [state.name.trim()]: state.label.trim() || state.name.trim() } : {}),
  };
  const moduleDisplayName = state.label.trim() || state.name.trim() || 'Untitled';
  const moduleGlyph = (() => {
    const two = moduleDisplayName.replace(/[^a-zA-Z0-9]/g, '').slice(0, 2) || '?';
    return two.charAt(0).toUpperCase() + two.slice(1);
  })();

  const patch = (p: Partial<ModuleFormState>) => setState((s) => ({ ...s, ...p }));
  const setFieldAt = (key: string, next: FieldDraft) =>
    setState((s) => ({ ...s, fields: s.fields.map((f) => (f.key === key ? next : f)) }));

  /** Append a fresh field of the picked type, expand it, and close the picker. */
  const pickType = (type: CmsType) => {
    const draft = emptyFieldDraft(type);
    setState((s) => ({ ...s, fields: [...s.fields, draft] }));
    setExpandedKey(draft.key);
    setPickerOpen(false);
  };

  /** New field (no backend id) → removed outright; a loaded field → soft-deleted (restorable). */
  const deleteField = (key: string) =>
    setState((s) => ({
      ...s,
      fields: s.fields.flatMap((f) => {
        if (f.key !== key) return [f];
        return f.id === undefined ? [] : [{ ...f, deleted: true }];
      }),
    }));
  const restoreField = (key: string) => setFieldAt(key, { ...state.fields.find((f) => f.key === key)!, deleted: false });
  const toggleExpand = (key: string) => setExpandedKey((cur) => (cur === key ? null : key));

  // ── drag-reorder (native DnD, handle-gated via `armed`) ──
  const grabHandle = (key: string) => {
    armed.current = true;
    setExpandedKey((cur) => (cur === key ? null : cur)); // collapse the grabbed card so the drag image is the row
    const release = () => {
      armed.current = false;
      window.removeEventListener('pointerup', release);
    };
    window.addEventListener('pointerup', release);
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

  // ── dirty / pending-changes tracking (vs the form's initial state) ──
  const dirty = useMemo(
    () => JSON.stringify(formToModuleDraft(state)) !== JSON.stringify(formToModuleDraft(initial)),
    [state, initial],
  );
  const pendingCount =
    state.fields.filter((f) => !f.raw && fieldStatus(f, state.baseline) !== 'clean').length +
    state.relations.filter((r) => relationStatus(r, state.relationBaseline) !== 'clean').length;
  const discard = () => {
    if (!dirty) return;
    if (!window.confirm('Discard all unsaved changes to this module?')) return;
    setState(initial);
    setExpandedKey(null);
    setPickerOpen(false);
    setError(null);
  };

  // ── unsaved-changes guards: in-app navigation (TanStack) + browser unload (close/refresh/external) ──
  // `phase === 'reviewing'` is still "unsaved" until Apply succeeds (which navigates away).
  const guarded = dirty && phase === 'editing';
  useBlocker({
    shouldBlockFn: () => !window.confirm('You have unsaved changes. Leave without applying them?'),
    enableBeforeUnload: false,
    disabled: !guarded,
  });
  useEffect(() => {
    if (!guarded) return undefined;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
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
      setPhase('reviewing');
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
      toast.success(isEdit ? `Module "${state.label || state.name}" updated` : `Module "${state.label || state.name}" created`);
      onSaved(result);
    } catch (err) {
      if (err instanceof BuilderError && err.isStale) {
        setError('The schema changed elsewhere since you opened this. Reload the page and try again.');
      } else if (err instanceof BuilderError && err.isBusy) {
        setError('Another schema change is in progress — wait a moment and apply again.');
      } else {
        setError(errorMessage(err));
      }
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  // Split loaded fields: authorable (editable rows, incl. soft-deleted) vs. authored-in-code.
  const authorable = state.fields.filter((f) => !f.raw);
  const rawFields = state.fields.filter((f) => f.raw);
  // Live = not soft-deleted; drives the empty state + the conditional-visibility sibling list.
  const liveAuthorable = authorable.filter((f) => !f.deleted);
  const fieldCountLabel = `${liveAuthorable.length} ${liveAuthorable.length === 1 ? 'field' : 'fields'}`;

  // The migration review is a modal overlay (rendered from the build return below), not a separate page.
  const reviewModal =
    phase === 'reviewing' && preview ? (
      <ReviewModal
        preview={preview}
        name={state.name.trim()}
        isEdit={isEdit}
        allowDestructive={allowDestructive}
        onAllowDestructiveChange={setAllowDestructive}
        busy={busy}
        error={error}
        onCancel={() => {
          setPhase('editing');
          setError(null);
        }}
        onApply={() => void apply()}
      />
    ) : null;

  // Preview / Code canvas modes render from the live draft; Review stays in Build mode.
  if (canvasMode !== 'build') {
    const liveRelations = state.relations.filter((r) => !r.deleted);
    return (
      <>
        {canvasMode === 'preview' ? (
          <PreviewMode
            moduleName={moduleDisplayName}
            moduleGlyph={moduleGlyph}
            fields={liveAuthorable}
            relations={liveRelations}
            i18n={state.i18n}
            draftAndPublish={state.draftAndPublish}
          />
        ) : (
          <CodeMode source={generateSchemaSourceMirror(formToModuleDraft(state))} filename={`${state.name.trim() || 'untitled'}/schema.ts`} />
        )}
        <ModeSwitcher mode={canvasMode} onChange={setCanvasMode} />
        {reviewModal}
      </>
    );
  }

  return (
    <>
    <form
      className="space-y-6"
      onSubmit={(e) => {
        e.preventDefault();
        void review();
      }}
    >
      {dirty && (
        <div
          className="flex items-center justify-between rounded-lg border px-3.5 py-2.5"
          style={{ background: 'color-mix(in srgb, var(--warning) 8%, transparent)', borderColor: 'color-mix(in srgb, var(--warning) 26%, transparent)' }}
        >
          <span className="flex items-center gap-2 text-[13px] font-semibold" style={{ color: 'var(--warning)' }}>
            <span className="h-2 w-2 rounded-full" style={{ background: 'var(--warning)' }} />
            {pendingCount > 0 ? `${pendingCount} pending change${pendingCount === 1 ? '' : 's'}` : 'Unsaved edits'}
          </span>
          <button
            type="button"
            onClick={discard}
            disabled={busy}
            className="flex items-center gap-1.5 rounded-lg border bg-card px-3 py-1.5 text-[12.5px] font-semibold text-muted-foreground transition-colors hover:text-foreground disabled:opacity-60"
          >
            <RotateCcw className="h-[13px] w-[13px]" />
            Discard
          </button>
        </div>
      )}

      <div className="max-w-sm space-y-1.5">
        <Label htmlFor="name" className="flex items-center gap-2">
          Name
          {isEdit && <LockedPill />}
        </Label>
        <Input
          id="name"
          value={state.name}
          placeholder="e.g. product"
          disabled={isEdit}
          onChange={(e) => patch({ name: e.target.value })}
        />
        <p className="text-xs text-muted-foreground">
          {isEdit
            ? "The canonical name — used in URLs, code, and the table. Locked after creation."
            : 'Lowercase identifier used in URLs, code, and the table. Immutable after creation.'}
        </p>
      </div>

      <div className="max-w-sm space-y-1.5">
        <Label htmlFor="label">Label</Label>
        <Input
          id="label"
          value={state.label}
          placeholder={state.name.trim() || 'e.g. Products'}
          onChange={(e) => patch({ label: e.target.value })}
        />
        <p className="text-xs text-muted-foreground">How this module is shown in the admin. Defaults to the name.</p>
      </div>

      <div className="flex items-center justify-between rounded-md border p-3">
        <div className="space-y-0.5">
          <Label htmlFor="draftPublish" className="flex items-center gap-2">
            Draft &amp; Publish
            {isEdit && <LockedPill />}
          </Label>
          <p className="text-xs text-muted-foreground">
            Entries start as drafts, hidden until published.
            {isEdit ? ' Locked after creation.' : ''}
          </p>
        </div>
        <Switch
          id="draftPublish"
          checked={state.draftAndPublish}
          disabled={isEdit}
          onCheckedChange={(v) => patch({ draftAndPublish: v })}
        />
      </div>

      <div className="flex items-center justify-between rounded-md border p-3">
        <div className="space-y-0.5">
          <Label htmlFor="i18n" className="flex items-center gap-2">
            Internationalization (i18n)
            {isEdit && <LockedPill />}
          </Label>
          <p className="text-xs text-muted-foreground">
            Per-locale variants sharing a document; mark each field Localized or Shared.
            {isEdit ? ' Locked after creation.' : ''}
          </p>
        </div>
        <Switch id="i18n" checked={state.i18n} disabled={isEdit} onCheckedChange={(v) => patch({ i18n: v })} />
      </div>

      <div data-builder>
        {liveAuthorable.length === 0 && !pickerOpen ? (
          <EmptyFieldsState moduleName={state.label.trim() || state.name.trim() || 'Untitled'} onAdd={() => setPickerOpen(true)} />
        ) : (
          <>
            <div className="mx-1 mb-[11px] flex items-center justify-between">
              <div className="flex items-baseline gap-2.5">
                <h2 className="font-display text-[15px] font-semibold tracking-[-0.01em]">Fields</h2>
                <span className="font-mono text-[12px]" style={{ color: 'var(--faint)' }}>
                  {fieldCountLabel}
                </span>
              </div>
              {liveAuthorable.length > 1 && (
                <span className="text-[11.5px]" style={{ color: 'var(--faint)' }}>
                  drag to reorder
                </span>
              )}
            </div>

            <div className="flex flex-col gap-[7px]">
              {authorable.map((draft) => (
                <FieldCard
                  key={draft.key}
                  draft={draft}
                  status={fieldStatus(draft, state.baseline)}
                  i18n={state.i18n}
                  siblingNames={liveAuthorable.filter((f) => f.key !== draft.key).map((f) => f.name).filter((n) => n.trim() !== '')}
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
                      e.dataTransfer.effectAllowed = 'move';
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
                  className="flex w-full items-center justify-center gap-2 rounded-[11px] border-[1.5px] border-dashed py-[13px] text-[13.5px] font-semibold text-muted-foreground transition-colors hover:border-primary/40 hover:bg-primary/5 hover:text-primary"
                >
                  <Plus className="h-[15px] w-[15px]" />
                  Add field
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
          ...(state.name.trim() ? { [state.name.trim()]: liveAuthorable.map((f) => f.name).filter((n) => n.trim() !== '') } : {}),
        }}
      />

      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className="flex items-center gap-2 pt-2">
        <Button type="submit" disabled={busy}>
          <Eye className="h-4 w-4" />
          {busy ? 'Reviewing…' : 'Review changes'}
        </Button>
      </div>
    </form>
      <ModeSwitcher mode={canvasMode} onChange={setCanvasMode} />
      {reviewModal}
    </>
  );
}

/** The first-field empty state: a centered prompt with a dashed "Add your first field" CTA. */
function EmptyFieldsState({ moduleName, onAdd }: { moduleName: string; onAdd: () => void }) {
  return (
    <div className="mx-auto max-w-[720px] py-2 text-center" style={{ animation: 'lmbUp .4s ease' }}>
      <div className="mx-auto mb-[18px] flex h-[60px] w-[60px] items-center justify-center rounded-2xl border bg-card shadow-card">
        <LayoutGrid className="h-7 w-7" style={{ color: 'hsl(var(--primary))' }} strokeWidth={1.7} />
      </div>
      <h1 className="mb-[7px] font-display text-[25px] font-semibold tracking-[-0.02em]">
        Design your <span style={{ color: 'hsl(var(--primary))' }}>{moduleName}</span> module
      </h1>
      <p className="mx-auto max-w-[440px] text-[14.5px] leading-[1.6] text-muted-foreground">
        A module is a content type — its fields, relations and options. Add your first field to get started.
      </p>
      <button
        type="button"
        onClick={onAdd}
        className="mt-6 flex w-full items-center justify-center gap-2.5 rounded-[13px] border-[1.5px] border-dashed border-primary/30 bg-card py-4 text-[14px] font-semibold text-primary transition-colors hover:border-primary hover:bg-primary/5"
      >
        <Plus className="h-[17px] w-[17px]" />
        Add your first field
      </button>
    </div>
  );
}

/** A small "locked" chip for fields that are immutable after creation (name / D&P / i18n). */
function LockedPill() {
  return (
    <span
      className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-semibold"
      style={{ background: 'color-mix(in srgb, hsl(var(--muted)) 80%, transparent)', color: 'var(--faint)' }}
    >
      <Lock className="h-2.5 w-2.5" />
      locked
    </span>
  );
}

/** The read-only "Authored in code" zone: components / dynamic zones / inline relations the builder can't
 *  edit yet but preserves verbatim on save. */
function AuthoredInCode({ fields }: { fields: FieldDraft[] }) {
  return (
    <div className="mt-7">
      <div className="mx-1 mb-[11px] flex items-center gap-2">
        <h2 className="font-display text-[15px] font-semibold tracking-[-0.01em]">Authored in code</h2>
        <span className="inline-flex items-center gap-1 rounded-full border bg-muted px-2 py-0.5 text-[10.5px] font-semibold" style={{ color: 'var(--faint)' }}>
          <Lock className="h-2.5 w-2.5" />
          read-only
        </span>
      </div>
      <div
        className="overflow-hidden rounded-[13px] border"
        style={{ background: 'repeating-linear-gradient(135deg, hsl(var(--card)), hsl(var(--card)) 11px, color-mix(in srgb, hsl(var(--muted)) 50%, transparent) 11px, color-mix(in srgb, hsl(var(--muted)) 50%, transparent) 22px)' }}
      >
        <div className="bg-card">
          {fields.map((f) => (
            <div key={f.key} className="flex items-center gap-3 border-b px-[15px] py-3 last:border-b-0">
              <div className="min-w-0 flex-1">
                <div className="font-mono text-[13px] font-medium text-foreground">{f.raw?.name}</div>
                <div className="mt-px text-[11.5px] text-muted-foreground">Preserved verbatim on save — edit in the schema file</div>
              </div>
              <span className="rounded-md bg-muted px-2 py-[3px] font-mono text-[11px] text-muted-foreground">{f.raw?.type}</span>
            </div>
          ))}
        </div>
        <div className="flex items-center gap-2 px-[15px] py-2.5 text-[11.5px] text-muted-foreground">
          Components &amp; dynamic zones are preserved on save. <span className="font-semibold text-primary">Visual editing — coming soon.</span>
        </div>
      </div>
    </div>
  );
}
