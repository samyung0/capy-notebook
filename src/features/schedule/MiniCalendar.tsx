import { useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import { IconButton } from '@/components/ui/IconButton';
import { cn } from '@/lib/cn';
import {
  addMonths,
  MONTHS,
  monthGrid,
  sameDay,
  startOfDay,
  WEEKDAYS,
} from './dateUtils';

export interface MiniCalendarProps {
  /** ISO dates that have events — rendered with a dot. */
  eventDays?: Set<string>;
  month: Date;
  onMonthChange: (d: Date) => void;
  onSelect: (d: Date) => void;
  rangeEnd?: Date;
  /**
   * Inclusive range to highlight with a grey band — mirrors the span shown in
   * the main calendar. When omitted, falls back to a ring on `selected`.
   */
  rangeStart?: Date;
  selected: Date;
}

export function MiniCalendar({
  month,
  onMonthChange,
  selected,
  onSelect,
  eventDays,
  rangeStart,
  rangeEnd,
}: MiniCalendarProps) {
  const [picking, setPicking] = useState(false);
  const grid = monthGrid(month);
  const hasRange = !!(rangeStart && rangeEnd);
  const rs = rangeStart ? startOfDay(rangeStart).getTime() : 0;
  const re = rangeEnd ? startOfDay(rangeEnd).getTime() : 0;
  const inRange = (d: Date) => {
    const t = startOfDay(d).getTime();
    return t >= rs && t <= re;
  };

  return (
    <div className="">
      <div className="mb-2 flex items-center justify-between">
        <button
          className="t-card-title translate-y-px rounded-button px-2.5 py-1 text-left text-fg hover:bg-surface-hover-bg"
          onClick={() => setPicking((p) => !p)}
          type="button"
        >
          {MONTHS[month.getMonth()]} {month.getFullYear()}
        </button>
        <div className="flex items-center gap-1">
          <IconButton
            className="text-fg-muted hover:bg-surface-hover-bg"
            icon="chevronLeft"
            label="Previous month"
            onClick={() => onMonthChange(addMonths(month, -1))}
            size="sm"
            variant="ghost"
          />
          <IconButton
            className="text-fg-muted hover:bg-surface-hover-bg"
            icon="chevronRight"
            label="Next month"
            onClick={() => onMonthChange(addMonths(month, 1))}
            size="sm"
            variant="ghost"
          />
        </div>
      </div>

      {picking ? (
        <div className="py-1">
          <div className="mb-2 flex items-center justify-between">
            <button
              aria-label="Previous year"
              className="rounded-button p-1 text-fg-muted hover:bg-surface-hover-bg"
              onClick={() =>
                onMonthChange(
                  new Date(month.getFullYear() - 1, month.getMonth(), 1)
                )
              }
              type="button"
            >
              <Icon name="chevronLeft" size={16} />
            </button>
            <span className="font-bold text-sm">{month.getFullYear()}</span>
            <button
              aria-label="Next year"
              className="rounded-button p-1 text-fg-muted hover:bg-surface-hover-bg"
              onClick={() =>
                onMonthChange(
                  new Date(month.getFullYear() + 1, month.getMonth(), 1)
                )
              }
              type="button"
            >
              <Icon name="chevronRight" size={16} />
            </button>
          </div>
          <div className="grid grid-cols-3 gap-1">
            {MONTHS.map((mo, i) => (
              <button
                className={cn(
                  'rounded-button py-1.5 font-medium text-xs hover:bg-surface-hover-bg',
                  i === month.getMonth()
                    ? 'bg-action text-action-fg'
                    : 'text-fg'
                )}
                key={mo}
                onClick={() => {
                  onMonthChange(new Date(month.getFullYear(), i, 1));
                  setPicking(false);
                }}
                type="button"
              >
                {mo.slice(0, 3)}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-7 gap-x-0">
            {WEEKDAYS.map((w) => (
              <div
                className="py-1 text-center font-semibold text-[0.68rem] text-fg-muted"
                key={w}
              >
                {w[0]}
              </div>
            ))}
          </div>
          <div className="grid grid-cols-7 gap-x-0 gap-y-0.5">
            {grid.map((day, i) => {
              const inMonth = day.getMonth() === month.getMonth();
              const isHighlighted = sameDay(day, selected);
              const isRange = hasRange && inRange(day);
              const isRangeStart = !!rangeStart && sameDay(day, rangeStart);
              const isRangeEnd = !!rangeEnd && sameDay(day, rangeEnd);
              const hasEvent = eventDays?.has(day.toDateString());
              return (
                <button
                  className={cn(
                    'relative flex h-8 items-center justify-center transition-colors',
                    // connected range band — spans the full cell so adjacent days touch
                    isRange && 'bg-page',
                    isRange && isRangeStart && 'rounded-l-row',
                    isRange && isRangeEnd && 'rounded-r-row'
                  )}
                  key={i}
                  onClick={() => onSelect(day)}
                  type="button"
                >
                  <span
                    className={cn(
                      'flex h-8 w-8 items-center justify-center rounded-button text-[0.8rem]',
                      isHighlighted && 'bg-action font-bold text-action-fg',
                      !isHighlighted && isRange && 'font-semibold text-fg',
                      !isHighlighted &&
                        !isRange &&
                        hasRange &&
                        'hover:bg-surface-hover-bg',
                      !isHighlighted &&
                        !isRange &&
                        (inMonth
                          ? 'text-fg hover:bg-surface-hover-bg'
                          : 'text-fg-muted hover:bg-surface-hover-bg')
                    )}
                  >
                    {day.getDate()}
                  </span>
                  {hasEvent && !isHighlighted && (
                    <span className="absolute bottom-1 h-1 w-1 rounded-full bg-solid-accent-1" />
                  )}
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
