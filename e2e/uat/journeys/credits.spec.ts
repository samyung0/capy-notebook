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
// balance the app reports, so no model is called. Stripe and the reload worker
// reach the open tab through the event stream's `billing` event, so what they
// change is asserted on the tab without reloading it.
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Locator, Page } from '@playwright/test';
import { setAutoReloadBodyThresholdCreditsMax } from '../../../src/api/gen/validators';
import { m } from '../../i18n';
import { workspace } from './files';
import {
  advanceStripeClock,
  arrayField,
  claimStripeCustomer,
  cleanupStripeTestClock,
  object,
  stringField,
  stripePeriodEnd,
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
/** The auto-reload amount every journey saves: $10. */
const RELOAD_CENTS = 1000;
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
  created_at: string;
  paid_at: string | null;
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
    'SELECT id,kind,status,amount_cents,credits_micros,stripe_checkout_session_id,stripe_invoice_id,stripe_payment_intent_id,next_attempt_at,decline_reason,refunded_micros,disputed_micros,reload_pm_id,created_at,paid_at FROM credit_purchases WHERE user_id=%s ORDER BY created_at',
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

/**
 * The `index`th auto-reload, declined, once its invoice.payment_failed is
 * processed. The worker records the decline right after its charge, before
 * Stripe has scheduled the retry, so it first reads `failed`; the webhook
 * then records Stripe's next attempt. `recordedFirst` is what the worker
 * wrote.
 */
async function declinedReload(
  run: UatRun,
  actor: Actor,
  index: number,
  since: number
) {
  const { reload: recorded } = await settledReload(run, actor, index);
  await processedEvent(
    run,
    'invoice.payment_failed',
    since,
    (value) => value.id === recorded.stripe_invoice_id
  );
  const [reload] = (await purchases(run, actor)).filter(
    (p) => p.id === recorded.id
  );
  const invoice = await stripeRequest(
    run.env,
    `/v1/invoices/${invoiceId(reload)}`
  );
  return { invoice, recordedFirst: recorded.status, reload };
}

async function billing(actor: Actor) {
  const response = await actor.request('/api/billing');
  expect(response.status).toBe(200);
  return object(response.body);
}

/** What the gate admits against: the allowance left plus purchased credits,
 * less reservations. */
const availableOf = (b: Record<string, unknown>) =>
  Math.max(Number(b.creditsLimitMicros) - Number(b.creditsUsedMicros), 0) +
  Number(b.creditsPurchasedMicros) -
  Number(b.creditsReservedMicros);

/** The balance in whole credits rounded up. A reload threshold at it makes
 * the reload worker (every 5 s) start a reload. */
const thresholdNow = async (actor: Actor) =>
  Math.ceil(availableOf(await billing(actor)) / MICROS);

const sleep = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

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

/** The Invoices row of a Stripe invoice. Its hosted-page link is signed anew
 * on every read, so it cannot name the row: the tab lists invoices in the
 * order the app's API returns them, under one header row. */
async function expectInvoice(
  actor: Actor,
  invoice: Record<string, unknown>,
  type: string,
  status: string,
  link: string
) {
  const listed = await actor.request('/api/billing/invoices');
  expect(listed.status).toBe(200);
  const index = arrayField(listed.body, 'items')
    .map(object)
    .findIndex((item) => item.id === invoice.id);
  expect(index, 'the invoice is listed').toBeGreaterThanOrEqual(0);
  const row = actor.page.getByRole('row').nth(index + 1);
  await expect(row).toContainText(type);
  await expect(row).toContainText(status);
  await expect(row.getByRole('link')).toHaveText(link);
}

/** Clicks the dialog's Save and returns the answer to its PUT. */
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
  const response = await saved;
  await expect(dialog).toBeHidden();
  return response;
}

/** Saves the open auto-reload dialog ($10 at `threshold` credits) and returns
 * whether a reload is armed: saving never arms one. */
