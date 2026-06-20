import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

/**
 * The shared Lua status pill — one consistent style for entry lifecycle states across the content list,
 * the dashboard resume strip, and the entry detail/editor. Hues come from the brand status tokens
 * (NOT raw hex): Published = success tint, In review = warning tint, Draft = muted/grey.
 */
const statusPillVariants = cva(
  'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium',
  {
    variants: {
      tone: {
        success: 'bg-success/15 text-success',
        warning: 'bg-warning/15 text-warning',
        muted: 'bg-muted text-muted-foreground',
      },
    },
    defaultVariants: { tone: 'muted' },
  },
);

/** The canonical lifecycle states the pill understands. */
export type EntryStatus = 'published' | 'review' | 'draft';

const STATUS_META: Record<EntryStatus, { tone: NonNullable<StatusPillProps['tone']>; label: string }> = {
  published: { tone: 'success', label: 'Published' },
  review: { tone: 'warning', label: 'In review' },
  draft: { tone: 'muted', label: 'Draft' },
};

export interface StatusPillProps extends VariantProps<typeof statusPillVariants> {
  className?: string;
}

/** Render a lifecycle status as a Lua pill. Pass `status` for the canonical label + hue. */
export function StatusPill({ status, className }: { status: EntryStatus; className?: string }) {
  const meta = STATUS_META[status];
  return (
    <span className={cn(statusPillVariants({ tone: meta.tone }), className)}>
      <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden />
      {meta.label}
    </span>
  );
}

export { statusPillVariants };
