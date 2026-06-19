import * as React from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { buttonVariants } from '@/components/ui/button';

/**
 * A zero-dependency month calendar (no react-day-picker / date-fns — native `Date` + `Intl`).
 * All reasoning is in LOCAL time so the visible grid matches the user's clock; callers translate
 * the chosen day to the wire form (date string / ISO) themselves.
 */
export interface CalendarProps {
  /** Currently-selected day (local). */
  selected?: Date | undefined;
  /** Fired with the local midnight of the clicked day. */
  onSelect: (date: Date) => void;
}

const WEEKDAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

const monthFormatter = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' });

function Calendar({ selected, onSelect }: CalendarProps) {
  const today = React.useMemo(() => new Date(), []);
  const anchor = selected ?? today;
  // The month currently on screen (local year/month). Starts on the selected month, else today's.
  const [view, setView] = React.useState(() => new Date(anchor.getFullYear(), anchor.getMonth(), 1));

  const year = view.getFullYear();
  const month = view.getMonth();
  const firstWeekday = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  // Leading blanks for the first week, then each day-of-month.
  const cells: (number | null)[] = [];
  for (let i = 0; i < firstWeekday; i += 1) cells.push(null);
  for (let d = 1; d <= daysInMonth; d += 1) cells.push(d);

  return (
    <div className="p-3">
      <div className="flex items-center justify-between pb-3">
        <button
          type="button"
          aria-label="Previous month"
          className={cn(buttonVariants({ variant: 'outline', size: 'icon' }), 'h-7 w-7')}
          onClick={() => setView(new Date(year, month - 1, 1))}
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <div className="text-sm font-medium">{monthFormatter.format(view)}</div>
        <button
          type="button"
          aria-label="Next month"
          className={cn(buttonVariants({ variant: 'outline', size: 'icon' }), 'h-7 w-7')}
          onClick={() => setView(new Date(year, month + 1, 1))}
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>

      <div className="grid grid-cols-7 gap-1">
        {WEEKDAYS.map((wd) => (
          <div
            key={wd}
            className="flex h-8 w-8 items-center justify-center text-xs font-normal text-muted-foreground"
          >
            {wd}
          </div>
        ))}
        {cells.map((day, idx) => {
          if (day === null) return <div key={`blank-${idx}`} className="h-8 w-8" />;
          const cellDate = new Date(year, month, day);
          const isSelected = selected !== undefined && sameDay(cellDate, selected);
          const isToday = sameDay(cellDate, today);
          return (
            <button
              key={day}
              type="button"
              onClick={() => onSelect(new Date(year, month, day))}
              className={cn(
                buttonVariants({ variant: isSelected ? 'default' : 'ghost', size: 'icon' }),
                'h-8 w-8 p-0 font-normal',
                !isSelected && isToday && 'border border-input',
              )}
            >
              {day}
            </button>
          );
        })}
      </div>
    </div>
  );
}
Calendar.displayName = 'Calendar';

export { Calendar };
