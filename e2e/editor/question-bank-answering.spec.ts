import { expect, test } from '@playwright/test';
import { m } from '../i18n';

// The bank mock seeds Area practice with questions 2–4 answered (right,
// wrong, half right) and Mensuration fully answered.

// Check answer reveals the key, shows the quiz review and marks the list;
// Try again clears the answer.
test('bank checks an answer and marks the topic list', async ({ page }) => {
  await page.goto('/qb/practice');
  const question = page.locator('[data-question-id="bank-practice-1"]');
  // A cold dev server compiles the bank route first.
  await expect(question).toContainText('width 2 cm', { timeout: 30_000 });
  const list = page.getByRole('navigation', {
    name: m.question_ui_questions(),
  });
  await expect(list.getByRole('button', { name: /^2\./ })).toHaveAttribute(
    'data-result',
    'correct'
  );
  await expect(list.getByRole('button', { name: /^1\./ })).toHaveAttribute(
    'data-result',
    'notDone'
  );

  await question
    .getByRole('textbox', { name: m.question_ui_your_answer() })
    .fill('6');
  await question
    .getByRole('button', { name: m.question_ui_check_answer() })
    .click();
  await expect(question).toContainText('1 / 1');
  await expect(
    question.getByText(m.question_ui_accepted_answers())
  ).toBeVisible();
  await expect(list.getByRole('button', { name: /^1\./ })).toHaveAttribute(
    'data-result',
    'correct'
  );

  await question
    .getByRole('button', { name: m.question_ui_answer_again() })
    .click();
  await expect(
    question.getByRole('textbox', { name: m.question_ui_your_answer() })
  ).toHaveValue('');
});

// The landing continues a topic, the filter narrows it, and ticked questions
// copy into a new quiz named in the picker.
test('bank continues, filters and copies to a quiz', async ({ page }) => {
  await page.goto('/qb');
  await expect(page.getByText(m.study_of({ done: 3, total: 34 }))).toBeVisible({
    timeout: 30_000,
  });
  await expect(
    page.getByRole('button', { name: m.question_ui_summary() }),
    'Mensuration is fully answered'
  ).toBeVisible();
  await page.getByRole('button', { name: m.question_ui_continue() }).click();
  await expect(page).toHaveURL(/\/qb\/practice\/bank-practice-5$/);

  await page.getByRole('button', { name: m.workspaces_filter() }).click();
  await page
    .getByRole('button', { exact: true, name: m.question_ui_status_partial() })
    .click();
  await page.keyboard.press('Escape');
  const list = page.getByRole('navigation', {
    name: m.question_ui_questions(),
  });
  await expect(list.getByRole('button', { name: /^\d+\./ })).toHaveText([
    /^4\./,
  ]);

  await list.getByRole('button', { name: m.action_clone() }).click();
  await list.getByRole('checkbox', { name: /^4\./ }).click();
  await page
    .getByRole('button', { name: m.question_ui_copy_to_quiz() })
    .click();
  const dialog = page.getByRole('dialog', {
    name: m.question_ui_copy_to_quiz(),
  });
  const quiz = dialog.getByRole('combobox', {
    name: m.question_ui_quiz_name(),
  });
  await expect(quiz).toHaveValue('Area practice');
  const copy = dialog.getByRole('button', { name: m.action_copy() });
  // Typing over a new quiz's name renames it without opening the list.
  await quiz.fill('Area drills');
  await expect(quiz).toHaveAttribute('aria-expanded', 'false');
  await expect(copy).toBeEnabled();
  // Cleared, typing searches, so Copy waits until Enter names the new quiz.
  await dialog
    .getByRole('button', { name: m.question_ui_clear_quiz() })
    .click();
  await quiz.fill('Bank quiz');
  await expect(copy).toBeDisabled();
  await expect(
    page.getByRole('option', {
      name: m.question_ui_create_quiz({ name: 'Bank quiz' }),
    })
  ).toBeVisible();
  await quiz.press('Enter');
  // The new quiz goes into a chapter typed here, created with the copy.
  // The row picker shows its value as text, not as an accessible name.
  const chapter = dialog
    .getByRole('combobox')
    .filter({ hasText: m.source_no_chapter() });
  await chapter.click();
  await page.getByRole('option', { name: m.source_new_chapter() }).click();
  await dialog.getByPlaceholder(m.source_new_chapter_name()).fill('Bank picks');
  await dialog.getByRole('button', { name: m.source_create_chapter() }).click();
  await expect(chapter).toHaveCount(0);
  await expect(
    dialog.getByRole('combobox').filter({ hasText: 'Bank picks' })
  ).toBeVisible();
  await copy.click();
  await expect(page.getByText(m.question_ui_copied())).toBeVisible();
  await expect(dialog).toHaveCount(0);
});
