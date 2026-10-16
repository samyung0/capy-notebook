/* biome-ignore-all lint/suspicious/noMisplacedAssertion: The helpers execute only inside the journey. */
// Purchased credits, top-ups, auto-reload and the monthly spending limit
// (openwiki/observability-metering.md, "Purchased credits, top-ups and
// auto-reload"). Each journey has its own Free owner, whose Stripe customer the
// app creates on the first credit Checkout. Credits only come in through the
// webhooks of a paid hosted Checkout, and the auto-reload card only through a
// Checkout, so those steps fill Stripe's hosted page with published test cards
// (`completeCheckout`); everything else uses the app's own UI and API, or the
// Stripe API where it stands in for the dashboard (refunds, an invoice Stripe
// gave up on, paying it). Reloads start at once by setting the threshold to the
// balance the app reports, so no model is called.
import { readFileSync } from 'node:fs';
import type { Locator, Page } from '@playwright/test';
import { m } from '../../i18n';
import {
  arrayField,
  claimStripeCustomer,
  object,
  stringField,
  stripeRequest,
  verifyOutboxDelivery,
  verifyStripeSandbox,
} from './providers';
import { type Actor, expect, test, type UatRun } from './runtime';

/** One credit in the ledger's micros. */
const MICROS = 1_000_000;
/** Stripe test cards (docs.stripe.com/testing): 0341 attaches, but every
 * charge on it declines. */
const VISA = '4242424242424242';
const DECLINES = '4000000000000341';
const zh = { locale: 'zh' } as const;
type Locale = typeof zh | undefined;

type Purchase = {
  id: string;
  kind: string;
  status: string;
  amount_cents: number;
  credits_micros: number;
  stripe_checkout_session_id: string | null;
  stripe_invoice_id: string | null;
  stripe_payment_intent_id: string | null;
  next_attempt_at: string | null;
  decline_reason: string | null;
  refunded_micros: number;
  disputed_micros: number;
  reload_pm_id: string | null;
};

type Credits = {
  purchased_micros: number;
  reload_armed: boolean;
  reload_pm_id: string | null;
  reload_pm_last4: string | null;
  spending_limit_cents: number | null;
  reload_skipped_at: string | null;
};

const purchases = (run: UatRun, actor: Actor) =>
  run.query<Purchase>(
    'SELECT id,kind,status,amount_cents,credits_micros,stripe_checkout_session_id,stripe_invoice_id,stripe_payment_intent_id,next_attempt_at,decline_reason,refunded_micros,disputed_micros,reload_pm_id FROM credit_purchases WHERE user_id=%s ORDER BY created_at',
    [actor.id]
  );

async function creditsRow(run: UatRun, actor: Actor) {
  const rows = await run.query<Credits>(
    'SELECT purchased_micros,reload_armed,reload_pm_id,reload_pm_last4,spending_limit_cents,reload_skipped_at FROM user_credits WHERE user_id=%s',
    [actor.id]
  );
  expect(rows.length).toBe(1);
  return rows[0];
}

async function purchaseWhere(
  run: UatRun,
  actor: Actor,
  label: string,
  accept: (purchase: Purchase) => boolean
) {
  const found = (
    await run.poll(
      label,
      () => purchases(run, actor),
      (rows) => rows.some(accept),
      120_000
    )
  ).find(accept);
  if (!found) throw new Error(label);
  return found;
}

const reloadCount = async (run: UatRun, actor: Actor) =>
  (await purchases(run, actor)).filter((p) => p.kind === 'reload').length;

const invoiceId = (purchase: Purchase) => {
  if (!purchase.stripe_invoice_id)
    throw new Error(`Purchase ${purchase.id} has no Stripe invoice`);
  return purchase.stripe_invoice_id;
};

/** The `index`th auto-reload once its charge has an outcome, and its invoice
 * (kept as sandbox history). */
