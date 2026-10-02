import { useState } from 'react';
import {
  useBilling,
  useBillingCheckout,
  useBillingPortal,
  useInvoices,
} from '@/api/hooks';
import type { Invoice } from '@/api/types';
import { ErrorState } from '@/components/app/ErrorState';
import { TabHeader } from '@/components/app/tabPanel';
import { Button, ErrorAction } from '@/components/ui/Button';
import { getLocale, m } from '@/i18n';
import { describeError } from '@/lib/errors';
import { track } from '@/lib/observability';
import {
  type BillingColumn,
  BillingTable,
  BillingTableSkeleton,
} from './BillingTable';
import { formatMoney } from './format';
import { planLabel } from './labels';

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
            className="rounded-input"
            disabled={portalIsPending}
            onClick={() => openPortal()}
            variant="outline"
          >
            {m.subscription_manage()}
          </Button>
        ) : (
          <Button
            className="rounded-input"
            disabled={upgrading || !billing}
            onClick={() => void upgrade()}
          >
            {m.billing_upgrade_pro()}
          </Button>
        )}
      </div>
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
    { id: 'due', label: m.billing_col_due(), muted: true },
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
      rows={data.items.map((invoice) => ({
        cells: {
          date: day(invoice.createdAt),
          due: invoice.dueAt ? day(invoice.dueAt) : '—',
          status: STATUS_LABEL[invoice.status](),
          total: formatMoney(invoice.total, invoice.currency),
          view: invoice.url && (
            <a
              className="font-semibold text-fg underline underline-offset-4"
              href={invoice.url}
              rel="noreferrer"
              target="_blank"
            >
              {m.billing_invoice_view()}
            </a>
          ),
        },
        key: invoice.id,
      }))}
    />
  );
}
