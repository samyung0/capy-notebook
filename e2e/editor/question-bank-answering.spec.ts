import { expect, test } from '@playwright/test';

// Check answer reveals the key, shows the quiz review and marks the list;
// Try again clears the answer.
test('bank checks an answer and marks the topic list', async ({ page }) => {
  await page.goto('/bank/practice');
  const question = page.locator('[data-question-id="bank-practice-1"]');
  // A cold dev server compiles the bank route first.
  await expect(question).toContainText('width 2 cm', { timeout: 30_000 });
  const list = page.getByRole('navigation', { name: 'Questions' });
  await expect(list).toContainText('0 correct · 0 to retry');

  await question.getByRole('textbox', { name: 'Your answer' }).fill('6');
  await question.getByRole('button', { name: 'Check answer' }).click();
  await expect(question).toContainText('1 / 1');
  await expect(question).toContainText('Accepted answers');
  await expect(list).toContainText('1 correct · 0 to retry');
  await expect(list.getByRole('button', { name: /^1\./ })).toContainText(
    'Correct'
  );

  await question.getByRole('button', { name: 'Try again' }).click();
  await expect(
    question.getByRole('textbox', { name: 'Your answer' })
  ).toHaveValue('');
});
