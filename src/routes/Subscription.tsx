import { useState } from 'react';
import { useBillingCheckout, useBillingPortal, useMe } from '@/api/hooks';
import type { PlanTier } from '@/api/types';
import { PageHeader, Panel } from '@/components/app/layout';
import { Button } from '@/components/ui';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';

function planLabel(tier: PlanTier) {
  switch (tier) {
    case 'pro':
      return m.subscription_plan_pro();
    case 'team':
      return m.subscription_plan_team();
    default:
      return m.subscription_plan_free();
  }
}

const PLANS: {
  tier: PlanTier;
  bullets: string[];
}[] = [
  {
    bullets: ['3 workspaces', '50 MB uploads', 'Basic chat'],
    tier: 'free',
  },
  {
    bullets: [
      'Unlimited workspaces',
      '5 GB uploads',
      'AI generate',
      'Priority ingest',
    ],
    tier: 'pro',
  },
  {
    bullets: [
      'Everything in Pro',
      'Shared workspaces',
      'Admin controls (coming soon)',
    ],
    tier: 'team',
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
        <Button disabled={loading} onClick={onUpgrade} variant="primary">
          {m.subscription_upgrade()}
        </Button>
      )}
    </div>
  );
}

export default function Subscription() {
  const { data: me } = useMe();
  const checkout = useBillingCheckout();
  const portal = useBillingPortal();
  const [busy, setBusy] = useState<PlanTier | null>(null);

  async function upgrade(tier: PlanTier) {
    setBusy(tier);
    try {
      const { url } = await checkout.mutateAsync(tier);
      window.location.href = url;
    } finally {
      setBusy(null);
    }
  }

  return (
    <Panel>
      <PageHeader showTopBar={false} title={m.subscription_title()} />
      <div className="min-h-0 flex-1 overflow-auto px-6 py-5">
        <div className="mx-auto max-w-3xl">
          <div className="mb-6 rounded-card border border-line bg-surface px-5 py-4">
            <p className="t-label mb-1 block text-fg-muted">
              {m.subscription_status_label()}
            </p>
            <p className="t-subtitle">
              {planLabel(me?.planTier ?? 'free')} ·{' '}
              {me?.subscriptionStatus ?? 'none'}
            </p>
            {me?.subscriptionStatus === 'active' && (
              <Button
                className="mt-3"
                disabled={portal.isPending}
                onClick={() => portal.mutate()}
                size="sm"
                variant="outline"
              >
                {m.subscription_manage()}
              </Button>
            )}
          </div>

          <p className="t-label mb-3 text-fg-muted">
            {m.subscription_plans_heading()}
          </p>
          <div className="grid gap-4 md:grid-cols-3">
            {PLANS.map((p) => (
              <PlanCard
                bullets={p.bullets}
                current={me?.planTier === p.tier}
                key={p.tier}
                loading={busy === p.tier}
                onUpgrade={
                  p.tier === 'free' ? undefined : () => upgrade(p.tier)
                }
                tier={p.tier}
              />
            ))}
          </div>
        </div>
      </div>
    </Panel>
  );
}
