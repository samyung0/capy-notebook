import { Link, useNavigate } from '@tanstack/react-router';
import { useBilling, useUsage } from '@/api/hooks';
import { TabHeader } from '@/components/app/tabPanel';
import {
  type Segment,
  UsageBar,
  UsageHead,
  UsageLegend,
} from '@/components/app/UsageMeter';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { m } from '@/i18n';
import { userColorPair } from '@/lib/userColor';
import { CreditNotices } from './CreditNotices';
import { StarterOffer } from './CreditsSection';
// Credit periods start at UTC midnight, so dates are read and shown in UTC;
// local time would put a western user's period a day early.
import { monthName, periodMonth, shortDate } from './creditLabels';
import { type CreditView, creditView } from './credits';
import { formatBytes, formatCredits, storageLimitLabel } from './format';
import { AREAS, areaOf, planLabel } from './labels';

export function UsageTab() {
  const { data: billing, isPending: billingPending } = useBilling();
  const { data: usage, isPending: usagePending } = useUsage();
  const creditsPending = billingPending || usagePending;
  const navigate = useNavigate();
  const toSubscription = () =>
    void navigate({ search: { tab: 'subscription' }, to: '/billing' });
  const loadingValue = (
    <span
      aria-hidden="true"
      className="inline-block h-[1lh] w-36 rounded-button bg-surface-hover-bg align-bottom"
    />
  );
  const purple = userColorPair('purple').bg;

  const periodStart = billing?.creditsPeriodStart
    ? new Date(billing.creditsPeriodStart)
    : undefined;
  const resetsAt = periodStart && new Date(periodStart);
  resetsAt?.setUTCMonth(resetsAt.getUTCMonth() + 1);
  const periodEnd = resetsAt && new Date(resetsAt.getTime() - 86_400_000);

  const storageLimit = billing?.storageLimitBytes ?? 0;
  const storageUsed = billing?.storageUsedBytes ?? 0;

  const byArea = new Map<string, number>();
  for (const bucket of usage?.bySurface ?? []) {
    const key = areaOf(bucket.key).key;
    byArea.set(key, (byArea.get(key) ?? 0) + bucket.creditMicros);
  }
  const spent = [...byArea.values()].reduce((sum, v) => sum + v, 0);
  const view = billing && creditView(billing, spent);
  const carried: Segment[] =
    billing && billing.creditsCarriedMicros > 0
      ? [
          {
            amount: billing.creditsCarriedMicros,
            color: userColorPair('coral').bg,
            faint: true,
            key: 'carried',
            label: m.billing_owed_from({
              month: monthName(periodMonth(billing.creditsPeriodStart, -1)),
            }),
          },
        ]
      : [];
  const areas: Segment[] = [
    ...carried,
    ...AREAS.map((a) => ({
      amount: byArea.get(a.key) ?? 0,
      color: userColorPair(a.tone).bg,
      key: a.key,
      label: a.label(),
    })),
  ];
  const reserved: Segment = {
    amount: billing?.creditsReservedMicros ?? 0,
    color: purple,
    faint: true,
    key: 'reserved',
    label: m.billing_reserved_label(),
  };
  const legend = reserved.amount > 0 ? [...areas, reserved] : areas;

  return (
    <div aria-busy={creditsPending}>
      {creditsPending && (
        <span className="sr-only" role="status">
          {m.a11y_loading()}
        </span>
      )}
      <TabHeader
        badge={
          billingPending ? (
            <span
              aria-hidden="true"
              className="h-4.5 w-12 rounded-full bg-surface-hover-bg"
            />
          ) : (
            billing && (
              <Badge size="sm" tone="accent-1">
                {planLabel(billing.planTier)}
              </Badge>
            )
          )
        }
        description={
          billingPending ? (
            <span
              aria-hidden="true"
              className="block h-[1lh] w-48 max-w-full rounded-button bg-surface-hover-bg"
            />
          ) : periodStart && periodEnd ? (
            m.billing_usage_period({
              end: shortDate(periodEnd),
              start: shortDate(periodStart),
            })
          ) : (
            ''
          )
        }
        title={m.billing_tab_usage()}
      />
      {billing && view && (
        <CreditNotices
          billing={billing}
          className="mb-8"
          onChangeLimit={toSubscription}
          onTopUp={toSubscription}
          view={view}
        />
      )}
      <div className="flex flex-col gap-10">
        <div>
          <UsageHead
            title={m.billing_storage()}
            value={
              billingPending
                ? loadingValue
                : m.billing_used_of({
                    limit: storageLimitLabel(storageLimit),
                    used: formatBytes(storageUsed),
                  })
            }
          />
          <UsageBar
            limit={storageLimit}
            segments={[
              { amount: storageUsed, color: purple, key: 'used', label: '' },
              {
                amount: billing?.storageReservedBytes ?? 0,
                color: purple,
                faint: true,
                key: 'reserved',
                label: '',
              },
            ]}
          />
          <p className="t-meta mt-2 text-fg-muted">
            {m.billing_storage_hint()}
          </p>
        </div>
        <div>
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <p className="t-subtitle font-bold">{m.billing_credits()}</p>
            <div className="flex items-center gap-4">
              <p className="t-subtitle font-bold">
                {view
                  ? view.owed > 0
                    ? m.billing_credits_owed({
                        amount: formatCredits(view.owed),
                      })
                    : m.billing_credits_left({
                        amount: formatCredits(Math.max(0, view.available)),
                      })
                  : loadingValue}
              </p>
              <Button asChild size="sm" variant="outline">
                <Link search={{ tab: 'subscription' }} to="/billing">
                  {m.billing_top_up()}
                </Link>
              </Button>
            </div>
          </div>
          <UsageBar
            limit={view?.barTotal ?? 0}
            segments={creditsPending ? [] : [...areas, reserved]}
            stripedFrom={
              view && view.purchasedPool > 0 ? markerAt(view) : undefined
            }
          />
          {view && view.purchasedPool > 0 && (
            // The spacer shrinks when the label would overflow the bar, so the
            // label starts where purchased credits start until it hits the end.
            <div className="mt-1.5 flex">
              <div style={{ flex: `0 1 ${markerAt(view)}%` }} />
              <span className="t-meta shrink-0 whitespace-nowrap text-fg-secondary">
                {m.billing_purchased_marker()}
              </span>
            </div>
          )}
          {billing?.creditSettings.starterAvailable && (
            <StarterOffer
              cardUsed={billing.creditSettings.starterCardUsed}
              className="mt-6"
            />
          )}
          <p className="t-meta mt-6 mb-1 text-fg-muted">
            {m.billing_by_area()}
          </p>
          <UsageLegend
            segments={legend.map((segment) => ({
              ...segment,
              value: creditsPending
                ? loadingValue
                : m.billing_credits_amount({
                    amount: formatCredits(segment.amount),
                  }),
            }))}
          />
        </div>
      </div>
    </div>
  );
}

/** Where purchased credits start on the bar, in percent. */
function markerAt(view: CreditView) {
  return (view.limit / view.barTotal) * 100;
}
