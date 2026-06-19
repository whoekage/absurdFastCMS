import { useEffect, useMemo, useRef, useState } from 'react';
import { useForm } from '@tanstack/react-form';
import { useBlocker } from '@tanstack/react-router';
import type { ContentTypeDefinition, FieldDefinition, RelationId, WriteBody } from '@absurd/sdk';
import { getFieldHandler, type FormFieldValue } from '@/lib/field-types';
import {
  asRelatedRows,
  buildSetOp,
  parseRelationId,
  type RelatedRow,
  type RelationFieldConfig,
} from '@/lib/relations';
import { RelationPicker } from '@/components/relation-picker';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

/** Fields the user may edit: everything that is not a system column (id/created_at/updated_at). */
export function editableFields(def: ContentTypeDefinition): FieldDefinition[] {
  return def.fields.filter((f) => !f.system);
}

/** The form's controlled values: one entry per editable field, keyed by field name. */
export type EntryFormValues = Record<string, FormFieldValue>;

/** Seed controlled values from an existing wire row (edit) or empties (create). */
export function buildInitialValues(
  def: ContentTypeDefinition,
  row?: Record<string, unknown>,
): EntryFormValues {
  const values: EntryFormValues = {};
  for (const field of editableFields(def)) {
    const handler = getFieldHandler(field.cmsType);
    if (row) {
      // Edit: seed from the existing row value.
      values[field.name] = handler.toForm(row[field.name]);
    } else if (field.default !== undefined) {
      // Create: prefill from the type definition's default (where the builder projects one).
      values[field.name] = handler.toForm(field.default);
    } else {
      values[field.name] = handler.emptyForm();
    }
  }
  return values;
}

/** The selected related-row ids for every configured relation field, keyed by field name. */
export type RelationSelections = Record<string, RelationId[]>;

/**
 * Seed relation selections from an existing row (edit) or empties (create). On edit, the row was loaded
 * with `?populate`, so each relation field holds the populated related rows (object/array) — we read
 * their ids. A bare un-populated id (number or array of numbers) is also tolerated.
 */
export function buildInitialRelations(
  relationFields: RelationFieldConfig[],
  row?: Record<string, unknown>,
): RelationSelections {
  const selections: RelationSelections = {};
  for (const rel of relationFields) {
    if (!row) {
      selections[rel.field] = [];
      continue;
    }
    const raw = row[rel.field];
    const rows = asRelatedRows(raw);
    if (rows.length > 0) {
      selections[rel.field] = rows
        .map((r) => parseRelationId(r.id))
        .filter((n): n is RelationId => n !== null);
    } else {
      // No populated rows — accept a bare id / id[] shorthand if that's what the row carried.
      const ids = (Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw])
        .map((v) => parseRelationId(v))
        .filter((n): n is RelationId => n !== null);
      selections[rel.field] = ids;
    }
  }
  return selections;
}

/** The populated related rows per relation field (used to label seeded selections in the picker). */
export function buildInitialRelationRows(
  relationFields: RelationFieldConfig[],
  row?: Record<string, unknown>,
): Record<string, RelatedRow[]> {
  const out: Record<string, RelatedRow[]> = {};
  for (const rel of relationFields) out[rel.field] = row ? asRelatedRows(row[rel.field]) : [];
  return out;
}

/** Lower the controlled form values back into a flat write body (wire-shaped scalars). */
export function toWriteBody(def: ContentTypeDefinition, values: EntryFormValues): WriteBody {
  const body: WriteBody = {};
  for (const field of editableFields(def)) {
    const handler = getFieldHandler(field.cmsType);
    const raw = values[field.name];
    const wire = handler.fromForm(raw ?? handler.emptyForm(), field);
    if (wire === undefined) continue; // skip unset optional fields
    body[field.name] = wire;
  }
  return body;
}

/**
 * Merge relation selections into a write body as relation-op fields (sibling keys to the scalars). We
 * emit a `{ set }` op REPLACING the related set: the picker always presents the full desired set, so a
 * `set` matches its semantics exactly (to-one → `{ set: [id] }` / `{ set: [] }`; to-many → `{ set: ids }`).
 */
export function applyRelationOps(
  body: WriteBody,
  relationFields: RelationFieldConfig[],
  selections: RelationSelections,
): WriteBody {
  for (const rel of relationFields) {
    body[rel.field] = buildSetOp(selections[rel.field] ?? [], rel.cardinality);
  }
  return body;
}

interface EntryFormProps {
  def: ContentTypeDefinition;
  initialValues: EntryFormValues;
  /** Configured relation fields for this type (empty when none / the API can't declare them). */
  relationFields?: RelationFieldConfig[];
  /** Seed selections for the relation fields (ids), e.g. from a populated edit row. */
  initialRelations?: RelationSelections;
  /** Seed populated rows per relation field (to label the seeded selections in the picker). */
  initialRelationRows?: Record<string, RelatedRow[]>;
  submitLabel: string;
  pending: boolean;
  onSubmit: (body: WriteBody) => void;
  onCancel: () => void;
}

