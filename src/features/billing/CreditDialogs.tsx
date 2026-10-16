import { zodResolver } from '@hookform/resolvers/zod';
import type { ReactNode } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import {
  setAutoReloadBodyAmountCentsMax,
  setAutoReloadBodyAmountCentsMin,
  setAutoReloadBodyThresholdCreditsMax,
  setSpendingLimitBodyLimitCentsMax,
} from '@/api/gen/validators';
import {
  usePaymentMethodCheckout,
  useSetAutoReload,
  useSetSpendingLimit,
} from '@/api/hooks';
import type { CreditSettings } from '@/api/types';
import { Button } from '@/components/ui/Button';
import { SimpleDialog } from '@/components/ui/Dialog';
import { Icon } from '@/components/ui/Icon';
import { Input, InputError } from '@/components/ui/Input';
import { m } from '@/i18n';
import { paymentMethodLabel, shortDate } from './creditLabels';
import { creditsForCents } from './credits';
import { formatDollars, formatMoney } from './format';

const DOLLARS = /^\d+(\.\d{1,2})?$/;
const WHOLE = /^\d+$/;

/** A typed dollar amount ("10", "12.5") in cents, or NaN. */
export function dollarsToCents(value: string): number {
  if (!DOLLARS.test(value.trim())) return Number.NaN;
  return Math.round(Number(value) * 100);
}

/** Dollar field schema bounded by the API's cent limits. */
export function dollarField(
  minCents: number,
  maxCents: number,
  message: string
) {
  return z.string().refine((v) => {
    const cents = dollarsToCents(v);
    return cents >= minCents && cents <= maxCents;
  }, message);
}

/** "10,000 credits" for a typed dollar amount, empty while it is not one. */
export function creditsLabel(value: string): string {
  const cents = dollarsToCents(value);
  if (!Number.isFinite(cents)) return '';
  return m.billing_credits_amount({
    amount: creditsForCents(cents).toLocaleString(),
  });
}

/** Cancel on the left, its text lined up with the content edge, and the
 * accented primary on the right. */
function DialogActions({
  onCancel,
  primary,
}: {
  onCancel: () => void;
  primary: ReactNode;
}) {
  return (
    <>
      <Button
        className="mr-auto -ml-6.5"
        onClick={onCancel}
        size="lg"
        type="button"
        variant="ghost-hover"
      >
        {m.action_cancel()}
      </Button>
      {primary}
    </>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the Input inside is the control
    <label className="flex flex-col gap-1.5">
      <span className="text-fg-secondary text-sm">{label}</span>
      {children}
    </label>
  );
}

const autoReloadSchema = () =>
  z.object({
    amount: dollarField(
      setAutoReloadBodyAmountCentsMin,
      setAutoReloadBodyAmountCentsMax,
      m.billing_topup_range()
    ),
    threshold: z
      .string()
      .refine(
        (v) =>
          WHOLE.test(v.trim()) &&
          Number(v) <= setAutoReloadBodyThresholdCreditsMax,
        m.billing_threshold_invalid()
      ),
  });
type AutoReloadForm = z.infer<ReturnType<typeof autoReloadSchema>>;

/** Edit opens it, and so does turning the switch on; Save turns auto-reload on. */
export function AutoReloadDialog({
  open,
  onClose,
  settings,
}: {
  open: boolean;
  onClose: () => void;
  settings: CreditSettings;
}) {
  const { mutateAsync: save } = useSetAutoReload();
  const { isPending: changing, mutate: changeMethod } =
    usePaymentMethodCheckout();
  const {
    formState: { errors, isSubmitting },
    handleSubmit,
    register,
    watch,
  } = useForm<AutoReloadForm>({
    mode: 'onChange',
    resolver: zodResolver(autoReloadSchema()),
    values: {
      amount: String(settings.reloadAmountCents / 100),
      threshold: String(settings.reloadThresholdMicros / 1_000_000),
    },
  });
  const pm = settings.paymentMethod;
  const submit = handleSubmit(async (v) => {
    await save({
      amountCents: dollarsToCents(v.amount),
      enabled: true,
      thresholdCredits: Number(v.threshold),
    });
    onClose();
  });

  return (
    <SimpleDialog
      footer={
        <DialogActions
          onCancel={onClose}
          primary={
            <Button
              disabled={!settings.paymentMethodInstant || isSubmitting}
              size="lg"
              type="submit"
              variant="accent"
            >
              {m.action_save()}
            </Button>
          }
        />
      }
      onClose={onClose}
      onSubmit={submit}
      open={open}
      title={m.billing_auto_reload()}
      width={448}
    >
      <Field label={m.billing_reload_amount()}>
        <Input
          aria-invalid={!!errors.amount}
          endText={creditsLabel(watch('amount'))}
          inputMode="decimal"
          startText="$"
          {...register('amount')}
        />
        {errors.amount && <InputError errors={[errors.amount]} />}
      </Field>
      <Field label={m.billing_reload_threshold()}>
        <Input
          aria-invalid={!!errors.threshold}
          endText={m.billing_credits_unit()}
          inputMode="numeric"
          {...register('threshold')}
        />
        {errors.threshold && <InputError errors={[errors.threshold]} />}
      </Field>
      <div className="flex flex-col gap-1.5">
        <span className="text-fg-secondary text-sm">
          {m.billing_payment_method()}
        </span>
        <div className="flex items-center gap-3 rounded-input border border-line p-3.5">
          <Icon className="size-4.5 shrink-0 text-fg-muted" name="creditCard" />
          <div className="min-w-0 flex-1">
            <p className="font-medium">
              {pm ? paymentMethodLabel(pm) : m.billing_payment_none()}
            </p>
            {pm?.expMonth && pm.expYear ? (
              <p className="t-meta text-fg-muted">
                {m.billing_payment_expires({
                  date: `${String(pm.expMonth).padStart(2, '0')}/${pm.expYear}`,
                })}
              </p>
            ) : null}
          </div>
          <button
            className="font-semibold text-fg underline underline-offset-4 disabled:opacity-50"
            disabled={changing}
            onClick={() => changeMethod()}
            type="button"
          >
            {pm ? m.billing_payment_change() : m.billing_payment_add()}
          </button>
        </div>
        {pm && !settings.paymentMethodInstant && (
          <p className="t-meta text-tint-error-fg">
            {m.billing_payment_not_instant()}
          </p>
        )}
      </div>
    </SimpleDialog>
  );
}

