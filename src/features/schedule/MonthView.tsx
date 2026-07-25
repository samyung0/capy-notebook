import type { CalendarEvent, Label } from '@/api/types';
import { cn } from '@/lib/cn';
import { userColorPair } from '@/lib/userColor';
import { monthGrid, sameDay, WEEKDAYS } from './dateUtils';

export function MonthView({
  month,
  events,
  labels,
  onCreate,
  onSelectEvent,
}: {
  month: Date;
  events: CalendarEvent[];
  labels: Label[];
  onCreate?: (day: Date) => void;
  onSelectEvent: (event: CalendarEvent) => void;
}) {
  const grid = monthGrid(month);
  const today = new Date();

  function colorFor(ev: CalendarEvent) {
    const first = labels.find((l) => l.id === ev.labelIds[0]);
    return first
      ? userColorPair(first.color)
      : { bg: 'var(--color-surface)', fg: 'var(--color-fg-secondary)' };
  }

  return (
    <div className="flex h-full flex-col">
      <div className="grid grid-cols-7 border-divider border-b">
        {WEEKDAYS.map((w) => (
          <div className="py-2 text-center font-semibold" key={w}>
            {w}
          </div>
        ))}
      </div>
      <div className="grid flex-1 grid-cols-7 grid-rows-6">
        {grid.map((day, i) => {
          const inMonth = day.getMonth() === month.getMonth();
          const isToday = sameDay(day, today);
          const dayEvents = events.filter((e) =>
            sameDay(new Date(e.start), day)
          );
          return (
            <div
              className="min-h-0 cursor-pointer overflow-hidden border-divider border-r border-b p-1 transition-colors hover:bg-surface-hover-bg"
              key={i}
              onClick={() => onCreate?.(day)}
            >
              <div
                className={cn(
                  'mb-1 flex h-6 w-6 items-center justify-center rounded-lg text-xs',
                  isToday
                    ? 'bg-action font-bold text-action-fg'
                    : inMonth
                      ? 'text-fg'
                      : 'text-fg-muted'
                )}
              >
                {day.getDate()}
              </div>
              <div className="flex flex-col gap-0.5">
                {dayEvents.slice(0, 3).map((ev) => {
                  const c = colorFor(ev);
                  return (
                    <button
                      className="block w-full truncate rounded px-1.5 py-0.5 text-left font-medium text-[0.66rem]"
                      key={ev.id}
                      onClick={(e) => {
                        e.stopPropagation();
                        onSelectEvent(ev);
                      }}
                      style={{ background: c.bg, color: c.fg }}
                      type="button"
                    >
                      {ev.title}
                    </button>
                  );
                })}
                {dayEvents.length > 3 && (
                  <span className="px-1 text-[0.62rem] text-fg-muted">
                    +{dayEvents.length - 3} more
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
