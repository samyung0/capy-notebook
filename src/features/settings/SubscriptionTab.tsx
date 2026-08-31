import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { useBillingCheckout, useBillingPortal, useMe } from '@/api/hooks';
import type { BillingCheckoutReq, PlanTier } from '@/api/types';
import { Button } from '@/components/ui/Button';
import { storageLimitLabel } from '@/features/billing/format';
import { PLAN_LIMITS } from '@/features/billing/planLimits';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { track } from '@/lib/observability';

export function planLabel(tier: PlanTier) {
  switch (tier) {
    case 'pro':
      return m.subscription_plan_pro();
    default:
      return m.subscription_plan_free();
  }
}

/** Only paid tiers can start a checkout session. */
type CheckoutTier = BillingCheckoutReq['planTier'];

const PLANS: {
  tier: PlanTier;
  bullets: () => string[];
  checkoutTier?: CheckoutTier;
}[] = [
  {
    bullets: () => [
      m.subscription_bullet_workspaces_free(),
      m.subscription_bullet_storage({
        size: storageLimitLabel(PLAN_LIMITS.free.storageLimitBytes),
      }),
      m.subscription_bullet_chat(),
    ],
    tier: 'free',
  },
  {
    bullets: () => [
      m.subscription_bullet_workspaces_unlimited(),
      m.subscription_bullet_storage({
        size: storageLimitLabel(PLAN_LIMITS.pro.storageLimitBytes),
      }),
      m.subscription_bullet_generate(),
      m.subscription_bullet_priority_ingest(),
    ],
    checkoutTier: 'pro',
    tier: 'pro',
  },
];

function PlanCard({
  tier,
  bullets,
  current,
  onUpgrade,
  loading,
}: {
  tier: PlanTier;
  bullets: string[];
  current: boolean;
  onUpgrade?: () => void;
  loading?: boolean;
}) {
  return (
    <div
      className={cn(
        'flex flex-col gap-3 rounded-card border px-5 py-5',
        current ? 'border-action bg-surface' : 'border-line bg-surface'
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <p className="t-subtitle">{planLabel(tier)}</p>
        {current && (
          <p className="t-label rounded-full bg-action/10 px-2 py-0.5 text-fg-muted">
            {m.subscription_current()}
          </p>
        )}
      </div>
      <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
        {bullets.map((b) => (
          <li className="text-fg-secondary text-sm" key={b}>
            · {b}
          </li>
        ))}
      </ul>
      {tier !== 'free' && !current && onUpgrade && (
        <Button disabled={loading} onClick={onUpgrade}>
          {m.subscription_upgrade()}
        </Button>
      )}
    </div>
  );
}

export function SubscriptionTab() {
  const { data: me } = useMe();
  const { mutateAsync: checkout } = useBillingCheckout();
  const { isPending: portalIsPending, mutate: openPortal } = useBillingPortal();
  const [busy, setBusy] = useState<PlanTier | null>(null);

  async function upgrade(tier: CheckoutTier) {
    setBusy(tier);
    try {
      const { url } = await checkout(tier);
      track('subscription_checkout_started', { tier });
      window.location.href = url;
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <div className="mb-6 rounded-card border border-line bg-surface px-5 py-4">
        <p className="t-label mb-1 block text-fg-muted">
          {m.subscription_status_label()}
        </p>
        <p className="t-subtitle">
          {planLabel(me?.planTier ?? 'free')} ·{' '}
          {me?.subscriptionStatus ?? 'none'}
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          {me?.subscriptionStatus === 'active' && (
            <Button
              disabled={portalIsPending}
              onClick={() => openPortal()}
              size="sm"
              variant="outline"
            >
              {m.subscription_manage()}
            </Button>
          )}
          <Button asChild size="sm" variant="ghost">
            <Link to="/billing">{m.billing_view_usage()}</Link>
          </Button>
        </div>
      </div>

      <p className="t-label mb-3 text-fg-muted">
        {m.subscription_plans_heading()}
      </p>
      <div className="grid gap-4 md:grid-cols-2">
        {PLANS.map((p) => {
          const checkoutTier = p.checkoutTier;
          return (
            <PlanCard
              bullets={p.bullets()}
              current={me?.planTier === p.tier}
              key={p.tier}
              loading={busy === p.tier}
              onUpgrade={checkoutTier ? () => upgrade(checkoutTier) : undefined}
              tier={p.tier}
            />
          );
        })}
      </div>
    </div>
  );
}
