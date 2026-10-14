import { expect, type Page, test } from '@playwright/test';

// The pages the site Worker renders run under an enforced script policy
// (vite-image-policy.ts pagePolicy, workers/site/handler.ts): scripts only
// from the app and named hosts, never inline. A shared note's formulas render
// on the server and its islands hydrate, and a shared quiz or flashcard set
// hydrates whole, with nothing the policy blocks.

const NOTE = '/share/notes/nt_shared.mswSignature0000';
const SPACES = /\s+/;

/** What the enforced policy blocks on `page`; the image policy only reports. */
async function blockedOn(page: Page) {
  await page.addInitScript(() => {
    const blocked: string[] = [];
    Object.assign(window, { policyBlocked: blocked });
    document.addEventListener(
      'securitypolicyviolation',
      (event) => {
        if (event.disposition === 'enforce')
          blocked.push(
            `${event.effectiveDirective} ${event.blockedURI} ${event.sourceFile}:${event.lineNumber}:${event.columnNumber} ${event.sample}`
          );
      },
      true
    );
  });
  return () =>
    page.evaluate(
      () => (window as unknown as { policyBlocked: string[] }).policyBlocked
    );
}

const scriptSources = (policy = '') =>
  policy
    .split(';')
    .map((directive) => directive.trim().split(SPACES))
    .find(([name]) => name === 'script-src')
    ?.slice(1);

test('a shared note with formulas hydrates its islands under the script policy', async ({
  page,
}) => {
  const blocked = await blockedOn(page);
  const response = await page.goto(NOTE);
  const sources = scriptSources(response?.headers()['content-security-policy']);
  expect(sources).toContain("'self'");
  expect(sources).not.toContain("'unsafe-inline'");
  expect(sources).not.toContain("'unsafe-eval'");
  // Formulas are the server's static markup.
  await expect(page.locator('.ML__latex').first()).toBeVisible();
  // Islands: the diagram draws, the embedded quiz's formula runs MathLive and
  // the interactive block's frame runs its snippet.
  await expect(page.locator('[data-island="mermaid"] svg').first()).toBeVisible(
    { timeout: 30_000 }
  );
  await expect(
    page.locator('[data-island="embed"] math-field').first()
  ).toBeAttached({ timeout: 30_000 });
  await expect(
    page.frameLocator('[data-island="html"] iframe').locator('#snippet-ready')
  ).toBeVisible({ timeout: 30_000 });
  expect(await blocked()).toEqual([]);
});

// Each kind loads its own page code; the quiz's first question has a formula.
for (const { kind, math, path } of [
  { kind: 'quiz', math: true, path: '/share/quizzes/qz_shared' },
  { kind: 'flashcard set', math: false, path: '/share/flashcards/dk_shared' },
])
  test(`a shared ${kind} hydrates under the script policy`, async ({
    page,
  }) => {
    const blocked = await blockedOn(page);
    await page.goto(`${path}.mswSignature0000`);
    await expect(page.locator('html')).toHaveAttribute('data-hydrated', '', {
      timeout: 30_000,
    });
    // MathLive draws the quiz's formulas.
    if (math) await expect(page.locator('math-field').first()).toBeAttached();
    expect(await blocked()).toEqual([]);
  });

test('a workspace summary runs its page script under the script policy', async ({
  page,
}) => {
  const blocked = await blockedOn(page);
  await page.goto('/w/ws_bio.WsDtCIGPdoZOSZL0');
  // The page script points the file icons at the sprite.
  await expect(
    page.locator('use[data-file-icon][href]').first()
  ).toBeAttached();
  // Analytics loads after first paint.
  await page.waitForLoadState('networkidle');
  expect(await blocked()).toEqual([]);
});