const limitSchema = () =>
  z.object({
    limit: dollarField(
      0,
      setSpendingLimitBodyLimitCentsMax,
      m.billing_limit_invalid()
    ),
  });
type LimitForm = z.infer<ReturnType<typeof limitSchema>>;

/** Setting the limit to $0 removes it. */
export function MonthlyLimitDialog({
  open,
  onClose,
  settings,
  resetsAt,
}: {
  open: boolean;
  onClose: () => void;
  settings: CreditSettings;
  resetsAt: Date;
}) {
  const { mutateAsync: save } = useSetSpendingLimit();
  const {
    formState: { errors, isSubmitting },
    handleSubmit,
    register,
  } = useForm<LimitForm>({
    mode: 'onChange',
    resolver: zodResolver(limitSchema()),
    values: {
      limit: settings.spendingLimitCents
        ? String(settings.spendingLimitCents / 100)
        : '',
    },
  });
  const submit = handleSubmit(async (v) => {
    await save(dollarsToCents(v.limit));
    onClose();
  });

  return (
    <SimpleDialog
      footer={
        <DialogActions
          onCancel={onClose}
          primary={
            <Button
              disabled={isSubmitting}
              size="lg"
              type="submit"
              variant="accent"
            >
              {m.action_save()}
            </Button>
          }
        />
      }
      onClose={onClose}
      onSubmit={submit}
      open={open}
      title={m.billing_monthly_limit()}
      width={448}
    >
      <Field label={m.billing_limit_dialog_label()}>
        <Input
          aria-invalid={!!errors.limit}
          endText="USD"
          inputMode="decimal"
          startText="$"
          {...register('limit')}
        />
        {errors.limit && <InputError errors={[errors.limit]} />}
      </Field>
      <div className="flex flex-col gap-2 border-divider border-t pt-4 text-sm">
        <div className="flex justify-between gap-4">
          <span className="text-fg-secondary">
            {m.billing_limit_spent_label()}
          </span>
          <span className="font-semibold">
            {formatMoney(settings.spentThisMonthCents, 'usd')}
          </span>
        </div>
        <div className="flex justify-between gap-4">
          <span className="text-fg-secondary">
            {m.billing_limit_resets_label()}
          </span>
          <span className="font-semibold">{shortDate(resetsAt)}</span>
        </div>
      </div>
      <p className="text-fg-secondary text-sm">
        {m.billing_limit_remove_hint()}
      </p>
    </SimpleDialog>
  );
}

/** A manual top-up while Stripe is charging an auto-reload pays for both. */
export function ReloadPendingDialog({
  open,
  onClose,
  onConfirm,
  amountCents,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  amountCents: number;
}) {
  return (
    <SimpleDialog
      footer={
        <DialogActions
          onCancel={onClose}
          primary={
            <Button
              onClick={() => {
                onClose();
                onConfirm();
              }}
              size="lg"
              type="button"
              variant="accent"
            >
              {m.billing_top_up_anyway()}
            </Button>
          }
        />
      }
      onClose={onClose}
      open={open}
      title={m.billing_reload_pending_title()}
      width={448}
    >
      <p className="text-fg-secondary">
        {m.billing_reload_pending_body({ amount: formatDollars(amountCents) })}
      </p>
    </SimpleDialog>
  );
}
