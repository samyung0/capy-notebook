import { expect, type Page, test } from '@playwright/test';
import { m } from '../i18n';

/** New assignment's Quiz field: its rows open the dialogs that make a quiz, from the
 * Assignments page and the Dashboard. */

async function openQuizField(page: Page) {
  await page
    .getByRole('button', { name: m.assignment_new() })
    .first()
    .click({ timeout: 60_000 });
  await page
    .getByRole('button', { exact: true, name: m.assignment_field_quiz() })
    .click();
}

const makerRow = (page: Page, name: string) =>
  page.getByRole('button', { exact: true, name });

test('from Assignments, New quiz opens Add file on Create', async ({
  page,
}) => {
  await page.goto('/workspaces/ws_bio?study=assignments');
  await openQuizField(page);
  await expect(page.getByLabel(m.assignment_search_quizzes())).toBeVisible();
  await makerRow(page, m.assignment_new_quiz()).click();

  await expect(
    page.getByRole('dialog').getByRole('tab', { name: m.action_create() })
  ).toHaveAttribute('aria-selected', 'true');
  await expect(page).toHaveURL(/study=assignments/);
  await expect(page).not.toHaveURL(/add=/);
});

test('a quiz made from the Quiz field is in the list when it opens again', async ({
  page,
}) => {
  await page.goto('/workspaces/ws_bio?study=assignments');
  await openQuizField(page);
  const quizzes = page.locator('[data-radix-popper-content-wrapper] ul button');
  await expect(quizzes.first()).toBeVisible();
  const before = await quizzes.count();
  await makerRow(page, m.assignment_new_quiz()).click();

  const add = page.getByRole('dialog');
  await add
    .getByRole('button', { exact: true, name: m.generate_quiz() })
    .click();
  await add
    .getByRole('button', { exact: true, name: m.action_create() })
    .click();
  await expect(page).toHaveURL(/material=/);

  // Back in the app, not a reload: the list has to refresh from what it held.
  await page.goBack();
  await openQuizField(page);
  await expect(quizzes).toHaveCount(before + 1);
});

test('cancelling Make a quiz returns to Assignments', async ({ page }) => {
  await page.goto('/workspaces/ws_bio?study=assignments');
  await openQuizField(page);
  await makerRow(page, m.dashboard_make_quiz()).click();
  await expect(page).toHaveURL(/make=files/);
  await page
    .getByRole('dialog')
    .getByRole('button', { exact: true, name: m.action_cancel() })
    .click();
  await expect(page).toHaveURL(/study=assignments/);
  await expect(page).not.toHaveURL(/make=/);
  await expect(
    page.getByRole('button', { name: m.assignment_new() }).first()
  ).toBeVisible();
});

test('Generate questions stays on Assignments with the quiz in the list', async ({
  page,
}) => {
  await page.goto('/workspaces/ws_bio?study=assignments');
  await openQuizField(page);
  const quizzes = page.locator('[data-radix-popper-content-wrapper] ul button');
  await expect(quizzes.first()).toBeVisible();
  const before = await quizzes.count();
  await makerRow(page, m.assignment_generate_questions()).click();

  const dialog = page.getByRole('dialog', {
    name: m.assignment_generate_questions(),
  });
  await dialog
    .getByRole('button', { exact: true, name: m.review_start() })
    .click();
  await expect(dialog).toBeHidden({ timeout: 30_000 });
  await expect(page).toHaveURL(/study=assignments/);

  await openQuizField(page);
  await expect(quizzes).toHaveCount(before + 1);
});

test('from the Dashboard, Make a quiz opens its dialog', async ({ page }) => {
  await page.goto('/workspaces/ws_bio');
  await openQuizField(page);
  await makerRow(page, m.dashboard_make_quiz()).click();
  await expect(page).toHaveURL(/make=files/);
  await expect(
    page.getByRole('dialog', { name: m.dashboard_make_quiz() })
  ).toBeVisible();
});

test('from the Dashboard, Generate questions opens its dialog', async ({
  page,
}) => {
  await page.goto('/workspaces/ws_bio');
  await openQuizField(page);
  await makerRow(page, m.assignment_generate_questions()).click();
  await expect(
    page.getByRole('dialog', { name: m.assignment_generate_questions() })
  ).toBeVisible();
});
