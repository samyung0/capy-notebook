import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import {
  useMarkNotificationRead,
  useMarkNotificationsRead,
  useNotificationStream,
  useNotifications,
  useUnreadNotificationCount,
} from '@/api/hooks';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { IconButton } from '@/components/ui/IconButton';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/Popover';

import { m } from '@/i18n';
import { NotificationItem } from '../../features/notification/NotificationItem';

export function NotificationsBell() {
  const { data, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useNotifications();
  const { data: unreadCount } = useUnreadNotificationCount();
  useNotificationStream();
  const markNotificationRead = useMarkNotificationRead();
  const markRead = useMarkNotificationsRead();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const notifications = data?.pages.flatMap((page) => page.items) ?? [];
  const unreadCountValue =
    unreadCount?.count ?? notifications.filter((n) => !n.readAt).length;
  const unread = unreadCountValue > 0;
  const bellLabel = unread
    ? m.notifications_unread_count({ count: String(unreadCountValue) })
    : m.notifications_title();

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>
        <IconButton
          className="shrink-0"
          // NOTE: dont include unread notification numbers in ui display, labelling is OK for accessibility
          dot={unread}
          icon="bell"
          label={bellLabel}
          size="md"
          variant="surface"
        />
      </PopoverTrigger>
      <PopoverContent>
        <Card
          border="solid"
          className="block min-w-[320px] max-w-120 p-1"
          radius="card"
        >
          <div className="flex h-9 items-center justify-between border-divider border-b px-4 py-2">
            <span className="t-label text-fg-muted">
              {m.notifications_title()}
            </span>
            {unread && (
              <Button
                className="text-xs"
                onClick={() => markRead.mutate()}
                size="xs"
                variant="ghost-link"
              >
                {m.notifications_mark_all_read()}
              </Button>
            )}
          </div>
          <div className="max-h-96 overflow-auto">
            {!notifications.length && (
              <div className="px-4 py-6 text-center text-fg-muted">
                {m.notifications_empty()}
              </div>
            )}
            {notifications.map((n) => (
              <Button
                className={
                  'group h-fit w-full whitespace-normal rounded-none border-divider border-b border-solid px-4 py-3 last:border-0 active:scale-[0.98]'
                }
                key={n.id}
                onClick={() => {
                  if (!n.readAt) markNotificationRead.mutate(n.id);
                  if (!n.href) return;
                  setOpen(false);
                  navigate({ to: n.href });
                }}
                type="button"
                variant="ghost"
              >
                <NotificationItem notification={n} />
              </Button>
            ))}
            {hasNextPage && (
              <div className="flex items-center justify-center border-divider border-t px-4 pt-3 pb-2.5">
                <Button
                  className="text-xs"
                  disabled={isFetchingNextPage}
                  onClick={() => void fetchNextPage()}
                  size="xs"
                  type="button"
                  variant="ghost-muted"
                >
                  {isFetchingNextPage
                    ? m.notifications_loading()
                    : m.notifications_load_more()}
                </Button>
              </div>
            )}
          </div>
        </Card>
      </PopoverContent>
    </Popover>
  );
}
