import type { FieldOptions, ModuleDraft, RelationKind } from '@/lib/builder-client';

/**
 * A CLIENT-SIDE mirror of the API's `generateSchemaSource` (packages/api/src/db/schema/codegen.ts).
 * Used only for the live "schema.ts" preview tab — the AUTHORITATIVE generated source is the server's
 * `PreviewResult.generatedSource` shown at Review. Kept structurally identical (same `defineSchema` +
 * `c.*` shape, same option emission incl. `default`) so the preview matches the real written file. New
 * fields have no id yet (the server mints them) — we omit the `id:` line for those.
 */

const lit = (v: unknown): string => JSON.stringify(v);

function pascalCase(s: string): string {
  return s
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('');
}

type WireField = Omit<{ id: string; name: string; type: string; options?: FieldOptions; localized?: boolean }, 'id'> & { id?: string };
type WireRelation = { id?: string; field: string; kind: RelationKind; target: string; inverseField?: string; displayField?: string };

function fieldCall(f: WireField): string {
  const o = f.options ?? {};
  const id = f.id !== undefined ? `id: ${lit(f.id)}` : '';
  const nul = o.nullable === false ? ', nullable: false' : '';
  const def = o.default !== undefined ? `, default: ${lit(o.default)}` : '';
  const max = o.length !== undefined ? `, max: ${o.length}` : '';
  const min = o.min !== undefined ? `, min: ${o.min}` : '';
  const maxv = o.max !== undefined ? `, max: ${o.max}` : '';
  const dec = `${o.precision !== undefined ? `, precision: ${o.precision}` : ''}${o.scale !== undefined ? `, scale: ${o.scale}` : ''}`;
  const cm =
    (o.editorWidth !== undefined ? `, editorWidth: ${lit(o.editorWidth)}` : '') +
    (o.condition !== undefined ? `, condition: ${lit(o.condition)}` : '') +
    (o.unique ? `, unique: true` : '');
  // The option run per type (mirrors the server's fieldBuilderCall switch).
  const body =
    f.type === 'string' || f.type === 'email' || f.type === 'uid' ? `${max}${min}${nul}${def}${cm}`
    : f.type === 'integer' || f.type === 'float' ? `${nul}${def}${min}${maxv}${cm}`
    : f.type === 'decimal' ? `${dec}${nul}${def}${cm}`
    : f.type === 'media' ? `${o.multiple ? ', multiple: true' : ''}${nul}${cm}`
    : f.type === 'enumeration' || f.type === 'uuid' || f.type === 'date' || f.type === 'datetime' || f.type === 'json' || f.type === 'text' || f.type === 'boolean' ? `${nul}${def}${cm}`
    : `${nul}${cm}`;
  const inner = `${id}${body}`.replace(/^, /, ''); // drop a leading comma when there's no id
  if (f.type === 'enumeration') return `c.enum(${lit(o.values ?? [])} as const, { ${inner} })`;
  return `c.${f.type}({ ${inner} })`;
}

function relationCall(r: WireRelation): string {
  const id = r.id !== undefined ? `id: ${lit(r.id)}, ` : '';
  const inv = r.inverseField !== undefined ? `, inverse: ${lit(r.inverseField)}` : '';
  const disp = r.displayField !== undefined ? `, displayField: ${lit(r.displayField)}` : '';
  return `c.relation(${lit(r.target)}, { ${id}kind: ${lit(r.kind)}${inv}${disp} })`;
}

/** Generate the `schema.ts` source for a draft (mirrors the server codegen; preview-only). */
export function generateSchemaSourceMirror(draft: ModuleDraft): string {
  const name = pascalCase(draft.name || 'Untitled');
  const lines: string[] = ["import { defineSchema, c } from '@conti/core';", '', `const ${name} = defineSchema({`];
  if (draft.id !== undefined) lines.push(`  id: ${lit(draft.id)},`);
  if (draft.label !== undefined && draft.label !== '') lines.push(`  label: ${lit(draft.label)},`);
  if (draft.options !== undefined) {
    const parts: string[] = [];
    if (draft.options.draftAndPublish !== undefined) parts.push(`draftAndPublish: ${draft.options.draftAndPublish}`);
    if (draft.options.i18n !== undefined) parts.push(`i18n: ${draft.options.i18n}`);
    if (parts.length > 0) lines.push(`  options: { ${parts.join(', ')} },`);
  }
  lines.push('  fields: {');
  for (const f of draft.fields) lines.push(`    ${f.name || 'field'}: ${fieldCall(f as WireField)},`);
  for (const r of draft.relations ?? []) lines.push(`    ${r.field || 'relation'}: ${relationCall(r as WireRelation)},`);
  lines.push('  },', '});', '', `export default ${name};`);
  return lines.join('\n');
}
