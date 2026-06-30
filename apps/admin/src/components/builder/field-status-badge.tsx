import type { FieldStatus } from '@/lib/module-draft';

/** The colour token + label for each non-clean status (Lua design). */
const BADGE: Record<Exclude<FieldStatus, 'clean'>, { label: string; color: string }> = {
  new: { label: 'New', color: 'var(--success)' },
  modified: { label: 'Modified', color: 'var(--warning)' },
  deleted: { label: 'Deleted', color: 'hsl(var(--destructive))' },
};

/**
 * A tiny uppercase pill marking a field's client-derived change status (New / Modified / Deleted).
 * Renders nothing for a clean field. Colour = the status hue; background = a 14% tint of it.
 */
export function FieldStatusBadge({ status }: { status: FieldStatus }) {
  if (status === 'clean') return null;
  const { label, color } = BADGE[status];
  return (
    <span
      className="rounded-[5px] px-1.5 py-0.5 text-[9.5px] font-bold uppercase tracking-[0.04em]"
      style={{ color, background: `color-mix(in srgb, ${color} 14%, transparent)` }}
    >
      {label}
    </span>
  );
}
