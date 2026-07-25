import { Link } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import type { CalendarEvent, Label } from '@/api/types';
import { cn } from '@/lib/cn';
import { userColorPair } from '@/lib/userColor';
import { usePortals } from '@/stores/portals';
import { fmtHour, fmtTime, hourOf, sameDay } from './dateUtils';

export const HOUR_H = 48;
const WEEKDAY_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function TimeGrid({
  days,
  events,
  labels,
  selectedId,
  onCreateSlot,
  onSelectEvent,
  autoScrollTracker,
  scrollContainerRef,
  hideHeader = false,
}: {
  days: Date[];
  events: CalendarEvent[];
  labels: Label[];
  selectedId: string | null;
  onCreateSlot?: (start: Date, end: Date) => void;
  onSelectEvent?: (event: CalendarEvent) => void;
  autoScrollTracker?: {
    hasRun: () => boolean;
    markRun: (scrollTop: number) => void;
    getPosition?: () => number | null;
  };
  scrollContainerRef?: React.RefObject<HTMLDivElement | null>;
  hideHeader?: boolean;
}) {
  const today = new Date();
  const nowTop = (today.getHours() + today.getMinutes() / 60) * HOUR_H;
  const todayIdx = days.findIndex((d) => sameDay(d, today));
  const isWeek = days.length > 1;

  const nowRef = useRef<HTMLDivElement>(null);
  const didScrollToNow = useRef(false);
  const [pendingSlot, setPendingSlot] = useState<{
    day: string;
    hour: number;
  } | null>(null);
  const [hoverSlot, setHoverSlot] = useState<{
    day: string;
    hour: number;
  } | null>(null);
  const isEventFormOpen = usePortals((s) => s.eventForm !== null);

  // Auto-scroll once per grid mount by default. Schedule supplies a visit-level
  // tracker because its ?event= updates can remount this component.
  useEffect(() => {
    if (didScrollToNow.current) return;
    const c = scrollContainerRef?.current;
    if (!c) return;
    if (autoScrollTracker?.hasRun()) {
      const savedPosition = autoScrollTracker.getPosition?.();
      if (savedPosition != null) c.scrollTop = savedPosition;
      didScrollToNow.current = true;
      return;
    }
    if (todayIdx < 0) return;
    const n = nowRef.current;
    if (!n) return;
    const cr = c.getBoundingClientRect();
    const nr = n.getBoundingClientRect();
    c.scrollTop += nr.top - cr.top - cr.height * 0.3;
    didScrollToNow.current = true;
    autoScrollTracker?.markRun(c.scrollTop);
  }, [autoScrollTracker, todayIdx, scrollContainerRef]);

  // drop the pending highlight once the data updates (e.g. event created).
  useEffect(() => setPendingSlot(null), [events]);

  // drop the pending highlight when the event form dialog closes.
  useEffect(() => {
    if (!isEventFormOpen) setPendingSlot(null);
  }, [isEventFormOpen]);

  function colorFor(ev: CalendarEvent) {
    const first = labels.find((l) => l.id === ev.labelIds[0]);
    return first
      ? userColorPair(first.color)
      : {
          bg: 'var(--color-surface)',
          fg: 'var(--text-secondary)',
          fgMuted: 'var(--text-muted)',
          solid: 'var(--text-muted)',
        };
  }

  function hourAt(e: React.MouseEvent<HTMLDivElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    return Math.max(
      0,
      Math.min(23, Math.floor((e.clientY - rect.top) / HOUR_H))
    );
  }

  function handleSlotClick(d: Date, e: React.MouseEvent<HTMLDivElement>) {
    if (!onCreateSlot) return;
    const hour = hourAt(e);
    const start = new Date(d);
    start.setHours(hour, 0, 0, 0);
    const end = new Date(start.getTime() + 60 * 60 * 1000);
    setPendingSlot({ day: d.toDateString(), hour });
    onCreateSlot(start, end);
  }

  return (
    <div className="flex flex-col">
      {/* header row */}
      {!hideHeader && (
        <div className="sticky top-0 z-10 flex border-divider border-b bg-surface">
          <div className="w-14 shrink-0" />
          {days.map((d) => {
            const isToday = sameDay(d, today);
            return (
              <div
                className={cn(
                  'flex-1 py-2 text-center',
                  isToday && isWeek && 'rounded-t-xl bg-page/70'
                )}
                key={d.toDateString()}
              >
                <div className="font-semibold text-fg-muted text-sm">
                  {WEEKDAY_SHORT[(d.getDay() + 6) % 7]}
                </div>
                <div className="mt-0.5 font-semibold">{d.getDate()}</div>
              </div>
            );
          })}
        </div>
      )}

      {/* scroll body */}
      <div className="relative flex" style={{ height: HOUR_H * 24 }}>
        {/* hour gutter */}
        <div className="w-14 shrink-0">
          {Array.from({ length: 24 }, (_, h) => (
            <div className="relative" key={h} style={{ height: HOUR_H }}>
              <span className="absolute -top-2 right-2 font-medium text-fg-muted text-xs">
                {h === 0 ? '' : fmtHour(h)}
              </span>
            </div>
          ))}
        </div>

        {/* day columns */}
        <div className="relative flex flex-1">
          {days.map((d) => {
            const isToday = sameDay(d, today);
            const dayEvents = events.filter((e) =>
              sameDay(new Date(e.start), d)
            );
            return (
              <div
                className={cn(
                  'relative flex-1',
                  onCreateSlot && 'cursor-pointer',
                  isToday && isWeek && 'overflow-hidden rounded-b-xl bg-page/70'
                )}
                key={d.toDateString()}
                onClick={(e) => handleSlotClick(d, e)}
                onMouseLeave={
                  onCreateSlot ? () => setHoverSlot(null) : undefined
                }
                onMouseMove={
                  onCreateSlot
                    ? (e) =>
                        setHoverSlot({ day: d.toDateString(), hour: hourAt(e) })
                    : undefined
                }
              >
                {/* gridlines */}
                {Array.from({ length: 24 }, (_, h) => (
                  <div
                    className="border-divider border-b"
                    key={h}
                    style={{ height: HOUR_H }}
                  />
                ))}
                {/* hover new-event hint */}
                {onCreateSlot &&
                  hoverSlot?.day === d.toDateString() &&
                  hoverSlot.hour !== pendingSlot?.hour && (
                    <div
                      className="pointer-events-none absolute right-1 left-1 z-1 flex items-center gap-1 rounded-row bg-tint-accent-1/30 px-2 font-semibold text-xs"
                      style={{ height: HOUR_H, top: hoverSlot.hour * HOUR_H }}
                    >
                      {/* the text will be hard to read, leave empty for now */}
                      {/* <Icon name="plus" size={13} strokeWidth={2.5} />
                      {fmtHour(hoverSlot.hour)} */}
                    </div>
                  )}
                {/* pending new-event highlight */}
                {pendingSlot?.day === d.toDateString() && (
                  <div
                    className="pointer-events-none absolute right-1 left-1 z-1 rounded-row"
                    style={{
                      backgroundColor: 'var(--color-surface)',
                      backgroundImage:
                        'repeating-linear-gradient(45deg, color-mix(in srgb, var(--tint-accent-1-bg) 100%, transparent) 0, color-mix(in srgb, var(--tint-accent-1-bg) 100%, transparent) 6px, transparent 6px, transparent 12px)',
                      height: HOUR_H,
                      top: pendingSlot.hour * HOUR_H,
                    }}
                  />
                )}
                {/* events */}
                {dayEvents.map((ev) => {
                  const c = colorFor(ev);
                  const top = hourOf(ev.start) * HOUR_H;
                  const height = Math.max(
                    24,
                    (hourOf(ev.end) - hourOf(ev.start)) * HOUR_H
                  );
                  const content = (
                    <>
                      <span className="block truncate font-bold text-xs">
                        {ev.title}
                      </span>
                      <span className="block truncate font-semibold text-xs opacity-80">
                        {fmtTime(ev.start)}
                      </span>
                    </>
                  );
                  const className = cn(
                    'absolute right-1 left-1 z-2 flex flex-col overflow-hidden rounded-row px-2 py-1.5 text-left shadow-xs',
                    selectedId === ev.id && 'ring-2 ring-fg'
                  );
                  const style = { background: c.bg, color: c.fg, height, top };

                  if (onSelectEvent) {
                    return (
                      <button
                        className={className}
                        key={ev.id}
                        onClick={(e) => {
                          e.stopPropagation();
                          onSelectEvent(ev);
                        }}
                        style={style}
                        type="button"
                      >
                        {content}
                      </button>
                    );
                  }

                  return (
                    <Link
                      className={className}
                      key={ev.id}
                      onClick={(e) => e.stopPropagation()}
                      search={{ event: ev.id }}
                      style={style}
                      to="/schedule"
                    >
                      {content}
                    </Link>
                  );
                })}
              </div>
            );
          })}

          {/* current-time line — dashed across the whole grid, solid over today */}
          {todayIdx >= 0 && (
            <div
              className="pointer-events-none absolute inset-x-0 z-10"
              ref={nowRef}
              style={{ top: nowTop }}
            >
              <div className="border-solid-error/70 border-t-2 border-dashed" />
              <div
                className="absolute top-0 border-solid-error border-t-2"
                style={{
                  left: `${(todayIdx / days.length) * 100}%`,
                  width: `${100 / days.length}%`,
                }}
              >
                <span className="absolute top-[-5px] -left-1 h-2 w-2 rounded-full bg-solid-error" />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
