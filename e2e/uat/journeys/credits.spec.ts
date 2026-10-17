/* biome-ignore-all lint/suspicious/noMisplacedAssertion: The helpers execute only inside the journey. */
// Purchased credits, auto-reload and the monthly spending limit
// (openwiki/observability-metering.md, "Purchased credits, top-ups and
// auto-reload"), in the billing lane. Each journey has its own owner, whose
// Stripe customer the app creates on the first credit Checkout. The auto-reload
// card only comes in through hosted Checkout in setup mode, so that step fills
// Stripe's page with published test cards (`completeCheckout`). A paid top-up
// needs payment Checkout, which stops on Stripe's hCaptcha challenge headless:
// those steps are in creditsManual.spec.ts, run by hand. Everything else uses
// the app's own UI and API, or the Stripe API where it stands in for the
// dashboard (refunds, an invoice Stripe gave up on, paying it). Reloads start
// at once by setting the threshold to the balance the app reports. Stripe and
// the reload worker reach the open tab through the event stream's `billing`
// event, so what they change is asserted on the tab without reloading it.
import { setAutoReloadBodyThresholdCreditsMax } from '../../../src/api/gen/validators';
import { m } from '../../i18n';
import {
  aiCommand,
  availableOf,
  bigContext,
  billing,
  completeCheckout,
  costliestEditorModel,
  credits,
  creditsRow,
  DECLINES,
  declinedReload,
  dollars,
  expectAnswered,
  expectInvoice,
  expectPurchasedOnUsage,
  expectRefusedAtZero,
  expectVoided,
  invoiceId,
  MAX_SPEND_CALLS,
  MICROS,
  money,
  nested,
  notice,
  openSubscription,
  processedEvent,
  purchases,
  purchaseWhere,
  RELOAD_CENTS,
  reloadCount,
  saveAutoReload,
  setAutoReload,
  setLimit,
  settledReload,
  shortDate,
  skippedSubject,
  sleep,
  startCheckout,
  switchAutoReloadOff,
  TOP_UP_CENTS,
  thresholdNow,
  VISA,
  visa,
  zh,
} from './credits';
import { workspace } from './files';
import {
  advanceStripeClock,
  arrayField,
  cleanupStripeTestClock,
  object,
  stringField,
  stripePeriodEnd,
  stripeRequest,
  verifyOutboxDelivery,
  verifyStripeSandbox,
} from './providers';
import { expect, test } from './runtime';

