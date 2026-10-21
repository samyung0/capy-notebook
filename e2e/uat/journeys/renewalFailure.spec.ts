/* biome-ignore-all lint/suspicious/noMisplacedAssertion: The helpers execute only inside the journey. */
// A Pro renewal that fails (openwiki/authorization-permissions-lifecycles.md,
// "Renewals and failed payments"; deployment runbook §12.4): during Stripe's
// retries the subscription is past_due and keeps Pro with no banner, notice or
// mail; a retry that succeeds returns it to active; after the last failed
// retry Stripe cancels it (the sandbox's final action), the account drops to
// Free, grace counts 14 days from Stripe's ended_at, and the "Pro ended" mail
// goes out once. Three owners share one test clock started now, so Stripe's
// times run ahead of real time (grace never reaches frozen here): A stores
// more than the Free limit, B stores nothing, C recovers. All subscribe with
// 4242 through the API (as billing.spec.ts), then 0341's API PaymentMethod,
// which attaches but declines every charge, becomes their default. No hosted
// Checkout and no model call.
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { m } from '../../i18n';
import { api, fileRow, string, upload } from './files';
import { apiNote, notesWorkspace } from './note';
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
import { type Actor, expect, test, type UatRun } from './runtime';

const DAY = 86_400;
/** overQuotaBufferDays (server/internal/store/account_state.go). */
const GRACE_DAYS = 14;
/** Clock moves while Stripe retries the renewal before it gives up: each
 * move passes every retry due for A and B, so Stripe's retry count (Smart
 * Retries, at most 8) bounds it. */
const MAX_RETRY_STEPS = 12;

type Owner = {
  actor: Actor;
  label: string;
  customerId: string;
  subscriptionId: string;
  firstInvoiceId: string;
};

const me = async (actor: Actor) => object(await api(actor, '/api/me'));
const account = async (actor: Actor) => object((await me(actor)).account);

const subscriptionRow = (run: UatRun, subscriptionId: string) =>
  run.query<{ status: string; plan_tier: string; ended: number | null }>(
    `SELECT status,plan_tier,extract(epoch FROM ended_at)::bigint AS ended
    FROM user_subscriptions WHERE stripe_subscription_id=%s`,
    [subscriptionId]
  );

const waitForSubscription = (
  run: UatRun,
  owner: Owner,
  status: string,
  label: string
) =>
  run.poll(
    `${owner.label}: ${label}`,
    () => subscriptionRow(run, owner.subscriptionId),
    (rows) => rows[0]?.status === status,
    180_000
  );

const mails = async (run: UatRun, actor: Actor, template: string) =>
  (
    await run.query<{ sent: number }>(
      'SELECT count(*)::int AS sent FROM email_outbox WHERE user_id=%s AND template=%s',
      [actor.id, template]
    )
  )[0].sent;

/** The template's English subject, from its source. */
const subject = (template: string) =>
  object(
    JSON.parse(readFileSync(`emails/templates/${template}.en.json`, 'utf8'))
  ).subject;

const overQuotaNotices = async (actor: Actor) =>
  arrayField(await api(actor, '/api/notifications?limit=100'), 'items')
    .map(object)
    .filter((item) =>
      String(object(item.data ?? {}).code ?? '').startsWith('over_quota')
    );

const roomAccess = async (actor: Actor, materialId: string) =>
  string(
    object(
      await api(
        actor,
        `/api/materials/${materialId}/collaboration-token`,
        'POST',
        undefined,
        201
      )
    ).access
  );

const fileCap = async (actor: Actor, workspaceId: string) =>
  Number(
    object(
      await api(actor, `/api/source-upload-policy?workspaceId=${workspaceId}`)
    ).maxBytes
  );

/** The app's invoice for a Stripe invoice (Subscription tab data). */
async function appInvoice(actor: Actor, invoiceId: string) {
  const found = arrayField(await api(actor, '/api/billing/invoices'), 'items')
    .map(object)
    .find((item) => item.id === invoiceId);
  if (!found) throw new Error(`Invoice ${invoiceId} is not listed`);
  return found;
}

