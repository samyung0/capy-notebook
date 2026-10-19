import { useState } from 'react';
import {
  useBilling,
  useBillingCheckout,
  useBillingPortal,
  useBillingPortalCancel,
  useCancelReloadRetry,
  useInvoices,
  useUsage,
} from '@/api/hooks';
import type { Invoice } from '@/api/types';
import { InlineErrorState } from '@/components/app/ErrorState';
import { TabHeader } from '@/components/app/tabPanel';
import { Button } from '@/components/ui/Button';
import { getLocale, m } from '@/i18n';
import { track } from '@/lib/analytics';
import { describeError, unexpectedErrorId } from '@/lib/errors';
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
            variant="ghost-hover"
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
      <InlineErrorState
        className="py-6"
        errorId={unexpectedErrorId(error)}
        message={describeError(error).title}
        onRetry={() => void refetch()}
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
        // An unpaid invoice with a next attempt failed and Stripe retries it;
        // it can be paid from its hosted page. A reload Stripe gave up on
        // (uncollectible) can still be paid, a Pro one cannot: the subscription
        // is cancelled by then, so it shows Failed with View. A reload that is
        // open with no next attempt is still being charged.
        const reload = invoice.kind === 'reload';
        const retrying = invoice.status === 'open' && !!invoice.nextAttemptAt;
        const gaveUp = invoice.status === 'uncollectible';
        const payable = retrying || (reload && gaveUp);
        const failed = retrying || gaveUp;
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
            view: (
              <span className="inline-flex items-center gap-3">
                {retrying && <CancelRetry reload={reload} />}
                {invoice.url && (
                  <a
                    className="font-semibold text-fg underline underline-offset-4"
                    href={invoice.url}
                    rel="noreferrer"
                    target="_blank"
                  >
                    {payable
                      ? m.billing_invoice_pay()
                      : m.billing_invoice_view()}
                  </a>
                )}
              </span>
            ),
          },
          key: invoice.id,
        };
      })}
    />
  );
}

/** Stops Stripe retrying a failed invoice: a reload is voided here, a plan
 * invoice ends with the subscription, cancelled on the portal's cancel
 * screen. */
function CancelRetry({ reload }: { reload: boolean }) {
  const { isPending: voiding, mutate: cancelReload } = useCancelReloadRetry();
  const { isPending: opening, mutate: openCancel } = useBillingPortalCancel();
  return (
    <Button
      disabled={voiding || opening}
      onClick={() => (reload ? cancelReload() : openCancel())}
      size="sm"
      variant="ghost-hover"
    >
      {m.billing_invoice_cancel()}
    </Button>
  );
}
