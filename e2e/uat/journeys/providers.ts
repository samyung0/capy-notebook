import { expect } from '@playwright/test';
import type { UatEnvironment, UatRun } from './runtime';

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected an object response');
  return value as Record<string, unknown>;
}
export function stringField(value: unknown, key: string) {
  const field = object(value)[key];
  if (typeof field !== 'string' || !field)
    throw new Error(`Missing response field ${key}`);
  return field;
}
export function arrayField(value: unknown, key: string): unknown[] {
  const field = object(value)[key];
  if (!Array.isArray(field)) throw new Error(`Missing response array ${key}`);
  return field;
}

class ProviderError extends Error {
  readonly status: number;
  constructor(provider: string, status: number, code = '') {
    super(`${provider} request failed (${status}${code ? `, ${code}` : ''})`);
    this.status = status;
  }
}

/** A Stripe error's type and code (e.g. `rate_limit`, `lock_timeout`), never
 * its message or the rest of the body. Empty for other providers. */
async function errorCode(provider: string, response: Response) {
  if (provider !== 'Stripe') return '';
  const body = (await response.json().catch(() => ({}))) as {
    error?: { code?: unknown; type?: unknown };
  };
  return [body.error?.type, body.error?.code]
    .filter((part) => typeof part === 'string' && /^[a-z_]{1,64}$/.test(part))
    .join('/');
}

async function providerJSON(url: URL, init: RequestInit, provider: string) {
  const response = await fetch(url, {
    ...init,
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  });
  // Provider bodies can contain addresses, tokens and signed links. Keep errors
  // bounded to the status and, for Stripe, its error type and code.
  if (!response.ok)
    throw new ProviderError(
      provider,
      response.status,
      await errorCode(provider, response)
    );
  return {
    body: (await response.json().catch(() => {
      throw new Error(`${provider} returned invalid JSON`);
    })) as unknown,
    headers: response.headers,
  };
}

export async function stripeRequest(
  env: UatEnvironment,
  path: string,
  method = 'GET',
  fields?: Record<string, string>,
  idempotencyKey?: string
) {
  if (
    !env.stripeSecretKey.startsWith('sk_test_') ||
    !env.stripeAccountId.startsWith('acct_')
  )
    throw new Error(
      'Stripe UAT requires a test secret and expected sandbox account ID'
    );
  if (!path.startsWith('/v1/')) throw new Error('Invalid Stripe API path');
  const url = new URL(path, 'https://api.stripe.com');
  const headers: Record<string, string> = {
    Authorization: `Bearer ${env.stripeSecretKey}`,
    'Stripe-Version': '2025-03-31.basil',
  };
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  const body = fields ? new URLSearchParams(fields) : undefined;
  if (body) headers['Content-Type'] = 'application/x-www-form-urlencoded';
  return object(
    (await providerJSON(url, { body, headers, method }, 'Stripe')).body
  );
}

async function verifyStripeAccount(env: UatEnvironment) {
  const account = await stripeRequest(env, '/v1/account');
  if (account.id !== env.stripeAccountId)
    throw new Error(
      'Stripe credential belongs to a different account than the UAT sandbox'
    );
}

export async function verifyStripeSandbox(env: UatEnvironment) {
  await verifyStripeAccount(env);
  const price = await stripeRequest(
    env,
    `/v1/prices/${encodeURIComponent(env.stripePriceId)}`
  );
  if (price.livemode !== false || price.active !== true || !price.recurring)
    throw new Error(
      'UAT Stripe price is not an active sandbox recurring price'
    );
  return price;
}

/** The current period end, on the subscription item in this API version. */
export function stripePeriodEnd(subscription: Record<string, unknown>) {
  const item = object(arrayField(subscription.items, 'data')[0]);
  if (typeof item.current_period_end !== 'number')
    throw new Error('Stripe subscription item omitted current_period_end');
  return item.current_period_end;
}

