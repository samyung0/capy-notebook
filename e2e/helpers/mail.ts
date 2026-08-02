import { type APIRequestContext, expect } from '@playwright/test';

export type CapturedEmail = {
  subject: string;
  text: string;
  to: string;
};

/**
 * Reads the mail the API delivered through its E2E-only recording sender.
 * The dispatcher polls the outbox on a timer, so poll until the message shows
 * up rather than assuming it was already sent.
 */
export async function waitForEmail(
  api: APIRequestContext,
  to: string,
  timeoutMs = 20_000
): Promise<CapturedEmail> {
  let captured: CapturedEmail[] = [];
  await expect(async () => {
    const response = await api.get('/api/e2e/emails');
    expect(response.status()).toBe(200);
    captured = (await response.json()) as CapturedEmail[];
    expect(captured.some((email) => email.to === to)).toBe(true);
  }).toPass({ timeout: timeoutMs });
  return captured.filter((email) => email.to === to).at(-1) as CapturedEmail;
}
