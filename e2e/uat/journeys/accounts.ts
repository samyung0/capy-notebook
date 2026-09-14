import { randomBytes, randomUUID } from 'node:crypto';
import { createClerkClient } from '@clerk/backend';
import type {
  APIRequestContext,
  Browser,
  BrowserContext,
  Page,
} from '@playwright/test';
import type { Actor, UatEnvironment, UatRun } from './runtime';

function setupFailure(error: unknown, stage: string) {
  const status =
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    typeof error.status === 'number'
      ? ` (${error.status})`
      : '';
  return new Error(
    `${stage} failed${status}; browser/provider details are omitted to keep credentials out of artifacts`
  );
}

export async function savedTokenStatus(
  request: APIRequestContext,
  url: string,
  token: string
) {
  try {
    return (
      await request.get(url, { headers: { Authorization: `Bearer ${token}` } })
    ).status();
  } catch (error) {
    throw setupFailure(error, 'Saved-token authorization probe');
  }
}

type BrowserClerk = {
  loaded: boolean;
  user?: { id: string };
  session?: { getToken(): Promise<string | null> };
  client: {
    signIn: {
      create(input: {
        strategy: 'ticket';
        ticket: string;
      }): Promise<{ status: string; createdSessionId: string | null }>;
    };
  };
  setActive(input: { session: string }): Promise<void>;
};

function uniqueEmail(run: UatRun, label: string) {
  const local = `uat-${run.id.replace(/[^a-zA-Z0-9]/g, '').slice(0, 20)}-${label}-${randomUUID().slice(0, 8)}`;
  return `${local}+clerk_test@${run.env.actorEmailDomain}`;
}

async function actorContext(env: UatEnvironment, browser: Browser) {
  const client = createClerkClient({ secretKey: env.clerkSecretKey });
  const encodedHost = env.clerkPublishableKey.replace(/^pk_(test|live)_/, '');
  const host = Buffer.from(encodedHost, 'base64').toString().replace(/\$$/, '');
  if (!host || host.includes('/') || !host.includes('.'))
    throw new Error('Invalid UAT Clerk publishable key');
  let testing = await client.testingTokens.createTestingToken();
  const context = await browser.newContext({
    baseURL: env.appUrl,
    locale: 'en-US',
  });
  // Official Clerk bot-protection token, not a mocked identity or application response.
  await context.route(`https://${host}/v1/**`, async (route) => {
    try {
      if (testing.expiresAt * 1000 < Date.now() + 5000)
        testing = await client.testingTokens.createTestingToken();
      const url = new URL(route.request().url());
      url.searchParams.set('__clerk_testing_token', testing.token);
      const response = await route.fetch({ url: url.toString() });
      const body = (await response.json()) as {
        response?: { captcha_bypass?: boolean };
        client?: { captcha_bypass?: boolean };
      };
      // Match Clerk's Playwright helper: the token bypasses server checks, while
      // this flag prevents the browser from waiting for a CAPTCHA first.
      for (const entry of [body.response, body.client]) {
        if (entry?.captcha_bypass === false) entry.captcha_bypass = true;
      }
      await route.fulfill({ json: body, response });
    } catch (error) {
      throw setupFailure(error, 'Clerk testing request');
    }
  });
  return context;
}

export async function closeActorContext(context: BrowserContext) {
  try {
    // Finish Clerk handlers before closing their request context.
    await context.unrouteAll({ behavior: 'wait' });
  } finally {
    await context.close();
  }
}

async function sessionReady(page: Page, userId?: string) {
  await page.waitForFunction(
    (expected) => {
      const clerk = (window as unknown as { Clerk?: BrowserClerk }).Clerk;
      return (
        clerk?.loaded &&
        clerk.session &&
        (!expected || clerk.user?.id === expected)
      );
    },
    userId,
    { timeout: 60_000 }
  );
}

function actorFor(
  run: UatRun,
  context: BrowserContext,
  page: Page,
  id: string,
  email: string
): Actor {
  return {
    context,
    email,
    id,
    page,
    async request(path, method = 'GET', body?: unknown) {
      if (!path.startsWith('/api/'))
        throw new Error('UAT actor request must use an application API path');
      // Navigation can finish before Clerk restores this actor's session.
      await sessionReady(page, id);
      const token = await page.evaluate(async () => {
        const clerk = (window as unknown as { Clerk?: BrowserClerk }).Clerk;
        return (await clerk?.session?.getToken()) ?? null;
      });
      if (!token) throw new Error('UAT actor has no Clerk session token');
      const trace = randomBytes(16).toString('hex');
      await run.record('trace', trace, { actorId: id, method, path });
      const response = await context.request
        .fetch(new URL(path, run.env.apiUrl).toString(), {
          data: body,
          headers: {
            Authorization: `Bearer ${token}`,
            traceparent: `00-${trace}-${randomBytes(8).toString('hex')}-01`,
          },
          method,
        })
        .catch((error: unknown) => {
          throw setupFailure(error, 'Authenticated API request');
        });
      const text = await response.text();
      let parsed: unknown = null;
      if (text) {
        try {
          parsed = JSON.parse(text);
        } catch {
          // biome-ignore lint/style/useErrorCause: JSON parse errors can include credential-bearing response text.
          throw new Error(
            `Application API returned non-JSON (${response.status()})`
          );
        }
      }
      return { body: parsed, status: response.status() };
    },
  };
}

