import { Link } from '@tanstack/react-router';
import { useBilling, useBillingPortal, useUsage } from '@/api/hooks';
import { PageHeader, Panel } from '@/components/app/layout';
import { Button } from '@/components/ui/Button';
import { ProgressBar } from '@/components/ui/ProgressBar';
import {
  formatBytes,
  formatCredits,
  usagePercent,
} from '@/features/billing/format';
import { planLabel } from '@/features/settings/SubscriptionTab';
import { getLocale, m } from '@/i18n';

function formatDate(iso?: string) {
  if (!iso) return null;
  try {
    return new Date(iso).toLocaleDateString(getLocale(), {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
  } catch {
    return iso;
  }
}

function kindLabel(kind: string): string {
  switch (kind) {
    case 'llm':
      return m.billing_kind_llm();
    case 'embedding':
      return m.billing_kind_embedding();
    case 'caption':
      return m.billing_kind_caption();
    case 'transcribe':
      return m.billing_kind_transcribe();
    case 'parse_gpu':
      return m.billing_kind_parse_gpu();
    case 'email':
      return m.billing_kind_email();
    default:
      return kind;
  }
}

function surfaceLabel(surface: string): string {
  switch (surface) {
    case 'chat':
      return m.billing_surface_chat();
    case 'generate':
      return m.billing_surface_generate();
    case 'editor':
      return m.billing_surface_editor();
    case 'ingest':
      return m.billing_surface_ingest();
    case 'transcribe':
      return m.billing_surface_transcribe();
    case 'system':
      return m.billing_surface_system();
    default:
      return surface;
  }
}

function Meter({
  title,
  usedLabel,
  reservedLabel,
  limitLabel,
  percent,
}: {
  title: string;
  usedLabel: string;
  reservedLabel?: string;
  limitLabel: string;
  percent: number;
}) {
  return (
    <div className="rounded-card border border-line bg-surface px-5 py-4">
      <p className="t-label mb-1 text-fg-muted">{title}</p>
      <p className="t-subtitle">
        {usedLabel} / {limitLabel}
      </p>
      {reservedLabel ? (
        <p className="mt-1 text-fg-muted text-sm">{reservedLabel}</p>
      ) : null}
      <ProgressBar className="mt-3" value={percent} />
    </div>
  );
}

function BucketList({
  title,
  items,
  labelFor,
}: {
  title: string;
  items: { key: string; events: number; creditMicros: number }[];
  labelFor: (key: string) => string;
}) {
  if (items.length === 0) {
    return (
      <div className="rounded-card border border-line bg-surface px-5 py-4">
        <p className="t-label mb-2 text-fg-muted">{title}</p>
        <p className="text-fg-muted text-sm">{m.billing_breakdown_empty()}</p>
      </div>
    );
  }
  return (
    <div className="rounded-card border border-line bg-surface px-5 py-4">
      <p className="t-label mb-3 text-fg-muted">{title}</p>
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {items.map((item) => (
          <li
            className="flex items-baseline justify-between gap-3 text-sm"
            key={item.key}
          >
            <span className="text-fg">
              {labelFor(item.key)}
              <span className="ml-2 text-fg-muted">
                {m.billing_event_count({ count: String(item.events) })}
              </span>
            </span>
            <span className="text-fg-secondary tabular-nums">
              {formatCredits(item.creditMicros)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function Billing() {
  const { data: billing } = useBilling();
  const { data: usage } = useUsage();
  const { isPending: portalIsPending, mutate: openPortal } = useBillingPortal();

  const storagePct = billing
    ? usagePercent(
        billing.storageUsedBytes,
        billing.storageReservedBytes,
        billing.storageLimitBytes
      )
    : 0;
  const creditsPct = billing
    ? usagePercent(
        billing.creditsUsedMicros,
        billing.creditsReservedMicros,
        billing.creditsLimitMicros
      )
    : 0;

  return (
    <Panel>
      <PageHeader showTopBar={false} title={m.billing_title()} />
      <div className="min-h-0 flex-1 overflow-auto px-6 py-5">
        <div className="mx-auto max-w-3xl">
          <p className="mb-5 text-fg-secondary text-sm">
            {m.billing_subtitle()}
          </p>

          <div className="mb-4 rounded-card border border-line bg-surface px-5 py-4">
            <p className="t-label mb-1 text-fg-muted">
              {m.subscription_status_label()}
            </p>
            <p className="t-subtitle">
              {planLabel(billing?.planTier ?? 'free')} ·{' '}
              {billing?.subscriptionStatus ?? 'none'}
            </p>
            {billing?.renewalAt && (
              <p className="mt-1 text-fg-muted text-sm">
                {billing.cancelAtPeriodEnd
                  ? m.billing_cancels_on({
                      date: formatDate(billing.renewalAt) ?? '',
                    })
                  : m.billing_renews_on({
                      date: formatDate(billing.renewalAt) ?? '',
                    })}
              </p>
            )}
            {billing?.creditsPeriodStart && (
              <p className="mt-1 text-fg-muted text-sm">
                {m.billing_credits_period({
                  date: formatDate(billing.creditsPeriodStart) ?? '',
                })}
              </p>
            )}
            <div className="mt-3 flex flex-wrap gap-2">
              {billing?.subscriptionStatus === 'active' && (
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
                <Link search={{ tab: 'subscription' }} to="/settings">
                  {m.billing_change_plan()}
                </Link>
              </Button>
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <Meter
              limitLabel={formatBytes(billing?.storageLimitBytes ?? 0)}
              percent={storagePct}
              reservedLabel={
                billing && billing.storageReservedBytes > 0
                  ? m.billing_reserved({
                      amount: formatBytes(billing.storageReservedBytes),
                    })
                  : undefined
              }
              title={m.billing_storage()}
              usedLabel={formatBytes(billing?.storageUsedBytes ?? 0)}
            />
            <Meter
              limitLabel={formatCredits(billing?.creditsLimitMicros ?? 0)}
              percent={creditsPct}
              reservedLabel={
                billing && billing.creditsReservedMicros > 0
                  ? m.billing_reserved({
                      amount: formatCredits(billing.creditsReservedMicros),
                    })
                  : undefined
              }
              title={m.billing_credits()}
              usedLabel={formatCredits(billing?.creditsUsedMicros ?? 0)}
            />
          </div>

          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <BucketList
              items={usage?.bySurface ?? []}
              labelFor={surfaceLabel}
              title={m.billing_by_surface()}
            />
            <BucketList
              items={usage?.byKind ?? []}
              labelFor={kindLabel}
              title={m.billing_by_kind()}
            />
          </div>

          <p className="t-label mt-6 mb-3 text-fg-muted">
            {m.billing_recent()}
          </p>
          <div className="rounded-card border border-line bg-surface">
            {(usage?.recent ?? []).length === 0 ? (
              <p className="px-5 py-4 text-fg-muted text-sm">
                {m.billing_recent_empty()}
              </p>
            ) : (
              <ul className="m-0 list-none divide-y divide-divider p-0">
                {usage?.recent.map((ev, i) => (
                  <li
                    className="flex flex-wrap items-baseline justify-between gap-2 px-5 py-3 text-sm"
                    key={`${ev.createdAt}-${ev.kind}-${i}`}
                  >
                    <div className="min-w-0">
                      <p className="text-fg">
                        {surfaceLabel(ev.surface)} · {kindLabel(ev.kind)}
                        {ev.modelKey ? ` · ${ev.modelKey}` : ''}
                      </p>
                      <p className="text-fg-muted text-xs">
                        {formatDate(ev.createdAt)}
                        {ev.inputTokens + ev.outputTokens > 0
                          ? ` · ${m.billing_tokens({
                              input: String(ev.inputTokens),
                              output: String(ev.outputTokens),
                            })}`
                          : null}
                      </p>
                    </div>
                    <span className="text-fg-secondary tabular-nums">
                      {formatCredits(ev.creditMicros)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </Panel>
  );
}
