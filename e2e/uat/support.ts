import { createClerkClient } from '@clerk/backend';
import type { Page } from '@playwright/test';

export type Actor = 'editor' | 'other' | 'owner' | 'viewer';

const emails: Record<Actor, string> = {
  editor: process.env.UAT_EDITOR_EMAIL!,
  other: process.env.UAT_OTHER_EMAIL!,
  owner: process.env.UAT_OWNER_EMAIL!,
  viewer: process.env.UAT_VIEWER_EMAIL!,
};

const clerkClient = createClerkClient({
  secretKey: process.env.CLERK_SECRET_KEY!,
});

type ClerkBrowser = {
  client: {
    signIn: {
      create: (input: { strategy: 'ticket'; ticket: string }) => Promise<{
        createdSessionId: string | null;
        status: string;
      }>;
    };
  };
  loaded: boolean;
  session?: { getToken: () => Promise<string | null> };
  setActive: (input: { session: string }) => Promise<void>;
  signOut: () => Promise<void>;
};

// This SPA redirects whenever Clerk's session state changes, and page.evaluate
// cannot survive a navigation. A redirect landing between the readiness check
// and the evaluate leaves a fresh context with no Clerk on it, so the wait has
// to sit inside the retry rather than before it.
const RETRYABLE_ERRORS = [
  'Execution context was destroyed',
  'Cannot read properties of undefined',
  'Clerk session is not available in the app',
  // A sign-out redirect still in flight aborts a navigation started next to it.
  'net::ERR_ABORTED',
];

async function retryAcrossNavigation<T>(page: Page, run: () => Promise<T>) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const retryable = RETRYABLE_ERRORS.some((known) =>
        message.includes(known)
      );
      if (attempt >= 4 || !retryable) {
        throw error;
      }
      await page.waitForLoadState('domcontentloaded');
    }
  }
}

async function evaluateWhenReady<T>(
  page: Page,
  needSession: boolean,
  run: () => Promise<T>
) {
  return retryAcrossNavigation(page, async () => {
    await page.waitForFunction((session) => {
      const clerk = (window as unknown as { Clerk?: ClerkBrowser }).Clerk;
      if (clerk?.loaded !== true) {
        return false;
      }
      return session ? Boolean(clerk.session) : true;
    }, needSession);
    return run();
  });
}

export async function signIn(page: Page, actor: Actor) {
  const { data: users } = await clerkClient.users.getUserList({
    emailAddress: [emails[actor]],
    limit: 2,
  });
  if (users.length !== 1) {
    throw new Error(
      `Expected exactly one Clerk UAT user for ${actor}; found ${users.length}`
    );
  }
  await retryAcrossNavigation(page, () => page.goto('/'));
  // Start from a clean session so an existing one below can only mean this
  // call's own earlier attempt, never a leftover from the previous actor.
  await signOut(page);
  // A ticket is single use, so each attempt mints its own: a navigation can
  // interrupt an attempt after Clerk has already consumed the one it was given.
  await retryAcrossNavigation(page, async () => {
    await page.waitForFunction(() => {
      const clerk = (window as unknown as { Clerk?: ClerkBrowser }).Clerk;
      return clerk?.loaded === true;
    });
    const ticket = await clerkClient.signInTokens.createSignInToken({
      expiresInSeconds: 60,
      userId: users[0].id,
    });
    await page.evaluate(async (token) => {
      const clerk = (window as unknown as { Clerk: ClerkBrowser }).Clerk;
      if (clerk.session) {
        return;
      }
      const attempt = await clerk.client.signIn.create({
        strategy: 'ticket',
        ticket: token,
      });
      if (attempt.status !== 'complete' || !attempt.createdSessionId) {
        throw new Error(`Clerk ticket sign-in ended with ${attempt.status}`);
      }
      await clerk.setActive({ session: attempt.createdSessionId });
    }, ticket.token);
  });
  // Signing in redirects, which can abort this navigation the same way.
  await retryAcrossNavigation(page, () => page.goto('/'));
  // Clerk bootstraps again after this navigation, and the app bounces through
  // the sign-in route until the session is restored. Wait for that to settle:
  // page.evaluate cannot survive a navigation, so callers would otherwise race
  // it and see "Execution context was destroyed".
  await page.waitForFunction(() => {
    const clerk = (window as unknown as { Clerk?: ClerkBrowser }).Clerk;
    return clerk?.loaded === true && Boolean(clerk.session);
  });
  await page.waitForURL((url) => !/\/sign-in(?:[/?]|$)/.test(url.pathname));
  await page.locator('main').waitFor({ state: 'visible' });
}

export async function signOut(page: Page) {
  // A test may sign out before it has ever loaded the app, so there is no Clerk
  // on the page yet and nothing to sign out of.
  await retryAcrossNavigation(page, () =>
    page.evaluate(async () => {
      const clerk = (window as unknown as { Clerk?: ClerkBrowser }).Clerk;
      if (!clerk?.loaded) {
        return;
      }
      await clerk.signOut();
    })
  );
}

export async function api(
  page: Page,
  path: string,
  method: 'GET' | 'POST' = 'GET'
) {
  return evaluateWhenReady(page, true, () =>
    page.evaluate(
      async ({ requestMethod, requestPath }) => {
        type ClerkWindow = Window & {
          Clerk?: { session?: { getToken: () => Promise<string | null> } };
        };
        const session = (window as ClerkWindow).Clerk?.session;
        if (!session)
          throw new Error('Clerk session is not available in the app');
        const token = await session.getToken();
        if (!token) throw new Error('Clerk did not return a session token');
        const response = await fetch(requestPath, {
          headers: { Authorization: `Bearer ${token}` },
          method: requestMethod,
        });
        const body = await response.text();
        return { body, status: response.status };
      },
      { requestMethod: method, requestPath: path }
    )
  );
}
