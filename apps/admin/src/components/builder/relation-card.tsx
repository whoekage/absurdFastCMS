import { Link2, ChevronDown } from 'lucide-react';
import { type RelationDraft, type FieldStatus, cardinalityCard, draftCardinality, pluralize } from '@/lib/module-draft';
import { FieldStatusBadge } from './field-status-badge';
import { RelationConfig } from './relation-config';

interface RelationCardProps {
  draft: RelationDraft;
  status: FieldStatus;
  moduleName: string;
  moduleGlyph: string;
  targetGlyph: string;
  targetTone: string;
  targetFields: string[];
  expanded: boolean;
  onToggle: () => void;
  onCycleTarget: () => void;
  onChange: (next: RelationDraft) => void;
  onDelete: () => void;
  onRestore: () => void;
}

/**
 * One relation row: a collapsed head (teal link glyph, mono field name + status badge, plain-English
 * sentence, the A·mark—B·mark cardinality token) that expands to the {@link RelationConfig}. Soft-deleted
 * relations show a restore strip. Pixel-matches the Lua design.
 */
export function RelationCard({
  draft,
  status,
  moduleName,
  moduleGlyph,
  targetGlyph,
  targetTone,
  targetFields,
  expanded,
  onToggle,
  onCycleTarget,
  onChange,
  onDelete,
  onRestore,
}: RelationCardProps) {
  const card = cardinalityCard(draftCardinality(draft));
  const deleted = status === 'deleted';
  const open = expanded && !deleted;
  const target = draft.target || 'target';
  const sentence = `Each ${moduleName} ${card.verb} ${card.bMark === '∞' ? pluralize(target) : target}`;
  const cardMark = `${card.aMark}—${card.bMark}`;

  const borderColor = deleted
    ? 'color-mix(in srgb, hsl(var(--destructive)) 30%, transparent)'
    : status === 'new'
      ? 'color-mix(in srgb, var(--success) 26%, transparent)'
      : open
        ? 'color-mix(in srgb, hsl(var(--primary)) 32%, transparent)'
        : 'hsl(var(--border))';

  return (
    <div className="overflow-hidden rounded-[11px] border bg-card shadow-card transition-[border-color]" style={{ borderColor }}>
      <div
        onClick={() => !deleted && onToggle()}
        className="flex items-center gap-3 px-3.5 py-3 transition-colors hover:bg-[var(--fill)]"
        style={{ cursor: deleted ? 'default' : 'pointer' }}
      >
        <span
          className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-[9px]"
          style={{ background: 'color-mix(in srgb, var(--teal) 14%, transparent)', color: 'var(--teal)' }}
        >
          <Link2 className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-mono text-[13.5px] font-medium text-foreground" style={{ textDecoration: deleted ? 'line-through' : 'none' }}>
              {draft.field || <span className="text-muted-foreground">unnamed</span>}
            </span>
            <FieldStatusBadge status={status} />
          </div>
          <div className="mt-px truncate text-[11.5px] text-muted-foreground">{sentence}</div>
        </div>
        <span
          className="inline-flex flex-shrink-0 items-center gap-1.5 rounded-[7px] border px-2 py-[5px]"
          style={{ background: 'color-mix(in srgb, var(--teal) 10%, transparent)', borderColor: 'color-mix(in srgb, var(--teal) 22%, transparent)' }}
        >
          <span className="font-mono text-[11px] font-semibold text-primary">{moduleGlyph}</span>
          <span className="font-mono text-[11px]" style={{ color: 'var(--teal)' }}>{cardMark}</span>
          <span className="font-mono text-[11px] font-semibold" style={{ color: targetTone }}>{targetGlyph}</span>
        </span>
        {!deleted && (
          <ChevronDown
            className="h-4 w-4 flex-shrink-0 text-[var(--faint)] transition-transform"
            style={{ transform: open ? 'rotate(180deg)' : 'rotate(0deg)' }}
          />
        )}
      </div>

      {open && (
        <RelationConfig
          draft={draft}
          moduleName={moduleName}
          moduleGlyph={moduleGlyph}
          targetGlyph={targetGlyph}
          targetTone={targetTone}
          targetFields={targetFields}
          onCycleTarget={onCycleTarget}
          onChange={onChange}
          onDelete={onDelete}
          onDone={onToggle}
        />
      )}

      {deleted && (
        <div
          className="flex items-center justify-between gap-2.5 border-t px-3.5 py-2"
          style={{ borderColor: 'color-mix(in srgb, hsl(var(--destructive)) 22%, transparent)', background: 'color-mix(in srgb, hsl(var(--destructive)) 7%, transparent)' }}
        >
          <span className="text-[12px] font-medium" style={{ color: 'hsl(var(--destructive))' }}>
            Marked for deletion — drops the join on apply
          </span>
          <button type="button" onClick={onRestore} className="rounded-[7px] border bg-card px-[11px] py-[5px] text-[12px] font-semibold text-foreground">
            Restore
          </button>
        </div>
      )}
    </div>
  );
}
