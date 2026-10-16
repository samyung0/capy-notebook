import type { BillingInfo } from '@/api/types';

/** $1 buys 1,000 credits (human/observability-metering.md). */
export const CREDITS_PER_DOLLAR = 1000;

export function creditsForCents(cents: number): number {
  return (cents / 100) * CREDITS_PER_DOLLAR;
}

/**
 * The Usage tab's credit numbers, in micros. The monthly allowance spends
 * first, then purchased credits; `purchasedPool` is what purchased credits
 * this month started from (the balance now plus what this month took from it).
 */
export interface CreditView {
  /** Allowance left plus purchased balance minus reservations; negative = owed. */
  available: number;
  /** Bar length: the allowance plus the purchased pool. */
  barTotal: number;
  carried: number;
  limit: number;
  /** This month's allowance spend, credits carried from last month included. */
  monthlyUsed: number;
  owed: number;
  purchasedPool: number;
  purchasedUsed: number;
}

export function creditView(
  billing: BillingInfo,
  spentThisMonthMicros: number
): CreditView {
  const limit = billing.creditsLimitMicros;
  const used = billing.creditsUsedMicros;
  const carried = billing.creditsCarriedMicros;
  const purchased = billing.creditsPurchasedMicros;
  const available =
    Math.max(limit - used, 0) + purchased - billing.creditsReservedMicros;
  // The ledger holds this month's spend; whatever the allowance did not cover
  // came out of purchased credits.
  const purchasedUsed = Math.max(0, spentThisMonthMicros - (used - carried));
  const purchasedPool = Math.max(0, purchased + purchasedUsed);
  return {
    available,
    barTotal: limit + purchasedPool,
    carried,
    limit,
    monthlyUsed: used,
    owed: Math.max(0, -purchased),
    purchasedPool,
    purchasedUsed: Math.min(purchasedUsed, purchasedPool),
  };
}
