import { expect, test } from '@playwright/test';
import { m } from '../i18n';

// The mock "Area practice" topic has 34 questions, loaded 10 at a time.
test('bank jumps to an unloaded question and loads earlier ones in place', async ({
  page,
}) => {
  const batches: number[] = [];
  page.on('request', (request) => {
    const ids = new URL(request.url()).searchParams.get('ids');
    if (request.url().includes('/api/bank/questions?') && ids)
      batches.push(ids.split(',').length);
  });
  await page.goto('/bank/practice');
  const question = (n: number) =>
    page.locator(`[data-question-id="bank-practice-${n}"]`);
  // Page readiness: a cold dev server compiles the bank route first, so this
  // gets the allowance question-formula.spec.ts uses.
  await expect(question(1)).toContainText('width 2 cm', { timeout: 30_000 });
  await expect(question(11)).toHaveCount(0);

  await page
    .getByRole('navigation', { name: m.question_ui_questions() })
    .getByRole('button', { name: /^30\./ })
    .click();
  // Question 30's page and the next load in one request.
  await expect(question(30)).toContainText('width 31 cm');
  await expect.poll(() => batches.slice(0, 2)).toEqual([10, 14]);
  // Distance from the top of the panel's view.
  const fromTop = (n: number) =>
    question(n).evaluate((element) => {
      const panel = element.closest('.overflow-auto');
      return panel
        ? Math.round(
            element.getBoundingClientRect().top -
              panel.getBoundingClientRect().top
          )
        : null;
    });
  // It scrolls to the top of the panel, not merely into view.
  await expect.poll(() => fromTop(30)).toBe(24);
  // The window began within reach of the top, so questions 11-20 load above
  // on their own once scrolling settles, holding question 30 still.
  await expect(question(11)).toContainText('width 12 cm');
  expect(await fromTop(30)).toBe(24);

  // Scrolled up to question 11, questions 1-10 load but wait while a finger
  // is down (iOS Safari would cancel a fling), then go in without moving it.
  await page.evaluate(() =>
    document.dispatchEvent(
      new TouchEvent('touchstart', {
        touches: [new Touch({ identifier: 1, target: document.body })],
      })
    )
  );
  await question(11).evaluate((element) => {
    const panel = element.closest('.overflow-auto');
    if (panel)
      panel.scrollTop +=
        element.getBoundingClientRect().top -
        panel.getBoundingClientRect().top -
        24;
  });
  const held = (await fromTop(11)) ?? 0;
  // Cached since the first window, so only the finger holds them back.
  await page.waitForTimeout(500);
  await expect(question(1)).toHaveCount(0);
  await page.evaluate(() =>
    document.dispatchEvent(new TouchEvent('touchend', { touches: [] }))
  );
  await expect(question(1)).toContainText('width 2 cm');
  // The reading position stays put, within subpixel rounding.
  expect(Math.abs(((await fromTop(11)) ?? 0) - held)).toBeLessThanOrEqual(1);
});
