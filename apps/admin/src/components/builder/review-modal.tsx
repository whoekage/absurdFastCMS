import { Boxes, X, Check, AlertTriangle, Ban, ArrowRight } from 'lucide-react';
import type { Change, ChangeRisk, PreviewResult } from '@/lib/builder-client';
import { CodeBlock } from './code-block';

type ChangeClass = 'safe' | 'destructive' | 'forbidden';

/** Collapse the 4 risks onto the 3 review buckets (data-dependent rolls into destructive). */
function classOf(risk: ChangeRisk): ChangeClass {
  if (risk === 'forbidden') return 'forbidden';
  if (risk === 'safe') return 'safe';
  return 'destructive';
}

const CLASS_META: Record<ChangeClass, { tag: string; color: string }> = {
  safe: { tag: 'Safe', color: 'var(--success)' },
  destructive: { tag: 'Destructive', color: 'hsl(var(--destructive))' },
  forbidden: { tag: 'Forbidden', color: 'var(--warning)' },
};
const ORDER: Record<ChangeClass, number> = { safe: 0, destructive: 1, forbidden: 2 };

/** A short human label for a change kind (camelCase → words). */
function describeKind(kind: string): string {
  return kind.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
}

interface ReviewModalProps {
  preview: PreviewResult;
  /** Module machine name (shown in the dry-run subtitle). */
  name: string;
  isEdit: boolean;
  allowDestructive: boolean;
  onAllowDestructiveChange: (value: boolean) => void;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onApply: () => void;
}

/**
 * The migration review modal (Lua design): a dry-run of {@link PreviewResult}. Header + Safe/Destructive/
 * Forbidden legend counts; a left change-list (tinted cards, tag pills, a single destructive ack on the
 * first destructive change); a right generated `schema.ts` panel; and a footer gate that enables Apply only
 * when there are no forbidden changes and any destructive change is acknowledged.
 */
