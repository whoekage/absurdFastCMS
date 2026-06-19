import * as React from 'react';
import { Check, Minus } from 'lucide-react';
import { cn } from '@/lib/utils';

// A dependency-free tri-state checkbox (no @radix-ui/react-checkbox install). It renders a native
// button with role="checkbox" so it is keyboard-operable and screen-reader-announced. `checked` may
// be `'indeterminate'` (TanStack Table's mixed page-selection state), which shows a dash instead of a
// tick and reports `aria-checked="mixed"`.
type CheckedState = boolean | 'indeterminate';

interface CheckboxProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'onChange' | 'type'> {
  checked?: CheckedState;
  onCheckedChange?: (checked: boolean) => void;
}

const Checkbox = React.forwardRef<HTMLButtonElement, CheckboxProps>(
  ({ className, checked = false, onCheckedChange, disabled, ...props }, ref) => {
    const isOn = checked === true;
    const isMixed = checked === 'indeterminate';
    return (
      <button
        ref={ref}
        type="button"
        role="checkbox"
        aria-checked={isMixed ? 'mixed' : isOn}
        disabled={disabled}
        data-state={isMixed ? 'indeterminate' : isOn ? 'checked' : 'unchecked'}
        onClick={() => onCheckedChange?.(!isOn)}
        className={cn(
          'peer h-4 w-4 shrink-0 rounded-sm border border-primary shadow ring-offset-background',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
          'disabled:cursor-not-allowed disabled:opacity-50',
          'data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground',
          'data-[state=indeterminate]:bg-primary data-[state=indeterminate]:text-primary-foreground',
          'flex items-center justify-center',
          className,
        )}
        {...props}
      >
        {isMixed ? (
          <Minus className="h-3.5 w-3.5" strokeWidth={3} />
        ) : isOn ? (
          <Check className="h-3.5 w-3.5" strokeWidth={3} />
        ) : null}
      </button>
    );
  },
);
Checkbox.displayName = 'Checkbox';

export { Checkbox };
