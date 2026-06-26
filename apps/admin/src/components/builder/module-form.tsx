import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Plus, Eye, ChevronLeft } from 'lucide-react';
import {
  type ModuleFormState,
  type FieldDraft,
  emptyFieldDraft,
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
import { FieldRowEditor } from '@/components/field-row-editor';
import { RelationRowsEditor } from '@/components/relation-rows-editor';
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
  /** Every existing module apiId (relation targets + apiId-uniqueness check). */
  allModuleApiIds: string[];
  /** Called after a successful apply with the save result (route navigates / refreshes). */
  onSaved: (result: SaveResult) => void;
}

/**
 * The shared module editor (create + edit) with the files-first SAVE flow:
 *   edit → Review (dry-run preview) → see the diff (safe vs destructive) → Apply (PUT: write schema.ts +
 *   migrate + live-swap). Destructive changes are gated behind an explicit ack; FORBIDDEN ones can't apply.
 * Optimistic concurrency rides the catalog `version` (If-Match); a 412 means someone else edited.
 */
export function ModuleForm({ mode, initial, version, allModuleApiIds, onSaved }: ModuleFormProps) {
  const queryClient = useQueryClient();
  const [state, setState] = useState<ModuleFormState>(initial);
  const [phase, setPhase] = useState<'editing' | 'reviewing'>('editing');
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [allowDestructive, setAllowDestructive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const isEdit = mode === 'edit';
  // Relation targets: every module plus this one (self-ref); on create the apiId isn't saved yet.
  const targets = [...new Set([state.apiId.trim(), ...allModuleApiIds])].filter((t) => t !== '');

  const patch = (p: Partial<ModuleFormState>) => setState((s) => ({ ...s, ...p }));
  const setFieldAt = (key: string, next: FieldDraft) =>
    setState((s) => ({ ...s, fields: s.fields.map((f) => (f.key === key ? next : f)) }));
  const removeField = (key: string) =>
    setState((s) => ({ ...s, fields: s.fields.filter((f) => f.key !== key) }));
  const addField = () => setState((s) => ({ ...s, fields: [...s.fields, emptyFieldDraft()] }));

  async function review(): Promise<void> {
    setError(null);
    const validationError = validateModuleForm(state, allModuleApiIds);
    if (validationError) {
      setError(validationError);
      return;
    }
    setBusy(true);
    try {
      const result = await previewModule(state.apiId.trim(), formToModuleDraft(state), false);
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
      const result = await saveModule(state.apiId.trim(), formToModuleDraft(state), version, {
        allowDestructive,
        idempotencyKey: crypto.randomUUID(),
      });
      await queryClient.invalidateQueries({ queryKey: moduleKeys.all });
      await queryClient.invalidateQueries({ queryKey: builderKeys.all });
      toast.success(isEdit ? `Module "${state.apiId}" updated` : `Module "${state.apiId}" created`);
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

  // Split loaded fields: authorable (editable rows) vs. authored-in-code (component/dynamiczone/inline-relation).
  const authorable = state.fields.filter((f) => !f.raw);
  const rawFields = state.fields.filter((f) => f.raw);

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
          apiId={state.apiId.trim()}
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

  return (
    <form
      className="space-y-6"
      onSubmit={(e) => {
        e.preventDefault();
        void review();
      }}
    >
      <div className="max-w-sm space-y-1.5">
        <Label htmlFor="apiId">API ID</Label>
        <Input
          id="apiId"
          value={state.apiId}
          placeholder="e.g. product"
          disabled={isEdit}
          onChange={(e) => patch({ apiId: e.target.value })}
        />
        {isEdit && <p className="text-xs text-muted-foreground">Renaming a module's apiId isn't supported here yet.</p>}
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

      <div className="space-y-4">
        <h2 className="text-sm font-medium">Fields</h2>
        {authorable.map((draft) => (
          <FieldRowEditor
            key={draft.key}
            draft={draft}
            i18n={state.i18n}
            onChange={(next) => setFieldAt(draft.key, next)}
            onRemove={authorable.length > 1 ? () => removeField(draft.key) : undefined}
          />
        ))}
        <Button type="button" variant="outline" size="sm" onClick={addField}>
          <Plus className="h-4 w-4" />
          Add field
        </Button>

        {rawFields.length > 0 && (
          <div className="space-y-1.5 rounded-md border border-dashed p-3">
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

      <RelationRowsEditor
        relations={state.relations}
        onChange={(relations) => patch({ relations })}
        targets={targets}
      />

      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className="flex items-center gap-2 pt-2">
        <Button type="submit" disabled={busy}>
          <Eye className="h-4 w-4" />
          {busy ? 'Reviewing…' : 'Review changes'}
        </Button>
      </div>
    </form>
  );
}
