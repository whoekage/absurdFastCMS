import type { DragEvent } from 'react';
import { GripVertical, ChevronDown, Columns2 } from 'lucide-react';
import { type FieldDraft, type FieldStatus, fieldSummary } from '@/lib/module-draft';
import { typeMetaFor, TONE_VAR } from '@/lib/field-types';
import { FieldStatusBadge } from './field-status-badge';
import { FieldConfig } from './field-config';

/** Native drag-reorder wiring (the grip handle arms the row; the list owns the order state). */
interface FieldDrag {
  draggable: boolean;
  isDragging: boolean;
  isOver: boolean;
  onHandlePointerDown: () => void;
  onDragStart: (e: DragEvent) => void;
  onDragOver: (e: DragEvent) => void;
  onDrop: () => void;
  onDragEnd: () => void;
}

interface FieldCardProps {
  draft: FieldDraft;
  status: FieldStatus;
  /** Module-level i18n flag (gates the localized toggle in config). */
  i18n: boolean;
  /** Other live field names (conditional-visibility source list). */
  siblingNames: string[];
  /** Defined component names (the reference picker for a component field). */
  componentNames?: string[];
  expanded: boolean;
  onToggle: () => void;
  onChange: (next: FieldDraft) => void;
  /** Soft-delete (loaded) or remove (new). */
  onDelete: () => void;
  /** Un-delete a soft-deleted field. */
  onRestore: () => void;
  /** Drag-reorder wiring (omitted ⇒ not reorderable, e.g. while collapsed-all or a deleted row). */
  drag?: FieldDrag;
}

/**
 * One field row: a collapsed head (drag handle, type glyph, mono name + status badge, summary line,
 * type pill, half-width hint, caret) that expands to the inline {@link FieldConfig}. A soft-deleted
 * field shows a strike-through and a restore strip instead of expanding. Pixel-matches the Lua design.
 */
export function FieldCard({ draft, status, i18n, siblingNames, componentNames, expanded, onToggle, onChange, onDelete, onRestore, drag }: FieldCardProps) {
  const meta = typeMetaFor(draft.type);
  const tone = TONE_VAR[meta.tone];
  const deleted = status === 'deleted';
  const open = expanded && !deleted;

  const borderColor = deleted
    ? 'color-mix(in srgb, hsl(var(--destructive)) 30%, transparent)'
    : open
      ? 'color-mix(in srgb, hsl(var(--primary)) 32%, transparent)'
      : 'hsl(var(--border))';

  return (
    <div
      className="relative overflow-hidden rounded-[11px] border bg-card shadow-card transition-[border-color,opacity]"
      style={{ borderColor, opacity: drag?.isDragging ? 0.4 : 1 }}
      draggable={drag?.draggable ?? false}
      onDragStart={drag?.onDragStart}
      onDragOver={drag?.onDragOver}
      onDrop={drag?.onDrop}
      onDragEnd={drag?.onDragEnd}
    >
      {drag?.isOver && (
        <span
          className="absolute left-2 right-2 top-[-2px] z-[3] h-[3px] rounded-[3px]"
          style={{ background: 'hsl(var(--primary))', boxShadow: '0 0 0 3px color-mix(in srgb, hsl(var(--primary)) 22%, transparent)' }}
        />
      )}
      <div
        onClick={() => !deleted && onToggle()}
        className="flex items-center gap-2.5 px-[13px] py-[11px] transition-colors hover:bg-[var(--fill)]"
        style={{ cursor: deleted ? 'default' : 'pointer' }}
      >
        <span
          className="flex flex-shrink-0 cursor-grab text-[var(--faint)] hover:text-muted-foreground"
          title="Drag to reorder"
          style={{ touchAction: 'none' }}
          onClick={(e) => e.stopPropagation()}
          onPointerDown={drag?.onHandlePointerDown}
        >
          <GripVertical className="h-[15px] w-[15px]" />
        </span>
        <span
          className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-[9px] font-mono text-[13px] font-semibold"
          style={{ background: `color-mix(in srgb, ${tone} 13%, transparent)`, color: tone }}
        >
          {meta.glyph}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span
              className="font-mono text-[13.5px] font-medium text-foreground"
              style={{ textDecoration: deleted ? 'line-through' : 'none' }}
            >
              {draft.name || <span className="text-muted-foreground">unnamed</span>}
            </span>
            <FieldStatusBadge status={status} />
          </div>
          <div className="mt-px truncate text-[11.5px] text-muted-foreground">
            {meta.name} · {fieldSummary(draft)}
          </div>
        </div>
        <div className="flex flex-shrink-0 items-center gap-[7px]">
          <span
            className="rounded-md px-2 py-[3px] font-mono text-[11px]"
            style={{ background: `color-mix(in srgb, ${tone} 13%, transparent)`, color: tone }}
          >
            {draft.type}
          </span>
          {draft.half && (
            <span title="Half width in the editor" className="flex text-[var(--faint)]">
              <Columns2 className="h-[15px] w-[15px]" />
            </span>
          )}
          {!deleted && (
            <ChevronDown
              className="h-4 w-4 text-[var(--faint)] transition-transform"
              style={{ transform: open ? 'rotate(180deg)' : 'rotate(0deg)' }}
            />
          )}
        </div>
      </div>

      {open && (
        <FieldConfig draft={draft} i18n={i18n} siblingNames={siblingNames} componentNames={componentNames} onChange={onChange} onDelete={onDelete} onDone={onToggle} />
      )}

      {deleted && (
        <div
          className="flex items-center justify-between gap-2.5 border-t px-[13px] py-2"
          style={{
            borderColor: 'color-mix(in srgb, hsl(var(--destructive)) 22%, transparent)',
            background: 'color-mix(in srgb, hsl(var(--destructive)) 7%, transparent)',
          }}
        >
          <span className="text-[12px] font-medium" style={{ color: 'hsl(var(--destructive))' }}>
            Marked for deletion — drops on apply
          </span>
          <button
            type="button"
            onClick={onRestore}
            className="rounded-[7px] border bg-card px-[11px] py-[5px] text-[12px] font-semibold text-foreground"
          >
            Restore
          </button>
        </div>
      )}
    </div>
  );
}
