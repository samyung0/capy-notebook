import { expect, test } from '@playwright/test';
import { m } from '../i18n';

// The bank mock seeds Area practice with questions 2–4 answered (right,
// wrong, half right) as the latest topic, plus older started and finished ones.

// Check answer reveals the key, shows the quiz review and marks the topic's
// square in the tree; Try again clears the answer.
test('bank checks an answer and marks its square', async ({ page }) => {
  await page.goto('/qb/practice');
  const question = page.locator('[data-question-id="bank-practice-1"]');
  // A cold dev server compiles the bank route first.
  await expect(question).toContainText('width 2 cm', { timeout: 30_000 });
  const squares = page
    .getByRole('navigation', { name: m.question_ui_exams_and_topics() })
    .getByRole('list', { name: m.question_ui_questions() });
  await expect(
    squares.getByRole('button', { name: m.quiz_question_right({ number: 2 }) })
  ).toBeVisible();
  await expect(
    squares.getByRole('button', {
      name: m.quiz_question_unanswered({ number: 1 }),
    })
  ).toBeVisible();

  await question
    .getByRole('textbox', { name: m.question_ui_your_answer() })
    .fill('6');
  await question
    .getByRole('button', { exact: true, name: m.question_ui_check() })
    .click();
  await expect(question).toContainText('1 / 1');
  await expect(
    question.getByText(m.question_ui_accepted_answers())
  ).toBeVisible();
  await expect(
    squares.getByRole('button', { name: m.quiz_question_right({ number: 1 }) })
  ).toBeVisible();

  await question
    .getByRole('button', { name: m.question_ui_answer_again() })
    .click();
  await expect(
    question.getByRole('textbox', { name: m.question_ui_your_answer() })
  ).toHaveValue('');
});

// The landing continues a topic from its map and the page's filter narrows it.
test('bank continues and filters', async ({ page }) => {
  await page.goto('/qb');
  await expect(
    page.getByText(
      m.question_ui_progress_line({ answered: 3, correct: 1, total: 34 })
    )
  ).toBeVisible({ timeout: 30_000 });
  await expect(
    page.getByRole('heading', { name: m.question_ui_finished() }),
    'fully answered topics are listed as finished'
  ).toBeVisible();
  await page
    .getByRole('button', { name: m.question_ui_continue_at({ position: 5 }) })
    .click();
  await expect(page).toHaveURL(/\/qb\/practice\/bank-practice-5$/);

  // Filter sits under the title, so start from the top rather than racing
  // the scroll to question 5.
  await page.goto('/qb/practice');
  await page.getByRole('button', { name: m.workspaces_filter() }).click();
  await page
    .getByRole('button', { exact: true, name: m.question_ui_status_partial() })
    .click();
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-question-id]')).toHaveCount(1);
  await expect(
    page.locator('[data-question-id="bank-practice-4"]')
  ).toBeVisible();
});

// Summary on a finished topic opens its summary page under the topic: the
// score, the missed questions to retry, and a square that opens its question.
test('a finished topic opens its summary', async ({ page }) => {
  await page.goto('/qb/circles/summary');
  await expect(page.getByText('7 / 10', { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText(m.result_wrong({ count: 3 }))).toBeVisible();
  // The trail ends on the topic, which opens the topic page.
  await expect(
    page
      .getByRole('navigation', { name: m.quiz_breadcrumb() })
      .getByRole('link')
      .last()
  ).toHaveAttribute('href', /\/qb\/circles$/);
  await expect(
    page.getByRole('button', { name: m.question_ui_retry() })
  ).toHaveCount(3);
  // The summary's own square, not the tree's.
  await page
    .getByRole('list', { name: m.quiz_question_results() })
    .getByRole('button', { name: m.quiz_question_wrong({ number: 3 }) })
    .click();
  await expect(page).toHaveURL(/\/qb\/circles\/[^/]+$/);
  await expect(page).not.toHaveURL(/summary$/);
});
