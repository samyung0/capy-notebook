import { zodResolver } from '@hookform/resolvers/zod';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { isApiError } from '@/api/client';
import {
  billingTopUpBodyAmountCentsMax,
  billingTopUpBodyAmountCentsMin,
} from '@/api/gen/validators';
import {
  usePaymentMethodCheckout,
  useSetAutoReload,
  useTopUp,
} from '@/api/hooks';
import type { BillingInfo } from '@/api/types';
import { UsageBar } from '@/components/app/UsageMeter';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { Input, InputError } from '@/components/ui/Input';
import { Switch } from '@/components/ui/Switch';
import { userToast } from '@/components/ui/userToast';
import { m } from '@/i18n';
import { describeError } from '@/lib/errors';
import { userColorPair } from '@/lib/userColor';
import {
  AutoReloadDialog,
  creditsLabel,
  dollarField,
  dollarsToCents,
  MonthlyLimitDialog,
  ReloadPendingDialog,
} from './CreditDialogs';
import { CreditNotices } from './CreditNotices';
import { periodMonth, shortDate } from './creditLabels';
import { type CreditView, creditView } from './credits';
import { formatCredits, formatDollars, formatMoney } from './format';

const topUpSchema = () =>
  z.object({
    amount: dollarField(
      billingTopUpBodyAmountCentsMin,
      billingTopUpBodyAmountCentsMax,
      m.billing_topup_range()
    ),
  });
type TopUpForm = z.infer<ReturnType<typeof topUpSchema>>;

/**
 * The Subscription tab's Credits: Buy credits (top-up field, auto-reload) and
 * Monthly limit side by side, with the reload notices above them.
 */
export function CreditsSection({
  billing,
  spentThisMonthMicros,
}: {
  billing: BillingInfo;
  spentThisMonthMicros: number;
}) {
  const navigate = useNavigate();
  const { reload: reloadReturn } = useSearch({
    from: '/auth-shell/billing',
  });
  const [autoReloadOpen, setAutoReloadOpen] = useState(false);
  const [limitOpen, setLimitOpen] = useState(false);
  const topUpField = useRef<HTMLInputElement | null>(null);
  const view = creditView(billing, spentThisMonthMicros);
  const resetsAt = periodMonth(billing.creditsPeriodStart, 1);

  // Back from saving the auto-reload card: finish setting it up.
  useEffect(() => {
    if (reloadReturn !== 'method') return;
    setAutoReloadOpen(true);
    void navigate({
      replace: true,
      search: { tab: 'subscription' },
      to: '/billing',
    });
  }, [reloadReturn, navigate]);

  return (
    <div className="mt-12 flex flex-col gap-5">
      <p className="t-card-title">{m.billing_credits()}</p>
      <CreditNotices
        billing={billing}
        onChangeLimit={() => setLimitOpen(true)}
        onTopUp={() => topUpField.current?.focus()}
        view={view}
      />
      <div className="grid grid-cols-1 gap-8 md:grid-cols-2 md:gap-6">
        <BuyCredits
          billing={billing}
          fieldRef={topUpField}
          onEditAutoReload={() => setAutoReloadOpen(true)}
          view={view}
        />
        <div className="min-w-0 border-divider border-t pt-8 md:border-t-0 md:border-l md:pt-0 md:pl-6">
          <MonthlyLimit
            billing={billing}
            onChange={() => setLimitOpen(true)}
            resetsAt={resetsAt}
          />
        </div>
      </div>
      <AutoReloadDialog
        onClose={() => setAutoReloadOpen(false)}
        open={autoReloadOpen}
        settings={billing.creditSettings}
      />
      <MonthlyLimitDialog
        onClose={() => setLimitOpen(false)}
        open={limitOpen}
        resetsAt={resetsAt}
        settings={billing.creditSettings}
      />
    </div>
  );
}

