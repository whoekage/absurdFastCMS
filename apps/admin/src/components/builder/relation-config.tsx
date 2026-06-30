import { Trash2, ChevronsUpDown, Clock, Check } from 'lucide-react';
import {
  type RelationDraft,
  type Cardinality,
  CARDINALITY_CARDS,
  cardinalityCard,
  draftCardinality,
  cardinalityPatch,
  pluralize,
} from '@/lib/module-draft';

const LABEL = 'mb-1.5 block text-[11px] font-semibold text-muted-foreground';
const MONO_INPUT =
  'w-full rounded-lg border bg-card px-[11px] py-[9px] font-mono text-[12.5px] text-foreground outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20';

interface RelationConfigProps {
  draft: RelationDraft;
  moduleName: string;
  moduleGlyph: string;
  /** glyph + tone for the current target. */
  targetGlyph: string;
  targetTone: string;
  /** Field names of the target module (the display-field chips). */
  targetFields: string[];
  /** Cycle to the next candidate target module. */
  onCycleTarget: () => void;
  onChange: (next: RelationDraft) => void;
  onDelete: () => void;
  onDone: () => void;
}

/**
 * The expanded relation editor (Lua design): a live plain-English sentence, the two entity boxes with a
 * target cycler, the 6-way cardinality picker (A–line–B diagrams, dashed = one-way), the field names on
 * each side (the inverse hidden for one-way), the target display-field chips, and Delete / Done.
 */
