/* biome-ignore-all lint/suspicious/noMisplacedAssertion: The helpers execute only inside the journey. */
// Shared steps of the credits journeys (credits.spec.ts in the billing lane,
// creditsManual.spec.ts by hand): the ledger reads, the Subscription tab's
// dialogs, Stripe's hosted Checkout, Stripe events and the editor AI command
// that spends credits.
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Locator, Page } from '@playwright/test';
import { m } from '../../i18n';
import {
  arrayField,
  claimStripeCustomer,
  object,
  stringField,
  stripeRequest,
} from './providers';
import { type Actor, expect, type UatRun } from './runtime';

/** One credit in the ledger's micros. */
export const MICROS = 1_000_000;
/** Stripe test cards (docs.stripe.com/testing): 0341 attaches, but every
 * charge on it declines. */
export const VISA = '4242424242424242';
export const DECLINES = '4000000000000341';
/** The auto-reload amount every journey saves: $10. */
export const RELOAD_CENTS = 1000;
/** The top-up every journey asks for: $8, the smallest allowed. */
export const TOP_UP_CENTS = 800;
export const zh = { locale: 'zh' } as const;
export type Locale = typeof zh | undefined;

export type Purchase = {
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

export type Credits = {
  purchased_micros: number;
  reload_armed: boolean;
  reload_pm_id: string | null;
  reload_pm_last4: string | null;
  spending_limit_cents: number | null;
  reload_skipped_at: string | null;
};

export const purchases = (run: UatRun, actor: Actor) =>
  run.query<Purchase>(
    'SELECT id,kind,status,amount_cents,credits_micros,stripe_checkout_session_id,stripe_invoice_id,stripe_payment_intent_id,next_attempt_at,decline_reason,refunded_micros,disputed_micros,reload_pm_id,created_at,paid_at FROM credit_purchases WHERE user_id=%s ORDER BY created_at',
    [actor.id]
  );

export async function creditsRow(run: UatRun, actor: Actor) {
  const rows = await run.query<Credits>(
    'SELECT purchased_micros,reload_armed,reload_pm_id,reload_pm_last4,spending_limit_cents,reload_skipped_at FROM user_credits WHERE user_id=%s',
    [actor.id]
  );
  expect(rows.length).toBe(1);
  return rows[0];
}

export async function purchaseWhere(
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

export const reloadCount = async (run: UatRun, actor: Actor) =>
  (await purchases(run, actor)).filter((p) => p.kind === 'reload').length;

export const invoiceId = (purchase: Purchase) => {
  if (!purchase.stripe_invoice_id)
    throw new Error(`Purchase ${purchase.id} has no Stripe invoice`);
  return purchase.stripe_invoice_id;
};

/** The `index`th auto-reload once its charge has an outcome, and its invoice
 * (kept as sandbox history). */
export async function settledReload(run: UatRun, actor: Actor, index: number) {
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
 * processed. A decline stays `charging` until Stripe schedules its retry (or
 * gives up), so `recordedFirst`, the first status after charging, is already
 * Stripe's decision.
 */
export async function declinedReload(
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

export async function billing(actor: Actor) {
  const response = await actor.request('/api/billing');
  expect(response.status).toBe(200);
  return object(response.body);
}

/** What the gate admits against: the allowance left plus purchased credits,
 * less reservations. */
export const availableOf = (b: Record<string, unknown>) =>
  Math.max(Number(b.creditsLimitMicros) - Number(b.creditsUsedMicros), 0) +
  Number(b.creditsPurchasedMicros) -
  Number(b.creditsReservedMicros);

/** The balance in whole credits rounded up. A reload threshold at it makes
 * the reload worker (every 5 s) start a reload. */
export const thresholdNow = async (actor: Actor) =>
  Math.ceil(availableOf(await billing(actor)) / MICROS);

export const sleep = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

export const nested = (value: unknown, key: string) =>
  value && typeof value === 'object'
    ? (value as Record<string, unknown>)[key]
    : undefined;

// The app's English display formats (src/features/billing/format.ts and
// creditLabels.ts).
export const credits = (micros: number) => {
  const value = micros / MICROS;
  return value.toLocaleString('en', {
    maximumFractionDigits: value >= 10 ? 0 : 1,
  });
};
export const dollars = (cents: number) =>
  new Intl.NumberFormat('en', {
    currency: 'USD',
    maximumFractionDigits: cents % 100 ? 2 : 0,
    minimumFractionDigits: cents % 100 ? 2 : 0,
    style: 'currency',
  }).format(cents / 100);
export const money = (cents: number) =>
  new Intl.NumberFormat('en', { currency: 'USD', style: 'currency' }).format(
    cents / 100
  );
export const shortDate = (date: Date) =>
  date.toLocaleDateString('en', {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
export const visa = (last4: string) =>
  m.billing_payment_card({ brand: 'Visa', last4 });

/** The skipped-reload mail's subject, from its template source. */
export const skippedSubject = (locale: string) =>
  object(
    JSON.parse(
      readFileSync(
        `emails/templates/credit-reload-skipped.${locale}.json`,
        'utf8'
      )
    )
  ).subject;

export async function openSubscription(
  run: UatRun,
  page: Page,
  locale?: Locale
) {
  await page.goto(
    new URL('/billing?tab=subscription', run.env.appUrl).toString()
  );
  await expect(
    page.getByText(m.billing_buy_credits({}, locale), { exact: true })
  ).toBeVisible();
}

export const notice = (page: Page, title: string) =>
  page.getByRole('status').filter({ hasText: title });

/** The Invoices row of a Stripe invoice. Its hosted-page link is signed anew
 * on every read, so it cannot name the row: the tab lists invoices in the
 * order the app's API returns them, under one header row. */
export async function expectInvoice(
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
export async function save(
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
export async function saveAutoReload(page: Page, threshold: number) {
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
export async function setAutoReload(page: Page, threshold: number) {
  const toggle = page.getByRole('switch', { name: m.billing_auto_reload() });
  if (await toggle.isChecked())
    await page
      .getByRole('button', { exact: true, name: m.action_edit() })
      .click();
  else await toggle.click();
  return saveAutoReload(page, threshold);
}

export async function switchAutoReloadOff(page: Page) {
  const saved = page.waitForResponse(
    (r) =>
      r.url().endsWith('/api/billing/auto-reload') &&
      r.request().method() === 'PUT'
  );
  await page.getByRole('switch', { name: m.billing_auto_reload() }).click();
  expect((await saved).status()).toBe(200);
}

/** Buy credits' balance line, which shows the purchased balance. */
export const purchasedLeft = (page: Page, micros: number) =>
  page.getByText(m.billing_purchased_left({ amount: credits(micros) }));

export async function setLimit(
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
export async function startCheckout(
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
 * here: they have no API equivalent. Headless, payment Checkout stops on
 * Stripe's hCaptcha challenge, so top-ups run by hand (creditsManual.spec.ts,
 * headed, with time for a person to answer it).
 */
export async function completeCheckout(
  run: UatRun,
  page: Page,
  card: string,
  returnTimeout = 90_000
) {
  await page.waitForURL(/^https:\/\/checkout\.stripe\.com\//);
  const number = page.locator('#cardNumber');
  // With Link enabled the card form can sit behind its accordion item.
  const cardItem = page.getByTestId('card-accordion-item-button');
  try {
    await expect(number.or(cardItem).first()).toBeVisible({ timeout: 60_000 });
  } catch (error) {
    // A customer with saved cards gets another layout; name what is there.
    await run.attach('checkout-without-card-form', {
      buttons: await page.getByRole('button').allInnerTexts(),
      captchaFrames: await page.locator('iframe[src*="hcaptcha"]').count(),
      testIds: await page
        .locator('[data-testid]')
        .evaluateAll((nodes) =>
          nodes.map((node) => node.getAttribute('data-testid'))
        ),
    });
    throw error;
  }
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
    // Stripe's address suggestions can arrive after any key that would close
    // them and then cover the form below, Link's opt-in among it. Choosing one
    // closes the list; it may fill the fields below as well.
    const suggestion = page.locator('.AddressAutocomplete-result').first();
    const listed = await suggestion
      .waitFor({ timeout: 5000 })
      .then(() => true)
      .catch(() => false);
    if (listed) await suggestion.click();
    const city = page.locator('#billingLocality');
    if (!(await city.inputValue())) await city.fill('New York');
    const state = page.locator('#billingAdministrativeArea');
    if (!(await state.inputValue())) await state.selectOption('NY');
  }
  if (!(await postal.inputValue())) await postal.fill('10001');
  // Link's opt-in would ask for a phone number.
  const link = page.locator('#enableStripePass');
  if ((await link.count()) > 0 && (await link.isChecked()))
    await link.uncheck();
  const submit = page.getByTestId('hosted-payment-submit-button');
  await expect(submit).toBeEnabled();
  const returned = page
    .waitForURL(/\/billing\?tab=subscription/, { timeout: returnTimeout })
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
export async function processedEvent(
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
export async function expectVoided(
  run: UatRun,
  actor: Actor,
  reload: Purchase
) {
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
export const MAX_SPEND_CALLS = 45;

/** About 180,000 characters of random words: a fresh, uncached prompt within
 * the editor's 200,000-character context (pipeline ai_adapter.py). */
export const bigContext = () =>
  Array.from({ length: 20 }, () =>
    randomBytes(6000)
      .toString('base64url')
      .replace(/(.{7})/g, '$1 ')
  );

export type AIAnswer = {
  status: number;
  body: unknown;
  events: Record<string, unknown>[];
};

/**
 * One editor AI command (Generate over `paragraphs`), as the note editor
 * sends it. A 429 or a busy provider is waited out as it asks and sent again,
 * which only paces the spend.
 */
export async function aiCommand(
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

export function expectAnswered(answer: AIAnswer) {
  expect(answer.status).toBe(200);
  expect(answer.events.filter((event) => event.type === 'error')).toEqual([]);
  expect(answer.events.some((event) => event.type === 'finish')).toBe(true);
}

export function expectRefusedAtZero(answer: AIAnswer) {
  expect(answer.status).toBe(403);
  expect(object(answer.body).code).toBe('llm_credits_exhausted');
}

export type EditorModel = {
  provider_slug: string;
  model_slug: string;
  micros_per_input_token: number;
  micros_per_output_token: number;
};

/** The editor model the account may use with the highest input rate in the
 * catalog: the fewest calls spend a balance. */
export async function costliestEditorModel(run: UatRun, actor: Actor) {
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