test('starter credits, the monthly limit, a card saved through setup Checkout, auto-reload, a skipped reload mailed in en and zh, and a half refund', async ({
  run,
}) => {
  test.setTimeout(1_200_000);
  await verifyStripeSandbox(run.env);
  const since = Math.floor(Date.now() / 1000) - 300;
  const owner = run.owner;
  const { page } = owner;

  // Usage: this month's allowance, then the starter grant as purchased credits.
  await page.goto(new URL('/billing', run.env.appUrl).toString());
  const start = await billing(owner);
  expect(start.planTier).toBe('free');
  const usage = await owner.request('/api/usage');
  expect(usage.status).toBe(200);
  const spent = arrayField(usage.body, 'bySurface').reduce<number>(
    (sum, bucket) => sum + Number(object(bucket).creditMicros),
    0
  );
  const used = Number(start.creditsUsedMicros);
  const pool =
    Number(start.creditsPurchasedMicros) +
    Math.max(0, spent - (used - Number(start.creditsCarriedMicros)));
  const resets = new Date(stringField(start, 'creditsPeriodStart'));
  resets.setUTCMonth(resets.getUTCMonth() + 1);
  await expect(
    page.getByText(
      `${m.billing_credits_hint_monthly({
        date: shortDate(resets),
        limit: credits(Number(start.creditsLimitMicros)),
        used: credits(used),
      })} ${m.billing_credits_hint_then_starter({ amount: credits(pool) })}`
    )
  ).toBeVisible();
  await expect(page.getByText(m.billing_purchased_marker())).toBeVisible();
  await page.getByRole('link', { name: m.billing_top_up() }).click();
  await expect(
    page.getByRole('tab', { name: m.subscription_title(), selected: true })
  ).toBeVisible();

  // Top-ups take $8 to $100, in the field and in the API.
  const field = page.getByLabel(m.billing_top_up(), { exact: true });
  const form = page.locator('form').filter({ has: field });
  const topUpButton = form.getByRole('button', {
    exact: true,
    name: m.billing_top_up(),
  });
  for (const amount of ['7', '101']) {
    await field.fill(amount);
    await expect(field).toHaveAttribute('aria-invalid', 'true');
    await topUpButton.click();
    await expect(form.getByText(m.billing_topup_range())).toBeVisible();
  }
  for (const amountCents of [700, 10_100])
    expect(
      (await owner.request('/api/billing/top-up', 'POST', { amountCents }))
        .status
    ).toBe(422);

  // A limit below one top-up refuses it on its own, before any Checkout (no
  // Stripe customer is created); $0 removes the limit.
  const limitBelow = TOP_UP_CENTS - 100;
  await setLimit(
    page,
    page.getByRole('button', { exact: true, name: m.billing_set_limit() }),
    String(limitBelow / 100)
  );
  expect((await creditsRow(run, owner)).spending_limit_cents).toBe(limitBelow);
  await expect(
    page.getByText(m.billing_limit_of({ limit: money(limitBelow) }))
  ).toBeVisible();
  await field.fill(String(TOP_UP_CENTS / 100));
  const refused = page.waitForResponse(
    (r) =>
      r.url().endsWith('/api/billing/top-up') && r.request().method() === 'POST'
  );
  await topUpButton.click();
  expect((await refused).status()).toBe(409);
  await expect(
    page.getByText(m.billing_limit_toast_over_title())
  ).toBeVisible();
  await expect(
    page.getByText(
      m.billing_limit_toast_over_body({ limit: dollars(limitBelow) })
    )
  ).toBeVisible();
  expect(
    (
      await run.query<{ stripe_customer_id: string | null }>(
        'SELECT stripe_customer_id FROM users WHERE id=%s',
        [owner.id]
      )
    )[0].stripe_customer_id
  ).toBeNull();
  await setLimit(
    page,
    page.getByRole('button', { exact: true, name: m.billing_change_limit() }),
    '0'
  );
  await expect(page.getByText(m.billing_limit_none())).toBeVisible();
  expect((await creditsRow(run, owner)).spending_limit_cents).toBeNull();

  // The auto-reload card through hosted setup Checkout (4242): the switch
  // with no card opens the dialog, Add a card, and the reopened dialog shows
  // the card by itself.
  const reloadDialog = page.getByRole('dialog', {
    name: m.billing_auto_reload(),
  });
  await page.getByRole('switch', { name: m.billing_auto_reload() }).click();
  await expect(reloadDialog.getByText(m.billing_payment_none())).toBeVisible();
  const { customerId } = await startCheckout(
    run,
    owner,
    '/api/billing/payment-method',
    () =>
      reloadDialog
        .getByRole('button', { exact: true, name: m.billing_payment_add() })
        .click()
  );
  await completeCheckout(run, page, VISA);
  await expect(reloadDialog.getByText(visa('4242'))).toBeVisible({
    timeout: 60_000,
  });
  const saved = await creditsRow(run, owner);
  expect(saved.reload_pm_last4).toBe('4242');

  // Saved from that dialog at the balance as threshold, auto-reload turns on
  // (a new account starts armed) and the worker charges $10 to the card. The
  // paid reload leaves credits above the threshold, which re-arms it; Usage
  // shows the new purchased balance without a page reload.
  const beforeReload = saved.purchased_micros;
  expect(await saveAutoReload(page, await thresholdNow(owner))).toBe(true);
  const { invoice: reloadInvoice, reload } = await settledReload(run, owner, 0);
  expect(reload).toMatchObject({
    amount_cents: RELOAD_CENTS,
    reload_pm_id: saved.reload_pm_id,
    status: 'paid',
  });
  const afterReload = await creditsRow(run, owner);
  expect(afterReload.reload_armed).toBe(true);
  expect(afterReload.purchased_micros - beforeReload).toBe(
    reload.credits_micros
  );
  await expectPurchasedOnUsage(page, afterReload.purchased_micros);
  expect(reloadInvoice.status).toBe('paid');
  await processedEvent(
    run,
    'invoice.paid',
    since,
    (value) => value.id === reload.stripe_invoice_id
  );
  await openSubscription(run, page);
  await expectInvoice(
    owner,
    reloadInvoice,
    m.billing_invoice_kind_reload(),
    m.billing_invoice_status_paid(),
    m.billing_invoice_view()
  );

  // A limit below this month's spend plus the reload skips the next one: with
  // the threshold raised to the balance (an edit, which arms nothing; the paid
  // reload did) there is no charge, the notice shows on the tab by itself and
  // the credit-reload-skipped mail arrives.
  const spentCents = Number(
    object((await billing(owner)).creditSettings).spentThisMonthCents
  );
  expect(spentCents).toBe(reload.amount_cents);
  const limitCents = spentCents + 200;
  await setLimit(
    page,
    page.getByRole('button', { exact: true, name: m.billing_set_limit() }),
    String(limitCents / 100)
  );
  const reloads = await reloadCount(run, owner);
  expect(await setAutoReload(page, await thresholdNow(owner))).toBe(true);
  const firstSkip = await run.poll(
    'reload skipped',
    () => creditsRow(run, owner),
    (row) => row.reload_skipped_at !== null
  );
  await expect(notice(page, m.billing_reload_skipped_title())).toContainText(
    m.billing_reload_skipped_body({
      amount: dollars(reload.amount_cents),
      limit: dollars(limitCents),
    })
  );
  expect(
    await verifyOutboxDelivery(
      run,
      owner.id,
      owner.email,
      'credit-reload-skipped'
    )
  ).toEqual({ locale: 'en', subject: skippedSubject('en') });
  expect(await reloadCount(run, owner)).toBe(reloads);

  // Chinese, chosen in Settings: Usage and Subscription, then the next skip's
  // mail. A changed limit clears the skip, and the reload skips again.
  await page.goto(
    new URL('/settings?tab=customizations', run.env.appUrl).toString()
  );
  await page.getByRole('combobox', { name: m.settings_language() }).click();
  const localeSaved = page.waitForResponse(
    (r) =>
      r.url().endsWith('/api/me/locale') && r.request().method() === 'PATCH'
  );
  await page.getByRole('option', { name: '中文' }).click();
  expect((await localeSaved).status()).toBe(204);
  expect(
    (
      await run.query<{ locale: string }>(
        'SELECT locale FROM users WHERE id=%s',
        [owner.id]
      )
    )[0].locale
  ).toBe('zh');
  await page.goto(new URL('/billing', run.env.appUrl).toString());
  await expect(
    page.getByRole('tab', { name: m.billing_tab_usage({}, zh), selected: true })
  ).toBeVisible();
  await expect(
    page.getByRole('link', { name: m.billing_top_up({}, zh) })
  ).toBeVisible();
  await expect(
    page.getByText(m.billing_purchased_marker({}, zh))
  ).toBeVisible();
  await expect(
    notice(page, m.billing_reload_skipped_title({}, zh))
  ).toBeVisible();
  await openSubscription(run, page, zh);
  await expect(
    page.getByText(m.billing_monthly_limit({}, zh), { exact: true })
  ).toBeVisible();
  await expectInvoice(
    owner,
    reloadInvoice,
    m.billing_invoice_kind_reload({}, zh),
    m.billing_invoice_status_paid({}, zh),
    m.billing_invoice_view({}, zh)
  );
  await setLimit(
    page,
    notice(page, m.billing_reload_skipped_title({}, zh)).getByRole('button', {
      name: m.billing_change_limit({}, zh),
    }),
    String((limitCents + 100) / 100),
    zh
  );
  await run.poll(
    'second skip mail queued',
    () =>
      run.query<{ queued: number }>(
        "SELECT count(*)::int AS queued FROM email_outbox WHERE user_id=%s AND template='credit-reload-skipped'",
        [owner.id]
      ),
    (rows) => rows[0].queued === 2,
    120_000
  );
  expect(
    await verifyOutboxDelivery(
      run,
      owner.id,
      owner.email,
      'credit-reload-skipped'
    )
  ).toEqual({ locale: 'zh', subject: skippedSubject('zh') });

  // Refunding half the reload takes half its credits back.
  const paymentIntent = reload.stripe_payment_intent_id;
  if (!paymentIntent) throw new Error('The reload has no payment intent');
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
    `${run.id}-${reload.id}-refund`
  );
  const refunded = await purchaseWhere(
    run,
    owner,
    'refund taken back',
    (p) => p.id === reload.id && p.refunded_micros > 0
  );
  expect(refunded.refunded_micros).toBe(
    Math.floor((reload.credits_micros * refund) / charged)
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
  // Skipped reloads never charged.
  expect(await reloadCount(run, owner)).toBe(reloads);
  await run.attach('credits-journey', {
    customerId,
    firstSkipAt: firstSkip.reload_skipped_at,
    refundedCents: refund,
    reloadId: reload.id,
  });
});