async function settledReload(run: UatRun, actor: Actor, index: number) {
  const reload = (
    await run.poll(
      `auto-reload ${index + 1} settled`,
      async () =>
        (await purchases(run, actor)).filter((p) => p.kind === 'reload'),
      (rows) => rows.length > index && rows[index].status !== 'charging',
      120_000
    )
  )[index];
  const invoice = await stripeRequest(
    run.env,
    `/v1/invoices/${invoiceId(reload)}`
  );
  expect(object(invoice.metadata)).toMatchObject({
    kind: 'reload',
    purchase_id: reload.id,
  });
  await run.record('stripe-invoice', invoiceId(reload), {
    retained: 'sandbox billing history',
    userId: actor.id,
  });
  return { invoice, reload };
}

async function billing(actor: Actor) {
  const response = await actor.request('/api/billing');
  expect(response.status).toBe(200);
  return object(response.body);
}

/** The balance the gate admits against, in whole credits rounded up. A reload
 * threshold at it makes the reload worker (every 5 s) start a reload. */
async function thresholdNow(actor: Actor) {
  const b = await billing(actor);
  const available =
    Math.max(Number(b.creditsLimitMicros) - Number(b.creditsUsedMicros), 0) +
    Number(b.creditsPurchasedMicros) -
    Number(b.creditsReservedMicros);
  return Math.ceil(available / MICROS);
}

const nested = (value: unknown, key: string) =>
  value && typeof value === 'object'
    ? (value as Record<string, unknown>)[key]
    : undefined;

// The app's English display formats (src/features/billing/format.ts and
// creditLabels.ts).
const credits = (micros: number) => {
  const value = micros / MICROS;
  return value.toLocaleString('en', {
    maximumFractionDigits: value >= 10 ? 0 : 1,
  });
};
const dollars = (cents: number) =>
  new Intl.NumberFormat('en', {
    currency: 'USD',
    maximumFractionDigits: cents % 100 ? 2 : 0,
    minimumFractionDigits: cents % 100 ? 2 : 0,
    style: 'currency',
  }).format(cents / 100);
const money = (cents: number) =>
  new Intl.NumberFormat('en', { currency: 'USD', style: 'currency' }).format(
    cents / 100
  );
