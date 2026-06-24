import { X } from 'lucide-react';
import type { FieldDefinition, FilterOperator } from '@conti/sdk';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  MULTI_OPERATORS,
  NULLARY_OPERATORS,
  RANGE_OPERATORS,
  fieldFilterKind,
} from '@/lib/list-filters';

// ──────────────────────────────────────────────────────────────────────────────────────────────
// The value editor for ONE filter row. Picks the right control from the field's cmsType (via its
// FilterKind) AND the operator's arity:
//   • nullary ($null/$notNull) → no input
//   • range ($between)         → two scalar inputs
//   • multi ($in/$notIn)       → enum multi-select (chips) or comma-ish multi-value list
//   • scalar                   → one input (boolean→true/false select, enum→single select, …)
// Values are STRINGS end-to-end (the search-param store + bigint/decimal precision); coercion to the
// wire form happens later in `buildFilters`.
// ──────────────────────────────────────────────────────────────────────────────────────────────

interface ValueInputProps {
  field: FieldDefinition;
  op: FilterOperator;
  value: string[];
  onChange: (value: string[]) => void;
  disabled?: boolean;
}

/** The HTML <input type> best matching a numeric/date field's cmsType. */
function htmlInputType(field: FieldDefinition): 'text' | 'number' | 'date' | 'datetime-local' | 'time' {
  switch (field.cmsType) {
    case 'integer':
    case 'float':
      return 'number';
    // biginteger / decimal stay TEXT so precision is never lost via a number input.
    case 'date':
      return 'date';
    case 'datetime':
      return 'datetime-local';
    case 'time':
      return 'time';
    default:
      return 'text';
  }
}

export function FilterValueInput({ field, op, value, onChange, disabled }: ValueInputProps) {
  const kind = fieldFilterKind(field);

  // Nullary — no value to edit.
  if (NULLARY_OPERATORS.has(op)) return null;

  // Boolean equals — true / false picker.
  if (kind === 'boolean' && op === '$eq') {
    return (
      <div className="w-32">
        <Select
          {...(value[0] ? { value: value[0] } : {})}
          onValueChange={(v) => onChange([v])}
          {...(disabled !== undefined ? { disabled } : {})}
        >
          <SelectTrigger>
            <SelectValue placeholder="value…" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="true">true</SelectItem>
            <SelectItem value="false">false</SelectItem>
          </SelectContent>
        </Select>
      </div>
    );
  }

  // Enum + a SET operator ($in / $notIn) — multi-select of enumValues.
  if (kind === 'enum' && MULTI_OPERATORS.has(op)) {
    const options = field.enumValues ?? [];
    return (
      <EnumMultiSelect
        options={options}
        value={value}
        onChange={onChange}
        {...(disabled !== undefined ? { disabled } : {})}
      />
    );
  }

  // Enum + scalar — single select of enumValues.
  if (kind === 'enum') {
    const options = field.enumValues ?? [];
    return (
      <div className="w-44">
        <Select
          {...(value[0] ? { value: value[0] } : {})}
          onValueChange={(v) => onChange([v])}
          {...(disabled !== undefined ? { disabled } : {})}
        >
          <SelectTrigger>
            <SelectValue placeholder="value…" />
          </SelectTrigger>
          <SelectContent>
            {options.map((o) => (
              <SelectItem key={o} value={o}>
                {o}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    );
  }

  const inputType = htmlInputType(field);

  // Range ($between) — two scalar inputs.
  if (RANGE_OPERATORS.has(op)) {
    return (
      <div className="flex items-center gap-1">
        <Input
          className="w-32"
          type={inputType}
          placeholder="from"
          value={value[0] ?? ''}
          onChange={(e) => onChange([e.target.value, value[1] ?? ''])}
          {...(disabled !== undefined ? { disabled } : {})}
        />
        <span className="text-muted-foreground">–</span>
        <Input
          className="w-32"
          type={inputType}
          placeholder="to"
          value={value[1] ?? ''}
          onChange={(e) => onChange([value[0] ?? '', e.target.value])}
          {...(disabled !== undefined ? { disabled } : {})}
        />
      </div>
    );
  }

  // Set operator on a non-enum (numeric/text) — a comma-separated multi-value list.
  if (MULTI_OPERATORS.has(op)) {
    return (
      <Input
        className="w-56"
        type="text"
        placeholder="comma,separated,values"
        value={value.join(',')}
        onChange={(e) =>
          onChange(
            e.target.value
              .split(',')
              .map((s) => s.trim())
              .filter((s) => s !== ''),
          )
        }
        {...(disabled !== undefined ? { disabled } : {})}
      />
    );
  }

  // Scalar — one input.
  return (
    <Input
      className="w-48"
      type={inputType}
      placeholder="value…"
      value={value[0] ?? ''}
      onChange={(e) => onChange([e.target.value])}
      {...(disabled !== undefined ? { disabled } : {})}
    />
  );
}

// ── enum multi-select ──────────────────────────────────────────────────────────────────────────
// Built from the existing <Select> primitive: each pick TOGGLES a member in/out of the value array,
// rendered back as removable chips. No new dependency (no popover/dropdown package needed).

function EnumMultiSelect({
  options,
  value,
  onChange,
  disabled,
}: {
  options: readonly string[];
  value: string[];
  onChange: (value: string[]) => void;
  disabled?: boolean;
}) {
  const toggle = (member: string) => {
    if (value.includes(member)) onChange(value.filter((v) => v !== member));
    else onChange([...value, member]);
  };

  return (
    <div className="flex flex-wrap items-center gap-1">
      <div className="w-40">
        <Select
          value=""
          onValueChange={toggle}
          {...(disabled !== undefined ? { disabled } : {})}
        >
          <SelectTrigger>
            <SelectValue placeholder="add value…" />
          </SelectTrigger>
          <SelectContent>
            {options.map((o) => (
              <SelectItem key={o} value={o}>
                {value.includes(o) ? `✓ ${o}` : o}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {value.map((v) => (
        <Badge key={v} variant="secondary" className="gap-1">
          {v}
          <button
            type="button"
            className="ml-0.5 rounded-sm hover:text-destructive"
            onClick={() => toggle(v)}
            aria-label={`Remove ${v}`}
          >
            <X className="h-3 w-3" />
          </button>
        </Badge>
      ))}
    </div>
  );
}