test('a declined auto-reload retries; a reload Stripe gave up on can still be paid and its dispute takes the credits back; a new card voids the next decline and its reload is paid', async ({
  run,
}) => {
  test.setTimeout(1_200_000);
  await verifyStripeSandbox(run.env);
  const since = Math.floor(Date.now() / 1000) - 300;
  const owner = run.owner;
  const { page } = owner;
  const toggle = page.getByRole('switch', { name: m.billing_auto_reload() });
  const dialog = page.getByRole('dialog', { name: m.billing_auto_reload() });

  // Auto-reload on with no card opens the dialog; Add a card is hosted
  // Checkout in setup mode, here with the card whose charges decline.
  await openSubscription(run, page);
  await toggle.click();
  await expect(dialog.getByText(m.billing_payment_none())).toBeVisible();
  const { customerId, session: setup } = await startCheckout(
    run,
    owner,
    '/api/billing/payment-method',
    () =>
      dialog
        .getByRole('button', { exact: true, name: m.billing_payment_add() })
        .click()
  );
  // Handoff question 1: setup mode with the billing address required.
  await run.attach('q1-setup-checkout-params', {
    billingAddressCollection: setup.billing_address_collection,
    currency: setup.currency,
    mode: setup.mode,
    paymentMethodTypes: setup.payment_method_types,
    sessionId: setup.id,
  });
  expect(setup).toMatchObject({
    billing_address_collection: 'required',
    currency: 'usd',
    mode: 'setup',
    payment_method_types: ['card', 'link'],
  });
  await completeCheckout(run, page, DECLINES);
  // The return reopens the dialog, which shows the new card once the
  // webhook's billing event has refetched billing.
  await expect(dialog.getByText(visa('0341'))).toBeVisible({ timeout: 60_000 });
  const declining = await creditsRow(run, owner);
  expect(declining.reload_pm_last4).toBe('0341');
  await processedEvent(
    run,
    'checkout.session.completed',
    since,
    (value) => value.id === setup.id
  );
  // The billing address went to the customer: reload invoices tax from it.
  expect(
    nested(
      (await stripeRequest(run.env, `/v1/customers/${customerId}`)).address,
      'country'
    )
  ).toBe('US');

  // Saved from that dialog at the balance as threshold, auto-reload turns on
  // (a new account starts armed) and the worker starts a reload, which
  // declines.
  expect(await saveAutoReload(page, await thresholdNow(owner))).toBe(true);
  const {
    invoice: firstInvoice,
    recordedFirst,
    reload: first,
  } = await declinedReload(run, owner, 0, since);
  // Handoff question 2: after our own invoices/pay fails, Stripe still has a
  // next attempt and sends invoice.payment_failed.
  await run.attach('q2-declined-reload', {
    attemptCount: firstInvoice.attempt_count,
    declineReason: first.decline_reason,
    invoiceId: firstInvoice.id,
    invoiceStatus: firstInvoice.status,
    nextAttemptAt: first.next_attempt_at,
    nextPaymentAttempt: firstInvoice.next_payment_attempt,
    purchaseStatus: first.status,
    recordedFirst,
  });
  // Never first recorded failed before Stripe schedules the retry.
  expect(recordedFirst).toBe('retrying');
  expect(first).toMatchObject({
    reload_pm_id: declining.reload_pm_id,
    status: 'retrying',
  });
  expect(firstInvoice.status).toBe('open');
  expect(Date.parse(String(first.next_attempt_at)) / 1000).toBe(
    firstInvoice.next_payment_attempt
  );
  const retryDate = shortDate(
    new Date(Number(firstInvoice.next_payment_attempt) * 1000)
  );
  // The tab, not reloaded since the save, shows the declined reload.
  await expect(notice(page, m.billing_reload_retrying_title())).toContainText(
    m.billing_reload_retrying_body({
      amount: dollars(first.amount_cents),
      date: retryDate,
    })
  );
  // The invoice list is read once per load.
  await openSubscription(run, page);
  await expectInvoice(
    owner,
    firstInvoice,
    m.billing_invoice_kind_reload(),
    m.billing_invoice_status_retrying({ date: retryDate }),
    m.billing_invoice_pay()
  );
  // While Stripe retries no second reload starts: three worker passes.
  await sleep(15_000);
  expect(await reloadCount(run, owner)).toBe(1);
  expect((await creditsRow(run, owner)).reload_armed).toBe(false);

  // Stripe gives up on it (marked uncollectible through the API, as after
  // its last scheduled retry): the row stays Failed with Pay.
  const firstInvoiceId = invoiceId(first);
  await stripeRequest(
    run.env,
    `/v1/invoices/${firstInvoiceId}/mark_uncollectible`,
    'POST',
    {},
    `${run.id}-${firstInvoiceId}-uncollectible`
  );
  const uncollectible = await stripeRequest(
    run.env,
    `/v1/invoices/${firstInvoiceId}`
  );
  expect(uncollectible.status).toBe('uncollectible');
  await openSubscription(run, page);
  await expectInvoice(
    owner,
    uncollectible,
    m.billing_invoice_kind_reload(),
    m.billing_invoice_status_failed(),
    m.billing_invoice_pay()
  );

  // Handoff question 3: the uncollectible invoice can still be paid (here
  // through the API, with a card whose charge is then disputed), and
  // invoice.paid credits it. The answer is attached either way.
  const disputing = await stripeRequest(
    run.env,
    '/v1/payment_methods/pm_card_createDispute/attach',
    'POST',
    { customer: customerId },
    `${run.id}-${customerId}-dispute-card`
  );
  const beforePay = (await creditsRow(run, owner)).purchased_micros;
  const q3 = {
    hostedInvoiceUrl: typeof uncollectible.hosted_invoice_url === 'string',
    invoiceId: firstInvoiceId,
    question: 'Can an uncollectible reload invoice still be paid?',
    statusBefore: uncollectible.status,
  };
  try {
    await stripeRequest(
      run.env,
      `/v1/invoices/${firstInvoiceId}/pay`,
      'POST',
      { off_session: 'true', payment_method: stringField(disputing, 'id') },
      `${run.id}-${firstInvoiceId}-pay`
    );
  } catch (error) {
    await run.attach('q3-uncollectible-reload', {
      ...q3,
      answer: 'refused',
      stripeError: error instanceof Error ? error.message : 'unknown',
    });
    throw new Error(
      'Stripe refused to pay an uncollectible reload invoice: the Pay link on Failed rows would have to go',
      { cause: error }
    );
  }
  const paidFirst = await purchaseWhere(
    run,
    owner,
    'paid uncollectible reload credited',
    (p) => p.id === first.id && p.status === 'paid'
  );
  const invoicePaid = await processedEvent(
    run,
    'invoice.paid',
    since,
    (value) => value.id === firstInvoiceId
  );
  await run.attach('q3-uncollectible-reload', {
    ...q3,
    answer: 'paid',
    creditedMicros: paidFirst.credits_micros,
    invoicePaidEvent: invoicePaid.id,
    purchaseStatus: paidFirst.status,
    statusAfter: (
      await stripeRequest(run.env, `/v1/invoices/${firstInvoiceId}`)
    ).status,
  });
  const disputedIntent = paidFirst.stripe_payment_intent_id;
  if (!disputedIntent)
    throw new Error('The paid reload recorded no payment intent');
  const disputeCreated = await processedEvent(
    run,
    'charge.dispute.created',
    since,
    (value) => value.payment_intent === disputedIntent
  );
  // The dispute's webhook holds the credits when invoice.paid has already
  // recorded the payment intent. Processed first, it finds no purchase and
  // the daily reconciliation holds them a day later, which a journey cannot
  // wait for: that path is recorded and checked to be the race, not failed.
  const [afterDispute] = (await purchases(run, owner)).filter(
    (p) => p.id === first.id
  );
  const [dispute] = arrayField(
    await stripeRequest(
      run.env,
      `/v1/disputes?${new URLSearchParams({ payment_intent: disputedIntent })}`
    ),
    'data'
  ).map(object);
  const heldBy =
    afterDispute.disputed_micros > 0 ? 'webhook' : 'daily reconciliation';
  await run.attach('dispute-hold', {
    disputeProcessedAt: disputeCreated.processedAt,
    disputeStatus: dispute?.status,
    heldBy,
    invoicePaidProcessedAt: invoicePaid.processedAt,
  });
  if (heldBy === 'webhook')
    expect(afterDispute.disputed_micros).toBe(
      afterDispute.credits_micros - afterDispute.refunded_micros
    );
  else {
    expect(
      Date.parse(String(disputeCreated.processedAt)) <=
        Date.parse(String(invoicePaid.processedAt))
    ).toBe(true);
    // An open dispute, which the daily re-read of the last 7 days holds.
    expect(['needs_response', 'under_review', 'lost']).toContain(
      dispute?.status
    );
  }
  expect((await creditsRow(run, owner)).purchased_micros).toBe(
    beforePay + afterDispute.credits_micros - afterDispute.disputed_micros
  );

  // The payment re-armed auto-reload (it left credits above the threshold).
  // With the threshold at the balance again (an edit, which arms nothing) the
  // next reload declines on the saved card. A new card through Change voids
  // it and re-arms auto-reload, and the reload that starts charges the new
  // card.
  await setAutoReload(page, await thresholdNow(owner));
  const { reload: second } = await declinedReload(run, owner, 1, since);
  expect(second.status).toBe('retrying');
  const beforeNewCard = (await creditsRow(run, owner)).purchased_micros;
  await openSubscription(run, page);
  await page
    .getByRole('button', { exact: true, name: m.action_edit() })
    .click();
  await expect(dialog.getByText(visa('0341'))).toBeVisible();
  await startCheckout(run, owner, '/api/billing/payment-method', () =>
    dialog
      .getByRole('button', { exact: true, name: m.billing_payment_change() })
      .click()
  );
  await completeCheckout(run, page, VISA);
  // The reopened dialog shows the new card by itself.
  await expect(dialog.getByText(visa('4242'))).toBeVisible({ timeout: 60_000 });
  await dialog
    .getByRole('button', { exact: true, name: m.action_cancel() })
    .click();
  const newCard = await creditsRow(run, owner);
  expect(newCard.reload_pm_last4).toBe('4242');
  await expectVoided(run, owner, second);
  const { invoice: thirdInvoice, reload: third } = await settledReload(
    run,
    owner,
    2
  );
  expect(third).toMatchObject({
    reload_pm_id: newCard.reload_pm_id,
    status: 'paid',
  });
  expect((await creditsRow(run, owner)).purchased_micros).toBe(
    beforeNewCard + third.credits_micros
  );
  await processedEvent(
    run,
    'invoice.paid',
    since,
    (value) => value.id === third.stripe_invoice_id
  );
  await openSubscription(run, page);
  await expectInvoice(
    owner,
    thirdInvoice,
    m.billing_invoice_kind_reload(),
    m.billing_invoice_status_paid(),
    m.billing_invoice_view()
  );
  await run.attach('declined-reload-journey', {
    customerId,
    reloads: [first, second, third].map((p) => ({
      id: p.id,
      invoiceId: p.stripe_invoice_id,
    })),
  });
});

