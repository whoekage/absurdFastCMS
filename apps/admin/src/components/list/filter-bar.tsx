import { Plus, X } from 'lucide-react';
import type { ModuleDefinition, FieldDefinition, FilterOperator } from '@conti/sdk';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  OPERATOR_LABELS,
  defaultValueForOp,
  isFilterableField,
  operatorsForField,
  type FilterRow,
} from '@/lib/list-filters';
import { FilterValueInput } from './filter-value-input';

// ──────────────────────────────────────────────────────────────────────────────────────────────
// The FILTER BAR: add / remove filter rows of (field → operator → value). The available operators
// are GATED by the chosen field's type (operatorsForField). Rows are combined with `$and`
// downstream (buildFilters). All edits flow up via `onChange` — the parent commits them to the URL
// search params (the canonical store).
// ──────────────────────────────────────────────────────────────────────────────────────────────

interface FilterBarProps {
  def: ModuleDefinition;
  byName: Map<string, FieldDefinition>;
  rows: FilterRow[];
  onChange: (rows: FilterRow[]) => void;
}

/**
 * The user-facing, filterable fields. System id/timestamps are excluded from the field picker, as
 * are json/array fields — the API rejects ALL filtering on json columns, so offering them would
 * guarantee a 400 (see {@link isFilterableField}).
 */
function filterableFields(def: ModuleDefinition): FieldDefinition[] {
  return def.fields.filter((f) => !f.system && isFilterableField(f));
}

export function FilterBar({ def, byName, rows, onChange }: FilterBarProps) {
  const fields = filterableFields(def);
  if (fields.length === 0) return null;

  const addRow = () => {
    const first = fields[0];
    if (!first) return;
    const ops = operatorsForField(first);
    const op = (ops[0] ?? '$eq') as FilterOperator;
    onChange([...rows, { field: first.name, op, value: defaultValueForOp(op) }]);
  };

  const updateRow = (index: number, next: FilterRow) => {
    onChange(rows.map((r, i) => (i === index ? next : r)));
  };

  const removeRow = (index: number) => {
    onChange(rows.filter((_, i) => i !== index));
  };

  return (
    <div className="space-y-2">
      {rows.map((row, i) => {
        const field = byName.get(row.field) ?? fields[0];
        if (!field) return null;
        const ops = operatorsForField(field);
        // Hardening: if the stored op is no longer valid for this field, fall back to the first.
        const op = (ops.includes(row.op as FilterOperator) ? row.op : ops[0]) as FilterOperator;

        return (
          <div key={i} className="flex flex-wrap items-center gap-2">
            {/* Field picker — switching the field re-gates the operator + resets the value. */}
            <div className="w-44">
              <Select
                value={row.field}
                onValueChange={(name) => {
                  const nextField = byName.get(name);
                  const nextOps = nextField ? operatorsForField(nextField) : ops;
                  const nextOp = (nextOps[0] ?? '$eq') as FilterOperator;
                  updateRow(i, { field: name, op: nextOp, value: defaultValueForOp(nextOp) });
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {fields.map((f) => (
                    <SelectItem key={f.name} value={f.name}>
                      {f.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Operator picker — GATED by the field's type. */}
            <div className="w-48">
              <Select
                value={op}
                onValueChange={(nextOp) =>
                  updateRow(i, {
                    field: row.field,
                    op: nextOp,
                    value: defaultValueForOp(nextOp as FilterOperator),
                  })
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ops.map((o) => (
                    <SelectItem key={o} value={o}>
                      {OPERATOR_LABELS[o]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Value input — per type + operator arity. */}
            <FilterValueInput
              field={field}
              op={op}
              value={row.value}
              onChange={(value) => updateRow(i, { field: row.field, op, value })}
            />

            <Button
              variant="ghost"
              size="icon"
              title="Remove filter"
              onClick={() => removeRow(i)}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        );
      })}

      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={addRow}>
          <Plus className="h-4 w-4" />
          Add filter
        </Button>
        {rows.length > 0 ? (
          <Button variant="ghost" size="sm" onClick={() => onChange([])}>
            Clear filters
          </Button>
        ) : null}
      </div>
    </div>
  );
}
