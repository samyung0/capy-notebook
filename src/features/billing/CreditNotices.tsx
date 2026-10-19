import type { ReactNode } from 'react';
import { useCancelReloadRetry } from '@/api/hooks';
import type { BillingInfo } from '@/api/types';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import {
  declineLabel,
  monthName,
  paymentMethodLabel,
  periodMonth,
  shortDate,
} from './creditLabels';
import type { CreditView } from './credits';
import { formatCredits, formatDollars } from './format';

type Tone = 'plain' | 'warning' | 'error';

function Notice({
  tone,
  title,
  body,
  action,
}: {
  tone: Tone;
  title: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <div
      className={cn(
        // Phones put the actions on their own row, right-aligned.
        'flex flex-col gap-3 rounded-lg border p-3.5 sm:flex-row sm:items-start sm:justify-between',
        tone === 'plain' && 'border-line bg-surface-hover-bg text-fg',
        tone === 'warning' &&
          'border-solid-warning/45 bg-tint-warning text-tint-warning-fg',
        tone === 'error' &&
          'border-solid-error/45 bg-tint-error text-tint-error-fg'
      )}
      role="status"
    >
      <div className="flex min-w-0 flex-1 items-start gap-2.5">
        <Icon className="mt-0.5 size-4.5 shrink-0" name="info" />
        <div className="min-w-0 flex-1">
          <p className="font-bold text-sm">{title}</p>
          <p className="mt-0.5 text-[13px]">{body}</p>
        </div>
      </div>
      {action && <div className="self-end sm:self-auto">{action}</div>}
    </div>
  );
}

/**
 * Auto-reload notices, shown above the credit panels on Subscription and above
 * the bars on Usage: charging (plain), Stripe retrying, Stripe stopped while
 * credits are owed, and skipped for the spending limit.
 */
export function CreditNotices({
  billing,
  view,
  onTopUp,
  onChangeLimit,
  className,
}: {
  billing: BillingInfo;
  view: CreditView;
  onTopUp: () => void;
  onChangeLimit: () => void;
  className?: string;
}) {
  const settings = billing.creditSettings;
  const reload = settings.reload;
  const amount = formatDollars(reload.amountCents);
  const owed = formatCredits(view.owed);
  const topUp = (
    <Button onClick={onTopUp} size="sm" variant="dark">
      {m.billing_top_up()}
    </Button>
  );
  const { isPending: cancelling, mutate: cancelRetry } = useCancelReloadRetry();
  const notices: ReactNode[] = [];

  if (reload.status === 'charging') {
    notices.push(
      <Notice
        body={m.billing_reload_charging_body({
          method: settings.paymentMethod
            ? paymentMethodLabel(settings.paymentMethod)
            : '',
        })}
        key="charging"
        title={m.billing_reload_charging_title({ amount })}
        tone="plain"
      />
    );
  }
  if (reload.status === 'retrying' && reload.nextAttemptAt) {
    const date = shortDate(new Date(reload.nextAttemptAt));
    notices.push(
      <Notice
        action={
          <div className="flex items-center gap-2">
            <Button
              disabled={cancelling}
              onClick={() => cancelRetry()}
              size="sm"
              variant="ghost-hover"
            >
              {m.billing_reload_cancel_retry()}
            </Button>
            {topUp}
          </div>
        }
        body={
          view.owed > 0
            ? m.billing_reload_retrying_body_owed({ amount, date, owed })
            : m.billing_reload_retrying_body({ amount, date })
        }
        key="retrying"
        title={m.billing_reload_retrying_title()}
        tone="warning"
      />
    );
  }
  if (reload.status === 'failed' && view.owed > 0) {
    notices.push(
      <Notice
        action={topUp}
        body={m.billing_reload_stopped_body_owed({
          amount,
          month: monthName(periodMonth(billing.creditsPeriodStart, 1)),
          owed,
          reason: declineLabel(reload.declineReason ?? ''),
        })}
        key="stopped"
        title={m.billing_reload_stopped_title()}
        tone="error"
      />
    );
  }
  if (reload.skipped && settings.spendingLimitCents) {
    notices.push(
      <Notice
        action={
          <Button onClick={onChangeLimit} size="sm" variant="dark">
            {m.billing_change_limit()}
          </Button>
        }
        body={m.billing_reload_skipped_body({
          amount: formatDollars(settings.reloadAmountCents),
          limit: formatDollars(settings.spendingLimitCents),
        })}
        key="skipped"
        title={m.billing_reload_skipped_title()}
        tone="warning"
      />
    );
  }
  if (notices.length === 0) return null;
  return <div className={cn('flex flex-col gap-3', className)}>{notices}</div>;
}