test('spent to zero through the app: work at zero is refused, the request that finds zero with auto-reload on is admitted, a declined reload refuses work after its window, switching auto-reload off and on arms nothing, and a paid reload on a new card lets work resume', async ({
  run,
}) => {
  test.setTimeout(1_200_000);
  await verifyStripeSandbox(run.env);
  const since = Math.floor(Date.now() / 1000) - 300;
  const owner = run.owner;
  const { page } = owner;
  const toggle = page.getByRole('switch', { name: m.billing_auto_reload() });
  const dialog = page.getByRole('dialog', { name: m.billing_auto_reload() });
  const workspaceId = await workspace(run, 'credits-spend');

  // The declining card, saved through hosted setup Checkout. Auto-reload
  // stays off while the balance is spent, so the worker starts nothing.
  await openSubscription(run, page);
  await toggle.click();
  await startCheckout(run, owner, '/api/billing/payment-method', () =>
    dialog
      .getByRole('button', { exact: true, name: m.billing_payment_add() })
      .click()
  );
  await completeCheckout(run, page, DECLINES);
  await expect(dialog.getByText(visa('0341'))).toBeVisible({ timeout: 60_000 });
  await dialog
    .getByRole('button', { exact: true, name: m.action_cancel() })
    .click();

  // Spend the allowance and the starter credits through the editor's AI
  // command on the editor model with the highest input rate: big, uncached
  // contexts, four at a time, until the gate's balance is at or below zero.
  const model = await costliestEditorModel(run, owner);
  expect(
    (
      await owner.request('/api/me/models', 'PATCH', {
        editorModel: {
          modelSlug: model.model_slug,
          providerSlug: model.provider_slug,
        },
      })
    ).status
  ).toBe(204);
  // Each command is one usage row; waiting for the rows (the provider call
  // receipts) means the counter is settled before it is read.
  const ledger = (calls: number) =>
    run.poll(
      `${calls} AI commands in the ledger`,
      () =>
        run.query<{ calls: number; spent: number }>(
          "SELECT count(*)::int AS calls,COALESCE(sum(credit_micros),0)::bigint AS spent FROM usage_events WHERE actor_user_id=%s AND surface='editor'",
          [owner.id]
        ),
      (rows) => rows[0].calls >= calls,
      120_000
    );
  const start = await billing(owner);
  const spendStarted = Date.now();
  expectAnswered(await aiCommand(owner, workspaceId, bigContext()));
  await ledger(1);
  const [firstCall] = await run.query<{
    input_tokens: number;
    output_tokens: number;
    credit_micros: number;
    catalog_provider_slug: string;
    catalog_model_slug: string;
  }>(
    'SELECT input_tokens,output_tokens,credit_micros,catalog_provider_slug,catalog_model_slug FROM usage_events WHERE actor_user_id=%s ORDER BY id DESC LIMIT 1',
    [owner.id]
  );
  const perCall = Number(firstCall.credit_micros);
  const planned = Math.ceil(availableOf(start) / perCall);
  await run.attach('spend-plan', {
    creditsPerCall: perCall / MICROS,
    firstCall,
    microsPerInputToken: model.micros_per_input_token,
    microsPerOutputToken: model.micros_per_output_token,
    plannedCalls: planned,
    startCredits: availableOf(start) / MICROS,
  });
  expect(firstCall).toMatchObject({
    catalog_model_slug: model.model_slug,
    catalog_provider_slug: model.provider_slug,
  });
  expect(
    planned,
    'AI commands needed to spend the balance under the AI rate limit'
  ).toBeLessThanOrEqual(MAX_SPEND_CALLS);
  let calls = 1;
  for (
    let available = availableOf(await billing(owner));
    available > 0;
    available = availableOf(await billing(owner))
  ) {
    expect(calls).toBeLessThan(MAX_SPEND_CALLS + 8);
    const batch = Math.min(4, Math.ceil(available / perCall));
    for (const answer of await Promise.all(
      Array.from({ length: batch }, () =>
        aiCommand(owner, workspaceId, bigContext())
      )
    ))
      expectAnswered(answer);
    calls += batch;
    await ledger(calls);
  }
  // The app wrote all of it: the counter holds the whole allowance, the
  // starter credits are gone (the overrun owed), and the ledger adds up.
  const [counter] = await run.query<{
    used_micros: number;
    purchased_micros: number;
    reserved_micros: number;
  }>(
    'SELECT used_micros,purchased_micros,reserved_micros FROM user_credits WHERE user_id=%s',
    [owner.id]
  );
  expect(counter.used_micros).toBe(Number(start.creditsLimitMicros));
  expect(counter.reserved_micros).toBe(0);
  expect(counter.purchased_micros).toBeLessThanOrEqual(0);
  const [spent] = await ledger(calls);
  expect(spent.calls).toBe(calls);
  expect(spent.spent).toBe(
    counter.used_micros +
      Number(start.creditsPurchasedMicros) -
      counter.purchased_micros
  );
  await run.attach('spend-down', {
    calls,
    creditsSpent: spent.spent / MICROS,
    owedCredits: -counter.purchased_micros / MICROS,
    seconds: Math.round((Date.now() - spendStarted) / 1000),
  });

  // At zero with auto-reload off, work is refused.
  expectRefusedAtZero(await aiCommand(owner, workspaceId, ['Spend check.']));

  // Auto-reload turned on at threshold 0 (still armed: no reload has started)
  // and at once a request: it finds credits at zero and is admitted, inside
  // the 60-second window of the reload it starts (or the worker started a
  // moment before). The reload declines and the tab shows it by itself.
  await toggle.click();
  expect(await saveAutoReload(page, 0)).toBe(true);
  const atZero = await aiCommand(owner, workspaceId, ['Spend check.']);
  const atZeroAnswered = new Date().toISOString();
  expectAnswered(atZero);
  const { reload: declined } = await declinedReload(run, owner, 0, since);
  await run.attach('reload-at-zero', {
    reloadCreatedAt: declined.created_at,
    requestAnsweredAt: atZeroAnswered,
  });
  expect(declined.status).toBe('retrying');
  await expect(notice(page, m.billing_reload_retrying_title())).toBeVisible({
    timeout: 60_000,
  });

  // Past the window (60 s from the reload's start) work at zero is refused,
  // and no second reload starts while Stripe retries.
  await sleep(Date.parse(declined.created_at) + 65_000 - Date.now());
  expectRefusedAtZero(await aiCommand(owner, workspaceId, ['Spend check.']));
  expect(await reloadCount(run, owner)).toBe(1);

  // Switching auto-reload off voids the declined reload; switching it on
  // again arms nothing: a warning toast asks for a top-up, no reload starts
  // and work at zero is still refused (no new window).
  await switchAutoReloadOff(page);
  await expectVoided(run, owner, declined);
  expect(await setAutoReload(page, 0)).toBe(false);
  await expect(page.getByText(m.billing_reload_disarmed_title())).toBeVisible();
  expectRefusedAtZero(await aiCommand(owner, workspaceId, ['Spend check.']));
  await sleep(15_000);
  expect(await reloadCount(run, owner)).toBe(1);

  // A new card (Change, hosted setup Checkout) re-arms auto-reload: at zero
  // its reload starts, is paid, and work resumes.
  await openSubscription(run, page);
  await page
    .getByRole('button', { exact: true, name: m.action_edit() })
    .click();
  await startCheckout(run, owner, '/api/billing/payment-method', () =>
    dialog
      .getByRole('button', { exact: true, name: m.billing_payment_change() })
      .click()
  );
  await completeCheckout(run, page, VISA);
  await expect(dialog.getByText(visa('4242'))).toBeVisible({ timeout: 60_000 });
  await dialog
    .getByRole('button', { exact: true, name: m.action_cancel() })
    .click();
  const newCard = await creditsRow(run, owner);
  expect(newCard.reload_pm_last4).toBe('4242');
  const { reload: paid } = await settledReload(run, owner, 1);
  expect(paid).toMatchObject({
    reload_pm_id: newCard.reload_pm_id,
    status: 'paid',
  });
  expect(availableOf(await billing(owner))).toBeGreaterThan(0);
  expectAnswered(await aiCommand(owner, workspaceId, ['Spend check.']));
});

