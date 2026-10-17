/* biome-ignore-all lint/suspicious/noMisplacedAssertion: The helpers execute only inside the journey. */
// Credit top-ups through Stripe's hosted payment Checkout, run by hand. Headless,
// payment Checkout stops on Stripe's hCaptcha challenge, so this journey is in
// no CI lane (project `manual`): run it headed before launch, as the journeys
// README says, and answer the challenge if Stripe shows one; each top-up
// waits up to ten minutes for the return. Everything a top-up proves that CI
// cannot: Stripe took the top-up parameters, a paid top-up is credited once and
// saves its card for auto-reload, a refund takes half back, and a top-up voids
// a reload Stripe is retrying and re-arms auto-reload.
import type { Page } from '@playwright/test';
import { m } from '../../i18n';
import {
  billing,
  completeCheckout,
  creditsRow,
  DECLINES,
  declinedReload,
  expectInvoice,
  expectPurchasedOnUsage,
  expectVoided,
  MICROS,
  nested,
  openSubscription,
  processedEvent,
  purchaseWhere,
  reloadCount,
  saveAutoReload,
  setAutoReload,
  sleep,
  startCheckout,
  switchAutoReloadOff,
  TOP_UP_CENTS,
  thresholdNow,
  VISA,
  visa,
} from './credits';
import {
  object,
  stringField,
  stripeRequest,
  verifyStripeSandbox,
} from './providers';
import { type Actor, expect, test, type UatRun } from './runtime';

/** Time for a person to answer Stripe's challenge. */
const BY_HAND = 10 * 60_000;

/** A top-up through hosted Checkout with 4242, credited once: back on the
 * plain Subscription tab, the ledger row, the balance on Usage without a page
 * reload and the processed `checkout.session.completed`. */
async function topUp(run: UatRun, owner: Actor, since: number) {
  const { page } = owner;
  await openSubscription(run, page);
  const field = page.getByLabel(m.billing_top_up(), { exact: true });
  await field.fill(String(TOP_UP_CENTS / 100));
  const before = Number((await billing(owner)).creditsPurchasedMicros);
  const { customerId, session } = await startCheckout(
    run,
    owner,
    '/api/billing/top-up',
    () =>
      page
        .locator('form')
        .filter({ has: field })
        .getByRole('button', { exact: true, name: m.billing_top_up() })
        .click()
  );
  await completeCheckout(run, page, VISA, BY_HAND);
  expect([...new URL(page.url()).searchParams.keys()]).toEqual(['tab']);
  const sessionId = stringField(session, 'id');
  const purchase = await purchaseWhere(
    run,
    owner,
    'top-up credited',
    (p) => p.stripe_checkout_session_id === sessionId
  );
  expect(purchase).toMatchObject({
    amount_cents: TOP_UP_CENTS,
    kind: 'topup',
    status: 'paid',
  });
  // The credits Checkout promised are the credits the ledger granted.
  expect(purchase.credits_micros).toBe(
    Number(object(session.metadata).credits) * MICROS
  );
  const after = await creditsRow(run, owner);
  expect(after.purchased_micros - before).toBe(purchase.credits_micros);
  await expectPurchasedOnUsage(page, after.purchased_micros);
  await processedEvent(
    run,
    'checkout.session.completed',
    since,
    (value) => value.id === sessionId
  );
  return { after, customerId, purchase, session };
}

async function cancelDialog(page: Page) {
  const dialog = page.getByRole('dialog', { name: m.billing_auto_reload() });
  await dialog
    .getByRole('button', { exact: true, name: m.action_cancel() })
    .click();
  await expect(dialog).toBeHidden();
}

