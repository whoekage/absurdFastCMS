import { Plus, Trash2, Info } from 'lucide-react';
import type { RelationKind } from '@/lib/builder-client';
import { type RelationDraft, emptyRelationDraft } from '@/lib/module-draft';
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

/** The four relation kinds with human labels for the dropdown. */
const KIND_OPTIONS: { value: RelationKind; label: string }[] = [
  { value: 'oneToMany', label: 'one-to-many (this has many)' },
  { value: 'manyToOne', label: 'many-to-one (this belongs to one)' },
  { value: 'oneToOne', label: 'one-to-one' },
  { value: 'manyToMany', label: 'many-to-many' },
];

interface RelationRowsEditorProps {
  relations: RelationDraft[];
  onChange: (next: RelationDraft[]) => void;
  /** Candidate target module moduleNames (includes this module for self-refs). */
  targets: readonly string[];
}

/**
 * The relations section of the module form. Files-first: relations are part of the module draft and saved
 * ATOMICALLY with the fields via the single PUT (no per-relation mutation here). Each row declares a
 * field name, cardinality, target module, and an optional inverse field (→ two-way). The link table is
 * created server-side on apply.
 */
export function RelationRowsEditor({ relations, onChange, targets }: RelationRowsEditorProps) {
  const setAt = (key: string, patch: Partial<RelationDraft>) =>
    onChange(relations.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const removeAt = (key: string) => onChange(relations.filter((r) => r.key !== key));
  const add = () => onChange([...relations, emptyRelationDraft()]);

  return (
    <div className="space-y-4 rounded-md border p-4">
      <div>
        <h2 className="text-sm font-semibold">Relations</h2>
        <p className="mt-1 flex items-start gap-1.5 text-xs text-muted-foreground">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            Declare a relation to another module. The link table is created on apply and the relation goes
            live for the entry-form picker, populate, and deep filtering. Provide an inverse field name to
            make it two-way (a partner field appears on the target).
          </span>
        </p>
      </div>

      {relations.length === 0 && (
        <p className="text-xs text-muted-foreground">No relations declared on this module.</p>
      )}

      {relations.map((draft) => (
        <div key={draft.key} className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_1fr_1fr_1fr_auto] sm:items-end">
          <div className="space-y-1.5">
            <Label htmlFor={`${draft.key}-field`}>Field name</Label>
            <Input
              id={`${draft.key}-field`}
              value={draft.field}
              placeholder="author"
              onChange={(e) => setAt(draft.key, { field: e.target.value })}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${draft.key}-kind`}>Kind</Label>
            <Select value={draft.kind} onValueChange={(v) => setAt(draft.key, { kind: v as RelationKind })}>
              <SelectTrigger id={`${draft.key}-kind`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {KIND_OPTIONS.map((k) => (
                  <SelectItem key={k.value} value={k.value}>
                    {k.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${draft.key}-target`}>Target module</Label>
            <Select
              {...(draft.target === '' ? {} : { value: draft.target })}
              onValueChange={(v) => setAt(draft.key, { target: v })}
            >
              <SelectTrigger id={`${draft.key}-target`}>
                <SelectValue placeholder="Select…" />
              </SelectTrigger>
              <SelectContent>
                {targets.map((t) => (
                  <SelectItem key={t} value={t}>
                    {t}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${draft.key}-inverse`}>Inverse field</Label>
            <Input
              id={`${draft.key}-inverse`}
              value={draft.inverseField}
              placeholder="(optional, two-way)"
              onChange={(e) => setAt(draft.key, { inverseField: e.target.value })}
            />
          </div>
          <Button type="button" variant="ghost" size="icon" title="Remove relation" onClick={() => removeAt(draft.key)}>
            <Trash2 className="h-4 w-4 text-destructive" />
          </Button>
        </div>
      ))}

      <Button type="button" variant="outline" size="sm" onClick={add}>
        <Plus className="h-4 w-4" />
        Add relation
      </Button>
    </div>
  );
}
