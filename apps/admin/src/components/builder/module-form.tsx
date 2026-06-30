import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Plus, Eye, ChevronLeft, LayoutGrid } from 'lucide-react';
import type { CmsType } from '@conti/sdk';
import {
  type ModuleFormState,
  type FieldDraft,
  emptyFieldDraft,
  fieldStatus,
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
import { DiffPreview, hasForbidden } from '@/components/builder/diff-preview';
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

  if (phase === 'reviewing' && preview) {
    const blockedUnacked = preview.blocked.some((c) => c.risk !== 'forbidden') && !allowDestructive;
    const cannotApply = hasForbidden(preview) || blockedUnacked;
    return (
      <div className="space-y-6">
        <Button variant="ghost" size="sm" className="-ml-2" onClick={() => setPhase('editing')} disabled={busy}>
          <ChevronLeft className="h-4 w-4" />
          Back to editing
        </Button>
        <DiffPreview
          preview={preview}
          name={state.name.trim()}
          allowDestructive={allowDestructive}
          onAllowDestructiveChange={setAllowDestructive}
        />
        {error && <p className="text-sm text-destructive">{error}</p>}
        <div className="flex items-center gap-2">
          <Button onClick={() => void apply()} disabled={busy || cannotApply}>
            {busy ? 'Applying…' : isEdit ? 'Apply changes' : 'Create module'}
          </Button>
          <Button variant="outline" onClick={() => setPhase('editing')} disabled={busy}>
            Back
          </Button>
        </div>
      </div>
    );
  }

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
      <div className="max-w-sm space-y-1.5">
        <Label htmlFor="name">Name</Label>
        <Input
          id="name"
          value={state.name}
          placeholder="e.g. product"
          disabled={isEdit}
          onChange={(e) => patch({ name: e.target.value })}
        />
        <p className="text-xs text-muted-foreground">
          {isEdit
            ? "The canonical name — used in URLs, code, and the table. Can't be changed here yet."
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
          <Label htmlFor="draftPublish">Draft &amp; Publish</Label>
          <p className="text-xs text-muted-foreground">
            Entries start as drafts, hidden until published.
            {isEdit ? ' Toggling this on an existing module isn’t supported here.' : ''}
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
          <Label htmlFor="i18n">Internationalization (i18n)</Label>
          <p className="text-xs text-muted-foreground">
            Per-locale variants sharing a document; mark each field Localized or Shared.
            {isEdit ? ' Toggling this on an existing module isn’t supported here.' : ''}
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

        {rawFields.length > 0 && (
          <div className="mt-3 space-y-1.5 rounded-md border border-dashed p-3">
            <p className="text-xs text-muted-foreground">
              Authored in code (components / dynamic zones / inline relations) — preserved on save, edit in the
              schema file:
            </p>
            <ul className="flex flex-wrap gap-2">
              {rawFields.map((f) => (
                <li key={f.key} className="rounded bg-muted px-2 py-0.5 text-xs">
                  {f.raw?.name} · {f.raw?.type}
                </li>
              ))}
            </ul>
          </div>
        )}
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
