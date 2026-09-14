import { expect } from '@playwright/test';
import {
  arrayField,
  claimStripeCustomer,
  cleanupStripeTestClock,
  expireStripeCheckout,
  object,
  stringField,
  stripeRequest,
  verifyStripeSandbox,
} from './providers';
import { type Actor, test, type UatRun } from './runtime';

async function subscriptionProjection(
  run: UatRun,
  actor: Actor,
  subscriptionId: string,
  status: string,
  plan: string
) {
  return run.poll(
    `Stripe ${status} webhook projection`,
    () =>
      run.query<{
        status: string;
        plan_tier: string;
        stripe_customer_id: string;
        cancel_at_period_end: boolean;
        current_period_end: string;
      }>(
        `SELECT s.status,u.plan_tier,u.stripe_customer_id,s.cancel_at_period_end,s.current_period_end
      FROM user_subscriptions s JOIN users u ON u.id=s.user_id
      WHERE s.stripe_subscription_id=%s AND u.id=%s`,
        [subscriptionId, actor.id]
      ),
    (rows) =>
      rows.length === 1 &&
      rows[0].status === status &&
      rows[0].plan_tier === plan,
    120_000
  );
}

function periodEnd(subscription: Record<string, unknown>) {
  const item = object(arrayField(subscription.items, 'data')[0]);
  if (typeof item.current_period_end !== 'number')
    throw new Error('Stripe subscription item omitted current_period_end');
  return item.current_period_end;
}

async function advanceClock(run: UatRun, clockId: string, timestamp: number) {
  await stripeRequest(
    run.env,
    `/v1/test_helpers/test_clocks/${clockId}/advance`,
    'POST',
    { frozen_time: String(timestamp) },
    `${run.id}-${clockId}-${timestamp}`
  );
  await run.poll(
    'Stripe clock ready',
    () => stripeRequest(run.env, `/v1/test_helpers/test_clocks/${clockId}`),
    (clock) => clock.status === 'ready',
    120_000
  );
}

test('application Checkout creates the exact sandbox session and reservation', async ({
  run,
}) => {
  await verifyStripeSandbox(run.env);
  const actor = run.owner;
  const checkout = await actor.request('/api/billing/checkout', 'POST', {
    planTier: 'pro',
  });
  expect(checkout.status).toBe(200);
  const url = stringField(checkout.body, 'url');
  const rows = await run.query<{
    id: string;
    provider_session_id: string;
    customer_id: string;
    price_id: string;
    status: string;
    success_url: string;
    cancel_url: string;
  }>(
    'SELECT id,provider_session_id,customer_id,price_id,status,success_url,cancel_url FROM stripe_checkout_sessions WHERE user_id=%s ORDER BY created_at DESC LIMIT 1',
    [actor.id]
  );
  expect(rows.length).toBe(1);
  const row = rows[0];
  await run.record('stripe-checkout', row.provider_session_id, {
    customerId: row.customer_id,
    reservationId: row.id,
    userId: actor.id,
  });
  await claimStripeCustomer(run, row.customer_id, actor.id);
  const session = await stripeRequest(
    run.env,
    `/v1/checkout/sessions/${row.provider_session_id}?expand%5B%5D=line_items`
  );
  expect(session.livemode).toBe(false);
  expect(session.mode).toBe('subscription');
  expect(session.status).toBe('open');
  expect(session.url === url).toBe(true);
  expect(session.customer).toBe(row.customer_id);
  expect(session.metadata).toMatchObject({
    checkout_reservation_id: row.id,
    user_id: actor.id,
  });
  expect(row.price_id).toBe(run.env.stripePriceId);
  expect(row.status).toBe('open');
  const returnURL = `${run.env.appUrl.replace(/\/$/, '')}/settings?tab=subscription`;
  expect(session.success_url).toBe(returnURL);
  expect(session.cancel_url).toBe(returnURL);
  expect(row.success_url).toBe(returnURL);
  expect(row.cancel_url).toBe(returnURL);
  const lineItems = arrayField(session.line_items, 'data');
  expect(lineItems.length).toBe(1);
  expect(object(object(lineItems[0]).price).id).toBe(run.env.stripePriceId);
  expect(object(lineItems[0]).quantity).toBe(1);
  // Do not drive hosted Checkout. Expiration is a supported provider API action.
  await expireStripeCheckout(
    run.env,
    row.provider_session_id,
    run.id,
    actor.id
  );
  expect(
    (
      await stripeRequest(
        run.env,
        `/v1/checkout/sessions/${row.provider_session_id}`
      )
    ).status
  ).toBe('expired');
  await run.attach('checkout', {
    customerId: row.customer_id,
    hostedPaymentCompletion: 'excluded',
    reservationId: row.id,
    sessionCreated: true,
    sessionId: row.provider_session_id,
  });
});

