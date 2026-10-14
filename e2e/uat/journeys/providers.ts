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
  constructor(provider: string, status: number) {
    super(`${provider} request failed (${status})`);
    this.status = status;
  }
}

async function providerJSON(url: URL, init: RequestInit, provider: string) {
  const response = await fetch(url, {
    ...init,
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  });
  // Provider bodies can contain addresses, tokens and signed links. Keep errors bounded to status.
  if (!response.ok) throw new ProviderError(provider, response.status);
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
  // Scope every page to the exact manifest-owned customer, including clock customers.
  let cursor = '';
  for (;;) {
    const params = new URLSearchParams({
      customer: customerId,
      limit: '100',
      status: 'all',
    });
    if (cursor) params.set('starting_after', cursor);
    const page = await stripeRequest(env, `/v1/subscriptions?${params}`);
    const subscriptions = arrayField(page, 'data');
    for (const value of subscriptions) {
      const subscription = object(value);
      if (
        subscription.customer !== customerId ||
        subscription.livemode !== false
      )
        throw new Error('Stripe subscription cleanup ownership mismatch');
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
    }
    if (page.has_more !== true) break;
    cursor = stringField(subscriptions.at(-1), 'id');
  }
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
        provider_message_id: string | null;
        status: string;
        to_email: string;
      }>(
        'SELECT id,provider_message_id,status,to_email FROM email_outbox WHERE user_id=%s AND template=%s ORDER BY created_at DESC LIMIT 1',
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
    outboxId: row.id,
    providerMessageId: messageId,
    receivedAt: message.receivedAt,
    template,
  });
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
