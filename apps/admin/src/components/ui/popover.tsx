import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * A minimal, zero-dependency Popover (no Radix). Anchors a floating panel beneath a trigger,
 * closing on outside pointer-down or Escape. Open state is controlled by the parent so callers
 * can also close it programmatically (e.g. after picking a date).
 */
interface PopoverContextValue {
  open: boolean;
  setOpen: (open: boolean) => void;
  triggerRef: React.RefObject<HTMLElement | null>;
}

const PopoverContext = React.createContext<PopoverContextValue | null>(null);

function usePopover(): PopoverContextValue {
  const ctx = React.useContext(PopoverContext);
  if (ctx === null) throw new Error('Popover components must be used within <Popover>');
  return ctx;
}

interface PopoverProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
}

function Popover({ open, onOpenChange, children }: PopoverProps) {
  const triggerRef = React.useRef<HTMLElement | null>(null);
  const value = React.useMemo<PopoverContextValue>(
    () => ({ open, setOpen: onOpenChange, triggerRef }),
    [open, onOpenChange],
  );
  return (
    <PopoverContext.Provider value={value}>
      <div className="relative inline-block w-full">{children}</div>
    </PopoverContext.Provider>
  );
}

const PopoverTrigger = React.forwardRef<HTMLButtonElement, React.ButtonHTMLAttributes<HTMLButtonElement>>(
  ({ onClick, ...props }, forwardedRef) => {
    const { open, setOpen, triggerRef } = usePopover();
    return (
      <button
        ref={(node) => {
          triggerRef.current = node;
          if (typeof forwardedRef === 'function') forwardedRef(node);
          else if (forwardedRef) forwardedRef.current = node;
        }}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={(e) => {
          onClick?.(e);
          if (!e.defaultPrevented) setOpen(!open);
        }}
        {...props}
      />
    );
  },
);
PopoverTrigger.displayName = 'PopoverTrigger';

const PopoverContent = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, forwardedRef) => {
    const { open, setOpen, triggerRef } = usePopover();
    const localRef = React.useRef<HTMLDivElement | null>(null);

    React.useEffect(() => {
      if (!open) return;
      const onPointerDown = (e: PointerEvent) => {
        const target = e.target as Node;
        if (localRef.current?.contains(target)) return;
        if (triggerRef.current?.contains(target)) return;
        setOpen(false);
      };
      const onKeyDown = (e: KeyboardEvent) => {
        if (e.key === 'Escape') setOpen(false);
      };
      document.addEventListener('pointerdown', onPointerDown);
      document.addEventListener('keydown', onKeyDown);
      return () => {
        document.removeEventListener('pointerdown', onPointerDown);
        document.removeEventListener('keydown', onKeyDown);
      };
    }, [open, setOpen, triggerRef]);

    if (!open) return null;
    return (
      <div
        ref={(node) => {
          localRef.current = node;
          if (typeof forwardedRef === 'function') forwardedRef(node);
          else if (forwardedRef) forwardedRef.current = node;
        }}
        role="dialog"
        className={cn(
          'absolute left-0 top-full z-50 mt-1 w-auto rounded-md border bg-popover p-0 text-popover-foreground shadow-md outline-none',
          className,
        )}
        {...props}
      />
    );
  },
);
PopoverContent.displayName = 'PopoverContent';

export { Popover, PopoverTrigger, PopoverContent };
