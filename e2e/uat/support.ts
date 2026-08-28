import { createClerkClient } from '@clerk/backend';
import type { Page } from '@playwright/test';

export type Actor = 'commenter' | 'editor' | 'other' | 'owner' | 'viewer';

const emails: Record<Actor, string> = {
  commenter: process.env.UAT_COMMENTER_EMAIL!,
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
  const signInToken = await clerkClient.signInTokens.createSignInToken({
    expiresInSeconds: 60,
    userId: users[0].id,
  });

  await page.goto('/');
  await page.waitForFunction(() => {
    const clerk = (window as unknown as { Clerk?: ClerkBrowser }).Clerk;
    return clerk?.loaded === true;
  });
  await page.evaluate(async (ticket) => {
    const clerk = (window as unknown as { Clerk: ClerkBrowser }).Clerk;
    const attempt = await clerk.client.signIn.create({
      strategy: 'ticket',
      ticket,
    });
    if (attempt.status !== 'complete' || !attempt.createdSessionId) {
      throw new Error(`Clerk ticket sign-in ended with ${attempt.status}`);
    }
    await clerk.setActive({ session: attempt.createdSessionId });
  }, signInToken.token);
  await page.goto('/');
}

export async function signOut(page: Page) {
  await page.evaluate(async () => {
    await (window as unknown as { Clerk: ClerkBrowser }).Clerk.signOut();
  });
}

export async function api(
  page: Page,
  path: string,
  method: 'GET' | 'POST' = 'GET'
) {
  return page.evaluate(
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
  );
}
