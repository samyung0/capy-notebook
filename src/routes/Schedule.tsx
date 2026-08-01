import { useNavigate, useSearch } from '@tanstack/react-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useDeleteLabel, useEvents, useLabels } from '@/api/hooks';
import type { CalendarEvent } from '@/api/types';
import { PageHeader, PanelWithInvertedRadius } from '@/components/app/layout';
import { Card } from '@/components/ui/Card';
import { Skeleton } from '@/components/ui/feedback';
import { HoverActions } from '@/components/ui/HoverActions';
import { Icon } from '@/components/ui/Icon';
import { IconButton } from '@/components/ui/IconButton';
import { MONTHS, weekDays } from '@/features/schedule/dateUtils';
import { MiniCalendar } from '@/features/schedule/MiniCalendar';
import { MonthView } from '@/features/schedule/MonthView';
import { scheduleAutoScroll } from '@/features/schedule/scrollState';
import { TimeGrid } from '@/features/schedule/TimeGrid';
import { m } from '@/i18n';
import { userColorPair } from '@/lib/userColor';
import { usePortals } from '@/stores/portals';

type View = 'month' | 'week' | 'day';

const LABEL_LIMIT = 7;

export default function Schedule() {
  const navigate = useNavigate();
  const { event: eventParam } = useSearch({ from: '/auth-shell/schedule' });
  const { data: events, isLoading } = useEvents();
  const { data: labels } = useLabels();
  const deleteLabel = useDeleteLabel();
  const openLabelEdit = usePortals((s) => s.openLabelEdit);
  const openConfirm = usePortals((s) => s.openConfirm);
  const openEventForm = usePortals((s) => s.openEventForm);
  const openEventDetail = usePortals((s) => s.openEventDetail);
  const eventDetail = usePortals((s) => s.eventDetail);
  const [view] = useState<View>('week');
  const [month, setMonth] = useState(() => new Date());
  const [selected, setSelected] = useState(() => new Date());
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [labelsOpen, setLabelsOpen] = useState(true);
  const [showAllLabels, setShowAllLabels] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  // track whether the open detail dialog originated from the ?event= param so
  // we only strip the param from the URL when that specific dialog closes.
  const openedFromParam = useRef(false);

  const visibleEvents = useMemo(
    () =>
      (events ?? []).filter(
        (e) =>
          e.labelIds.length === 0 || e.labelIds.some((id) => !hidden.has(id))
      ),
    [events, hidden]
  );
  const eventDays = useMemo(
    () => new Set((events ?? []).map((e) => new Date(e.start).toDateString())),
    [events]
  );

  // open the details dialog when navigated here with an ?event=<id> param
  // (e.g. from the dashboard calendar). Jumps the grid to that day too.
  useEffect(() => {
    if (!eventParam || !events) return;
    const ev = events.find((e) => e.id === eventParam);
    if (!ev) return;
    const day = new Date(ev.start);
    // only move the grid when the event day isn't already visible — avoids
    // re-rendering TimeGrid's day columns on every in-page event click.
    setSelected((prev) => {
      if (view === 'week') {
        const visible = weekDays(prev);
        return visible.some((d) => d.toDateString() === day.toDateString())
          ? prev
          : day;
      }
      if (view === 'day') {
        return prev.toDateString() === day.toDateString() ? prev : day;
      }
      return day;
    });
    openedFromParam.current = true;
    openEventDetail(ev);
  }, [eventParam, events, openEventDetail, view]);

  // once a param-opened dialog is dismissed, drop the ?event= param from the URL.
  // guard on a truthy→null transition so we don't strip on the initial mount,
  // where the open effect sets eventDetail but this render still sees it null.
  const prevDetail = useRef(eventDetail);
  useEffect(() => {
    const wasOpen = prevDetail.current;
    prevDetail.current = eventDetail;
    if (openedFromParam.current && wasOpen && !eventDetail) {
      openedFromParam.current = false;
      scheduleAutoScroll.rememberPosition(scrollRef.current?.scrollTop);
      navigate({ replace: true, search: {}, to: '/schedule' });
    }
  }, [eventDetail, navigate]);

  const days = view === 'week' ? weekDays(selected) : [selected];

  const createAt = (start: Date, end: Date) =>
    openEventForm({ end: end.toISOString(), start: start.toISOString() });
  const selectEvent = (event: CalendarEvent) => {
    scheduleAutoScroll.rememberPosition(scrollRef.current?.scrollTop);
    openedFromParam.current = true;
    openEventDetail(event);
    navigate({ search: { event: event.id }, to: '/schedule' });
  };
  const createOnDay = (day: Date) => {
    const start = new Date(day);
    start.setHours(9, 0, 0, 0);
    const end = new Date(start.getTime() + 60 * 60 * 1000);
    createAt(start, end);
  };

  // Range mirrored in the mini calendar — whatever the main grid is showing.
  const range = useMemo(() => {
    if (view === 'month') {
      return {
        end: new Date(month.getFullYear(), month.getMonth() + 1, 0),
        start: new Date(month.getFullYear(), month.getMonth(), 1),
      };
    }
    if (view === 'week') {
      const wd = weekDays(selected);
      return { end: wd[6], start: wd[0] };
    }
    return { end: selected, start: selected };
  }, [view, month, selected]);

  return (
    <div className="flex h-full min-h-0 gap-2.5">
      {/* left rail */}
      <div className="flex h-full w-70 shrink-0 flex-col gap-3 overflow-auto">
        <Card className="gap-0 p-3.5">
          <MiniCalendar
            eventDays={eventDays}
            month={month}
            onMonthChange={setMonth}
            onSelect={(d) => {
              setSelected(d);
              setMonth(d);
            }}
            rangeEnd={range.end}
            rangeStart={range.start}
            selected={selected}
          />
        </Card>

        <Card className="h-full flex-1 gap-0 p-3.5">
          <button
            aria-expanded={labelsOpen}
            className="flex w-full items-center gap-1.5 text-left"
            onClick={() => setLabelsOpen((o) => !o)}
            type="button"
          >
            <Icon
              className="text-fg-muted"
              name={labelsOpen ? 'chevronDown' : 'chevronRight'}
              size={16}
            />
            <span className="t-card-title font-semibold">Labels</span>
          </button>
          {labelsOpen && (
            <div className="flex flex-col py-1.5 pl-4">
              {(showAllLabels ? labels : labels?.slice(0, LABEL_LIMIT))?.map(
                (l) => {
                  const on = !hidden.has(l.id);
                  return (
                    <div
                      className="group relative flex items-center rounded-button py-1.5 pr-8 hover:bg-surface-hover-bg"
                      key={l.id}
                    >
                      <button
                        className="flex min-w-0 flex-1 items-center gap-2.5 px-1.5 text-left"
                        onClick={() =>
                          setHidden((s) => {
                            const n = new Set(s);
                            if (on) {
                              n.add(l.id);
                            } else {
                              n.delete(l.id);
                            }
                            return n;
                          })
                        }
                        type="button"
                      >
                        <span
                          className="h-3.5 w-3.5 shrink-0 rounded-sm"
                          style={{
                            background: on
                              ? userColorPair(l.color).bg
                              : 'transparent',
                            border: on
                              ? 'none'
                              : '1.5px solid var(--border-strong)',
                          }}
                        />
                        <span
                          className={
                            on
                              ? 'truncate text-fg text-sm'
                              : 'truncate text-fg-muted text-sm'
                          }
                        >
                          {l.name}
                        </span>
                      </button>
                      <HoverActions
                        className="absolute top-1/2 right-1 -translate-y-1/2"
                        items={[
                          {
                            icon: 'write',
                            label: m.action_edit(),
                            onClick: () => openLabelEdit(l),
                          },
                          {
                            danger: true,
                            icon: 'trash',
                            label: m.action_delete(),
                            onClick: () =>
                              openConfirm({
                                body: m.confirm_delete_body(),
                                onConfirm: () => deleteLabel.mutate(l.id),
                                title: m.confirm_delete_title({ name: l.name }),
                              }),
                          },
                        ]}
                      />
                    </div>
                  );
                }
              )}
              {(labels?.length ?? 0) > LABEL_LIMIT && (
                <button
                  className="mt-1 self-start rounded-button px-1.5 py-1 font-medium text-fg-muted text-sm hover:bg-surface-hover-bg hover:text-fg"
                  onClick={() => setShowAllLabels((s) => !s)}
                  type="button"
                >
                  {showAllLabels ? 'Show less' : `Show all (${labels?.length})`}
                </button>
              )}
            </div>
          )}
        </Card>
      </div>

      {/* main calendar */}
      <PanelWithInvertedRadius className="flex-1">
        <PageHeader
          actions={
            <IconButton
              icon="plus"
              label="New event"
              onClick={() => openEventForm()}
              size="lg"
              variant="page"
            />
          }
          showTopBar
          title={`${MONTHS[month.getMonth()]} ${month.getFullYear()}`}
        />
        <div className="flex items-center gap-3 px-6 pb-3">
          {/* TODO: change */}
          {/* <SegmentedControl
            onChange={(v) => setView(v as View)}
            options={[
              { label: "Month", value: "month" },
              { label: "Week", value: "week" },
              { label: "Day", value: "day" },
            ]}
            size="sm"
            value={view}
            variant="ghost"
          /> */}
        </div>

        <div className="min-h-0 flex-1 overflow-auto px-3 pb-4" ref={scrollRef}>
          {isLoading ? (
            <Skeleton className="h-full min-h-[560px] w-full" />
          ) : view === 'month' ? (
            <div className="h-full min-h-[560px]">
              <MonthView
                events={visibleEvents}
                labels={labels ?? []}
                month={month}
                onCreate={createOnDay}
                onSelectEvent={selectEvent}
              />
            </div>
          ) : (
            <TimeGrid
              autoScrollTracker={scheduleAutoScroll}
              days={days}
              events={visibleEvents}
              labels={labels ?? []}
              onCreateSlot={createAt}
              onSelectEvent={selectEvent}
              scrollContainerRef={scrollRef}
              selectedId={eventDetail?.id ?? null}
            />
          )}
        </div>
      </PanelWithInvertedRadius>
    </div>
  );
}