async function saveAutoReload(page: Page, threshold: number) {
  const dialog = page.getByRole('dialog', { name: m.billing_auto_reload() });
  await dialog
    .getByLabel(m.billing_reload_amount())
    .fill(String(RELOAD_CENTS / 100));
  await dialog.getByLabel(m.billing_reload_threshold()).fill(String(threshold));
  const response = await save(page, dialog, '/api/billing/auto-reload');
  expect(response.status()).toBe(200);
  return object(await response.json()).armed === true;
}

/** Auto-reload turned on (the switch) or edited (Edit) through its dialog. */
async function setAutoReload(page: Page, threshold: number) {
  const toggle = page.getByRole('switch', { name: m.billing_auto_reload() });
  if (await toggle.isChecked())
    await page
      .getByRole('button', { exact: true, name: m.action_edit() })
      .click();
  else await toggle.click();
  return saveAutoReload(page, threshold);
}

async function switchAutoReloadOff(page: Page) {
  const saved = page.waitForResponse(
    (r) =>
      r.url().endsWith('/api/billing/auto-reload') &&
      r.request().method() === 'PUT'
  );
  await page.getByRole('switch', { name: m.billing_auto_reload() }).click();
  expect((await saved).status()).toBe(200);
}

/** Buy credits' balance line, which shows the purchased balance. */
const purchasedLeft = (page: Page, micros: number) =>
  page.getByText(m.billing_purchased_left({ amount: credits(micros) }));

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
  expect(
    (await save(page, dialog, '/api/billing/spending-limit', locale)).status()
  ).toBe(204);
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
async function completeCheckout(run: UatRun, page: Page, card: string) {
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
  const submit = page.getByTestId('hosted-payment-submit-button');
  await expect(submit).toBeEnabled();
  const returned = page
    .waitForURL(/\/billing\?tab=subscription/, { timeout: 90_000 })
    .then(
      () => undefined,
      (error: unknown) => error
    );
  await submit.click();
  const failure = await returned;
  if (failure === undefined) return;
  // What the page shows instead: Stripe's field errors, a challenge, or the
  // Link sign-up's phone number. No card or address values are kept.
  const at = new URL(page.url());
  await run.attach('checkout-not-returned', {
    alerts: await page.getByRole('alert').allInnerTexts(),
    captchaFrames: await page.locator('iframe[src*="hcaptcha"]').count(),
    invalidFields: await page
      .locator('[aria-invalid="true"]')
      .evaluateAll((fields) => fields.map((field) => field.id)),
    page: `${at.host}${at.pathname}`,
    phoneField: await page.locator('#phoneNumber').count(),
    submitText: await submit.innerText(),
  });
  throw failure;
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
    actor,
    invoice,
    m.billing_invoice_kind_reload(),
    m.billing_invoice_status_void(),
    m.billing_invoice_view()
  );
}

/** At most this many big AI commands spend a new account's credits: past
 * the 15-request burst the AI rate limit admits one every 18 s, so these fit
 * in about ten minutes. */
const MAX_SPEND_CALLS = 45;

/** About 180,000 characters of random words: a fresh, uncached prompt within
 * the editor's 200,000-character context (pipeline ai_adapter.py). */
const bigContext = () =>
  Array.from({ length: 20 }, () =>
    randomBytes(6000)
      .toString('base64url')
      .replace(/(.{7})/g, '$1 ')
  );

type AIAnswer = {
  status: number;
  body: unknown;
  events: Record<string, unknown>[];
};

/**
 * One editor AI command (Generate over `paragraphs`), as the note editor
 * sends it. A 429 or a busy provider is waited out as it asks and sent again,
 * which only paces the spend.
 */