/** Moves a test clock to `timestamp` and waits until Stripe has caught up. */
export async function advanceStripeClock(
  run: UatRun,
  clockId: string,
  timestamp: number
) {
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

export async function claimStripeCustomer(
  run: UatRun,
  customerId: string,
  userId: string
) {
  const customer = await stripeRequest(
    run.env,
    `/v1/customers/${encodeURIComponent(customerId)}`
  );
  if (
    customer.livemode !== false ||
    object(customer.metadata).user_id !== userId
  )
    throw new Error('Stripe customer is not owned by the expected UAT actor');
  const existingRun = object(customer.metadata).capyUatRunId;
  if (existingRun !== undefined && existingRun !== run.id)
    throw new Error('Stripe customer already belongs to another UAT run');
  await run.record('stripe-customer', customerId, { userId });
  await stripeRequest(
    run.env,
    `/v1/customers/${encodeURIComponent(customerId)}`,
    'POST',
    { 'metadata[capyUatRunId]': run.id },
    `${run.id}-${customerId}-claim`
  );
}

async function ownedCustomer(
  env: UatEnvironment,
  customerId: string,
  runId: string,
  userId: string
) {
  const customer = await stripeRequest(
    env,
    `/v1/customers/${encodeURIComponent(customerId)}`
  );
  if (customer.deleted === true) return customer;
  const metadata = object(customer.metadata);
  if (
    customer.livemode !== false ||
    metadata.capyUatRunId !== runId ||
    metadata.user_id !== userId
  )
    throw new Error(
      'Refusing Stripe cleanup: customer ownership does not match manifest'
    );
  return customer;
}

export async function expireStripeCheckout(
  env: UatEnvironment,
  sessionId: string,
  runId: string,
  userId: string
) {
  await verifyStripeAccount(env);
  const session = await stripeRequest(
    env,
    `/v1/checkout/sessions/${encodeURIComponent(sessionId)}`
  );
  if (session.livemode !== false || object(session.metadata).user_id !== userId)
    throw new Error('Refusing Stripe Checkout cleanup: session actor mismatch');
  await ownedCustomer(env, stringField(session, 'customer'), runId, userId);
  if (session.status === 'open')
    await stripeRequest(
      env,
      `/v1/checkout/sessions/${encodeURIComponent(sessionId)}/expire`,
      'POST',
      {},
      `${runId}-${sessionId}-expire`
    );
}

/** Every object of a Stripe list endpoint with `status`, scoped to the exact
 * manifest-owned customer (clock customers included). */
async function customerObjects(
  env: UatEnvironment,
  path: string,
  customerId: string,
  status: string
) {
  const objects: Record<string, unknown>[] = [];
  let cursor = '';
  for (;;) {
    const params = new URLSearchParams({
      customer: customerId,
      limit: '100',
      status,
    });
    if (cursor) params.set('starting_after', cursor);
    const page = await stripeRequest(env, `${path}?${params}`);
    const data = arrayField(page, 'data').map(object);
    for (const item of data)
      if (item.customer !== customerId || item.livemode !== false)
        throw new Error('Stripe cleanup ownership mismatch');
    objects.push(...data);
    if (page.has_more !== true) return objects;
    cursor = stringField(data.at(-1), 'id');
  }
}

export async function cleanupStripeCustomer(
  env: UatEnvironment,
  customerId: string,
  runId: string,
  userId: string
) {
  await verifyStripeAccount(env);
  let customer: Record<string, unknown>;
  try {
    customer = await ownedCustomer(env, customerId, runId, userId);
  } catch (error) {
    if (error instanceof ProviderError && error.status === 404) return;
    throw error;
  }
  if (customer.deleted === true) return;
  // Credit top-ups and card saving leave hosted Checkout sessions open.
  for (const session of await customerObjects(
    env,
    '/v1/checkout/sessions',
    customerId,
    'open'
  ))
    await stripeRequest(
      env,
      `/v1/checkout/sessions/${stringField(session, 'id')}/expire`,
      'POST',
      {}
    );
  for (const subscription of await customerObjects(
    env,
    '/v1/subscriptions',
    customerId,
    'all'
  ))
    if (
      !['canceled', 'incomplete_expired'].includes(
        stringField(subscription, 'status')
      )
    )
      await stripeRequest(
        env,
        `/v1/subscriptions/${stringField(subscription, 'id')}`,
        'DELETE'
      );
  // Auto-reload invoices Stripe still retries, or that could still be paid.
  for (const status of ['draft', 'open', 'uncollectible'])
    for (const invoice of await customerObjects(
      env,
      '/v1/invoices',
      customerId,
      status
    ))
      await stripeRequest(
        env,
        status === 'draft'
          ? `/v1/invoices/${stringField(invoice, 'id')}`
          : `/v1/invoices/${stringField(invoice, 'id')}/void`,
        status === 'draft' ? 'DELETE' : 'POST',
        status === 'draft' ? undefined : {}
      );
  await stripeRequest(
    env,
    `/v1/customers/${encodeURIComponent(customerId)}`,
    'DELETE'
  );
}

export async function cleanupStripeTestClock(
  env: UatEnvironment,
  clockId: string,
  runId: string
) {
  await verifyStripeAccount(env);
  let clock: Record<string, unknown>;
  try {
    clock = await stripeRequest(
      env,
      `/v1/test_helpers/test_clocks/${encodeURIComponent(clockId)}`
    );
  } catch (error) {
    if (error instanceof ProviderError && error.status === 404) return;
    throw error;
  }
  if (clock.name !== `capy-uat-${runId}` || clock.livemode !== false)
    throw new Error('Refusing Stripe clock cleanup: run identity mismatch');
  await stripeRequest(
    env,
    `/v1/test_helpers/test_clocks/${encodeURIComponent(clockId)}`,
    'DELETE'
  );
}

// Email Routing hands mail for the actors' inbox domain to the UAT inbox Worker
// (workers/uat-inbox), which keeps each message for a day.
const UAT_INBOX = 'https://uat-inbox.capynotebook.com';

// The subject names the deletion date (server/internal/mail/copy_gen.go).
const expectedSubjects: Record<string, RegExp> = {
  'account-deletion-requested':
    /^Your Capy Notebook account will be deleted on \d{1,2} [A-Z][a-z]{2} \d{4}$/,
};

export async function verifyOutboxDelivery(
  run: UatRun,
  userId: string,
  email: string,
  template: string
) {
  const rows = await run.poll(
    'email sent by the gateway',
    () =>
      run.query<{
        id: string;
        locale: string;
        provider_message_id: string | null;
        status: string;
        to_email: string;
      }>(
        'SELECT id,locale,provider_message_id,status,to_email FROM email_outbox WHERE user_id=%s AND template=%s ORDER BY created_at DESC LIMIT 1',
        [userId, template]
      ),
    (values) =>
      values.length === 1 &&
      values[0].status === 'sent' &&
      Boolean(values[0].provider_message_id),
    120_000
  );
  const row = rows[0];
  expect(row.to_email).toBe(email);
  const messageId = row.provider_message_id;
  if (!messageId) throw new Error('Sent outbox has no provider message ID');
  await run.record('sent-email', messageId, {
    retention: 'provider history',
    template,
    userId,
  });
  // Cloudflare's message ID is the Message-ID header the inbox receives. The
  // inbox stores mail in KV, whose reads can trail a write by a minute.
  const messages = await run.poll(
    'email received by the UAT inbox',
    async () => {
      const url = new URL('/messages', UAT_INBOX);
      url.searchParams.set('to', email);
      const { body } = await providerJSON(
        url,
        { headers: { Authorization: `Bearer ${run.env.inboxToken}` } },
        'UAT inbox'
      );
      return (Array.isArray(body) ? body : [])
        .map(object)
        .filter(
          (message) => object(message.headers)['message-id'] === messageId
        );
    },
    (values) => values.length > 0,
    240_000
  );
  const message = messages[0];
  expect(message.to).toBe(email.toLowerCase());
  if (expectedSubjects[template])
    expect(message.subject).toMatch(expectedSubjects[template]);
  expect(String(message.from)).toMatch(/@uat\.capynotebook\.com$/);
  if (!(message.subject && (message.html || message.text)))
    throw new Error('Inbox message has no subject or content');
  await run.attach(`email-${template}`, {
    locale: row.locale,
    outboxId: row.id,
    providerMessageId: messageId,
    receivedAt: message.receivedAt,
    template,
  });
  return { locale: row.locale, subject: String(message.subject) };
}

export type SentryScope = {
  traceIds: string[];
  actorIds: string[];
  /** Run files, for collaboration's rebuild events (no trace or user). */
  fileIds?: string[];
  start: string;
};
export async function readSentryEvents(
  env: UatEnvironment,
  scope: SentryScope
) {
  if (
    !env.sentryToken ||
    !env.sentryOrganization ||
    !env.sentryProjectSlugs.length
  )
    throw new Error('UAT Sentry read configuration is required');
  const fileIds = scope.fileIds ?? [];
  if (!scope.traceIds.length && !scope.actorIds.length && !fileIds.length)
    throw new Error('Sentry reads must be scoped to this run');
  const clauses = [
    ...scope.traceIds.map((id) => {
      if (!/^[a-f0-9]{32}$/.test(id)) throw new Error('Invalid run trace ID');
      return `trace_id:${id}`;
    }),
    ...scope.actorIds.map((id) => {
      if (!/^user_[a-zA-Z0-9]+$/.test(id))
        throw new Error('Invalid run actor ID');
      return `user.id:${id}`;
    }),
    ...fileIds.map((id) => {
      if (!/^f_[a-zA-Z0-9]+$/.test(id)) throw new Error('Invalid run file ID');
      return `file_id:${id}`;
    }),
  ];
  const url = new URL(
    `/api/0/organizations/${encodeURIComponent(env.sentryOrganization)}/events/`,
    env.sentryBaseUrl
  );
  if (
    url.protocol !== 'https:' ||
    !['sentry.io', 'de.sentry.io', 'us.sentry.io'].includes(url.hostname)
  )
    throw new Error('Unexpected Sentry API host');
  url.searchParams.set('dataset', 'errors');
  url.searchParams.set('environment', 'uat');
  url.searchParams.set('start', scope.start);
  url.searchParams.set('end', new Date().toISOString());
  url.searchParams.set('query', `(${clauses.join(' OR ')})`);
  url.searchParams.set('per_page', '100');
  for (const project of env.sentryProjectSlugs)
    url.searchParams.append('project', project);
  for (const field of ['id', 'project', 'timestamp', 'trace_id', 'level'])
    url.searchParams.append('field', field);
  const events: Record<string, unknown>[] = [];
  for (let page = 0; page < 20; page++) {
    const { body, headers } = await providerJSON(
      url,
      { headers: { Authorization: `Bearer ${env.sentryToken}` } },
      'Sentry'
    );
    events.push(...arrayField(body, 'data').map(object));
    const next = headers
      .get('link')
      ?.split(',')
      .find(
        (part) => part.includes('rel="next"') && part.includes('results="true"')
      );
    if (!next) return events;
    const cursor = next.match(/cursor="([^"]+)"/)?.[1];
    if (!cursor) throw new Error('Sentry pagination omitted the next cursor');
    url.searchParams.set('cursor', cursor);
  }
  throw new Error('Sentry query exceeded the bounded run event limit');
}