test('saving auto-reload again during a charge arms nothing, and a paid Pro renewal re-arms it', async ({
  run,
}) => {
  test.setTimeout(1_200_000);
  await verifyStripeSandbox(run.env);
  const since = Math.floor(Date.now() / 1000) - 300;
  const owner = run.owner;
  const { page } = owner;
  const dialog = page.getByRole('dialog', { name: m.billing_auto_reload() });

  // Pro on a test clock (as billing.spec.ts): the subscription binds the
  // clock's customer to the owner, and credit Checkout and reloads use it.
  const clockName = `capy-uat-${run.id}`;
  await run.record('stripe-clock-intent', clockName, { userId: owner.id });
  const clockId = stringField(
    await stripeRequest(
      run.env,
      '/v1/test_helpers/test_clocks',
      'POST',
      { frozen_time: String(Math.floor(Date.now() / 1000)), name: clockName },
      `${run.id}-${owner.id}-clock`
    ),
    'id'
  );
  await run.record('stripe-clock', clockId, {
    name: clockName,
    userId: owner.id,
  });
  const customerId = stringField(
    await stripeRequest(
      run.env,
      '/v1/customers',
      'POST',
      {
        email: owner.email,
        'metadata[capyUatRunId]': run.id,
        'metadata[user_id]': owner.id,
        source: 'tok_visa',
        test_clock: clockId,
      },
      `${run.id}-${owner.id}-customer`
    ),
    'id'
  );
  await run.record('stripe-customer', customerId, {
    clockId,
    userId: owner.id,
  });
  const subscription = await stripeRequest(
    run.env,
    '/v1/subscriptions',
    'POST',
    {
      customer: customerId,
      'items[0][price]': run.env.stripePriceId,
      'metadata[capyUatRunId]': run.id,
      'metadata[user_id]': owner.id,
      payment_behavior: 'error_if_incomplete',
    },
    `${run.id}-${owner.id}-subscription`
  );
  const subscriptionId = stringField(subscription, 'id');
  await run.record('stripe-subscription', subscriptionId, {
    clockId,
    customerId,
    userId: owner.id,
  });
  await run.poll(
    'Pro projection with the clock customer',
    () =>
      run.query<{ plan_tier: string; stripe_customer_id: string | null }>(
        'SELECT plan_tier,stripe_customer_id FROM users WHERE id=%s',
        [owner.id]
      ),
    (rows) =>
      rows[0]?.plan_tier === 'pro' && rows[0].stripe_customer_id === customerId,
    120_000
  );
  // The first Pro invoice's invoice.paid arms an account that starts armed;
  // it is processed before any reload can start.
  const firstInvoiceId = stringField(subscription, 'latest_invoice');
  await processedEvent(
    run,
    'invoice.paid',
    since,
    (value) => value.id === firstInvoiceId
  );

  // The reload card through hosted setup Checkout (4242), then auto-reload
  // on at the highest threshold the dialog takes, which one reload never
  // lifts credits past: the worker starts a reload at once, and only arming
  // decides whether another follows. The same settings saved every few
  // hundred milliseconds through its charge arm nothing: one reload, paid,
  // and auto-reload disarmed.
  await openSubscription(run, page);
  await page.getByRole('switch', { name: m.billing_auto_reload() }).click();
  await startCheckout(run, owner, '/api/billing/payment-method', () =>
    dialog
      .getByRole('button', { exact: true, name: m.billing_payment_add() })
      .click()
  );
  await completeCheckout(run, page, VISA);
  await expect(dialog.getByText(visa('4242'))).toBeVisible({ timeout: 60_000 });
  const threshold = setAutoReloadBodyThresholdCreditsMax;
  expect(await saveAutoReload(page, threshold)).toBe(true);
  const saves: number[] = [];
  for (const until = Date.now() + 20_000; Date.now() < until; ) {
    const resaved = await owner.request('/api/billing/auto-reload', 'PUT', {
      amountCents: RELOAD_CENTS,
      enabled: true,
      thresholdCredits: threshold,
    });
    expect(resaved.status).toBe(200);
    saves.push(Date.now());
    await sleep(250);
  }
  const { reload: first } = await settledReload(run, owner, 0);
  expect(first.status).toBe('paid');
  const charging = [
    Date.parse(first.created_at),
    Date.parse(String(first.paid_at)),
  ];
  const savesWhileCharging = saves.filter(
    (at) => at >= charging[0] && at <= charging[1]
  ).length;
  await run.attach('resaved-while-charging', {
    chargingMs: charging[1] - charging[0],
    saves: saves.length,
    savesWhileCharging,
  });
  expect(savesWhileCharging).toBeGreaterThan(0);
  await sleep(15_000);
  expect(await reloadCount(run, owner)).toBe(1);
  expect((await creditsRow(run, owner)).reload_armed).toBe(false);

  // The renewal: the clock past the period end, then past Stripe's hour of
  // draft finalization. Its paid invoice (above zero) re-arms auto-reload,
  // and with credits still under the threshold a second reload starts.
  const periodEnd = stripePeriodEnd(subscription);
  await advanceStripeClock(run, clockId, periodEnd + 1);
  const renewalId = stringField(
    await run.poll(
      'renewal invoice created',
      () => stripeRequest(run.env, `/v1/subscriptions/${subscriptionId}`),
      (value) => value.latest_invoice !== firstInvoiceId,
      120_000
    ),
    'latest_invoice'
  );
  await run.record('stripe-invoice', renewalId, {
    customerId,
    retained: 'sandbox billing history',
    userId: owner.id,
  });
  await advanceStripeClock(run, clockId, periodEnd + 3601);
  const renewal = await run.poll(
    'renewal invoice paid',
    () => stripeRequest(run.env, `/v1/invoices/${renewalId}`),
    (value) => value.status === 'paid',
    120_000
  );
  expect(Number(renewal.amount_paid)).toBeGreaterThan(0);
  await processedEvent(
    run,
    'invoice.paid',
    since,
    (value) => value.id === renewalId
  );
  const { reload: rearmed } = await settledReload(run, owner, 1);
  expect(rearmed).toMatchObject({
    reload_pm_id: first.reload_pm_id,
    status: 'paid',
  });
  await cleanupStripeTestClock(run.env, clockId, run.id);
});