async function waitForApplicationUser(run: UatRun, actor: Actor) {
  const response = await actor.request('/api/me');
  if (response.status !== 200)
    throw new Error(`New actor /api/me failed (${response.status})`);
  await run.poll(
    'Clerk identity persisted in application',
    () =>
      run.query<{ id: string; email: string }>(
        'SELECT id,email FROM users WHERE id=%s AND deleted_at IS NULL',
        [actor.id]
      ),
    (rows) => rows.length === 1 && rows[0].email === actor.email,
    60_000
  );
}

export async function createPrimaryActor(
  run: UatRun,
  browser: Browser
): Promise<Actor> {
  const email = uniqueEmail(run, 'owner');
  await run.record('actor-email', email, { label: 'owner' });
  const context = await actorContext(run.env, browser).catch(
    (error: unknown) => {
      throw setupFailure(error, 'Clerk browser setup');
    }
  );
  const page = await context.newPage();
  let stage = 'Primary actor signup page';
  try {
    await page.goto('/sign-up');
    stage = 'Primary actor signup form';
    await page.locator('input[autocomplete="email"]').fill(email);
    await page
      .locator('input[autocomplete="new-password"]')
      .fill(`Uat!${randomBytes(24).toString('base64url')}7`);
    await page
      .locator('form')
      .filter({ has: page.locator('input[autocomplete="new-password"]') })
      .locator('button[type="submit"]')
      .click();
    stage = 'Primary actor email verification';
    const codeInput = page.locator('input[autocomplete="one-time-code"]');
    await codeInput.waitFor({ state: 'visible', timeout: 60_000 });
    await codeInput.fill('424242');
    await page
      .locator('form')
      .filter({ has: codeInput })
      .locator('button[type="submit"]')
      .click();
    stage = 'Primary actor Clerk session';
    await sessionReady(page);
    const id = await page.evaluate(
      () => (window as unknown as { Clerk: BrowserClerk }).Clerk.user?.id
    );
    if (!id) throw new Error('Signup completed without a Clerk user');
    stage = 'Primary actor Clerk identity';
    await run.record('actor', id, {
      email,
      label: 'owner',
      registration: 'browser',
    });
    const client = createClerkClient({ secretKey: run.env.clerkSecretKey });
    const user = await client.users.getUser(id);
    if (
      !user.emailAddresses.some(
        (address) =>
          address.emailAddress === email &&
          address.verification?.status === 'verified'
      )
    )
      throw new Error('Clerk did not persist the verified signup email');
    await client.users.updateUserMetadata(id, {
      privateMetadata: { capyUatRunId: run.id },
    });
    const actor = actorFor(run, context, page, id, email);
    stage = 'Primary actor application profile';
    await waitForApplicationUser(run, actor);
    return actor;
  } catch (error) {
    await closeActorContext(context);
    throw setupFailure(error, stage);
  }
}

export async function createSecondaryActor(
  run: UatRun,
  browser: Browser,
  label: string
): Promise<Actor> {
  if (!/^[a-z0-9-]{1,20}$/.test(label))
    throw new Error('Actor label must be a short lowercase identifier');
  const email = uniqueEmail(run, label);
  await run.record('actor-email', email, { label });
  const client = createClerkClient({ secretKey: run.env.clerkSecretKey });
  const user = await client.users
    .createUser({
      emailAddress: [email],
      password: `Uat!${randomBytes(24).toString('base64url')}7`,
      privateMetadata: { capyUatRunId: run.id },
    })
    .catch((error: unknown) => {
      throw setupFailure(error, 'Secondary Clerk identity creation');
    });
  await run.record('actor', user.id, {
    email,
    label,
    registration: 'backend-ticket',
  });
  const context = await actorContext(run.env, browser).catch(
    (error: unknown) => {
      throw setupFailure(error, 'Clerk browser setup');
    }
  );
  const page = await context.newPage();
  try {
    await page.goto('/sign-in');
    await page.waitForFunction(
      () =>
        (window as unknown as { Clerk?: BrowserClerk }).Clerk?.loaded === true
    );
    const ticket = await client.signInTokens.createSignInToken({
      expiresInSeconds: 60,
      userId: user.id,
    });
    try {
      await page.evaluate(async (value) => {
        const clerk = (window as unknown as { Clerk: BrowserClerk }).Clerk;
        const attempt = await clerk.client.signIn.create({
          strategy: 'ticket',
          ticket: value,
        });
        if (attempt.status !== 'complete' || !attempt.createdSessionId)
          throw new Error('Clerk ticket sign-in did not complete');
        await clerk.setActive({ session: attempt.createdSessionId });
      }, ticket.token);
    } catch (error) {
      if (
        !(
          error instanceof Error &&
          error.message.includes('Execution context was destroyed')
        )
      )
        throw error;
    }
    await sessionReady(page, user.id);
    const actor = actorFor(run, context, page, user.id, email);
    await waitForApplicationUser(run, actor);
    return actor;
  } catch (error) {
    await closeActorContext(context);
    throw setupFailure(error, 'Secondary actor sign-in');
  }
}

export async function cleanupClerkActor(
  env: UatEnvironment,
  userId: string,
  runId: string,
  email: string
) {
  const client = createClerkClient({ secretKey: env.clerkSecretKey });
  try {
    const user = await client.users.getUser(userId);
    if (
      user.privateMetadata.capyUatRunId !== runId ||
      !user.emailAddresses.some((entry) => entry.emailAddress === email)
    )
      throw new Error(
        'Refusing Clerk cleanup: actor ownership does not match manifest'
      );
    await client.users.deleteUser(userId);
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'status' in error &&
      error.status === 404
    )
      return;
    throw error;
  }
}
