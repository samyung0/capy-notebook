import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { m } from '@/i18n';
import { UsageTab } from './UsageTab';

const pending = vi.hoisted(() => ({ billing: true, usage: true }));
const starter = vi.hoisted(() => ({ available: false, cardUsed: false }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: React.ReactNode }) => (
    <a href="/">{children}</a>
  ),
  useNavigate: () => () => undefined,
}));
vi.mock('@/api/hooks', () => ({
  useBilling: () => ({
    data: pending.billing
      ? undefined
      : {
          creditSettings: {
            reload: { amountCents: 0, skipped: false },
            starterAvailable: starter.available,
            starterCardUsed: starter.cardUsed,
          },
          creditsCarriedMicros: 0,
          creditsLimitMicros: 20_000_000,
          creditsPeriodStart: '2026-10-01T00:00:00Z',
          creditsPurchasedMicros: 0,
          creditsReservedMicros: 0,
          creditsUsedMicros: 1_000_000,
          planTier: 'pro',
          storageLimitBytes: 100_000_000,
          storageUsedBytes: 1_000_000,
        },
    isFetching: true,
    isPending: pending.billing,
  }),
  useCancelReloadRetry: () => ({ isPending: false, mutate: vi.fn() }),
  usePaymentMethodCheckout: () => ({ isPending: false, mutate: vi.fn() }),
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

it('offers the starter credits and says when the saved card was used before', () => {
  pending.billing = false;
  pending.usage = false;
  starter.available = true;
  starter.cardUsed = false;
  const offer = renderToStaticMarkup(<UsageTab />);
  expect(offer).toContain(m.billing_starter_offer());
  expect(offer).not.toContain(m.billing_starter_card_used());

  starter.cardUsed = true;
  const used = renderToStaticMarkup(<UsageTab />);
  expect(used).toContain(m.billing_starter_card_used());
  expect(used).not.toContain(m.billing_starter_offer());

  starter.available = false;
  const granted = renderToStaticMarkup(<UsageTab />);
  expect(granted).not.toContain(m.billing_starter_card_used());
  expect(granted).not.toContain(m.billing_starter_offer());
});
