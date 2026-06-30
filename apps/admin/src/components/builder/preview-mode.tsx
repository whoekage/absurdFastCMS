import type { ReactNode } from 'react';
import { ChevronDown, ImageIcon, Globe } from 'lucide-react';
import { type FieldDraft, type RelationDraft, draftCardinality, cardinalityCard } from '@/lib/module-draft';

interface PreviewModeProps {
  moduleName: string;
  moduleGlyph: string;
  /** Live (non-deleted) authorable fields, in order. */
  fields: FieldDraft[];
  /** Live (non-deleted) relations. */
  relations: RelationDraft[];
  i18n: boolean;
  draftAndPublish: boolean;
}

/** machine_name → "Machine Name". */
function labelize(name: string): string {
  return name.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) || 'Field';
}

const FIELD_BOX = 'rounded-[9px] border bg-background';

/**
 * The "Preview" canvas mode: renders the current draft AS THE ENTRY FORM an editor would see — a 2-column
 * grid honouring half-width, required `*`, and per-type read-only widgets with sample values. A locale pill
 * (i18n) and a Draft badge (draft&publish) sit in the header. Pixel-matches the Lua design.
 */
export function PreviewMode({ moduleName, moduleGlyph, fields, relations, i18n, draftAndPublish }: PreviewModeProps) {
  return (
    <div className="mx-auto max-w-[720px]" style={{ animation: 'lmbUp .3s ease' }}>
      <div className="overflow-hidden rounded-[15px] border bg-card shadow-card">
        {/* header */}
        <div className="flex items-center justify-between gap-3 border-b px-5 py-[18px]">
          <div className="flex min-w-0 items-center gap-2.5">
            <span
              className="flex h-[38px] w-[38px] flex-shrink-0 items-center justify-center rounded-[11px] font-mono text-[14px] font-semibold text-white"
              style={{ background: 'linear-gradient(150deg, hsl(var(--primary)), var(--violet))' }}
            >
              {moduleGlyph}
            </span>
            <div className="min-w-0">
              <div className="font-display text-[17px] font-semibold tracking-[-0.01em]">New {moduleName.toLowerCase()}</div>
              <div className="text-[11.5px]" style={{ color: 'var(--faint)' }}>
                This is exactly what your editors see
              </div>
            </div>
          </div>
          <div className="flex flex-shrink-0 items-center gap-2">
            {i18n && (
              <span
                className="flex items-center gap-1.5 rounded-full border px-2.5 py-[5px]"
                style={{ background: 'color-mix(in srgb, var(--info) 10%, transparent)', borderColor: 'color-mix(in srgb, var(--info) 26%, transparent)' }}
              >
                <Globe className="h-[13px] w-[13px]" style={{ color: 'var(--info)' }} />
                <span className="text-[11.5px] font-bold" style={{ color: 'var(--info)' }}>
                  EN
                </span>
              </span>
            )}
            {draftAndPublish && (
              <span
                className="rounded-full px-2.5 py-1 text-[11.5px] font-semibold"
                style={{ color: 'var(--warning)', background: 'color-mix(in srgb, var(--warning) 13%, transparent)' }}
              >
                Draft
              </span>
            )}
          </div>
        </div>

        {/* fields grid */}
        {fields.length === 0 && relations.length === 0 ? (
          <div className="px-5 py-10 text-center text-[13px] text-muted-foreground">Add a field to see the editor form.</div>
        ) : (
          <div className="grid grid-cols-2 gap-4 p-5">
            {fields.map((f) => (
              <PreviewField key={f.key} field={f} />
            ))}
            {relations.map((r) => (
              <div key={r.key} className="col-span-2">
                <PreviewLabel text={labelize(r.field)} required={false} />
                <RelationChips relation={r} />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function PreviewLabel({ text, required }: { text: string; required: boolean }) {
  return (
    <label className="mb-[7px] flex items-center gap-1.5 text-[12px] font-semibold text-foreground">
      {text}
      {required && <span style={{ color: 'hsl(var(--destructive))' }}>*</span>}
    </label>
  );
}

function PreviewField({ field }: { field: FieldDraft }) {
  const span = field.half ? 'col-span-1' : 'col-span-2';
  return (
    <div className={span}>
      <PreviewLabel text={labelize(field.name)} required={!field.nullable} />
      <PreviewWidget field={field} />
    </div>
  );
}

function PreviewWidget({ field }: { field: FieldDraft }): ReactNode {
  const v = field.defaultValue.trim();
  switch (field.type) {
    case 'text':
      return (
        <div className={`${FIELD_BOX} min-h-[74px] px-[13px] py-[11px] text-[13.5px] leading-[1.55] text-foreground`}>
          {v || 'Lorem ipsum dolor sit amet, consectetur adipiscing elit…'}
        </div>
      );
    case 'uid':
      return (
        <div className={`${FIELD_BOX} flex h-10 items-center px-[13px] font-mono text-[12.5px] text-muted-foreground`}>
          <span style={{ color: 'var(--faint)' }}>/</span>
          {v || 'sample-slug'}
        </div>
      );
    case 'integer':
    case 'float':
    case 'decimal':
    case 'biginteger':
      return <div className={`${FIELD_BOX} flex h-10 items-center px-[13px] font-mono text-[13.5px] text-muted-foreground`}>{v || '42'}</div>;
    case 'enumeration': {
      const val = v || field.enumValues.find((e) => e.trim() !== '')?.trim() || 'value';
      return (
        <div className={`${FIELD_BOX} flex h-10 items-center justify-between px-[13px] text-[13.5px] text-foreground`}>
          <span className="inline-flex items-center gap-2">
            <span className="h-[7px] w-[7px] rounded-full" style={{ background: 'var(--success)' }} />
            {val}
          </span>
          <ChevronDown className="h-3.5 w-3.5" style={{ color: 'var(--faint)' }} />
        </div>
      );
    }
    case 'boolean':
      return (
        <div className="flex h-10 items-center gap-2.5">
          <span className="relative h-[23px] w-10 rounded-[13px]" style={{ background: v === 'true' ? 'hsl(var(--primary))' : 'hsl(var(--border))' }}>
            <span className="absolute top-[2.5px] h-[18px] w-[18px] rounded-full bg-white shadow" style={{ insetInlineStart: v === 'true' ? '19px' : '2.5px' }} />
          </span>
          <span className="text-[13px] text-muted-foreground">{v === 'true' ? 'On' : 'Off'}</span>
        </div>
      );
    case 'media':
      return (
        <div className={`${FIELD_BOX} flex h-24 flex-col items-center justify-center gap-1.5 border-dashed`} style={{ color: 'var(--faint)' }}>
          <ImageIcon className="h-5 w-5" strokeWidth={1.7} />
          <span className="text-[12px]">{field.multiple ? 'Drop images' : 'Drop an image'}</span>
        </div>
      );
    case 'json':
      return <div className={`${FIELD_BOX} min-h-[60px] px-[13px] py-[11px] font-mono text-[12.5px] text-muted-foreground`}>{v || '{ }'}</div>;
    default:
      // string / email / uuid / date / datetime
      return (
        <div className={`${FIELD_BOX} flex h-10 items-center px-[13px] text-[13.5px]`} style={{ color: v ? 'hsl(var(--foreground))' : 'var(--faint)' }}>
          {v || placeholderFor(field.type)}
        </div>
      );
  }
}

function placeholderFor(type: string): string {
  if (type === 'email') return 'editor@example.com';
  if (type === 'uuid') return '00000000-0000-4000-8000-000000000000';
  if (type === 'date') return '2026-01-01';
  if (type === 'datetime') return '2026-01-01 09:00';
  return 'Sample text';
}

function RelationChips({ relation }: { relation: RelationDraft }) {
  const card = cardinalityCard(draftCardinality(relation));
  const multi = card.bMark === '∞';
  const target = relation.target || 'Entry';
  const chips = multi ? [target, `${target} 2`] : [target];
  return (
    <div className={`${FIELD_BOX} flex min-h-10 flex-wrap items-center gap-1.5 px-[9px] py-1.5`}>
      {chips.map((name) => (
        <span key={name} className="inline-flex items-center gap-1.5 rounded-full border bg-card py-1 pe-2.5 ps-1 text-[12.5px] text-foreground">
          <span className="flex h-[18px] w-[18px] items-center justify-center rounded-full text-[8.5px] font-bold text-white" style={{ background: 'var(--info)' }}>
            {name.slice(0, 2).toUpperCase()}
          </span>
          {name}
        </span>
      ))}
    </div>
  );
}
