import * as React from 'react';
import { CalendarIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/input';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { buttonVariants } from '@/components/ui/button';

export type DateKind = 'date' | 'datetime' | 'time';

interface DatePickerInputProps {
  id: string;
  kind: DateKind;
  /** Controlled form value, already shaped for the underlying control (see field-types wireToInput). */
  value: string;
  /** Emits the next control value; the field handler lowers it to the wire form on submit. */
  onChange: (value: string) => void;
  onBlur: () => void;
  disabled?: boolean | undefined;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Parse a `YYYY-MM-DD` (date) or `YYYY-MM-DDTHH:mm` (datetime-local) string to a local Date. */
function parseControlValue(kind: DateKind, value: string): Date | undefined {
  if (value === '') return undefined;
  const datePart = kind === 'datetime' ? value.split('T')[0] : value;
  if (datePart === undefined) return undefined;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(datePart);
  if (m === null) return undefined;
  const [, y, mo, d] = m;
  const date = new Date(Number(y), Number(mo) - 1, Number(d));
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/**
 * Calendar/popover-backed picker for date & datetime, plus a native time control for time. Always
 * keeps a raw text field so power users can type; the calendar only rewrites the date portion,
 * preserving any time-of-day the user already typed for datetime.
 */
export function DatePickerInput({
  id,
  kind,
  value,
  onChange,
  onBlur,
  disabled,
}: DatePickerInputProps) {
  const [open, setOpen] = React.useState(false);

  // `time` has no calendar — a single native time input is the clearest control.
  if (kind === 'time') {
    return (
      <Input
        id={id}
        type="time"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        {...(disabled !== undefined ? { disabled } : {})}
      />
    );
  }

  const selected = parseControlValue(kind, value);

  const handleSelect = (day: Date) => {
    const datePart = `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`;
    if (kind === 'datetime') {
      const timePart = value.includes('T') ? (value.split('T')[1] ?? '00:00') : '00:00';
      onChange(`${datePart}T${timePart || '00:00'}`);
    } else {
      onChange(datePart);
    }
    setOpen(false);
    onBlur();
  };

  return (
    <div className="flex items-center gap-2">
      <Input
        id={id}
        type={kind === 'datetime' ? 'datetime-local' : 'date'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        {...(disabled !== undefined ? { disabled } : {})}
      />
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          aria-label="Open calendar"
          disabled={disabled}
          className={cn(buttonVariants({ variant: 'outline', size: 'icon' }), 'shrink-0')}
        >
          <CalendarIcon className="h-4 w-4" />
        </PopoverTrigger>
        <PopoverContent className="right-0 left-auto">
          <Calendar onSelect={handleSelect} {...(selected ? { selected } : {})} />
        </PopoverContent>
      </Popover>
    </div>
  );
}
