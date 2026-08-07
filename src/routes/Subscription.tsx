import { useState } from 'react';
import {
  useBilling,
  useBillingCheckout,
  useBillingPortal,
  useMe,
} from '@/api/hooks';
import type { PlanTier } from '@/api/types';
import { PageHeader, Panel } from '@/components/app/layout';
import { Button } from '@/components/ui/Button';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';

const STORAGE_LIMITS = {
  free: 100 * 1024 * 1024,
  pro: 1024 * 1024 * 1024,
} as const;

function storageLimitLabel(bytes: number) {
  const unit = bytes >= 1024 ** 3 ? 'GB' : 'MB';
  const divisor = unit === 'GB' ? 1024 ** 3 : 1024 ** 2;
  return `${Math.round(bytes / divisor)} ${unit}`;
}

function formatBytes(bytes: number) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  return `${Math.round(bytes / 1024)} KiB`;
}

function planLabel(tier: PlanTier) {
  switch (tier) {
    case 'pro':
      return m.subscription_plan_pro();
    default:
      return m.subscription_plan_free();
  }
}

const PLANS: {
  tier: PlanTier;
  bullets: string[];
}[] = [
  {
    bullets: [
      '3 workspaces',
      `${storageLimitLabel(STORAGE_LIMITS.free)} storage`,
      'Basic chat',
    ],
    tier: 'free',
  },
  {
    bullets: [
      'Unlimited workspaces',
      `${storageLimitLabel(STORAGE_LIMITS.pro)} storage`,
      'AI generate',
      'Priority ingest',
    ],
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

export default function Subscription() {
  const { data: me } = useMe();
  const { data: billing } = useBilling();
  const { mutateAsync: checkout } = useBillingCheckout();
  const { isPending: portalIsPending, mutate: openPortal } = useBillingPortal();
  const [busy, setBusy] = useState<PlanTier | null>(null);

  async function upgrade(tier: PlanTier) {
    setBusy(tier);
    try {
      const { url } = await checkout(tier);
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
            {billing && (
              <p className="mt-2 text-fg-muted text-sm">
                Storage: {formatBytes(billing.storageUsedBytes)} of{' '}
                {formatBytes(billing.storageLimitBytes)}
                {billing.storageReservedBytes > 0 &&
                  ` (${formatBytes(billing.storageReservedBytes)} reserved)`}
              </p>
            )}
            {me?.subscriptionStatus === 'active' && (
              <Button
                className="mt-3"
                disabled={portalIsPending}
                onClick={() => openPortal()}
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
          <div className="grid gap-4 md:grid-cols-2">
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
