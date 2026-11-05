import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';
import { qk } from '@/api/client';
import { AccountState, StorageUsageLevel } from '@/api/types';
import { m } from '@/i18n';
import HomeBanner, { AccountStatusBanner } from './HomeBanner';

const state = vi.hoisted(() => ({
  account: undefined as Record<string, unknown> | undefined,
  online: true,
}));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
}));
vi.mock('@/api/hooks', () => ({
  useMe: () => ({ data: { account: state.account } }),
}));
vi.mock('@/lib/online', () => ({ useOnlineStatus: () => state.online }));

const render = (node: ReactNode, stream: 'connected' | 'disconnected') => {
  const client = new QueryClient();
  client.setQueryData(qk.eventStream, { status: stream });
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>{node}</QueryClientProvider>
  ).replaceAll('&#x27;', "'");
};
const storage = (storageUsage: string) => ({
  state: AccountState.active,
  storageLimitBytes: 100_000_000,
  storageUsage,
  storageUsedBytes: 96_000_000,
});

beforeEach(() => {
  state.account = undefined;
  state.online = true;
});

it('both sizes show the same state, frozen before the rest', () => {
  for (const [account, title] of [
    [
      {
        ...storage(StorageUsageLevel.full),
        state: AccountState.over_quota_frozen,
      },
      m.account_banner_frozen_title(),
    ],
    [
      {
        ...storage(StorageUsageLevel.full),
        state: AccountState.over_quota_grace,
      },
      m.account_banner_grace_title(),
    ],
    [storage(StorageUsageLevel.full), m.account_banner_full_title()],
    [storage(StorageUsageLevel.near_limit), m.account_banner_near_title()],
  ] as const) {
    state.account = account;
    state.online = false;
    for (const Status of [HomeBanner, AccountStatusBanner]) {
      const html = render(<Status />, 'disconnected');
      expect(html).toContain(title);
      expect(html).toContain('href="/billing"');
    }
  }
});

it('the connection comes after the account, with no links', () => {
  state.online = false;
  const offline = render(<AccountStatusBanner />, 'connected');
  expect(offline).toContain(m.connection_offline_title());
  expect(offline).not.toContain('<a ');
  state.online = true;
  expect(render(<AccountStatusBanner />, 'disconnected')).toContain(
    m.connection_reconnecting_title()
  );
});

it('the small banner has the same words and links, with no meter', () => {
  state.account = storage(StorageUsageLevel.near_limit);
  const small = render(<AccountStatusBanner />, 'connected');
  expect(small).toContain('data-kind="near"');
  expect(small).toContain(m.account_banner_subscription());
  expect(small).toContain(
    m.account_banner_near_body({ limit: '100 MB', used: '96 MB' })
  );
  expect(small).not.toContain('storage-usage-meter');
  expect(render(<HomeBanner />, 'connected')).toContain('storage-usage-meter');
});

it('shows nothing with nothing wrong', () => {
  state.account = storage(StorageUsageLevel.ok);
  const healthy = render(<AccountStatusBanner />, 'connected');
  expect(healthy).toBe('');
  expect(render(<HomeBanner />, 'connected')).toBe('');
});