export function EntryForm({
  def,
  initialValues,
  relationFields = [],
  initialRelations,
  initialRelationRows,
  submitLabel,
  pending,
  onSubmit,
  onCancel,
}: EntryFormProps) {
  const fields = useMemo(() => editableFields(def), [def]);
  const relations = useRelationSelectionsState(relationFields, initialRelations);

  // Once we submit, the imminent success redirect must NOT be blocked. We flip this on submit and
  // re-arm it below if the mutation FAILS — otherwise a failed save would disable the guard forever.
  const submittedRef = useRef(false);

  const form = useForm({
    defaultValues: initialValues,
    onSubmit: ({ value }) => {
      submittedRef.current = true;
      const body = applyRelationOps(toWriteBody(def, value), relationFields, relations.selections);
      onSubmit(body);
    },
  });

  // A submit that finishes while we're still mounted must have FAILED (success navigates away, so the
  // form unmounts before this runs). Re-arm the guard so the user can't then leave with unsaved edits.
  const wasPending = useRef(false);
  useEffect(() => {
    if (wasPending.current && !pending) submittedRef.current = false;
    wasPending.current = pending;
  }, [pending]);

  // Unsaved-changes guard: while the form is dirty (and not yet submitted), block route changes and
  // browser unload. `withResolver` surfaces a resolver so we can show our own confirm dialog.
  const blocker = useBlocker({
    shouldBlockFn: () => (form.state.isDirty || relations.dirty) && !submittedRef.current,
    enableBeforeUnload: () => (form.state.isDirty || relations.dirty) && !submittedRef.current,
    withResolver: true,
  });

  return (
    <>
    <form
      onSubmit={(e) => {
        e.preventDefault();
        e.stopPropagation();
        void form.handleSubmit();
      }}
      className="space-y-5"
    >
      {fields.map((field) => {
        const handler = getFieldHandler(field.cmsType);
        return (
          <form.Field
            key={field.name}
            name={field.name}
            validators={{
              onChange: ({ value }) => {
                const result = handler.zod(field).safeParse(value);
                if (result.success) return undefined;
                return result.error.issues[0]?.message ?? 'Invalid value';
              },
            }}
          >
            {(fieldApi) => {
              const errors = fieldApi.state.meta.errors;
              const errorText =
                errors.length > 0 && typeof errors[0] === 'string' ? errors[0] : undefined;
              const fieldId = `field-${field.name}`;
              return (
                <div className="space-y-1.5">
                  <Label htmlFor={fieldId}>
                    {field.name}
                    {!field.nullable && <span className="ml-0.5 text-destructive">*</span>}
                    <span className="ml-2 text-xs font-normal text-muted-foreground">
                      {field.cmsType}
                    </span>
                    {/* i18n: a shared field's value is synced across every locale variant (editing it on
                        ANY variant updates all). Localized fields are per-variant. */}
                    {def.i18n === true && field.localized === false && (
                      <span
                        className="ml-2 text-xs font-normal text-muted-foreground/80"
                        title="Shared across all locale variants — editing here updates every locale."
                      >
                        shared
                      </span>
                    )}
                  </Label>
                  {handler.input({
                    id: fieldId,
                    field,
                    value: fieldApi.state.value,
                    onChange: (v) => fieldApi.handleChange(v),
                    onBlur: () => fieldApi.handleBlur(),
                    disabled: pending,
                  })}
                  {errorText && <p className="text-xs text-destructive">{errorText}</p>}
                </div>
              );
            }}
          </form.Field>
        );
      })}

      {/* Relation fields — discovered from the API definition (def.relations, surfaced by the caller as
          relationFields). Each picker searches its target type and emits a `{ set }` relation op into
          the write body on submit. */}
      {relationFields.map((rel) => {
        const fieldId = `relation-${rel.field}`;
        return (
          <div key={rel.field} className="space-y-1.5">
            <Label htmlFor={fieldId}>
              {rel.field}
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                relation · {rel.cardinality === 'toOne' ? 'to-one' : 'to-many'} · → {rel.target}
              </span>
            </Label>
            <RelationPicker
              id={fieldId}
              config={rel}
              value={relations.selections[rel.field] ?? []}
              {...(initialRelationRows?.[rel.field]
                ? { initialRows: initialRelationRows[rel.field] }
                : {})}
              onChange={(ids) => relations.set(rel.field, ids)}
              disabled={pending}
            />
          </div>
        );
      })}

      <div className="flex items-center gap-2 pt-2">
        <Button type="submit" disabled={pending}>
          {pending ? 'Saving…' : submitLabel}
        </Button>
        <Button type="button" variant="outline" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
      </div>
    </form>

      <Dialog
        open={blocker.status === 'blocked'}
        onOpenChange={(open) => {
          // Closing the dialog any other way (overlay / X / Escape) means "stay on the page".
          if (!open && blocker.status === 'blocked') blocker.reset();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Discard unsaved changes?</DialogTitle>
            <DialogDescription>
              You have unsaved changes on this form. If you leave now, they will be lost.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                if (blocker.status === 'blocked') blocker.reset();
              }}
            >
              Keep editing
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => {
                if (blocker.status === 'blocked') blocker.proceed();
              }}
            >
              Discard changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** The relation-selection state hook: per-field id arrays + a `dirty` flag (diff vs. the seed). */
interface RelationSelectionsState {
  selections: RelationSelections;
  dirty: boolean;
  set: (field: string, ids: RelationId[]) => void;
}

function useRelationSelectionsState(
  relationFields: RelationFieldConfig[],
  initial: RelationSelections | undefined,
): RelationSelectionsState {
  const seed = useMemo<RelationSelections>(() => {
    const out: RelationSelections = {};
    for (const rel of relationFields) out[rel.field] = initial?.[rel.field] ?? [];
    return out;
    // `relationFields`/`initial` are stable per form mount (derived from the loaded def + row).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [relationFields]);

  const [selections, setSelections] = useState<RelationSelections>(seed);

  const set = (field: string, ids: RelationId[]): void => {
    setSelections((prev) => ({ ...prev, [field]: ids }));
  };

  // Dirty when any relation field's id set differs from its seed (order-insensitive).
  const dirty = relationFields.some((rel) => {
    const cur = selections[rel.field] ?? [];
    const base = seed[rel.field] ?? [];
    if (cur.length !== base.length) return true;
    const baseSet = new Set(base);
    return cur.some((id) => !baseSet.has(id));
  });

  return { selections, dirty, set };
}
