import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { qk } from './client';
import { applyNotificationEvent } from './hooks';

const notification = {
  at: '2026-08-02T12:00:00.000Z',
  data: { inviteId: 'inv_1234567890' },
  href: '/workspace-invites/inv_1234567890',
  id: 'nt_1',
  kind: 'workspace_invite' as const,
};

function cache(client: QueryClient, readAt?: string) {
  client.setQueryData(qk.notifications, {
    pageParams: [''],
    pages: [
      {
        items: [{ ...notification, ...(readAt ? { readAt } : {}) }],
      },
    ],
  });
  client.setQueryData(qk.notificationUnread, { count: readAt ? 0 : 1 });
}

describe('notification stream cache reconciliation', () => {
  it('turns a same-id re-invite back into an unread notification', () => {
    const client = new QueryClient();
    cache(client, '2026-08-02T12:01:00.000Z');

    applyNotificationEvent(client, {
      notification,
      type: 'created',
    });

    const updated = client.getQueryData<{
      pages: Array<{ items: Array<{ id: string; readAt?: string }> }>;
    }>(qk.notifications);
    expect(updated?.pages[0]?.items[0]?.id).toBe('nt_1');
    expect(updated?.pages[0]?.items[0]).not.toHaveProperty('readAt');
    expect(client.getQueryData(qk.notificationUnread)).toEqual({ count: 1 });
  });

  it('does not double-count duplicate created events', () => {
    const client = new QueryClient();
    cache(client);

    applyNotificationEvent(client, { notification, type: 'created' });
    applyNotificationEvent(client, { notification, type: 'created' });

    expect(client.getQueryData(qk.notificationUnread)).toEqual({ count: 1 });
    expect(
      client
        .getQueryData<{
          pages: Array<{ items: (typeof notification)[] }>;
        }>(qk.notifications)
        ?.pages.flatMap((page) => page.items)
    ).toHaveLength(1);
  });
});
