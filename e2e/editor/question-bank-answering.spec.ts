import { expect, test } from '@playwright/test';

// The bank mock seeds Area practice with questions 2–4 answered (right,
// wrong, half right) and Mensuration fully answered.

// Check answer reveals the key, shows the quiz review and marks the list;
// Try again clears the answer.
test('bank checks an answer and marks the topic list', async ({ page }) => {
  await page.goto('/bank/practice');
  const question = page.locator('[data-question-id="bank-practice-1"]');
  // A cold dev server compiles the bank route first.
  await expect(question).toContainText('width 2 cm', { timeout: 30_000 });
  const list = page.getByRole('navigation', { name: 'Questions' });
  await expect(list).toContainText('1 correct · 2 to retry');

  await question.getByRole('textbox', { name: 'Your answer' }).fill('6');
  await question.getByRole('button', { name: 'Check answer' }).click();
  await expect(question).toContainText('1 / 1');
  await expect(question).toContainText('Accepted answers');
  await expect(list).toContainText('2 correct · 2 to retry');
  await expect(list.getByRole('button', { name: /^1\./ })).toContainText(
    'Correct'
  );

  await question.getByRole('button', { name: 'Try again' }).click();
  await expect(
    question.getByRole('textbox', { name: 'Your answer' })
  ).toHaveValue('');
});

// The landing continues a topic, the filter narrows it, and ticked questions
// copy into a new quiz.
test('bank continues, filters and copies to a quiz', async ({ page }) => {
  await page.goto('/bank');
  await expect(page.getByText('3 of 34')).toBeVisible({ timeout: 30_000 });
  await expect(
    page.getByRole('button', { name: 'Summary' }),
    'Mensuration is fully answered'
  ).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page).toHaveURL(/\/bank\/practice\/bank-practice-5$/);

  await page.getByRole('button', { name: 'Filter' }).click();
  await page
    .getByRole('button', { exact: true, name: 'Partially wrong' })
    .click();
  await page.keyboard.press('Escape');
  const list = page.getByRole('navigation', { name: 'Questions' });
  await expect(list.getByRole('button', { name: /^\d+\./ })).toHaveText([
    /^4\./,
  ]);

  await page.getByRole('checkbox', { name: 'Select question 4' }).click();
  await page.getByRole('button', { name: 'Copy to quiz' }).click();
  const dialog = page.getByRole('dialog', {
    name: 'Copy 1 question to a quiz',
  });
  await expect(dialog.getByRole('textbox', { name: 'Quiz name' })).toHaveValue(
    'Area practice'
  );
  await dialog.getByRole('button', { name: 'Copy' }).click();
  await expect(page.getByText('Questions copied')).toBeVisible();
  await expect(dialog).toHaveCount(0);
});
