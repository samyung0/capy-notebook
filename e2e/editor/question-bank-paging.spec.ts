import { expect, test } from '@playwright/test';
import { m } from '../i18n';

// The mock "Area practice" topic has 34 questions, loaded 10 at a time.
test('bank jumps to an unloaded question and restores earlier ones in place', async ({
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
  await expect.poll(() => batches).toEqual([10, 14]);
  // It scrolls to the top of the panel, not merely into view.
  await expect
    .poll(() =>
      question(30).evaluate((element) => {
        const panel = element.closest('.overflow-auto');
        return panel
          ? Math.round(
              element.getBoundingClientRect().top -
                panel.getBoundingClientRect().top
            )
          : null;
      })
    )
    .toBe(24);

  const earlier = page.getByRole('button', {
    name: m.question_ui_show_questions({ from: 11, to: 20 }),
  });
  await earlier.scrollIntoViewIfNeeded();
  const before = (await question(21).boundingBox())?.y ?? 0;
  await earlier.click();
  await expect(question(11)).toContainText('width 12 cm');
  const after = (await question(21).boundingBox())?.y ?? 0;
  // The reading position stays put, within subpixel rounding.
  expect(Math.abs(after - before)).toBeLessThanOrEqual(1);
});
