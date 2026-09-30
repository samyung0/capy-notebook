import { useBilling, useUsage } from '@/api/hooks';
import { TabHeader } from '@/components/app/tabPanel';
import { Badge } from '@/components/ui/Badge';
import { getLocale, m } from '@/i18n';
import { cn } from '@/lib/cn';
import { userColorPair } from '@/lib/userColor';
import { formatBytes, formatCredits, storageLimitLabel } from './format';
import { AREAS, areaOf, planLabel } from './labels';

interface Segment {
  /** Bytes for storage, credit micros for credits: same unit as the limit. */
  amount: number;
  color: string;
  faint?: boolean;
  key: string;
  label: string;
}

// Credit periods start at UTC midnight, so dates are read and shown in UTC;
// local time would put a western user's period a day early.
function shortDate(date: Date) {
  return date.toLocaleDateString(getLocale(), {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
}

/** Track with one coloured segment per share of the limit; a 2px surface
 * gap separates neighbours. */
function UsageBar({ segments, limit }: { segments: Segment[]; limit: number }) {
  return (
    <div className="mt-3 flex h-2.5 overflow-hidden rounded-full bg-surface-hover-bg">
      {limit > 0 &&
        segments
          .filter((s) => s.amount > 0)
          .map((s) => (
            <div
              className={cn(
                'h-full shrink-0 shadow-[2px_0_0_var(--color-surface)]',
                s.faint && 'opacity-35'
              )}
              key={s.key}
              style={{
                backgroundColor: s.color,
                width: `${Math.min(100, (s.amount / limit) * 100)}%`,
              }}
            />
          ))}
    </div>
  );
}

function UsageHead({ title, value }: { title: string; value: string }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
      <p className="t-subtitle font-bold">{title}</p>
      <p className="t-subtitle font-bold">{value}</p>
    </div>
  );
}

export function UsageTab() {
  const { data: billing } = useBilling();
  const { data: usage } = useUsage();
  const purple = userColorPair('purple').bg;

  const periodStart = billing?.creditsPeriodStart
    ? new Date(billing.creditsPeriodStart)
    : undefined;
  const resetsAt = periodStart && new Date(periodStart);
  resetsAt?.setUTCMonth(resetsAt.getUTCMonth() + 1);
  const periodEnd = resetsAt && new Date(resetsAt.getTime() - 86_400_000);

  const storageLimit = billing?.storageLimitBytes ?? 0;
  const storageUsed = billing?.storageUsedBytes ?? 0;
  const creditsLimit = billing?.creditsLimitMicros ?? 0;

  const byArea = new Map<string, number>();
  for (const bucket of usage?.bySurface ?? []) {
    const key = areaOf(bucket.key).key;
    byArea.set(key, (byArea.get(key) ?? 0) + bucket.creditMicros);
  }
  const areas: Segment[] = AREAS.map((a) => ({
    amount: byArea.get(a.key) ?? 0,
    color: userColorPair(a.tone).bg,
    key: a.key,
    label: a.label(),
  }));
  const reserved: Segment = {
    amount: billing?.creditsReservedMicros ?? 0,
    color: purple,
    faint: true,
    key: 'reserved',
    label: m.billing_reserved_label(),
  };
  const legend = reserved.amount > 0 ? [...areas, reserved] : areas;

  return (
    <>
      <TabHeader
        badge={
          billing && (
            <Badge size="sm" tone="accent-1">
              {planLabel(billing.planTier)}
            </Badge>
          )
        }
        description={
          periodStart && periodEnd
            ? m.billing_usage_period({
                end: shortDate(periodEnd),
                start: shortDate(periodStart),
              })
            : ''
        }
        title={m.billing_tab_usage()}
      />
      <div className="flex flex-col gap-10">
        <div>
          <UsageHead
            title={m.billing_storage()}
            value={m.billing_used_of({
              limit: storageLimitLabel(storageLimit),
              used: formatBytes(storageUsed),
            })}
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
          <UsageHead
            title={m.billing_credits()}
            value={m.billing_used_of({
              limit: formatCredits(creditsLimit),
              used: formatCredits(billing?.creditsUsedMicros ?? 0),
            })}
          />
          <UsageBar limit={creditsLimit} segments={[...areas, reserved]} />
          {resetsAt && (
            <p className="t-meta mt-2 text-fg-muted">
              {m.billing_credits_resets({ date: shortDate(resetsAt) })}
            </p>
          )}
          <p className="t-meta mt-6 mb-1 text-fg-muted">
            {m.billing_by_area()}
          </p>
          <ul className="m-0 flex list-none flex-col p-0">
            {legend.map((s) => (
              <li
                className="flex items-center justify-between gap-4 py-1.5"
                key={s.key}
              >
                <span className="flex items-center gap-3">
                  <span
                    className={cn(
                      'size-2.5 shrink-0 rounded-[3px]',
                      s.faint && 'opacity-35'
                    )}
                    style={{ backgroundColor: s.color }}
                  />
                  {s.label}
                </span>
                <span className="text-fg-muted">
                  {m.billing_credits_amount({
                    amount: formatCredits(s.amount),
                  })}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </>
  );
}
