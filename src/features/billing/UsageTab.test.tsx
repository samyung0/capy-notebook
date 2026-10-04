import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { m } from '@/i18n';
import { UsageTab } from './UsageTab';

const pending = vi.hoisted(() => ({ billing: true, usage: true }));
vi.mock('@/api/hooks', () => ({
  useBilling: () => ({
    data: pending.billing
      ? undefined
      : {
          creditsLimitMicros: 20_000_000,
          creditsPeriodStart: '2026-10-01T00:00:00Z',
          creditsUsedMicros: 1_000_000,
          planTier: 'pro',
          storageLimitBytes: 100_000_000,
          storageUsedBytes: 1_000_000,
        },
    isFetching: true,
    isPending: pending.billing,
  }),
  useUsage: () => ({
    data: pending.usage ? undefined : { bySurface: [] },
    isFetching: true,
    isPending: pending.usage,
  }),
}));

it('reserves date lines during initial loading and keeps cached data during refresh', () => {
  pending.billing = true;
  pending.usage = true;
  const loading = renderToStaticMarkup(<UsageTab />);
  expect(loading).toContain('aria-busy="true"');
  expect(loading).toContain('h-[1lh]');
  expect(loading).not.toContain(
    m.billing_used_of({ limit: '0 B', used: '0 B' })
  );

  pending.billing = false;
  const partial = renderToStaticMarkup(<UsageTab />);
  expect(partial).toContain('aria-busy="true"');
  expect(partial).toContain(m.subscription_plan_pro());
  expect(partial).toContain('aria-hidden="true"');

  pending.usage = false;
  const loaded = renderToStaticMarkup(<UsageTab />);
  expect(loaded).toContain('aria-busy="false"');
  expect(loaded).not.toContain('h-[1lh]');
  expect(loaded).not.toContain('role="status"');
  expect(loading.match(/<p[ >]/g)?.length).toBe(
    loaded.match(/<p[ >]/g)?.length
  );
  expect(loading.match(/<li[ >]/g)?.length).toBe(
    loaded.match(/<li[ >]/g)?.length
  );
});