function BuyCredits({
  billing,
  view,
  fieldRef,
  onEditAutoReload,
}: {
  billing: BillingInfo;
  view: CreditView;
  fieldRef: React.RefObject<HTMLInputElement | null>;
  onEditAutoReload: () => void;
}) {
  const settings = billing.creditSettings;
  const { mutateAsync: topUp } = useTopUp();
  const { isPending: savingReload, mutate: saveReload } = useSetAutoReload();
  const [pendingCents, setPendingCents] = useState<number | null>(null);
  const {
    formState: { errors, isSubmitting },
    handleSubmit,
    register,
    watch,
  } = useForm<TopUpForm>({
    defaultValues: { amount: '10' },
    mode: 'onChange',
    resolver: zodResolver(topUpSchema()),
  });
  const { ref: registerRef, ...amountField } = register('amount');

  async function startTopUp(amountCents: number) {
    try {
      await topUp(amountCents);
    } catch (err) {
      if (isApiError(err) && err.code === 'spending_limit') {
        const limitCents = Number(err.body?.limitCents ?? 0);
        const charging = Number(err.body?.chargingCents ?? 0);
        const spent = Number(err.body?.spentCents ?? 0);
        const limit = formatDollars(limitCents);
        // "Wait" only when the reload being charged is what tips it over.
        userToast(
          charging > 0 && spent - charging + amountCents <= limitCents
            ? {
                description: m.billing_limit_toast_wait_body({
                  amount: formatDollars(charging),
                  limit,
                }),
                title: m.billing_limit_toast_wait_title(),
                variant: 'warning',
              }
            : {
                description: m.billing_limit_toast_over_body({ limit }),
                title: m.billing_limit_toast_over_title(),
                variant: 'warning',
              }
        );
        return;
      }
      const { description, title } = describeError(err);
      userToast({ description, title, variant: 'error' });
    }
  }

  const submit = handleSubmit(async (v) => {
    const cents = dollarsToCents(v.amount);
    if (settings.reload.status === 'charging') {
      setPendingCents(cents);
      return;
    }
    await startTopUp(cents);
  });

  return (
    <div className="min-w-0">
      <p className="t-subtitle font-bold">{m.billing_buy_credits()}</p>
      {view.owed > 0 && (
        <p className="t-meta mt-1 text-fg-muted">
          {m.billing_purchased_owed({ amount: formatCredits(view.owed) })}
        </p>
      )}
      {settings.starterAvailable && <StarterOffer />}
      <form noValidate onSubmit={submit}>
        <label
          className="mt-5 mb-1.5 block text-fg-secondary text-sm"
          htmlFor="billing-top-up"
        >
          {m.billing_top_up()}
        </label>
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <Input
              aria-invalid={!!errors.amount}
              endText={creditsLabel(watch('amount'))}
              id="billing-top-up"
              inputMode="decimal"
              startText="$"
              wrapperClassName="rounded-md"
              {...amountField}
              ref={(el) => {
                registerRef(el);
                fieldRef.current = el;
              }}
            />
            {errors.amount && <InputError errors={[errors.amount]} />}
          </div>
          <Button
            className="rounded-md"
            disabled={isSubmitting}
            type="submit"
            variant="dark"
          >
            {m.billing_top_up()}
          </Button>
        </div>
      </form>
      <div className="mt-6">
        <label className="flex items-center gap-3">
          <Switch
            checked={settings.autoReload}
            disabled={savingReload}
            onCheckedChange={(on) => {
              if (on) {
                onEditAutoReload();
                return;
              }
              saveReload({
                amountCents: settings.reloadAmountCents,
                enabled: false,
                thresholdCredits: settings.reloadThresholdMicros / 1_000_000,
              });
            }}
          />
          <span className="font-medium">{m.billing_auto_reload()}</span>
        </label>
        {settings.autoReload && (
          <div className="mt-3 flex items-center gap-3 text-fg-secondary text-sm">
            <span className="flex min-w-0 flex-1 items-start gap-2">
              <Icon className="size-4.5 shrink-0 text-fg-muted" name="info" />
              <span>
                {m.billing_auto_reload_line({
                  amount: formatDollars(settings.reloadAmountCents),
                  threshold: formatCredits(settings.reloadThresholdMicros),
                })}
              </span>
            </span>
            {/* The ghost padding would inset the label from the column edge. */}
            <Button
              className="-mr-4"
              onClick={onEditAutoReload}
              size="sm"
              variant="ghost-hover"
            >
              {m.action_edit()}
            </Button>
          </div>
        )}
      </div>
      <ReloadPendingDialog
        amountCents={settings.reload.amountCents}
        onClose={() => setPendingCents(null)}
        onConfirm={() => {
          if (pendingCents !== null) void startTopUp(pendingCents);
        }}
        open={pendingCents !== null}
      />
    </div>
  );
}

/** The account's first saved card adds the starter credits (once). */
function StarterOffer() {
  const { isPending, mutate: addCard } = usePaymentMethodCheckout();
  return (
    <div className="mt-3 flex items-start gap-2 text-fg-secondary text-sm">
      <Icon className="size-4.5 shrink-0 text-fg-muted" name="info" />
      <span>
        {m.billing_starter_offer()}{' '}
        <button
          className="font-semibold text-fg underline underline-offset-4 disabled:opacity-50"
          disabled={isPending}
          onClick={() => addCard()}
          type="button"
        >
          {m.billing_payment_add()}
        </button>
      </span>
    </div>
  );
}

function MonthlyLimit({
  billing,
  resetsAt,
  onChange,
}: {
  billing: BillingInfo;
  resetsAt: Date;
  onChange: () => void;
}) {
  const settings = billing.creditSettings;
  const limit = settings.spendingLimitCents;
  const spent = settings.spentThisMonthCents;
  return (
    <div className="min-w-0">
      <p className="t-subtitle font-bold">{m.billing_monthly_limit()}</p>
      {limit ? (
        <>
          <UsageBar
            limit={limit}
            segments={[
              {
                amount: spent,
                color: userColorPair('purple').bg,
                key: 'spent',
                label: '',
              },
            ]}
          />
          <p className="mt-4">
            <span className="t-card-title">{formatMoney(spent, 'usd')}</span>
            <span className="ml-2 text-fg-muted">
              {m.billing_limit_of({ limit: formatMoney(limit, 'usd') })}
            </span>
          </p>
          <p className="t-meta mt-1 text-fg-muted">
            {m.billing_credits_resets({ date: shortDate(resetsAt) })}
          </p>
        </>
      ) : (
        <>
          <p className="mt-5">
            <span className="t-card-title">{formatMoney(spent, 'usd')}</span>
            <span className="ml-2 text-fg-muted">
              {m.billing_limit_spent()}
            </span>
          </p>
          <p className="t-meta mt-1 text-fg-muted">{m.billing_limit_none()}</p>
        </>
      )}
      <div className="mt-5">
        <Button
          className="-ml-4"
          onClick={onChange}
          size="sm"
          variant="ghost-hover"
        >
          {limit ? m.billing_change_limit() : m.billing_set_limit()}
        </Button>
      </div>
    </div>
  );
}