export function RelationConfig({
  draft,
  moduleName,
  moduleGlyph,
  targetGlyph,
  targetTone,
  targetFields,
  onCycleTarget,
  onChange,
  onDelete,
  onDone,
}: RelationConfigProps) {
  const set = (patch: Partial<RelationDraft>) => onChange({ ...draft, ...patch });
  const card = cardinalityCard(draftCardinality(draft));
  const target = draft.target || 'target';
  const cardMark = `${card.aMark}—${card.bMark}`;
  const sentence = `Each ${moduleName} ${card.verb} ${card.bMark === '∞' ? pluralize(target) : target}`;
  const inverseSentence = card.inv ? `${card.inv} ${card.inv.includes('many') ? pluralize(moduleName) : moduleName}` : '';
  const displayActive = draft.displayField || targetFields[0] || '';

  return (
    <div
      className="border-t px-[15px] pb-[15px] pt-4"
      style={{ background: 'color-mix(in srgb, hsl(var(--muted)) 45%, transparent)', animation: 'lmbExpand .2s ease' }}
    >
      {/* live sentence */}
      <div
        className="mb-[15px] flex items-start gap-2.5 rounded-[10px] border px-[13px] py-[11px]"
        style={{ background: 'color-mix(in srgb, var(--teal) 8%, transparent)', borderColor: 'color-mix(in srgb, var(--teal) 20%, transparent)' }}
      >
        <Clock className="mt-px h-[15px] w-[15px] flex-shrink-0" style={{ color: 'var(--teal)' }} />
        <span className="text-[13px] leading-[1.5] text-foreground">
          {sentence}
          {inverseSentence && <span className="text-muted-foreground"> · in reverse, each {target} {inverseSentence}</span>}
        </span>
      </div>

      {/* entity boxes + target cycler */}
      <div className="mb-4 flex items-center gap-2.5">
        <div
          className="flex flex-1 items-center gap-2.5 rounded-[10px] border px-3 py-[11px]"
          style={{ background: 'color-mix(in srgb, hsl(var(--primary)) 8%, transparent)', borderColor: 'color-mix(in srgb, hsl(var(--primary)) 24%, transparent)' }}
        >
          <span className="flex h-[26px] w-[26px] flex-shrink-0 items-center justify-center rounded-[7px] bg-primary font-mono text-[10px] font-semibold text-primary-foreground">
            {moduleGlyph}
          </span>
          <div className="min-w-0">
            <div className="text-[13px] font-semibold text-foreground">{moduleName}</div>
            <div className="text-[10.5px] text-muted-foreground">this module</div>
          </div>
        </div>
        <span className="flex-shrink-0 font-mono text-[13px] font-semibold" style={{ color: 'var(--teal)' }}>
          {cardMark}
        </span>
        <button
          type="button"
          onClick={onCycleTarget}
          className="flex flex-1 items-center gap-2.5 rounded-[10px] border bg-card px-3 py-[11px] text-start transition-colors hover:border-[var(--teal)]"
        >
          <span
            className="flex h-[26px] w-[26px] flex-shrink-0 items-center justify-center rounded-[7px] font-mono text-[10px] font-semibold text-white"
            style={{ background: targetTone }}
          >
            {targetGlyph}
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-semibold text-foreground">{draft.target || 'pick a module'}</div>
            <div className="text-[10.5px] text-muted-foreground">target module</div>
          </div>
          <ChevronsUpDown className="h-[15px] w-[15px] flex-shrink-0" style={{ color: 'var(--faint)' }} />
        </button>
      </div>

      {/* 6-way cardinality picker */}
      <label className={LABEL}>Relation type</label>
      <div className="mb-4 grid grid-cols-3 gap-[7px]">
        {CARDINALITY_CARDS.map((c) => (
          <CardButton key={c.key} card={c} active={c.key === card.key} targetTone={targetTone} onPick={() => set(cardinalityPatch(c.key))} />
        ))}
      </div>

      {/* field names on both sides */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={LABEL}>Field on {moduleName}</label>
          <input className={MONO_INPUT} value={draft.field} onChange={(e) => set({ field: e.target.value })} placeholder="author" />
        </div>
        <div>
          <label className="mb-1.5 flex items-center justify-between text-[11px] font-semibold text-muted-foreground">
            Field on {target}
            {card.oneWay && <span className="text-[9.5px] font-semibold" style={{ color: 'var(--faint)' }}>one-way · none</span>}
          </label>
          {card.oneWay ? (
            <div className="w-full rounded-lg border border-dashed bg-muted px-[11px] py-[9px] font-mono text-[12.5px]" style={{ color: 'var(--faint)' }}>
              — not linked back —
            </div>
          ) : (
            <input className={MONO_INPUT} value={draft.inverseField} onChange={(e) => set({ inverseField: e.target.value })} placeholder={pluralize(moduleName).toLowerCase()} />
          )}
        </div>
      </div>

      {/* target display field */}
      <div className="mt-[13px]">
        <label className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold text-muted-foreground">
          Show {target} entries by
          <span className="rounded-[4px] border bg-card px-1.5 py-px text-[9.5px] font-semibold" style={{ color: 'var(--faint)' }}>
            display field
          </span>
        </label>
        {targetFields.length === 0 ? (
          <p className="text-[12px] text-muted-foreground">Pick a target with fields to choose its display field.</p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {targetFields.map((fn) => {
              const active = displayActive === fn;
              return (
                <button
                  key={fn}
                  type="button"
                  onClick={() => set({ displayField: fn })}
                  className="inline-flex items-center gap-1.5 rounded-lg border px-[11px] py-1.5 font-mono text-[12px] font-medium transition-colors"
                  style={
                    active
                      ? { background: 'color-mix(in srgb, hsl(var(--primary)) 12%, transparent)', borderColor: 'color-mix(in srgb, hsl(var(--primary)) 32%, transparent)', color: 'hsl(var(--primary))' }
                      : { background: 'hsl(var(--card))', borderColor: 'hsl(var(--border))', color: 'hsl(var(--muted-foreground))' }
                  }
                >
                  {active && <Check className="h-[11px] w-[11px]" strokeWidth={3} />}
                  {fn}
                </button>
              );
            })}
          </div>
        )}
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
          Delete relation
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

/** One cardinality card button: A-mark · (dashed if one-way) line · B-mark + label. */
function CardButton({
  card,
  active,
  targetTone,
  onPick,
}: {
  card: { key: Cardinality; label: string; aMark: string; bMark: string; oneWay: boolean };
  active: boolean;
  targetTone: string;
  onPick: () => void;
}) {
  const lineColor = active ? 'var(--teal)' : 'var(--faint)';
  return (
    <button
      type="button"
      onClick={onPick}
      className="flex flex-col items-center gap-[7px] rounded-[10px] border px-[7px] pb-[9px] pt-[11px] transition-colors"
      style={
        active
          ? { background: 'color-mix(in srgb, hsl(var(--primary)) 10%, transparent)', borderColor: 'color-mix(in srgb, hsl(var(--primary)) 40%, transparent)' }
          : { background: 'hsl(var(--card))', borderColor: 'hsl(var(--border))' }
      }
    >
      <span className="flex items-center gap-1">
        <Endpoint mark={card.aMark} fill="hsl(var(--primary))" />
        <span className="relative h-[2px] w-[18px] rounded-[2px]" style={{ background: card.oneWay ? 'transparent' : lineColor }}>
          {card.oneWay && (
            <span
              className="absolute inset-0"
              style={{ background: `repeating-linear-gradient(90deg, ${lineColor}, ${lineColor} 3px, transparent 3px, transparent 5px)` }}
            />
          )}
        </span>
        <Endpoint mark={card.bMark} fill={active ? targetTone : `color-mix(in srgb, ${targetTone} 55%, hsl(var(--muted)))`} />
      </span>
      <span className="text-center text-[10.5px] font-semibold leading-[1.2]" style={{ color: active ? 'hsl(var(--primary))' : 'hsl(var(--muted-foreground))' }}>
        {card.label}
      </span>
    </button>
  );
}

function Endpoint({ mark, fill }: { mark: string; fill: string }) {
  return (
    <span
      className="flex h-[15px] w-[15px] items-center justify-center rounded-[4px] font-mono text-[8px] font-bold text-white"
      style={{ background: fill }}
    >
      {mark}
    </span>
  );
}
