import { describe, expect, it } from 'vitest';
import type { BillingInfo } from '@/api/types';
import { creditView } from './credits';

const C = 1_000_000;

function billing(over: Partial<BillingInfo>): BillingInfo {
  return {
    creditsCarriedMicros: 0,
    creditsLimitMicros: 10_000 * C,
    creditsPurchasedMicros: 0,
    creditsReservedMicros: 0,
    creditsUsedMicros: 0,
    ...over,
  } as BillingInfo;
}

describe('creditView', () => {
  it('puts purchased credits after the monthly allowance on one bar', () => {
    const view = creditView(
      billing({
        creditsPurchasedMicros: 4070 * C,
        creditsUsedMicros: 6420 * C,
      }),
      6420 * C
    );
    expect(view.available).toBe(7650 * C);
    expect(view.barTotal).toBe(14_070 * C);
    expect(view.purchasedUsed).toBe(0);
  });

  it('counts what this month took from purchased credits', () => {
    const view = creditView(
      billing({
        creditsPurchasedMicros: 2770 * C,
        creditsUsedMicros: 10_000 * C,
      }),
      11_300 * C
    );
    expect(view.purchasedPool).toBe(4070 * C);
    expect(view.purchasedUsed).toBe(1300 * C);
  });

  it('reports overrun past purchased credits as owed', () => {
    const view = creditView(
      billing({
        creditsPurchasedMicros: -1240 * C,
        creditsUsedMicros: 10_000 * C,
      }),
      15_310 * C
    );
    expect(view.owed).toBe(1240 * C);
    expect(view.purchasedPool).toBe(4070 * C);
  });

  it('keeps credits carried from last month inside the allowance', () => {
    const view = creditView(
      billing({ creditsCarriedMicros: 1240 * C, creditsUsedMicros: 3340 * C }),
      2100 * C
    );
    expect(view.purchasedUsed).toBe(0);
    expect(view.barTotal).toBe(10_000 * C);
    expect(view.available).toBe(6660 * C);
  });
});
