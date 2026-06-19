import { Trash2, X, Plus } from 'lucide-react';
import type { CmsType } from '@absurd/sdk';
import { BUILDER_CMS_TYPES, optionMetaFor } from '@/lib/field-types';
import type { FieldDraft } from '@/lib/content-types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

interface FieldRowEditorProps {
  draft: FieldDraft;
  onChange: (next: FieldDraft) => void;
  /** Render a remove button (create form has many rows; edit-field dialog has one — omit there). */
  onRemove?: (() => void) | undefined;
  /** Lock the field name (e.g. the edit dialog may still allow rename — leave editable by default). */
  disabled?: boolean | undefined;
  /** When the type is i18n, render a per-field Localized/Shared toggle (hidden otherwise). */
  i18n?: boolean | undefined;
}

/**
 * One editable field row: name + cmsType + conditional options (enum values / length /
 * precision+scale) + a nullable checkbox + an optional default. Shared by the create form, the
 * add-field dialog, and the edit-field dialog.
 */
export function FieldRowEditor({ draft, onChange, onRemove, disabled, i18n }: FieldRowEditorProps) {
  const meta = optionMetaFor(draft.cmsType);
  const set = (patch: Partial<FieldDraft>) => onChange({ ...draft, ...patch });

  return (
    <div className="space-y-3 rounded-md border p-4">
      <div className="flex items-end gap-3">
        <div className="flex-1 space-y-1.5">
          <Label htmlFor={`${draft.key}-name`}>Name</Label>
          <Input
            id={`${draft.key}-name`}
            value={draft.name}
            placeholder="field_name"
            disabled={disabled === true}
            onChange={(e) => set({ name: e.target.value })}
          />
        </div>
        <div className="w-44 space-y-1.5">
          <Label htmlFor={`${draft.key}-type`}>Type</Label>
          <Select
            value={draft.cmsType}
            onValueChange={(v) => set({ cmsType: v as CmsType })}
            {...(disabled === true ? { disabled: true } : {})}
          >
            <SelectTrigger id={`${draft.key}-type`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {BUILDER_CMS_TYPES.map((t) => (
                <SelectItem key={t} value={t}>
                  {t}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {onRemove && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            title="Remove field"
            onClick={onRemove}
          >
            <Trash2 className="h-4 w-4 text-destructive" />
          </Button>
        )}
      </div>

      {meta.enumValues && (
        <EnumValuesEditor
          draftKey={draft.key}
          values={draft.enumValues}
          onChange={(values) => set({ enumValues: values })}
        />
      )}

      {meta.length && (
        <div className="w-40 space-y-1.5">
          <Label htmlFor={`${draft.key}-length`}>Length</Label>
          <Input
            id={`${draft.key}-length`}
            type="number"
            value={draft.length}
            placeholder="optional"
            onChange={(e) => set({ length: e.target.value })}
          />
        </div>
      )}

      {meta.precisionScale && (
        <div className="flex gap-3">
          <div className="w-40 space-y-1.5">
            <Label htmlFor={`${draft.key}-precision`}>Precision</Label>
            <Input
              id={`${draft.key}-precision`}
              type="number"
              value={draft.precision}
              placeholder="total digits"
              onChange={(e) => set({ precision: e.target.value })}
            />
          </div>
          <div className="w-40 space-y-1.5">
            <Label htmlFor={`${draft.key}-scale`}>Scale</Label>
            <Input
              id={`${draft.key}-scale`}
              type="number"
              value={draft.scale}
              placeholder="fraction digits"
              onChange={(e) => set({ scale: e.target.value })}
            />
          </div>
        </div>
      )}

      {meta.multiple && (
        <label className="flex items-center gap-2 text-sm" title="Multiple: this media field holds an ARRAY of assets. Unchecked = a single asset reference.">
          <input
            type="checkbox"
            className="h-4 w-4 rounded border-input"
            checked={draft.multiple}
            onChange={(e) => set({ multiple: e.target.checked })}
          />
          Multiple (asset array)
        </label>
      )}

      <div className="flex flex-wrap items-end gap-4">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="h-4 w-4 rounded border-input"
            checked={draft.nullable}
            onChange={(e) => set({ nullable: e.target.checked })}
          />
          Nullable
        </label>
        {i18n && (
          <label className="flex items-center gap-2 text-sm" title="Localized: a per-locale value. Unchecked = shared across all locale variants of a document.">
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-input"
              checked={draft.localized}
              onChange={(e) => set({ localized: e.target.checked })}
            />
            Localized
          </label>
        )}
        <div className="flex-1 space-y-1.5">
          <Label htmlFor={`${draft.key}-default`}>Default</Label>
          <Input
            id={`${draft.key}-default`}
            value={draft.defaultValue}
            placeholder="optional"
            onChange={(e) => set({ defaultValue: e.target.value })}
          />
        </div>
      </div>
    </div>
  );
}

function EnumValuesEditor({
  draftKey,
  values,
  onChange,
}: {
  draftKey: string;
  values: string[];
  onChange: (values: string[]) => void;
}) {
  const setAt = (index: number, value: string) => {
    onChange(values.map((v, i) => (i === index ? value : v)));
  };
  const removeAt = (index: number) => {
    onChange(values.filter((_, i) => i !== index));
  };

  return (
    <div className="space-y-2">
      <Label>Values</Label>
      {values.length === 0 && (
        <p className="text-xs text-muted-foreground">Add at least one enum value.</p>
      )}
      {values.map((value, index) => (
        <div key={`${draftKey}-enum-${index}`} className="flex items-center gap-2">
          <Input
            value={value}
            placeholder={`value ${index + 1}`}
            onChange={(e) => setAt(index, e.target.value)}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            title="Remove value"
            onClick={() => removeAt(index)}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => onChange([...values, ''])}
      >
        <Plus className="h-4 w-4" />
        Add value
      </Button>
    </div>
  );
}
