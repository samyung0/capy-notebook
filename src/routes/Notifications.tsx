import { Link } from '@tanstack/react-router';
import {
  useMarkNotificationRead,
  useMarkNotificationsRead,
  useMe,
  useNotifications,
  useUnreadNotificationCount,
} from '@/api/hooks';
import type { AppNotification } from '@/api/types';
import { ListEnd } from '@/components/app/ListEnd';
import { PageHeader, PanelWithInvertedRadius } from '@/components/app/layout';
import { QueryPausedState } from '@/components/app/QueryPausedState';
import { Button } from '@/components/ui/Button';
import { SkeletonList } from '@/components/ui/feedback';
import { Icon } from '@/components/ui/Icon';
import { IconButton } from '@/components/ui/IconButton';
import {
  NotificationItem,
  type NotificationSelf,
} from '@/features/notification/NotificationItem';
import { getLocale, m } from '@/i18n';

function dayLabel(date: Date): string {
  const today = new Date();
  if (date.toDateString() === today.toDateString())
    return m.notifications_today();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString())
    return m.notifications_yesterday();
  return new Intl.DateTimeFormat(getLocale(), {
    day: 'numeric',
    month: 'short',
    weekday: 'short',
  }).format(date);
}

/** Newest first, so each day's rows are already together. */
function byDay(items: AppNotification[]) {
  const days: { label: string; items: AppNotification[] }[] = [];
  for (const item of items) {
    const label = dayLabel(new Date(item.at));
    const last = days.at(-1);
    if (last?.label === label) last.items.push(item);
    else days.push({ items: [item], label });
  }
  return days;
}

/** A notification's href, split into the router's path and search. */
function target(href: string) {
  const q = href.indexOf('?');
  if (q === -1) return { to: href };
  return {
    search: Object.fromEntries(new URLSearchParams(href.slice(q + 1))),
    to: href.slice(0, q),
  };
}

function Row({
  notification: n,
  self,
}: {
  notification: AppNotification;
  self?: NotificationSelf;
}) {
  const { mutate: markRead } = useMarkNotificationRead();
  const item = <NotificationItem notification={n} self={self} />;
  if (!n.href)
    return (
      <div className="flex w-full border-divider border-b px-3 py-2.5 last:border-0">
        {item}
      </div>
    );
  return (
    <Link
      className="flex w-full rounded-button border-divider border-b px-3 py-2.5 transition-[background-color,scale] last:border-0 hover:border-transparent hover:bg-surface-hover-bg active:scale-[0.99]"
      onClick={() => {
        if (!n.readAt) markRead(n.id);
      }}
      {...target(n.href)}
    >
      {item}
    </Link>
  );
}

/** Every notification of the last 30 days, grouped by day; a row opens what
 * it is about and marks itself read. */
export default function Notifications() {
  const {
    data,
    fetchNextPage,
    fetchStatus,
    hasNextPage,
    isFetchingNextPage,
    isFetchNextPageError,
  } = useNotifications();
  const { data: unread } = useUnreadNotificationCount({
    errorBoundary: false,
  });
  const { mutate: markAllRead } = useMarkNotificationsRead();
  const { data: me } = useMe({ errorBoundary: false });
  const items = data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <PanelWithInvertedRadius
      header={<PageHeader title={m.notifications_title()} />}
    >
      {/* The wide gutter; the actions sit at the panel's right edge, the
       * list keeps its reading width. */}
      <div className="page-px-wide flex w-full flex-col">
        <div className="flex items-center justify-end">
          <Button
            disabled={!unread?.count}
            iconLeft="tickDouble"
            onClick={() => markAllRead()}
            size="sm"
            variant="ghost-hover"
          >
            {m.notifications_mark_all_read()}
          </Button>
          <IconButton
            asChild
            icon="settings"
            label={m.notifications_settings()}
            size="sm"
            tooltip
            variant="ghost-hover"
          >
            <Link search={{ tab: 'notifications' }} to="/settings" />
          </IconButton>
        </div>
        <div className="flex max-w-3xl flex-col">
          {!data &&
            (fetchStatus === 'paused' ? (
              <QueryPausedState />
            ) : (
              <SkeletonList className="mt-4" count={6} rowHeight={64} />
            ))}
          {data && !items.length && (
            <div className="flex flex-col items-center gap-2 px-6 py-16 text-center">
              <Icon className="text-fg-muted" name="bell" size={28} />
              <p className="t-subtitle font-bold">{m.notifications_empty()}</p>
              <p className="text-fg-secondary">
                {m.notifications_empty_body()}
              </p>
            </div>
          )}
          {byDay(items).map((day) => (
            <section className="mt-3.5" key={day.label}>
              <h2 className="t-label pb-1.5 text-fg-muted">{day.label}</h2>
              <div className="-mx-3 flex flex-col">
                {day.items.map((n) => (
                  <Row key={n.id} notification={n} self={me} />
                ))}
              </div>
            </section>
          ))}
          <ListEnd
            fetchNextPage={fetchNextPage}
            hasNextPage={hasNextPage}
            isFetchingNextPage={isFetchingNextPage}
            isFetchNextPageError={isFetchNextPageError}
          />
          {!hasNextPage && items.length > 0 && (
            <p className="t-meta pt-4 text-center text-fg-muted">
              {m.notifications_end()}
            </p>
          )}
        </div>
      </div>
    </PanelWithInvertedRadius>
  );
}