const shortDate = (seconds: number) =>
  new Date(seconds * 1000).toLocaleDateString('en', {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });

/** The Subscription tab's row of a Stripe invoice. Its hosted-page link is
 * signed anew on every read, so it cannot name the row: the tab lists
 * invoices in the order the app's API returns them, under one header row. */
async function expectInvoiceRow(
  run: UatRun,
  actor: Actor,
  invoice: Record<string, unknown>,
  status: string,
  link: string
) {
  await actor.page.goto(`${run.env.appUrl}/billing?tab=subscription`);
  const index = arrayField(await api(actor, '/api/billing/invoices'), 'items')
    .map(object)
    .findIndex((item) => item.id === invoice.id);
  expect(index, 'the invoice is listed').toBeGreaterThanOrEqual(0);
  const row = actor.page.getByRole('row').nth(index + 1);
  await expect(row).toContainText(m.billing_invoice_kind_plan());
  await expect(row).toContainText(status);
  await expect(row.getByRole('link')).toHaveText(link);
}

/** Hides the tab and shows it again, as switching windows does; /me is
 * refetched on that focus. Returns the fresh account. */
async function refocus(page: Page) {
  const refetched = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/me' &&
      response.request().method() === 'GET'
  );
  await page.evaluate(() => {
    for (const state of ['hidden', 'visible']) {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => state,
      });
      document.dispatchEvent(new Event('visibilitychange', { bubbles: true }));
    }
  });
  return object(object(await (await refetched).json()).account);
}

// Journey users never finish onboarding, so its modal dialog sits over the
// dashboard and hides the page behind it from the accessibility tree.
const banner = (page: Page, title: string) =>
  page.getByRole('status', { includeHidden: true }).filter({ hasText: title });

/** The dashboard, with /me fetched fresh (persisted queries can be minutes
 * old on load). */
async function dashboard(run: UatRun, page: Page) {
  await page.goto(run.env.appUrl);
  await expect(page.getByText(m.dashboard_learn_today())).toBeVisible();
  return refocus(page);
}

async function expectNoAccountBanner(run: UatRun, actor: Actor) {
  expect((await dashboard(run, actor.page)).state).toBe('active');
  for (const title of [
    m.account_banner_grace_title(),
    m.account_banner_frozen_title(),
  ])
    await expect(banner(actor.page, title)).toHaveCount(0);
}

/** Pro on the clock's customer, paid with 4242 (tok_visa); then the 0341
 * PaymentMethod, which attaches but declines, becomes the customer's and the
 * subscription's default, so the renewal and every retry fail. */
async function proThatWillDecline(
  run: UatRun,
  actor: Actor,
  clockId: string,
  label: string
): Promise<Owner> {
  const key = `${run.id}-${actor.id}-renewal`;
  const customerId = stringField(
    await stripeRequest(
      run.env,
      '/v1/customers',
      'POST',
      {
        email: actor.email,
        'metadata[capyUatRunId]': run.id,
        'metadata[user_id]': actor.id,
        source: 'tok_visa',
        test_clock: clockId,
      },
      `${key}-customer`
    ),
    'id'
  );
  await run.record('stripe-customer', customerId, {
    clockId,
    userId: actor.id,
  });
  const subscription = await stripeRequest(
    run.env,
    '/v1/subscriptions',
    'POST',
    {
      customer: customerId,
      'items[0][price]': run.env.stripePriceId,
      'metadata[capyUatRunId]': run.id,
      'metadata[user_id]': actor.id,
      payment_behavior: 'error_if_incomplete',
    },
    `${key}-subscription`
  );
  const subscriptionId = stringField(subscription, 'id');
  await run.record('stripe-subscription', subscriptionId, {
    clockId,
    customerId,
    userId: actor.id,
  });
  expect(subscription.status).toBe('active');
  const firstInvoiceId = stringField(subscription, 'latest_invoice');
  await run.record('stripe-invoice', firstInvoiceId, {
    customerId,
    retained: 'sandbox billing history',
    userId: actor.id,
  });
  const declining = stringField(
    await stripeRequest(
      run.env,
      '/v1/payment_methods/pm_card_chargeCustomerFail/attach',
      'POST',
      { customer: customerId },
      `${key}-declining-card`
    ),
    'id'
  );
  await stripeRequest(
    run.env,
    `/v1/customers/${customerId}`,
    'POST',
    { 'invoice_settings[default_payment_method]': declining },
    `${key}-customer-default`
  );
  await stripeRequest(
    run.env,
    `/v1/subscriptions/${subscriptionId}`,
    'POST',
    { default_payment_method: declining },
    `${key}-subscription-default`
  );
  const owner = { actor, customerId, firstInvoiceId, label, subscriptionId };
  await waitForSubscription(run, owner, 'active', 'Pro active');
  return owner;
}

