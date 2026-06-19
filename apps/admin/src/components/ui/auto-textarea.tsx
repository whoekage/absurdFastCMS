import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * A textarea that grows to fit its content (no scrollbar until a max-height), driven purely off the
 * controlled `value`. Zero dependencies — measures `scrollHeight` on each value change.
 */
const AutoTextarea = React.forwardRef<HTMLTextAreaElement, React.ComponentProps<'textarea'>>(
  ({ className, value, onChange, ...props }, forwardedRef) => {
    const localRef = React.useRef<HTMLTextAreaElement | null>(null);

    const resize = React.useCallback(() => {
      const el = localRef.current;
      if (el === null) return;
      el.style.height = 'auto';
      el.style.height = `${el.scrollHeight}px`;
    }, []);

    // Re-fit whenever the controlled value changes (incl. programmatic resets like "format").
    React.useLayoutEffect(() => {
      resize();
    }, [value, resize]);

    return (
      <textarea
        ref={(node) => {
          localRef.current = node;
          if (typeof forwardedRef === 'function') forwardedRef(node);
          else if (forwardedRef) forwardedRef.current = node;
        }}
        value={value}
        onChange={(e) => {
          onChange?.(e);
          resize();
        }}
        rows={1}
        className={cn(
          'flex max-h-[40vh] min-h-[60px] w-full resize-none overflow-auto rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50',
          className,
        )}
        {...props}
      />
    );
  },
);
AutoTextarea.displayName = 'AutoTextarea';

export { AutoTextarea };