export function ReviewModal({ preview, name, isEdit, allowDestructive, onAllowDestructiveChange, busy, error, onCancel, onApply }: ReviewModalProps) {
  const changes: Change[] = [...preview.applied, ...preview.blocked].sort((a, b) => ORDER[classOf(a.risk)] - ORDER[classOf(b.risk)]);
  const safeCount = changes.filter((c) => classOf(c.risk) === 'safe').length;
  const destructiveCount = changes.filter((c) => classOf(c.risk) === 'destructive').length;
  const forbiddenCount = changes.filter((c) => classOf(c.risk) === 'forbidden').length;
  const firstDestructiveIdx = changes.findIndex((c) => classOf(c.risk) === 'destructive');

  const needsAck = destructiveCount > 0;
  const forbidden = forbiddenCount > 0;
  const empty = changes.length === 0;
  const canApply = !forbidden && !empty && (!needsAck || allowDestructive);

  const gate = forbidden
    ? { color: 'var(--warning)', text: `${forbiddenCount} forbidden change${forbiddenCount > 1 ? 's' : ''} can’t be applied — edit the schema by hand.`, Icon: Ban }
    : needsAck && !allowDestructive
      ? { color: 'hsl(var(--destructive))', text: 'Acknowledge the destructive change to continue.', Icon: AlertTriangle }
      : empty
        ? { color: 'hsl(var(--muted-foreground))', text: 'No changes — this module already matches.', Icon: Check }
        : { color: 'var(--success)', text: 'All changes are safe to apply.', Icon: Check };

  return (
    <div
      onClick={onCancel}
      className="fixed inset-0 z-50 flex items-center justify-center p-8"
      style={{ background: 'color-mix(in srgb, #0a0912 58%, transparent)', backdropFilter: 'blur(2px)', animation: 'lmbBackdrop .2s ease' }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[88vh] w-[min(940px,96vw)] flex-col overflow-hidden rounded-[18px] border bg-card shadow-pop"
        style={{ animation: 'lmbPop .26s cubic-bezier(.2,.7,.3,1)' }}
      >
        {/* header */}
        <div className="flex-shrink-0 border-b px-[22px] pb-[17px] pt-5">
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="flex h-[42px] w-[42px] items-center justify-center rounded-xl" style={{ background: 'color-mix(in srgb, hsl(var(--primary)) 13%, transparent)', color: 'hsl(var(--primary))' }}>
                <Boxes className="h-[21px] w-[21px]" strokeWidth={1.9} />
              </div>
              <div>
                <h2 className="font-display text-[19px] font-semibold tracking-[-0.02em]">Review migration</h2>
                <p className="mt-0.5 text-[13px] text-muted-foreground">
                  Dry-run on <span className="font-mono text-foreground">{name || 'untitled'}</span> · {changes.length} change{changes.length === 1 ? '' : 's'}
                </p>
              </div>
            </div>
            <button type="button" onClick={onCancel} className="flex h-8 w-8 items-center justify-center rounded-lg border-none bg-muted text-muted-foreground hover:text-foreground">
              <X className="h-4 w-4" />
            </button>
          </div>
          {/* legend */}
          <div className="mt-4 flex gap-2.5">
            <LegendPill color="var(--success)" label={`${safeCount} Safe`} />
            <LegendPill color="hsl(var(--destructive))" label={`${destructiveCount} Destructive`} />
            <LegendPill color="var(--warning)" label={`${forbiddenCount} Forbidden`} />
          </div>
        </div>

        {/* body: changes + generated code */}
        <div className="grid min-h-0 flex-1 overflow-hidden" style={{ gridTemplateColumns: '1fr 1fr' }}>
          <div className="overflow-y-auto border-e px-[18px] py-4">
            {empty && <p className="text-[13px] text-muted-foreground">No changes — this module already matches the applied schema.</p>}
            {changes.map((c, i) => (
              <ChangeCard key={i} change={c} showAck={i === firstDestructiveIdx} ack={allowDestructive} onAck={() => onAllowDestructiveChange(!allowDestructive)} />
            ))}
          </div>
          <div className="overflow-y-auto" style={{ background: 'var(--code-bg)' }}>
            <div className="sticky top-0 z-[1] flex items-center gap-2 border-b px-4 py-[11px]" style={{ background: 'var(--code-bg)' }}>
              <span className="font-mono text-[11.5px] text-muted-foreground">generated · schema.ts</span>
            </div>
            <CodeBlock source={preview.generatedSource} />
          </div>
        </div>

        {/* footer */}
        <div className="flex flex-shrink-0 items-center justify-between gap-3.5 border-t px-5 py-[15px]" style={{ background: 'color-mix(in srgb, hsl(var(--muted)) 40%, transparent)' }}>
          <div className="flex items-center gap-2.5 text-[12.5px]" style={{ color: gate.color }}>
            <gate.Icon className="h-[15px] w-[15px]" />
            <span>{error ?? gate.text}</span>
          </div>
          <div className="flex gap-2.5">
            <button type="button" onClick={onCancel} disabled={busy} className="rounded-[9px] border bg-transparent px-4 py-[9px] text-[13px] font-semibold text-foreground transition-colors hover:bg-[var(--fill)] disabled:opacity-60">
              Cancel
            </button>
            <button
              type="button"
              onClick={onApply}
              disabled={busy || !canApply}
              className="flex items-center gap-2 rounded-[9px] border-none bg-primary px-[18px] py-[9px] text-[13px] font-bold text-primary-foreground transition enabled:hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <ArrowRight className="h-[15px] w-[15px]" />
              {busy ? 'Applying…' : isEdit ? 'Apply changes' : 'Create module'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function LegendPill({ color, label }: { color: string; label: string }) {
  return (
    <div className="flex items-center gap-2 rounded-[9px] border px-3 py-[7px]" style={{ background: `color-mix(in srgb, ${color} 11%, transparent)`, borderColor: `color-mix(in srgb, ${color} 26%, transparent)` }}>
      <span className="h-2 w-2 rounded-full" style={{ background: color }} />
      <span className="text-[12.5px] font-semibold" style={{ color }}>
        {label}
      </span>
    </div>
  );
}

function ChangeCard({ change, showAck, ack, onAck }: { change: Change; showAck: boolean; ack: boolean; onAck: () => void }) {
  const cls = classOf(change.risk);
  const meta = CLASS_META[cls];
  const title = `${describeKind(change.kind)}${change.field ? ` ${change.field}` : ''}`;
  return (
    <div
      className="mb-[9px] flex gap-2.5 rounded-[11px] border p-3"
      style={{ background: `color-mix(in srgb, ${meta.color} 5%, transparent)`, borderColor: `color-mix(in srgb, ${meta.color} 22%, transparent)` }}
    >
      <span className="mt-px flex h-[26px] w-[26px] flex-shrink-0 items-center justify-center rounded-[7px]" style={{ background: `color-mix(in srgb, ${meta.color} 14%, transparent)`, color: meta.color }}>
        {cls === 'safe' ? <Check className="h-[14px] w-[14px]" /> : cls === 'forbidden' ? <Ban className="h-[14px] w-[14px]" /> : <AlertTriangle className="h-[14px] w-[14px]" />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[13px] font-semibold capitalize text-foreground">{title}</span>
          <span className="rounded-[5px] px-1.5 py-0.5 text-[9.5px] font-bold uppercase tracking-[0.05em]" style={{ color: meta.color, background: `color-mix(in srgb, ${meta.color} 14%, transparent)` }}>
            {meta.tag}
          </span>
        </div>
        {change.detail && <div className="mt-[3px] text-[12px] leading-[1.5] text-muted-foreground">{change.detail}</div>}
        {showAck && (
          <button
            type="button"
            onClick={onAck}
            className="mt-2.5 flex w-full items-center gap-2 rounded-lg border bg-card px-[11px] py-2 text-start transition-colors"
            style={{ borderColor: `color-mix(in srgb, hsl(var(--destructive)) ${ack ? 50 : 26}%, transparent)` }}
          >
            <span
              className="flex h-[18px] w-[18px] flex-shrink-0 items-center justify-center rounded-[5px] border-[1.5px]"
              style={{ borderColor: ack ? 'hsl(var(--destructive))' : 'hsl(var(--border))', background: ack ? 'hsl(var(--destructive))' : 'transparent' }}
            >
              {ack && <Check className="h-[11px] w-[11px] text-white" strokeWidth={3.4} />}
            </span>
            <span className="text-[12px] font-semibold" style={{ color: 'hsl(var(--destructive))' }}>
              I understand this permanently changes or deletes data.
            </span>
          </button>
        )}
      </div>
    </div>
  );
}
