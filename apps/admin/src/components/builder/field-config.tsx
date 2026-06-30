import { useState } from 'react';
import { Plus, Trash2, X, SlidersHorizontal } from 'lucide-react';
import type { FieldDraft } from '@/lib/module-draft';
import type { FieldCondition } from '@/lib/builder-client';
import { optionMetaFor } from '@/lib/field-types';
import { Switch } from '@/components/ui/switch';

interface FieldConfigProps {
  draft: FieldDraft;
  /** Module-level i18n flag — gates the per-field localized note. */
  i18n: boolean;
  /** Names of the OTHER live fields (the conditional-visibility "show when" source list). */
  siblingNames: string[];
  onChange: (next: FieldDraft) => void;
  onDelete: () => void;
  onDone: () => void;
}

const LABEL = 'mb-1.5 block text-[11px] font-semibold text-muted-foreground';
const INPUT =
  'w-full rounded-lg border bg-card px-[11px] py-[9px] text-[13px] text-foreground outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20';
const MONO_INPUT = `${INPUT} font-mono text-[12.5px]`;

/** A two-option segmented control (editor width, media count). */
function Segmented({ options }: { options: { label: string; active: boolean; onPick: () => void }[] }) {
  return (
    <div className="flex rounded-lg border bg-card p-[3px]">
      {options.map((o) => (
        <button
          key={o.label}
          type="button"
          onClick={o.onPick}
          className="flex-1 rounded-md border-none px-3.5 py-1.5 text-[12.5px] font-semibold transition-colors"
          style={
            o.active
              ? { background: 'color-mix(in srgb, hsl(var(--primary)) 14%, transparent)', color: 'hsl(var(--primary))' }
              : { background: 'transparent', color: 'hsl(var(--muted-foreground))' }
          }
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/**
 * The expanded inline configuration body for one field card: name + default, the type-specific
 * controls (enum values / min·max length / numeric bounds / precision·scale / media count), the
 * Required + Unique toggles, the per-field localized note, editor-width + conditional-visibility, and
 * the Delete / Done actions. Mirrors the Lua design's expanded field row.
 */
export function FieldConfig({ draft, i18n, siblingNames, onChange, onDelete, onDone }: FieldConfigProps) {
  const meta = optionMetaFor(draft.type);
  const set = (patch: Partial<FieldDraft>) => onChange({ ...draft, ...patch });

  return (
    <div
      className="border-t px-[15px] pb-[15px] pt-4"
      style={{ background: 'color-mix(in srgb, hsl(var(--muted)) 45%, transparent)', animation: 'lmbExpand .2s ease' }}
    >
      {/* name + default (media carries no constant default — the backend codegen can't express one) */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={LABEL}>Name</label>
          <input className={MONO_INPUT} value={draft.name} onChange={(e) => set({ name: e.target.value })} placeholder="field_name" />
        </div>
        {draft.type !== 'media' && (
          <div>
            <label className={LABEL}>Default value</label>
            <input className={INPUT} value={draft.defaultValue} onChange={(e) => set({ defaultValue: e.target.value })} placeholder="—" />
          </div>
        )}
      </div>

      {/* type-specific */}
      {meta.enumValues && <EnumValues values={draft.enumValues} onChange={(enumValues) => set({ enumValues })} />}

      {meta.length && (
        <div className="mt-3 grid grid-cols-2 gap-3">
          <div>
            <label className={LABEL}>Min length</label>
            <input className={MONO_INPUT} value={draft.min} onChange={(e) => set({ min: e.target.value })} placeholder="0" inputMode="numeric" />
          </div>
          <div>
            <label className={LABEL}>Max length</label>
            <input className={MONO_INPUT} value={draft.length} onChange={(e) => set({ length: e.target.value })} placeholder="—" inputMode="numeric" />
          </div>
        </div>
      )}

      {meta.numericBounds && (
        <div className="mt-3 grid grid-cols-2 gap-3">
          <div>
            <label className={LABEL}>Min value</label>
            <input className={MONO_INPUT} value={draft.min} onChange={(e) => set({ min: e.target.value })} placeholder="—" inputMode="numeric" />
          </div>
          <div>
            <label className={LABEL}>Max value</label>
            <input className={MONO_INPUT} value={draft.max} onChange={(e) => set({ max: e.target.value })} placeholder="—" inputMode="numeric" />
          </div>
        </div>
      )}

      {meta.dateBounds && (
        <div className="mt-3 grid grid-cols-2 gap-3">
          <div>
            <label className={LABEL}>Earliest</label>
            <input className={MONO_INPUT} value={draft.min} onChange={(e) => set({ min: e.target.value })} placeholder="$now(-1 year)" />
          </div>
          <div>
            <label className={LABEL}>Latest</label>
            <input className={MONO_INPUT} value={draft.max} onChange={(e) => set({ max: e.target.value })} placeholder="$now" />
          </div>
        </div>
      )}

      {meta.precisionScale && (
        <div className="mt-3 grid grid-cols-2 gap-3">
          <div>
            <label className={LABEL}>Precision</label>
            <input className={MONO_INPUT} value={draft.precision} onChange={(e) => set({ precision: e.target.value })} placeholder="10" inputMode="numeric" />
          </div>
          <div>
            <label className={LABEL}>Scale</label>
            <input className={MONO_INPUT} value={draft.scale} onChange={(e) => set({ scale: e.target.value })} placeholder="2" inputMode="numeric" />
          </div>
        </div>
      )}

      {meta.multiple && (
        <div className="mt-3">
          <label className={LABEL}>Allowed count</label>
          <div className="inline-flex">
            <Segmented
              options={[
                { label: 'Single', active: !draft.multiple, onPick: () => set({ multiple: false }) },
                { label: 'Multiple', active: draft.multiple, onPick: () => set({ multiple: true }) },
              ]}
            />
          </div>
        </div>
      )}

      {meta.mediaTypes && (
        <div className="mt-3">
          <label className={LABEL}>Allowed file types</label>
          <div className="flex flex-wrap gap-1.5">
            {(['images', 'videos', 'audios', 'files'] as const).map((cat) => {
              const on = draft.allowedTypes.includes(cat);
              return (
                <button
                  key={cat}
                  type="button"
                  onClick={() =>
                    set({ allowedTypes: on ? draft.allowedTypes.filter((t) => t !== cat) : [...draft.allowedTypes, cat] })
                  }
                  className="rounded-[7px] border px-2.5 py-1 text-[12px] font-medium capitalize transition-colors"
                  style={
                    on
                      ? { background: 'color-mix(in srgb, hsl(var(--primary)) 14%, transparent)', color: 'hsl(var(--primary))', borderColor: 'color-mix(in srgb, hsl(var(--primary)) 30%, transparent)' }
                      : { color: 'hsl(var(--muted-foreground))' }
                  }
                >
                  {cat}
                </button>
              );
            })}
          </div>
          <p className="mt-1.5 text-[11px] text-muted-foreground">
            {draft.allowedTypes.length === 0 ? 'Any file type allowed.' : 'Only the selected categories are accepted.'}
          </p>
        </div>
      )}

      {meta.mediaTypes && draft.multiple && (
        <div className="mt-3 grid grid-cols-2 gap-3">
          <div>
            <label className={LABEL}>Min items</label>
            <input className={MONO_INPUT} value={draft.minItems} onChange={(e) => set({ minItems: e.target.value })} placeholder="0" inputMode="numeric" />
          </div>
          <div>
            <label className={LABEL}>Max items</label>
            <input className={MONO_INPUT} value={draft.maxItems} onChange={(e) => set({ maxItems: e.target.value })} placeholder="—" inputMode="numeric" />
          </div>
        </div>
      )}

      {meta.arrayItems && (
        <>
          <div className="mt-3 grid grid-cols-2 gap-3">
            <div>
              <label className={LABEL}>Min items</label>
              <input className={MONO_INPUT} value={draft.minItems} onChange={(e) => set({ minItems: e.target.value })} placeholder="0" inputMode="numeric" />
            </div>
            <div>
              <label className={LABEL}>Max items</label>
              <input className={MONO_INPUT} value={draft.maxItems} onChange={(e) => set({ maxItems: e.target.value })} placeholder="—" inputMode="numeric" />
            </div>
          </div>
          <label className="mt-3 flex items-center gap-2">
            <Switch checked={draft.uniqueItems} onCheckedChange={(v) => set({ uniqueItems: v })} />
            <span className="text-[12.5px] font-medium text-foreground">Unique items</span>
          </label>
        </>
      )}

      {meta.pattern && (
        <div className="mt-3 space-y-3">
          <div className="flex gap-3">
            <div className="flex-1">
              <label className={LABEL}>Pattern (regex)</label>
              <input className={MONO_INPUT} value={draft.pattern} onChange={(e) => set({ pattern: e.target.value })} placeholder="^[a-z0-9-]+$" />
            </div>
            <div className="w-[80px]">
              <label className={LABEL}>Flags</label>
              <input className={MONO_INPUT} value={draft.patternFlags} onChange={(e) => set({ patternFlags: e.target.value })} placeholder="i" />
            </div>
          </div>
          <div>
            <label className={LABEL}>Validation message</label>
            <input className={INPUT} value={draft.patternMessage} onChange={(e) => set({ patternMessage: e.target.value })} placeholder="Shown when the value doesn’t match" />
          </div>
          <p className="text-[11px] text-muted-foreground">
            Full-match (the server wraps it as <span className="font-mono">^(?:…)$</span>) · flags from <span className="font-mono">imsu</span> only.
          </p>
        </div>
      )}

      {/* toggles */}
      <div className="mt-[15px] flex flex-wrap items-center gap-x-[18px] gap-y-3 border-t pt-3.5">
        <label className="flex items-center gap-2">
          <Switch checked={!draft.nullable} onCheckedChange={(v) => set({ nullable: !v })} />
          <span className="text-[12.5px] font-medium text-foreground">Required</span>
        </label>
        {meta.unique && (
          <label className="flex items-center gap-2">
            <Switch checked={draft.unique} onCheckedChange={(v) => set({ unique: v })} />
            <span className="text-[12.5px] font-medium text-foreground">Unique</span>
          </label>
        )}
        <label className="flex items-center gap-2" title="Write-only: hidden from all read responses">
          <Switch checked={draft.isPrivate} onCheckedChange={(v) => set({ isPrivate: v })} />
          <span className="text-[12.5px] font-medium text-foreground">Private</span>
        </label>
        {i18n && (
          <label className="flex items-center gap-2">
            <Switch checked={draft.localized} onCheckedChange={(v) => set({ localized: v })} />
            <span className="text-[12.5px] font-medium text-foreground">Localized</span>
          </label>
        )}
      </div>

      {/* layout + conditional */}
      <div className="mt-[15px] grid grid-cols-2 gap-3">
        <div>
          <label className={LABEL}>Editor width</label>
          <Segmented
            options={[
              { label: 'Full', active: !draft.half, onPick: () => set({ half: false }) },
              { label: 'Half', active: draft.half, onPick: () => set({ half: true }) },
            ]}
          />
        </div>
        <ConditionalControl
          condition={draft.condition}
          siblingNames={siblingNames}
          onChange={(condition) => onChange(condition ? { ...draft, condition } : omitCondition(draft))}
        />
      </div>

      {/* actions */}
      <div className="mt-4 flex items-center justify-between">
        <button
          type="button"
          onClick={onDelete}
          className="flex items-center gap-1.5 rounded-lg border px-[11px] py-[7px] text-[12.5px] font-semibold transition-colors"
          style={{ borderColor: 'color-mix(in srgb, hsl(var(--destructive)) 30%, transparent)', color: 'hsl(var(--destructive))' }}
        >
          <Trash2 className="h-[13px] w-[13px]" />
          Delete field
        </button>
        <button
          type="button"
          onClick={onDone}
          className="rounded-lg border-none bg-primary px-3.5 py-[7px] text-[12.5px] font-bold text-primary-foreground transition hover:brightness-105"
        >
          Done
        </button>
      </div>
    </div>
  );
}

/** Drop the `condition` key (exactOptional-safe — can't assign `undefined`). */
function omitCondition(draft: FieldDraft): FieldDraft {
  const { condition: _drop, ...rest } = draft;
  return rest;
}

/** Editable enum-value chips (each a small mono input) + an "add value" button. */
function EnumValues({ values, onChange }: { values: string[]; onChange: (values: string[]) => void }) {
  return (
    <div className="mt-3">
      <label className={LABEL}>Enumeration values</label>
      <div className="flex flex-wrap items-center gap-1.5">
        {values.map((v, i) => (
          <span key={i} className="inline-flex items-center gap-1.5 rounded-[7px] border bg-card px-2 py-1">
            <input
              className="w-[88px] border-none bg-transparent font-mono text-[12px] text-foreground outline-none"
              value={v}
              placeholder="value"
              onChange={(e) => onChange(values.map((x, j) => (j === i ? e.target.value : x)))}
            />
            <button type="button" onClick={() => onChange(values.filter((_, j) => j !== i))} style={{ color: 'var(--faint)' }}>
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
        <button
          type="button"
          onClick={() => onChange([...values, ''])}
          className="inline-flex items-center gap-1 rounded-[7px] border border-dashed px-2 py-1 text-[12px] text-muted-foreground"
        >
          <Plus className="h-[11px] w-[11px]" />
          value
        </button>
      </div>
    </div>
  );
}

/** The conditional-visibility control: a summary button that expands a compact rule editor. */
function ConditionalControl({
  condition,
  siblingNames,
  onChange,
}: {
  condition: FieldCondition | undefined;
  siblingNames: string[];
  onChange: (c: FieldCondition | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const label = condition
    ? `${condition.action} when ${condition.field} ${condition.op === 'eq' ? '=' : '≠'} ${String(condition.value)}`
    : 'Always visible';

  const start = (): FieldCondition => condition ?? { field: siblingNames[0] ?? '', op: 'eq', value: '', action: 'show' };

  return (
    <div>
      <label className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold text-muted-foreground">
        Conditional
        <span className="rounded-[4px] border bg-card px-1.5 py-px text-[9.5px] font-semibold" style={{ color: 'var(--faint)' }}>
          show when
        </span>
      </label>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        disabled={siblingNames.length === 0}
        className="flex w-full items-center gap-1.5 truncate rounded-lg border bg-card px-[11px] py-2 text-[12.5px] text-muted-foreground transition-colors hover:text-foreground disabled:opacity-60"
      >
        <SlidersHorizontal className="h-[13px] w-[13px] flex-shrink-0" />
        <span className="truncate">{siblingNames.length === 0 ? 'Add another field first' : label}</span>
      </button>

      {open && siblingNames.length > 0 && (
        <div className="mt-2 space-y-2 rounded-lg border bg-card p-2.5" style={{ animation: 'lmbExpand .15s ease' }}>
          <div className="grid grid-cols-2 gap-2">
            <select
              className={MONO_INPUT}
              value={start().field}
              onChange={(e) => onChange({ ...start(), field: e.target.value })}
            >
              {siblingNames.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
            <select
              className={INPUT}
              value={start().op}
              onChange={(e) => onChange({ ...start(), op: e.target.value as 'eq' | 'ne' })}
            >
              <option value="eq">equals</option>
              <option value="ne">not equals</option>
            </select>
          </div>
          <input
            className={INPUT}
            placeholder="value"
            value={String(start().value)}
            onChange={(e) => onChange({ ...start(), value: e.target.value })}
          />
          <div className="flex items-center justify-between gap-2">
            <select
              className={INPUT}
              value={start().action}
              onChange={(e) => onChange({ ...start(), action: e.target.value as 'show' | 'hide' })}
            >
              <option value="show">show this field</option>
              <option value="hide">hide this field</option>
            </select>
            <button
              type="button"
              onClick={() => {
                onChange(null);
                setOpen(false);
              }}
              className="flex-shrink-0 rounded-lg border px-3 py-2 text-[12px] font-semibold text-muted-foreground"
            >
              Clear
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