const shortDate = (date: Date) =>
  date.toLocaleDateString('en', {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
const visa = (last4: string) =>
  m.billing_payment_card({ brand: 'Visa', last4 });

/** The skipped-reload mail's subject, from its template source. */
const skippedSubject = (locale: string) =>
  object(
    JSON.parse(
      readFileSync(
        `emails/templates/credit-reload-skipped.${locale}.json`,
        'utf8'
      )
    )
  ).subject;

async function openSubscription(run: UatRun, page: Page, locale?: Locale) {
  await page.goto(
    new URL('/billing?tab=subscription', run.env.appUrl).toString()
  );
  await expect(
    page.getByText(m.billing_buy_credits({}, locale), { exact: true })
  ).toBeVisible();
}

const notice = (page: Page, title: string) =>
  page.getByRole('status').filter({ hasText: title });

/** The Invoices row whose View or Pay link is the invoice's hosted page. */
async function expectInvoice(
  page: Page,
  invoice: Record<string, unknown>,
  type: string,
  status: string,
  link: string
) {
  const row = page.getByRole('row').filter({
    has: page.locator(
      `a[href="${stringField(invoice, 'hosted_invoice_url')}"]`
    ),
  });
  await expect(row).toContainText(type);
  await expect(row).toContainText(status);
  await expect(row.getByRole('link')).toHaveText(link);
}

async function save(
  page: Page,
  dialog: Locator,
  path: string,
  locale?: Locale
) {
  const saved = page.waitForResponse(
    (r) => r.url().endsWith(path) && r.request().method() === 'PUT'
  );
  await dialog
    .getByRole('button', { exact: true, name: m.action_save({}, locale) })
    .click();
  expect((await saved).status()).toBe(204);
  await expect(dialog).toBeHidden();
}

/** Auto-reload on (the switch) or edited (Edit) through its dialog: $10 at
 * `threshold` credits, after checking the saved card when `card` is given. */
async function setAutoReload(page: Page, threshold: number, card?: string) {
  const toggle = page.getByRole('switch', { name: m.billing_auto_reload() });
  if (await toggle.isChecked())
    await page
      .getByRole('button', { exact: true, name: m.action_edit() })
      .click();
  else await toggle.click();
  const dialog = page.getByRole('dialog', { name: m.billing_auto_reload() });
  if (card) await expect(dialog.getByText(card)).toBeVisible();
  await dialog.getByLabel(m.billing_reload_amount()).fill('10');
  await dialog.getByLabel(m.billing_reload_threshold()).fill(String(threshold));
  await save(page, dialog, '/api/billing/auto-reload');
}

async function setLimit(
  page: Page,
  open: Locator,
  limitDollars: string,
  locale?: Locale
) {
  await open.click();
  const dialog = page.getByRole('dialog', {
    name: m.billing_monthly_limit({}, locale),
  });
  await dialog
    .getByLabel(m.billing_limit_dialog_label({}, locale))
    .fill(limitDollars);
  await save(page, dialog, '/api/billing/spending-limit', locale);
}

/** Clicks `start`, whose POST to `path` sends the page to hosted Checkout,
 * then claims the customer the app bound and records the session. */
async function startCheckout(
  run: UatRun,
  actor: Actor,
  path: string,
  start: () => Promise<void>
) {
  const created = actor.page.waitForResponse(
    (r) => r.url().endsWith(path) && r.request().method() === 'POST'
  );
  await start();
  const response = await created;
  // Stripe refusing the session's parameters fails here, before any payment.
  await run.attach(`checkout-request-${path.split('/').at(-1)}`, {
    status: response.status(),
  });
  expect(response.status()).toBe(200);
  // The page leaves at once, so the session is read from its URL, not the
  // response body.
  await actor.page.waitForURL(/^https:\/\/checkout\.stripe\.com\//);
  const [user] = await run.query<{ stripe_customer_id: string | null }>(
    'SELECT stripe_customer_id FROM users WHERE id=%s',
    [actor.id]
  );
  const customerId = user?.stripe_customer_id;
  if (!customerId) throw new Error('Credit Checkout bound no Stripe customer');
  await claimStripeCustomer(run, customerId, actor.id);
  const session = arrayField(
    await stripeRequest(
      run.env,
      `/v1/checkout/sessions?${new URLSearchParams({ customer: customerId, limit: '10' })}`
    ),
    'data'
  )
    .map(object)
    .find((value) => actor.page.url().includes(stringField(value, 'id')));
  if (!session)
    throw new Error('The Checkout page matches no session of the customer');
  await run.record('stripe-checkout', stringField(session, 'id'), {
    customerId,
    userId: actor.id,
  });
  return { customerId, session };
}

/**
 * Pays, or saves, a Stripe test card on the hosted Checkout page and waits to
 * be back on the Subscription tab. Only top-up and card-saving Checkout land
 * here: they have no API equivalent.
 */
async function completeCheckout(page: Page, card: string) {
  await page.waitForURL(/^https:\/\/checkout\.stripe\.com\//);
  const number = page.locator('#cardNumber');
  // With Link enabled the card form can sit behind its accordion item.
  const cardItem = page.getByTestId('card-accordion-item-button');
  await expect(number.or(cardItem).first()).toBeVisible({ timeout: 60_000 });
  if (!(await number.isVisible())) await cardItem.click();
  await number.fill(card);
  await page.locator('#cardExpiry').fill('12 / 34');
  await page.locator('#cardCvc').fill('123');
  const name = page.locator('#billingName');
  if (await name.isVisible()) await name.fill('Capy UAT');
  await page.locator('#billingCountry').selectOption('US');
  const postal = page.locator('#billingPostalCode');
  // Address autocomplete can keep the fields behind manual entry.
  const manual = page.getByText(/enter address manually/i);
  await expect(postal.or(manual).first()).toBeVisible();
  if (!(await postal.isVisible())) await manual.first().click();
  // Card-saving Checkout requires the whole billing address.
  const line1 = page.locator('#billingAddressLine1');
  if (await line1.isVisible()) {
    await line1.fill('1 Main Street');
    await line1.press('Escape');
    await page.locator('#billingLocality').fill('New York');
    await page.locator('#billingAdministrativeArea').selectOption('NY');
  }
  await postal.fill('10001');
  // Link's opt-in would ask for a phone number.
  const link = page.locator('#enableStripePass');
  if ((await link.count()) > 0 && (await link.isChecked()))
    await link.uncheck();
  await page.getByTestId('hosted-payment-submit-button').click();
  await page.waitForURL(/\/billing\?tab=subscription/, { timeout: 90_000 });
}

/** The Stripe event of `type` about one object: delivered to every endpoint
 * with a 2xx (`pending_webhooks` 0) and processed by the gateway without error. */
async function processedEvent(
  run: UatRun,
  type: string,
  since: number,
  about: (value: Record<string, unknown>) => boolean
) {
  const event = await run.poll(
    `Stripe ${type} delivered`,
    async () =>
      arrayField(
        await stripeRequest(
          run.env,
          `/v1/events?${new URLSearchParams({ 'created[gte]': String(since), limit: '100', type })}`
        ),
        'data'
      )
        .map(object)
        .find((value) => about(object(object(value.data).object))),
    (value) => value?.pending_webhooks === 0,
    180_000
  );
  if (!event) throw new Error(`No ${type} event`);
  const id = stringField(event, 'id');
  const [row] = await run.poll(
    `gateway processed ${type}`,
    () =>
      run.query<{ processed_at: string | null; error: string | null }>(
        "SELECT processed_at,error FROM webhook_events WHERE source='stripe' AND id=%s",
        [id]
      ),
    (rows) =>
      rows.length === 1 &&
      (rows[0].processed_at !== null || rows[0].error !== null),
    120_000
  );
  expect(row.error).toBeNull();
  return { id, processedAt: row.processed_at };
}

/** A reload voided by the app: void in the ledger and Stripe, Void in the list. */
async function expectVoided(run: UatRun, actor: Actor, reload: Purchase) {
  await purchaseWhere(
    run,
    actor,
    `auto-reload ${reload.id} void`,
    (p) => p.id === reload.id && p.status === 'void'
  );
  const invoice = await stripeRequest(
    run.env,
    `/v1/invoices/${invoiceId(reload)}`
  );
  expect(invoice.status).toBe('void');
  await openSubscription(run, actor.page);
  await expectInvoice(
    actor.page,
    invoice,
    m.billing_invoice_kind_reload(),
    m.billing_invoice_status_void(),
    m.billing_invoice_view()
  );
}

test('starter credits, a hosted-Checkout top-up, the monthly limit, auto-reload, a skipped reload mailed in en and zh, and a half refund', async ({
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

  // $8 through hosted Checkout in the same tab.
  const before = Number((await billing(owner)).creditsPurchasedMicros);
  await field.fill('8');
  const { customerId, session } = await startCheckout(
    run,
    owner,
    '/api/billing/top-up',
    () => topUpButton.click()
  );
  const sessionId = stringField(session, 'id');
  // Handoff question 1: Stripe took the top-up parameters together.
  await run.attach('topup-checkout-params', {
    adaptivePricing: nested(session.adaptive_pricing, 'enabled'),
    amountSubtotal: session.amount_subtotal,
    automaticTax: nested(session.automatic_tax, 'enabled'),
    currency: session.currency,
    expiresInSeconds: Number(session.expires_at) - Number(session.created),
    invoiceCreation: nested(session.invoice_creation, 'enabled'),
    mode: session.mode,
    paymentMethodTypes: session.payment_method_types,
    sessionId,
  });
  expect(session).toMatchObject({
    amount_subtotal: 800,
    currency: 'usd',
    mode: 'payment',
    payment_method_types: ['card', 'link'],
  });
  expect(nested(session.automatic_tax, 'enabled')).toBe(true);
  expect(nested(session.invoice_creation, 'enabled')).toBe(true);
  expect(nested(session.adaptive_pricing, 'enabled')).toBe(false);
  await completeCheckout(page, VISA);
  const topUp = await purchaseWhere(
    run,
    owner,
    'top-up credited',
    (p) => p.stripe_checkout_session_id === sessionId
  );
  expect(topUp).toMatchObject({
    amount_cents: 800,
    kind: 'topup',
    status: 'paid',
  });
  // The credits Checkout promised are the credits the ledger granted.
  expect(topUp.credits_micros).toBe(
    Number(object(session.metadata).credits) * MICROS
  );
  const afterTopUp = await creditsRow(run, owner);
  expect(afterTopUp.purchased_micros - before).toBe(topUp.credits_micros);
  // The first top-up's card is the auto-reload card.
  expect(afterTopUp.reload_pm_last4).toBe('4242');
  await processedEvent(
    run,
    'checkout.session.completed',
    since,
    (value) => value.id === sessionId
  );
  const paidSession = await run.poll(
    'top-up invoice created',
    () => stripeRequest(run.env, `/v1/checkout/sessions/${sessionId}`),
    (value) => typeof value.invoice === 'string'
  );
  const topUpInvoice = await run.poll(
    'top-up invoice paid',
    () =>
      stripeRequest(
        run.env,
        `/v1/invoices/${stringField(paidSession, 'invoice')}`
      ),
    (value) => value.status === 'paid'
  );
  expect(object(topUpInvoice.metadata).kind).toBe('topup');
  await run.record('stripe-invoice', stringField(topUpInvoice, 'id'), {
    customerId,
    retained: 'sandbox billing history',
    userId: owner.id,
  });
  await openSubscription(run, page);
  await expectInvoice(
    page,
    topUpInvoice,
    m.billing_invoice_kind_topup(),
    m.billing_invoice_status_paid(),
    m.billing_invoice_view()
  );
  const toggle = page.getByRole('switch', { name: m.billing_auto_reload() });
  const reloadDialog = page.getByRole('dialog', {
    name: m.billing_auto_reload(),
  });
  await toggle.click();
  await expect(reloadDialog.getByText(visa('4242'))).toBeVisible();
  await reloadDialog
    .getByRole('button', { exact: true, name: m.action_cancel() })
    .click();
  await expect(reloadDialog).toBeHidden();

  // A $10 monthly limit refuses another $8 top-up; $0 removes the limit.
  await setLimit(
    page,
    page.getByRole('button', { exact: true, name: m.billing_set_limit() }),
    '10'
  );
  expect((await creditsRow(run, owner)).spending_limit_cents).toBe(1000);
  await expect(
    page.getByText(m.billing_limit_of({ limit: money(1000) }))
  ).toBeVisible();
  await field.fill('8');
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
    page.getByText(m.billing_limit_toast_over_body({ limit: dollars(1000) }))
  ).toBeVisible();
  await setLimit(
    page,
    page.getByRole('button', { exact: true, name: m.billing_change_limit() }),
    '0'
  );
  await expect(page.getByText(m.billing_limit_none())).toBeVisible();
  expect((await creditsRow(run, owner)).spending_limit_cents).toBeNull();

  // Auto-reload at the threshold charges $10 to the saved card. The charge
  // takes seconds and the page polls only once it has seen it charging, so
  // the "Reloading" notice is not asserted.
  const beforeReload = (await creditsRow(run, owner)).purchased_micros;
  await setAutoReload(page, await thresholdNow(owner));
  const { invoice: reloadInvoice, reload } = await settledReload(run, owner, 0);
  expect(reload).toMatchObject({
    amount_cents: 1000,
    reload_pm_id: afterTopUp.reload_pm_id,
    status: 'paid',
  });
  // At the top-up's rate.
  expect(reload.credits_micros * topUp.amount_cents).toBe(
    topUp.credits_micros * reload.amount_cents
  );
  expect((await creditsRow(run, owner)).purchased_micros - beforeReload).toBe(
    reload.credits_micros
  );
  expect(reloadInvoice.status).toBe('paid');
  await processedEvent(
    run,
    'invoice.paid',
    since,
    (value) => value.id === reload.stripe_invoice_id
  );
  await openSubscription(run, page);
  await expectInvoice(
    page,
    reloadInvoice,
    m.billing_invoice_kind_reload(),
    m.billing_invoice_status_paid(),
    m.billing_invoice_view()
  );

  // A limit below this month's spend plus the reload skips it: no charge, a
  // notice and the credit-reload-skipped mail.
  const spentCents = Number(
    object((await billing(owner)).creditSettings).spentThisMonthCents
  );
  expect(spentCents).toBe(topUp.amount_cents + reload.amount_cents);
  const limitCents = spentCents + 200;
  await setLimit(
    page,
    page.getByRole('button', { exact: true, name: m.billing_set_limit() }),
    String(limitCents / 100)
  );
  const reloads = await reloadCount(run, owner);
  await setAutoReload(page, await thresholdNow(owner));
  const firstSkip = await run.poll(
    'reload skipped',
    () => creditsRow(run, owner),
    (row) => row.reload_skipped_at !== null
  );
  await openSubscription(run, page);
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
    page,
    topUpInvoice,
    m.billing_invoice_kind_topup({}, zh),
    m.billing_invoice_status_paid({}, zh),
    m.billing_invoice_view({}, zh)
  );
  await expectInvoice(
    page,
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

  // Refunding half the top-up takes half its credits back.
  const paymentIntent = topUp.stripe_payment_intent_id;
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
    `${run.id}-${topUp.id}-refund`
  );
  const refunded = await purchaseWhere(
    run,
    owner,
    'refund taken back',
    (p) => p.id === topUp.id && p.refunded_micros > 0
  );
  expect(refunded.refunded_micros).toBe(
    Math.floor((topUp.credits_micros * refund) / charged)
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
    topUpId: topUp.id,
  });
});

test('a declined auto-reload retries; switching off, a top-up and a new card void it; a reload Stripe gave up on can still be paid, and its dispute takes the credits back', async ({
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
  await run.attach('setup-checkout-params', {
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
  await completeCheckout(page, DECLINES);
  // The return reopens the dialog; whether it already shows the new card
  // depends on the webhook beating the page load, so that is only recorded.
  await expect(dialog).toBeVisible();
  const cardShownOnReturn = await dialog.getByText(visa('0341')).isVisible();
  const declining = await run.poll(
    'declining card saved',
    () => creditsRow(run, owner),
    (row) => row.reload_pm_last4 === '0341'
  );
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

  // At the balance as threshold the worker starts a reload, which declines.
  await openSubscription(run, page);
  await setAutoReload(page, await thresholdNow(owner), visa('0341'));
  const { invoice: firstInvoice, reload: first } = await settledReload(
    run,
    owner,
    0
  );
  // Handoff question 2: after our own invoices/pay fails, Stripe still has a
  // next attempt and sends invoice.payment_failed.
  await run.attach('declined-reload', {
    attemptCount: firstInvoice.attempt_count,
    declineReason: first.decline_reason,
    invoiceId: firstInvoice.id,
    invoiceStatus: firstInvoice.status,
    nextAttemptAt: first.next_attempt_at,
    nextPaymentAttempt: firstInvoice.next_payment_attempt,
    purchaseStatus: first.status,
  });
  expect(first).toMatchObject({
    reload_pm_id: declining.reload_pm_id,
    status: 'retrying',
  });
  expect(firstInvoice.status).toBe('open');
  expect(Date.parse(String(first.next_attempt_at)) / 1000).toBe(
    firstInvoice.next_payment_attempt
  );
  await processedEvent(
    run,
    'invoice.payment_failed',
    since,
    (value) => value.id === firstInvoice.id
  );
  const retryDate = shortDate(
    new Date(Number(firstInvoice.next_payment_attempt) * 1000)
  );
  await openSubscription(run, page);
  await expect(notice(page, m.billing_reload_retrying_title())).toContainText(
    m.billing_reload_retrying_body({
      amount: dollars(first.amount_cents),
      date: retryDate,
    })
  );
  await expectInvoice(
    page,
    firstInvoice,
    m.billing_invoice_kind_reload(),
    m.billing_invoice_status_retrying({ date: retryDate }),
    m.billing_invoice_pay()
  );
  // While Stripe retries no second reload starts: three worker passes.
  await new Promise((resolve) => setTimeout(resolve, 15_000));
  expect(await reloadCount(run, owner)).toBe(1);
  expect((await creditsRow(run, owner)).reload_armed).toBe(false);

  // Switching auto-reload off voids it.
  const switchedOff = page.waitForResponse(
    (r) =>
      r.url().endsWith('/api/billing/auto-reload') &&
      r.request().method() === 'PUT'
  );
  await toggle.click();
  expect((await switchedOff).status()).toBe(204);
  await expectVoided(run, owner, first);

  // Switching it on arms one reload again, which declines again. Stripe then
  // gives up on it (marked uncollectible, as after its last scheduled retry):
  // the row stays Failed with Pay.
  await setAutoReload(page, await thresholdNow(owner));
  const { reload: second } = await settledReload(run, owner, 1);
  expect(second.status).toBe('retrying');
  const secondInvoiceId = invoiceId(second);
  await stripeRequest(
    run.env,
    `/v1/invoices/${secondInvoiceId}/mark_uncollectible`,
    'POST',
    {},
    `${run.id}-${secondInvoiceId}-uncollectible`
  );
  const uncollectible = await stripeRequest(
    run.env,
    `/v1/invoices/${secondInvoiceId}`
  );
  expect(uncollectible.status).toBe('uncollectible');
  await openSubscription(run, page);
  await expectInvoice(
    page,
    uncollectible,
    m.billing_invoice_kind_reload(),
    m.billing_invoice_status_failed(),
    m.billing_invoice_pay()
  );

  // Handoff question 3: the uncollectible invoice can still be paid (here
  // through the API, with a card whose charge is then disputed), and
  // invoice.paid credits it.
  const disputing = await stripeRequest(
    run.env,
    '/v1/payment_methods/pm_card_createDispute/attach',
    'POST',
    { customer: customerId },
    `${run.id}-${customerId}-dispute-card`
  );
  const beforePay = (await creditsRow(run, owner)).purchased_micros;
  try {
    await stripeRequest(
      run.env,
      `/v1/invoices/${secondInvoiceId}/pay`,
      'POST',
      { off_session: 'true', payment_method: stringField(disputing, 'id') },
      `${run.id}-${secondInvoiceId}-pay`
    );
  } catch (error) {
    await run.attach('uncollectible-reload-pay', {
      failure: error instanceof Error ? error.message : 'unknown',
      paid: false,
    });
    throw new Error(
      'Stripe refused to pay an uncollectible reload invoice: the Pay link on Failed rows would have to go',
      { cause: error }
    );
  }
  const paidSecond = await purchaseWhere(
    run,
    owner,
    'paid uncollectible reload credited',
    (p) => p.id === second.id && p.status === 'paid'
  );
  const invoicePaid = await processedEvent(
    run,
    'invoice.paid',
    since,
    (value) => value.id === secondInvoiceId
  );
  const disputedIntent = paidSecond.stripe_payment_intent_id;
  if (!disputedIntent)
    throw new Error('The paid reload recorded no payment intent');
  const disputeCreated = await processedEvent(
    run,
    'charge.dispute.created',
    since,
    (value) => value.payment_intent === disputedIntent
  );
  await run.attach('uncollectible-reload-pay', {
    disputeProcessedAt: disputeCreated.processedAt,
    invoicePaidProcessedAt: invoicePaid.processedAt,
    paid: true,
  });
  // A dispute processed before the payment intent was recorded finds no
  // purchase and takes nothing; the processing times above tell.
  const held = await purchaseWhere(
    run,
    owner,
    'dispute held the reload credits',
    (p) => p.id === second.id && p.disputed_micros > 0
  );
  expect(held.disputed_micros).toBe(held.credits_micros - held.refunded_micros);
  expect((await creditsRow(run, owner)).purchased_micros).toBe(
    beforePay + held.credits_micros - held.disputed_micros
  );

  // The payment re-armed auto-reload and the hold put credits back at the
  // threshold: the next reload declines on the saved card. A manual top-up
  // voids it, re-arms auto-reload and keeps the saved card.
  const { reload: third } = await settledReload(run, owner, 2);
  expect(third.status).toBe('retrying');
  await openSubscription(run, page);
  const field = page.getByLabel(m.billing_top_up(), { exact: true });
  await field.fill('8');
  const beforeTopUp = (await creditsRow(run, owner)).purchased_micros;
  const { session: topUpSession } = await startCheckout(
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
  await completeCheckout(page, VISA);
  const topUp = await purchaseWhere(
    run,
    owner,
    'top-up credited',
    (p) => p.stripe_checkout_session_id === topUpSession.id
  );
  await expectVoided(run, owner, third);
  const afterTopUp = await creditsRow(run, owner);
  expect(afterTopUp.purchased_micros - beforeTopUp).toBe(topUp.credits_micros);
  expect(afterTopUp).toMatchObject({
    reload_armed: true,
    reload_pm_last4: '0341',
  });

  // Another declined reload at the new balance; a new card through Change
  // voids it, and the reload it re-arms charges the new card.
  await setAutoReload(page, await thresholdNow(owner));
  const { reload: fourth } = await settledReload(run, owner, 3);
  expect(fourth.status).toBe('retrying');
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
  await completeCheckout(page, VISA);
  const newCard = await run.poll(
    'new card saved',
    () => creditsRow(run, owner),
    (row) => row.reload_pm_last4 === '4242'
  );
  await expectVoided(run, owner, fourth);
  const { invoice: fifthInvoice, reload: fifth } = await settledReload(
    run,
    owner,
    4
  );
  expect(fifth).toMatchObject({
    reload_pm_id: newCard.reload_pm_id,
    status: 'paid',
  });
  expect((await creditsRow(run, owner)).purchased_micros).toBe(
    afterTopUp.purchased_micros + fifth.credits_micros
  );
  await processedEvent(
    run,
    'invoice.paid',
    since,
    (value) => value.id === fifth.stripe_invoice_id
  );
  await openSubscription(run, page);
  await expectInvoice(
    page,
    fifthInvoice,
    m.billing_invoice_kind_reload(),
    m.billing_invoice_status_paid(),
    m.billing_invoice_view()
  );
  for (const declined of [second, third, fourth])
    await processedEvent(
      run,
      'invoice.payment_failed',
      since,
      (value) => value.id === declined.stripe_invoice_id
    );
  await run.attach('declined-reload-journey', {
    cardShownOnReturn,
    customerId,
    reloads: [first, second, third, fourth, fifth].map((p) => ({
      id: p.id,
      invoiceId: p.stripe_invoice_id,
    })),
    topUpId: topUp.id,
  });
});