/** Every Stripe event about these customers since `since`, oldest first. */
async function eventSequence(run: UatRun, since: number, owners: Owner[]) {
  const whose = new Map(owners.map((owner) => [owner.customerId, owner]));
  const events: Record<string, unknown>[] = [];
  let cursor = '';
  for (let page = 0; page < 30; page++) {
    const params = new URLSearchParams({
      'created[gte]': String(since),
      limit: '100',
    });
    if (cursor) params.set('starting_after', cursor);
    const result = await stripeRequest(run.env, `/v1/events?${params}`);
    const data = arrayField(result, 'data').map(object);
    for (const event of data) {
      const about = object(object(event.data).object);
      const customer =
        about.object === 'customer' ? about.id : (about.customer as unknown);
      const owner = whose.get(String(customer));
      if (owner)
        events.push({
          created: event.created,
          id: event.id,
          object: about.id,
          owner: owner.label,
          status: about.status,
          type: event.type,
        });
    }
    if (result.has_more !== true) break;
    cursor = stringField(data.at(-1), 'id');
  }
  return events.sort((a, b) => Number(a.created) - Number(b.created));
}

test('a failed Pro renewal keeps Pro while Stripe retries, recovers when paid, and after the last retry ends Pro with grace and one "Pro ended" mail', async ({
  run,
}) => {
  test.setTimeout(2_400_000);
  const price = await verifyStripeSandbox(run.env);
  expect(object(price.recurring)).toMatchObject({
    interval: 'month',
    interval_count: 1,
  });
  const since = Math.floor(Date.now() / 1000) - 300;
  const a = run.owner;
  const b = await run.createActor('renewal-b');
  const c = await run.createActor('renewal-c');

  // A's workspace and note; the Free limit while A is still on Free.
  const workspaceId = await notesWorkspace(run, 'renewal');
  const noteId = await apiNote(run, workspaceId, 'Renewal note');
  const freeLimit = Number((await account(a)).storageLimitBytes);

  // 1. Pro for A, B and C on one clock started now.
  const clockName = `capy-uat-${run.id}`;
  await run.record('stripe-clock-intent', clockName, { userId: a.id });
  const clockId = stringField(
    await stripeRequest(
      run.env,
      '/v1/test_helpers/test_clocks',
      'POST',
      { frozen_time: String(Math.floor(Date.now() / 1000)), name: clockName },
      `${run.id}-renewal-clock`
    ),
    'id'
  );
  await run.record('stripe-clock', clockId, {
    name: clockName,
    userId: a.id,
  });
  const ownerA = await proThatWillDecline(run, a, clockId, 'A');
  const ownerB = await proThatWillDecline(run, b, clockId, 'B');
  const ownerC = await proThatWillDecline(run, c, clockId, 'C');
  const owners = [ownerA, ownerB, ownerC];
  for (const { actor } of owners)
    expect(await me(actor)).toMatchObject({
      account: { state: 'active' },
      planTier: 'pro',
      subscriptionStatus: 'active',
    });
  // A stores more than the Free limit, store-only, in files under Pro's cap.
  const proFileCap = await fileCap(a, workspaceId);
  const proLimit = Number((await account(a)).storageLimitBytes);
  const fileSize = Math.floor(proFileCap * 0.85);
  const ballast: string[] = [];
  for (let index = 0; index <= Math.floor(freeLimit / fileSize); index++)
    ballast.push(
      await upload(
        run,
        workspaceId,
        `ballast-${index}.bin`,
        randomBytes(fileSize)
      )
    );
  expect(Number((await account(a)).storageUsedBytes)).toBeGreaterThan(
    freeLimit
  );
  // One "Pro started" mail each, and the plan invoice Paid.
  for (const { actor } of owners)
    expect(await mails(run, actor, 'subscription-started')).toBe(1);
  for (const sent of await Promise.all(
    owners.map(({ actor }) =>
      verifyOutboxDelivery(run, actor.id, actor.email, 'subscription-started')
    )
  ))
    expect(sent.subject).toBe(subject('subscription-started'));
  const firstInvoice = await stripeRequest(
    run.env,
    `/v1/invoices/${ownerA.firstInvoiceId}`
  );
  expect(firstInvoice.status).toBe('paid');
  await expectInvoiceRow(
    run,
    a,
    firstInvoice,
    m.billing_invoice_status_paid(),
    m.billing_invoice_view()
  );

  // 2. Past the period end (and Stripe's hour of finalization): the renewal
  // declines and Stripe retries. Everyone keeps Pro, past_due, with no
  // banner, notice or app mail; A still uploads and edits under Pro limits.
  const periodEnd = stripePeriodEnd(
    await stripeRequest(run.env, `/v1/subscriptions/${ownerA.subscriptionId}`)
  );
  await advanceStripeClock(run, clockId, periodEnd + 2 * 3600);
  const renewals = new Map<Owner, string>();
  for (const owner of owners) {
    const renewal = await run.poll(
      `${owner.label}: renewal declined, retrying`,
      async () => {
        const subscription = await stripeRequest(
          run.env,
          `/v1/subscriptions/${owner.subscriptionId}`
        );
        const invoiceId = stringField(subscription, 'latest_invoice');
        return {
          invoice: await stripeRequest(run.env, `/v1/invoices/${invoiceId}`),
          subscription,
        };
      },
      ({ invoice, subscription }) =>
        invoice.id !== owner.firstInvoiceId &&
        invoice.status === 'open' &&
        Number(invoice.next_payment_attempt) > 0 &&
        subscription.status === 'past_due',
      180_000
    );
    renewals.set(owner, stringField(renewal.invoice, 'id'));
    await run.record('stripe-invoice', stringField(renewal.invoice, 'id'), {
      customerId: owner.customerId,
      retained: 'sandbox billing history',
      userId: owner.actor.id,
    });
    await waitForSubscription(run, owner, 'past_due', 'past_due projected');
  }
  for (const { actor } of [ownerA, ownerB]) {
    expect(await me(actor)).toMatchObject({
      account: { state: 'active' },
      planTier: 'pro',
      subscriptionStatus: 'past_due',
    });
    await expectNoAccountBanner(run, actor);
    expect(await overQuotaNotices(actor)).toEqual([]);
    for (const template of ['subscription-over-quota', 'subscription-ended'])
      expect(await mails(run, actor, template)).toBe(0);
  }
  expect(await fileCap(a, workspaceId)).toBe(proFileCap);
  expect(Number((await account(a)).storageLimitBytes)).toBe(proLimit);
  const pastDueFile = await upload(
    run,
    workspaceId,
    'past-due.bin',
    randomBytes(1024)
  );
  expect((await fileRow(run, pastDueFile)).status).toBe('ready');
  expect(await roomAccess(a, noteId)).toBe('write');
  const retryingA = await stripeRequest(
    run.env,
    `/v1/invoices/${renewals.get(ownerA)}`
  );
  await expectInvoiceRow(
    run,
    a,
    retryingA,
    m.billing_invoice_status_retrying({
      date: shortDate(Number(retryingA.next_payment_attempt)),
    }),
    m.billing_invoice_pay()
  );
  const retryingB = await appInvoice(b, String(renewals.get(ownerB)));
  expect(retryingB).toMatchObject({ kind: 'plan', status: 'open' });
  expect(retryingB.nextAttemptAt).toBeTruthy();

  // 3a. C recovers: 4242 attached and the renewal paid. Active again, with
  // nothing to revert; C's open tab refetches /me when it regains focus.
  await c.page.goto(`${run.env.appUrl}/billing?tab=subscription`);
  const good = stringField(
    await stripeRequest(
      run.env,
      '/v1/payment_methods/pm_card_visa/attach',
      'POST',
      { customer: ownerC.customerId },
      `${run.id}-${c.id}-renewal-good-card`
    ),
    'id'
  );
  const paid = await stripeRequest(
    run.env,
    `/v1/invoices/${renewals.get(ownerC)}/pay`,
    'POST',
    { off_session: 'true', payment_method: good },
    `${run.id}-${c.id}-renewal-pay`
  );
  expect(paid.status).toBe('paid');
  await waitForSubscription(run, ownerC, 'active', 'recovered');
  expect(await refocus(c.page)).toMatchObject({
    planTier: 'pro',
    state: 'active',
  });
  expect(await me(c)).toMatchObject({ subscriptionStatus: 'active' });
  expect(await appInvoice(c, String(renewals.get(ownerC)))).toMatchObject({
    kind: 'plan',
    status: 'paid',
  });
  expect(await overQuotaNotices(c)).toEqual([]);
  expect(await mails(run, c, 'subscription-ended')).toBe(0);

  // 3b. A and B keep declining. The clock follows Stripe's own retry
  // schedule: each move passes the later of their next attempts (Smart
  // Retries times each invoice on its own), a day once none is left, until
  // Stripe cancels both after the last retry.
  const declining = [ownerA, ownerB];
  const steps: Record<string, unknown>[] = [];
  for (;;) {
    // One read at a time: three lanes share the sandbox's request rate, and
    // this loop's parallel reads met Stripe 429s in uat-quality.
    const subscriptions: Record<string, unknown>[] = [];
    const invoices: Record<string, unknown>[] = [];
    for (const owner of declining) {
      subscriptions.push(
        await stripeRequest(
          run.env,
          `/v1/subscriptions/${owner.subscriptionId}`
        )
      );
      invoices.push(
        await stripeRequest(run.env, `/v1/invoices/${renewals.get(owner)}`)
      );
    }
    const now = Number(
      (await stripeRequest(run.env, `/v1/test_helpers/test_clocks/${clockId}`))
        .frozen_time
    );
    steps.push({
      attempts: invoices.map((invoice) => invoice.attempt_count),
      clock: now,
      next: invoices.map((invoice) => invoice.next_payment_attempt),
      statuses: subscriptions.map((value) => value.status),
    });
    if (subscriptions.every((value) => value.status === 'canceled')) break;
    if (steps.length > MAX_RETRY_STEPS) {
      await run.attach('renewal-retry-steps', steps);
      throw new Error(
        `Stripe had not cancelled after ${MAX_RETRY_STEPS} clock moves`
      );
    }
    const next = invoices
      .map((invoice) => Number(invoice.next_payment_attempt))
      .filter((at) => at > 0);
    const target = next.length ? Math.max(...next) + 3600 : now + DAY;
    await advanceStripeClock(run, clockId, Math.max(target, now + 3600));
  }
  await run.attach('renewal-retry-steps', steps);
  for (const owner of declining) {
    const [row] = await waitForSubscription(
      run,
      owner,
      'canceled',
      'cancelled after the last retry'
    );
    const ended = Number(
      (
        await stripeRequest(
          run.env,
          `/v1/subscriptions/${owner.subscriptionId}`
        )
      ).ended_at
    );
    // The app's end is Stripe's.
    expect(row).toMatchObject({ ended, plan_tier: 'pro' });
    expect(await me(owner.actor)).toMatchObject({
      planTier: 'free',
      subscriptionStatus: 'canceled',
    });
    expect(
      await appInvoice(owner.actor, String(renewals.get(owner)))
    ).toMatchObject({ kind: 'plan', status: 'uncollectible' });
    expect(await mails(run, owner.actor, 'subscription-ended')).toBe(1);
    if (owner === ownerA) {
      const grace = await account(a);
      expect(grace).toMatchObject({
        planTier: 'free',
        state: 'over_quota_grace',
        storageLimitBytes: freeLimit,
      });
      expect(Date.parse(string(grace.graceEndsAt))).toBe(
        (ended + GRACE_DAYS * DAY) * 1000
      );
    }
  }
  for (const sent of await Promise.all(
    declining.map(({ actor }) =>
      verifyOutboxDelivery(run, actor.id, actor.email, 'subscription-ended')
    )
  ))
    expect(sent.subject).toBe(subject('subscription-ended'));
  const gaveUp = await stripeRequest(
    run.env,
    `/v1/invoices/${renewals.get(ownerA)}`
  );
  await expectInvoiceRow(
    run,
    a,
    gaveUp,
    m.billing_invoice_status_failed(),
    m.billing_invoice_view()
  );
  // A in grace: the banner, content view-only, organizing still allowed.
  expect((await dashboard(run, a.page)).state).toBe('over_quota_grace');
  await expect(banner(a.page, m.account_banner_grace_title())).toBeVisible();
  expect(await roomAccess(a, noteId)).toBe('read');
  const growth = await a.request(
    `/api/workspaces/${workspaceId}/materials`,
    'POST',
    { kind: 'note', title: 'Grace growth' }
  );
  expect(growth.status).toBe(403);
  expect(object(arrayField(growth.body, 'errors')[0]).message).toBe(
    'storage_quota_exceeded'
  );
  await api(a, `/api/files/${ballast[0]}`, 'PATCH', {
    name: 'ballast-kept.bin',
  });
  await api(a, `/api/files/${pastDueFile}`, 'DELETE', undefined, 204);
  expect((await account(a)).state).toBe('over_quota_grace');
  // B, under the Free limit, is simply on Free.
  expect((await account(b)).state).toBe('active');
  await expectNoAccountBanner(run, b);
  expect(await overQuotaNotices(b)).toEqual([]);
  expect(await mails(run, b, 'subscription-over-quota')).toBe(0);

  // 5. A resubscribes with 4242: Pro and active again, the banner gone on
  // the next focus, and a new "Pro started" mail for the new subscription.
  const visa = stringField(
    await stripeRequest(
      run.env,
      '/v1/payment_methods/pm_card_visa/attach',
      'POST',
      { customer: ownerA.customerId },
      `${run.id}-${a.id}-resubscribe-card`
    ),
    'id'
  );
  const again = await stripeRequest(
    run.env,
    '/v1/subscriptions',
    'POST',
    {
      customer: ownerA.customerId,
      default_payment_method: visa,
      'items[0][price]': run.env.stripePriceId,
      'metadata[capyUatRunId]': run.id,
      'metadata[user_id]': a.id,
      payment_behavior: 'error_if_incomplete',
    },
    `${run.id}-${a.id}-resubscribe`
  );
  const againId = stringField(again, 'id');
  await run.record('stripe-subscription', againId, {
    clockId,
    customerId: ownerA.customerId,
    userId: a.id,
  });
  expect(again.status).toBe('active');
  await waitForSubscription(
    run,
    { ...ownerA, subscriptionId: againId },
    'active',
    'resubscribed'
  );
  expect(await refocus(a.page)).toMatchObject({
    planTier: 'pro',
    state: 'active',
  });
  await expect(banner(a.page, m.account_banner_grace_title())).toBeHidden();
  await run.poll(
    'second "Pro started" mail queued',
    () => mails(run, a, 'subscription-started'),
    (sent) => sent === 2,
    120_000
  );
  expect(
    (await verifyOutboxDelivery(run, a.id, a.email, 'subscription-started'))
      .subject
  ).toBe(subject('subscription-started'));

  // The over-quota sweep runs hourly, so its notice may or may not have come
  // during the journey: at most one for A, none for B or C, and A's stays as
  // history after the recovery.
  const notices = await overQuotaNotices(a);
  expect(notices.length).toBeLessThanOrEqual(1);
  expect(await mails(run, a, 'subscription-over-quota')).toBeLessThanOrEqual(1);
  for (const actor of [b, c]) expect(await overQuotaNotices(actor)).toEqual([]);
  await run.attach('subscription-failure-events', {
    events: await eventSequence(run, since, owners),
    overQuotaNoticeBeforeEnd: notices.length === 1,
  });
  await cleanupStripeTestClock(run.env, clockId, run.id);
});