test('sandbox paid subscription, renewal, deletion blocker and cancellation converge through webhooks', async ({
  run,
}) => {
  await verifyStripeSandbox(run.env);
  const actor = await run.createActor('billing');
  const clockName = `capy-uat-${run.id}`;
  await run.record('stripe-clock-intent', clockName, { userId: actor.id });
  const clock = await stripeRequest(
    run.env,
    '/v1/test_helpers/test_clocks',
    'POST',
    { frozen_time: String(Math.floor(Date.now() / 1000)), name: clockName },
    `${run.id}-clock`
  );
  const clockId = stringField(clock, 'id');
  await run.record('stripe-clock', clockId, {
    name: clockName,
    userId: actor.id,
  });
  // A separate actor has no app-created customer. The subscription webhook binds its metadata identity.
  const customer = await stripeRequest(
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
    `${run.id}-${actor.id}-customer`
  );
  const customerId = stringField(customer, 'id');
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
    `${run.id}-${actor.id}-subscription`
  );
  const subscriptionId = stringField(subscription, 'id');
  await run.record('stripe-subscription', subscriptionId, {
    clockId,
    customerId,
    userId: actor.id,
  });
  expect(subscription.status).toBe('active');
  expect(subscription.livemode).toBe(false);
  const initial = await subscriptionProjection(
    run,
    actor,
    subscriptionId,
    'active',
    'pro'
  );
  expect(initial[0].stripe_customer_id).toBe(customerId);
  const preflight = await actor.request('/api/account/deletion');
  expect(preflight.status).toBe(200);
  const blocked = object(preflight.body);
  expect(blocked.canDelete).toBe(false);
  expect(object(blocked.subscription).stripeSubscriptionId).toBe(
    subscriptionId
  );
  const refused = await actor.request('/api/account/deletion', 'POST', {
    confirmEmail: actor.email,
    lifecycleGeneration: blocked.lifecycleGeneration,
  });
  expect(refused.status).toBe(409);
  expect(
    (
      await run.query<{ deletion_requested_at: string | null }>(
        'SELECT deletion_requested_at FROM users WHERE id=%s',
        [actor.id]
      )
    )[0].deletion_requested_at
  ).toBeNull();
  expect(
    (await actor.request('/api/billing/checkout', 'POST', { planTier: 'pro' }))
      .status
  ).toBe(409);

  const firstEnd = periodEnd(subscription);
  await advanceClock(run, clockId, firstEnd + 1);
  const renewed = await run.poll(
    'paid renewal',
    async () => {
      const current = await stripeRequest(
        run.env,
        `/v1/subscriptions/${subscriptionId}`
      );
      return { end: periodEnd(current), subscription: current };
    },
    (value) => value.subscription.status === 'active' && value.end > firstEnd,
    120_000
  );
  const invoiceId = stringField(renewed.subscription, 'latest_invoice');
  await run.record('stripe-invoice', invoiceId, {
    customerId,
    retained: 'sandbox billing history',
    userId: actor.id,
  });
  // Renewal first creates a draft invoice. Move the frozen clock through
  // Stripe's one-hour finalization window before waiting for collection.
  await advanceClock(run, clockId, firstEnd + 3601);
  const invoice = await run.poll(
    'renewal invoice paid',
    () => stripeRequest(run.env, `/v1/invoices/${invoiceId}`),
    (value) => value.status === 'paid',
    120_000
  );
  expect(invoice.customer).toBe(customerId);
  expect(invoice.livemode).toBe(false);
  await run.poll(
    'renewed application period',
    () => subscriptionProjection(run, actor, subscriptionId, 'active', 'pro'),
    (rows) => Date.parse(rows[0].current_period_end) / 1000 === renewed.end,
    120_000
  );

  await stripeRequest(
    run.env,
    `/v1/subscriptions/${subscriptionId}`,
    'POST',
    { cancel_at_period_end: 'true' },
    `${run.id}-${subscriptionId}-cancel-period`
  );
  await run.poll(
    'period-end cancellation webhook',
    () => subscriptionProjection(run, actor, subscriptionId, 'active', 'pro'),
    (rows) => rows[0].cancel_at_period_end,
    120_000
  );
  const allowed = await actor.request('/api/account/deletion');
  expect(allowed.status).toBe(200);
  expect(object(allowed.body).canDelete).toBe(true);
  await advanceClock(run, clockId, renewed.end + 1);
  await subscriptionProjection(run, actor, subscriptionId, 'canceled', 'free');
  const receipts = await run.poll(
    'subscription webhook receipts',
    () =>
      run.query<{ id: string; event_type: string; error: string | null }>(
        "SELECT id,event_type,error FROM webhook_events WHERE source='stripe' AND user_id=%s AND processed_at IS NOT NULL AND event_type IN ('customer.subscription.created','customer.subscription.updated','customer.subscription.deleted')",
        [actor.id]
      ),
    (rows) =>
      [
        'customer.subscription.created',
        'customer.subscription.updated',
        'customer.subscription.deleted',
      ].every((type) =>
        rows.some((row) => row.event_type === type && row.error === null)
      ),
    120_000
  );
  await run.attach('billing-lifecycle', {
    clockId,
    customerId,
    databaseTimeAdvanced: false,
    deletionBlocked: true,
    finalPlan: 'free',
    invoiceId,
    receiptIds: receipts.map((row) => row.id),
    renewalPaid: true,
    subscriptionId,
  });
  await cleanupStripeTestClock(run.env, clockId, run.id);
});