async function aiCommand(
  actor: Actor,
  workspaceId: string,
  paragraphs: string[]
): Promise<AIAnswer> {
  for (;;) {
    const response = await actor.request(
      `/api/workspaces/${workspaceId}/ai/command`,
      'POST',
      {
        ctx: {
          children: paragraphs.map((text) => ({
            children: [{ text }],
            type: 'p',
          })),
          toolName: 'generate',
        },
        messages: [
          {
            parts: [{ text: 'Reply with the single word OK.', type: 'text' }],
            role: 'user',
          },
        ],
      },
      120_000
    );
    const limited =
      response.status === 429 &&
      Number(nested(response.body, 'retryAfterSeconds'));
    if (limited) {
      await sleep(limited * 1000);
      continue;
    }
    if (response.status !== 200) return { ...response, events: [] };
    const events = String(response.body)
      .split('\n')
      .filter((line) => line.startsWith('data: {'))
      .map((line) => object(JSON.parse(line.slice('data: '.length))));
    const busy = events.find(
      (event) =>
        event.type === 'error' &&
        nested(event.data, 'retryAfterSeconds') !== undefined
    );
    if (!busy) return { ...response, events };
    await sleep(
      Math.max(1, Number(nested(busy.data, 'retryAfterSeconds'))) * 1000
    );
  }
}

function expectAnswered(answer: AIAnswer) {
  expect(answer.status).toBe(200);
  expect(answer.events.filter((event) => event.type === 'error')).toEqual([]);
  expect(answer.events.some((event) => event.type === 'finish')).toBe(true);
}

function expectRefusedAtZero(answer: AIAnswer) {
  expect(answer.status).toBe(403);
  expect(object(answer.body).code).toBe('llm_credits_exhausted');
}

type EditorModel = {
  provider_slug: string;
  model_slug: string;
  micros_per_input_token: number;
  micros_per_output_token: number;
};

/** The editor model the account may use with the highest input rate in the
 * catalog: the fewest calls spend a balance. */