test('hosted top-ups: credited once with the card saved, half refunded, voiding a retrying reload and re-arming auto-reload', async ({
  run,
}) => {
  test.setTimeout(3_600_000);
  await verifyStripeSandbox(run.env);
  const since = Math.floor(Date.now() / 1000) - 300;
  const owner = run.owner;
  const { page } = owner;
  const toggle = page.getByRole('switch', { name: m.billing_auto_reload() });
  const dialog = page.getByRole('dialog', { name: m.billing_auto_reload() });

  // 1. The first top-up: Stripe took its parameters (handoff question 1), it
  // is credited once, its card becomes the auto-reload card, and its invoice
  // is a Top-up, Paid row.
  const first = await topUp(run, owner, since);
  const { session } = first;
  await run.attach('q1-topup-checkout-params', {
    adaptivePricing: nested(session.adaptive_pricing, 'enabled'),
    amountSubtotal: session.amount_subtotal,
    automaticTax: nested(session.automatic_tax, 'enabled'),
    currency: session.currency,
    expiresInSeconds: Number(session.expires_at) - Number(session.created),
    invoiceCreation: nested(session.invoice_creation, 'enabled'),
    mode: session.mode,
    paymentMethodTypes: session.payment_method_types,
    sessionId: session.id,
  });
  expect(session).toMatchObject({
    amount_subtotal: TOP_UP_CENTS,
    currency: 'usd',
    mode: 'payment',
    payment_method_types: ['card', 'link'],
  });
  expect(nested(session.automatic_tax, 'enabled')).toBe(true);
  expect(nested(session.invoice_creation, 'enabled')).toBe(true);
  expect(nested(session.adaptive_pricing, 'enabled')).toBe(false);
  expect(first.after.reload_pm_last4).toBe('4242');
  const paidSession = await run.poll(
    'top-up invoice created',
    () => stripeRequest(run.env, `/v1/checkout/sessions/${session.id}`),
    (value) => typeof value.invoice === 'string'
  );
  const invoice = await run.poll(
    'top-up invoice paid',
    () =>
      stripeRequest(
        run.env,
        `/v1/invoices/${stringField(paidSession, 'invoice')}`
      ),
    (value) => value.status === 'paid'
  );
  expect(object(invoice.metadata).kind).toBe('topup');
  await run.record('stripe-invoice', stringField(invoice, 'id'), {
    customerId: first.customerId,
    retained: 'sandbox billing history',
    userId: owner.id,
  });
  await openSubscription(run, page);
  await expectInvoice(
    owner,
    invoice,
    m.billing_invoice_kind_topup(),
    m.billing_invoice_status_paid(),
    m.billing_invoice_view()
  );
  await toggle.click();
  await expect(dialog.getByText(visa('4242'))).toBeVisible();
  await cancelDialog(page);

  // 2. Refunding half the top-up takes half its credits back.
  const paymentIntent = first.purchase.stripe_payment_intent_id;
  if (!paymentIntent) throw new Error('The top-up has no payment intent');
  const charged = Number(
    (await stripeRequest(run.env, `/v1/payment_intents/${paymentIntent}`))
      .amount
  );
  const refund = Math.floor(charged / 2);
  const beforeRefund = (await creditsRow(run, owner)).purchased_micros;
  await stripeRequest(
    run.env,
    '/v1/refunds',
    'POST',
    { amount: String(refund), payment_intent: paymentIntent },
    `${run.id}-${first.purchase.id}-refund`
  );
  const refunded = await purchaseWhere(
    run,
    owner,
    'refund taken back',
    (p) => p.id === first.purchase.id && p.refunded_micros > 0
  );
  expect(refunded.refunded_micros).toBe(
    Math.floor((first.purchase.credits_micros * refund) / charged)
  );
  expect(beforeRefund - (await creditsRow(run, owner)).purchased_micros).toBe(
    refunded.refunded_micros
  );
  await processedEvent(
    run,
    'charge.refunded',
    since,
    (value) => value.payment_intent === paymentIntent
  );

  // 3. With the declining card (Change, hosted setup Checkout) auto-reload
  // on at the balance declines; a top-up voids that reload, re-arms
  // auto-reload and keeps the saved card.
  await openSubscription(run, page);
  await toggle.click();
  await startCheckout(run, owner, '/api/billing/payment-method', () =>
    dialog
      .getByRole('button', { exact: true, name: m.billing_payment_change() })
      .click()
  );
  await completeCheckout(run, page, DECLINES);
  await expect(dialog.getByText(visa('0341'))).toBeVisible({ timeout: 60_000 });
  const declining = await creditsRow(run, owner);
  expect(await saveAutoReload(page, await thresholdNow(owner))).toBe(true);
  const { reload: declined } = await declinedReload(run, owner, 0, since);
  expect(declined).toMatchObject({
    reload_pm_id: declining.reload_pm_id,
    status: 'retrying',
  });
  const second = await topUp(run, owner, since);
  await expectVoided(run, owner, declined);
  expect(second.after).toMatchObject({
    reload_armed: true,
    reload_pm_last4: '0341',
  });

  // 4. The re-armed reload declines too. Switching auto-reload off voids it;
  // switching it on arms nothing (the top-up toast, no reload). A top-up
  // re-arms it, and a reload starts at the threshold.
  expect(await setAutoReload(page, await thresholdNow(owner))).toBe(true);
  const { reload: again } = await declinedReload(run, owner, 1, since);
  expect(again.status).toBe('retrying');
  await switchAutoReloadOff(page);
  await expectVoided(run, owner, again);
  expect(await setAutoReload(page, await thresholdNow(owner))).toBe(false);
  await expect(page.getByText(m.billing_reload_disarmed_title())).toBeVisible();
  await sleep(15_000);
  expect(await reloadCount(run, owner)).toBe(2);
  const third = await topUp(run, owner, since);
  expect(third.after.reload_armed).toBe(true);
  expect(await setAutoReload(page, await thresholdNow(owner))).toBe(true);
  const { reload: atThreshold } = await declinedReload(run, owner, 2, since);
  expect(atThreshold).toMatchObject({
    reload_pm_id: declining.reload_pm_id,
    status: 'retrying',
  });
});
