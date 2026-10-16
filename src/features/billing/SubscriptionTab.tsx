import { useState } from 'react';
import {
  useBilling,
  useBillingCheckout,
  useBillingPortal,
  useInvoices,
  useUsage,
} from '@/api/hooks';
import type { Invoice } from '@/api/types';
import { ErrorState } from '@/components/app/ErrorState';
import { TabHeader } from '@/components/app/tabPanel';
import { Button, ErrorAction } from '@/components/ui/Button';
import { getLocale, m } from '@/i18n';
import { track } from '@/lib/analytics';
import { describeError } from '@/lib/errors';
import {
  type BillingColumn,
  BillingTable,
  BillingTableSkeleton,
} from './BillingTable';
import { CreditsSection } from './CreditsSection';
import { shortDate } from './creditLabels';
import { formatMoney } from './format';
import { planLabel } from './labels';

const KIND_LABEL: Record<Invoice['kind'], () => string> = {
  plan: m.billing_invoice_kind_plan,
  reload: m.billing_invoice_kind_reload,
  topup: m.billing_invoice_kind_topup,
};

const STATUS_LABEL: Record<Invoice['status'], () => string> = {
  open: m.billing_invoice_status_open,
  paid: m.billing_invoice_status_paid,
  uncollectible: m.billing_invoice_status_uncollectible,
  void: m.billing_invoice_status_void,
};

/** Current plan plus one way forward: Checkout for Free, the Stripe portal
 * for Pro. Plan comparison lives on the landing site. */
export function SubscriptionTab() {
  const { data: billing } = useBilling();
  const { data: usage } = useUsage();
  const { mutateAsync: checkout } = useBillingCheckout();
  const { isPending: portalIsPending, mutate: openPortal } = useBillingPortal();
  const [upgrading, setUpgrading] = useState(false);
  const tier = billing?.planTier ?? 'free';

  async function upgrade() {
    setUpgrading(true);
    try {
      const { url } = await checkout('pro');
      track('subscription_checkout_started', { tier: 'pro' });
      window.location.href = url;
    } catch {
      // The global mutation handler shows the failure.
    } finally {
      setUpgrading(false);
    }
  }

  return (
    <>
      <TabHeader
        description={m.billing_subscription_hint()}
        title={m.subscription_title()}
      />
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-col gap-1">
          <p className="t-meta text-fg-muted">{m.billing_current_plan()}</p>
          <p className="t-large-card-title">{planLabel(tier)}</p>
        </div>
        {tier === 'pro' ? (
          <Button
            disabled={portalIsPending}
            onClick={() => openPortal()}
            rounded="large"
            variant="outline"
          >
            {m.subscription_manage()}
          </Button>
        ) : (
          <Button
            disabled={upgrading || !billing}
            onClick={() => void upgrade()}
            rounded="large"
          >
            {m.billing_upgrade_pro()}
          </Button>
        )}
      </div>
      {billing && usage && (
        <CreditsSection
          billing={billing}
          spentThisMonthMicros={usage.bySurface.reduce(
            (sum, bucket) => sum + bucket.creditMicros,
            0
          )}
        />
      )}
      <div className="mt-12 flex flex-col gap-3">
        <p className="t-subtitle font-bold">{m.billing_invoices()}</p>
        <Invoices />
      </div>
    </>
  );
}

function Invoices() {
  const { data, error, isError, isPending, refetch } = useInvoices();
  const locale = getLocale();
  const columns: BillingColumn[] = [
    { id: 'date', label: m.billing_col_date() },
    { id: 'type', label: m.billing_col_type(), muted: true },
    { id: 'total', label: m.billing_col_total() },
    { id: 'status', label: m.billing_col_status() },
    { align: 'right', id: 'view', label: '' },
  ];
  const day = (iso: string) =>
    new Date(iso).toLocaleDateString(locale, {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    });

  if (isError) {
    return (
      <ErrorState
        {...describeError(error)}
        action={
          <ErrorAction iconLeftClassName="me-1" onClick={() => void refetch()}>
            {m.error_action_retry()}
          </ErrorAction>
        }
        variant="panel"
      />
    );
  }
  if (isPending) return <BillingTableSkeleton columns={columns} />;
  if (data.items.length === 0) {
    return <p className="text-fg-muted">{m.billing_invoices_empty()}</p>;
  }
  return (
    <BillingTable
      columns={columns}
      rows={data.items.map((invoice) => {
        // An unpaid reload failed: Stripe retries it (a next attempt) or gave
        // up (uncollectible); either can still be paid from its hosted page.
        // One that is open with no next attempt is still being charged.
        const reload = invoice.kind === 'reload';
        const retrying =
          reload && invoice.status === 'open' && !!invoice.nextAttemptAt;
        const failed =
          retrying || (reload && invoice.status === 'uncollectible');
        const status =
          retrying && invoice.nextAttemptAt
            ? m.billing_invoice_status_retrying({
                date: shortDate(new Date(invoice.nextAttemptAt)),
              })
            : failed
              ? m.billing_invoice_status_failed()
              : reload && invoice.status === 'open'
                ? m.billing_invoice_status_processing()
                : STATUS_LABEL[invoice.status]();
        return {
          cells: {
            date: day(invoice.createdAt),
            status,
            total: formatMoney(invoice.total, invoice.currency),
            type: KIND_LABEL[invoice.kind](),
            view: invoice.url && (
              <a
                className="font-semibold text-fg underline underline-offset-4"
                href={invoice.url}
                rel="noreferrer"
                target="_blank"
              >
                {failed ? m.billing_invoice_pay() : m.billing_invoice_view()}
              </a>
            ),
          },
          key: invoice.id,
        };
      })}
    />
  );
}
