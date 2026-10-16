import type { PaymentMethod } from '@/api/types';
import { getLocale, m } from '@/i18n';

const BRANDS: Record<string, string> = {
  amex: 'American Express',
  diners: 'Diners Club',
  discover: 'Discover',
  jcb: 'JCB',
  mastercard: 'Mastercard',
  unionpay: 'UnionPay',
  visa: 'Visa',
};

/** "Visa ending 7290", "Link", or "Bank debit" for a method that is not instant. */
export function paymentMethodLabel(pm: PaymentMethod): string {
  if (pm.type === 'card') {
    const brand =
      BRANDS[pm.brand ?? ''] ??
      (pm.brand ? pm.brand[0].toUpperCase() + pm.brand.slice(1) : '');
    return m.billing_payment_card({ brand, last4: pm.last4 ?? '' });
  }
  if (pm.type === 'link') return m.billing_payment_link();
  return m.billing_payment_bank();
}

/** Stripe's decline code in the user's words. */
export function declineLabel(code: string): string {
  switch (code) {
    case 'expired_card':
      return m.billing_decline_expired_card();
    case 'insufficient_funds':
      return m.billing_decline_insufficient_funds();
    case 'authentication_required':
      return m.billing_decline_authentication_required();
    default:
      return m.billing_decline_generic();
  }
}

/** Credit periods and Stripe dates are shown in UTC, like the Usage tab. */
export function shortDate(date: Date): string {
  return date.toLocaleDateString(getLocale(), {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
}

export function monthName(date: Date): string {
  return date.toLocaleDateString(getLocale(), {
    month: 'long',
    timeZone: 'UTC',
  });
}

/** The first day of the month `offset` months from the period start. */
export function periodMonth(periodStart: string, offset: number): Date {
  const date = new Date(periodStart);
  date.setUTCMonth(date.getUTCMonth() + offset, 1);
  return date;
}