async function costliestEditorModel(run: UatRun, actor: Actor) {
  const listed = await actor.request('/api/models?slot=editor');
  expect(listed.status).toBe(200);
  const offered = arrayField(listed.body, 'models')
    .map(object)
    .filter((model) => model.available === true && model.usesUserKey !== true);
  const rows = (
    await run.query<EditorModel>(
      "SELECT DISTINCT ON (provider_slug,model_slug) provider_slug,model_slug,micros_per_input_token,micros_per_output_token FROM model_configs WHERE enabled AND platform_enabled AND 'editor'=ANY(slots) ORDER BY provider_slug,model_slug,version DESC"
    )
  ).filter((row) =>
    offered.some(
      (model) =>
        model.providerSlug === row.provider_slug &&
        model.modelSlug === row.model_slug
    )
  );
  const [costliest] = rows.sort(
    (a, b) => b.micros_per_input_token - a.micros_per_input_token
  );
  if (!costliest) throw new Error('No platform editor model is offered');
  return costliest;
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
  await run.attach('q1-topup-checkout-params', {
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
  await completeCheckout(run, page, VISA);
  // Checkout returns to the plain Subscription tab.
  expect([...new URL(page.url()).searchParams.keys()]).toEqual(['tab']);
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
  // The tab, not reloaded since the return, shows the credited balance.
  await expect(purchasedLeft(page, afterTopUp.purchased_micros)).toBeVisible({
    timeout: 60_000,
  });
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
    owner,
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

  // Auto-reload turned on at the balance as threshold: the account is armed
  // (it starts so, and the top-up re-armed it), so the worker charges $10 to
  // the saved card at the top-up's rate. The paid reload leaves credits above
  // the threshold, which re-arms it; the tab shows the new balance by itself.
  const beforeReload = (await creditsRow(run, owner)).purchased_micros;
  const threshold = await thresholdNow(owner);
  expect(await setAutoReload(page, threshold)).toBe(true);
  const { invoice: reloadInvoice, reload } = await settledReload(run, owner, 0);
  expect(reload).toMatchObject({
    amount_cents: RELOAD_CENTS,
    reload_pm_id: afterTopUp.reload_pm_id,
    status: 'paid',
  });
  expect(reload.credits_micros * topUp.amount_cents).toBe(
    topUp.credits_micros * reload.amount_cents
  );
  const afterReload = await creditsRow(run, owner);
  expect(afterReload.reload_armed).toBe(true);
  expect(afterReload.purchased_micros - beforeReload).toBe(
    reload.credits_micros
  );
  await expect(purchasedLeft(page, afterReload.purchased_micros)).toBeVisible();
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
  expect(spentCents).toBe(topUp.amount_cents + reload.amount_cents);
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
    topUpInvoice,
    m.billing_invoice_kind_topup({}, zh),
    m.billing_invoice_status_paid({}, zh),
    m.billing_invoice_view({}, zh)
  );
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

test('a declined auto-reload retries; a top-up and a new card void it; a reload Stripe gave up on can still be paid, and its dispute takes the credits back', async ({
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
    workerRecorded: recordedFirst,
  });
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
  // next reload declines on the saved card. A manual top-up voids it,
  // re-arms auto-reload and keeps the saved card.
  await setAutoReload(page, await thresholdNow(owner));
  const { reload: second } = await declinedReload(run, owner, 1, since);
  expect(second.status).toBe('retrying');
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
  await completeCheckout(run, page, VISA);
  const topUp = await purchaseWhere(
    run,
    owner,
    'top-up credited',
    (p) => p.stripe_checkout_session_id === topUpSession.id
  );
  await expectVoided(run, owner, second);
  const afterTopUp = await creditsRow(run, owner);
  expect(afterTopUp.purchased_micros - beforeTopUp).toBe(topUp.credits_micros);
  expect(afterTopUp).toMatchObject({
    reload_armed: true,
    reload_pm_last4: '0341',
  });

  // Another declined reload at the new balance; a new card through Change
  // voids it, and the reload it re-arms charges the new card.
  await setAutoReload(page, await thresholdNow(owner));
  const { reload: third } = await declinedReload(run, owner, 2, since);
  expect(third.status).toBe('retrying');
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
  await expectVoided(run, owner, third);
  const { invoice: fourthInvoice, reload: fourth } = await settledReload(
    run,
    owner,
    3
  );
  expect(fourth).toMatchObject({
    reload_pm_id: newCard.reload_pm_id,
    status: 'paid',
  });
  expect((await creditsRow(run, owner)).purchased_micros).toBe(
    afterTopUp.purchased_micros + fourth.credits_micros
  );
  await processedEvent(
    run,
    'invoice.paid',
    since,
    (value) => value.id === fourth.stripe_invoice_id
  );
  await openSubscription(run, page);
  await expectInvoice(
    owner,
    fourthInvoice,
    m.billing_invoice_kind_reload(),
    m.billing_invoice_status_paid(),
    m.billing_invoice_view()
  );
  await run.attach('declined-reload-journey', {
    customerId,
    reloads: [first, second, third, fourth].map((p) => ({
      id: p.id,
      invoiceId: p.stripe_invoice_id,
    })),
    topUpId: topUp.id,
  });
});

test('spent to zero through the app: work at zero is refused, the request that finds zero with auto-reload on is admitted, a declined reload refuses work after its window, switching auto-reload off and on arms nothing, and a top-up re-arms it', async ({
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

  // A top-up (hosted Checkout, 4242) re-arms auto-reload and keeps the saved
  // card; credited past what is owed, work resumes, and with the threshold
  // at the new balance a reload starts.
  await openSubscription(run, page);
  const field = page.getByLabel(m.billing_top_up(), { exact: true });
  await field.fill('8');
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
  await completeCheckout(run, page, VISA);
  await purchaseWhere(
    run,
    owner,
    'top-up credited',
    (p) => p.stripe_checkout_session_id === topUpSession.id
  );
  expect(await creditsRow(run, owner)).toMatchObject({
    reload_armed: true,
    reload_pm_last4: '0341',
  });
  expect(availableOf(await billing(owner))).toBeGreaterThan(0);
  expectAnswered(await aiCommand(owner, workspaceId, ['Spend check.']));
  expect(await setAutoReload(page, await thresholdNow(owner))).toBe(true);
  const { reload: atThreshold } = await declinedReload(run, owner, 1, since);
  expect(atThreshold).toMatchObject({
    reload_pm_id: declined.reload_pm_id,
    status: 'retrying',
  });
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
