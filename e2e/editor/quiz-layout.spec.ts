import { expect, type Page, test } from '@playwright/test';
import { m } from '../i18n';

/* A quiz's one layout (Epo 2026-11-06): the question list on the left, one
 * question on the right; on a phone the list, then the question. */

const STUDY = '/quizzes/qz_1/attempt';
const rows = (page: Page) => page.locator('[data-question-row]');
const current = (page: Page) =>
  page.locator('[data-question-row][aria-current]');
const button = (page: Page, name: string) =>
  page.getByRole('button', { exact: true, name });

test('study takes one question at a time and marks it in the list', async ({
  page,
}) => {
  await page.goto(STUDY);
  await expect(rows(page).first()).toBeVisible({ timeout: 30_000 });
  await expect(rows(page)).toHaveCount(12);
  await expect(page.locator('[data-question-id]')).toHaveCount(1);
  await expect(button(page, m.action_previous())).toHaveCount(0);
  await page.getByText('Mitochondria', { exact: true }).click();
  await button(page, m.question_ui_check()).click();
  await expect(rows(page).first().locator('svg')).toBeVisible();
  await expect(
    page.getByText(
      m.quiz_study_progress({
        awarded: 1,
        checked: 1,
        marks: 1,
        total: 12,
      })
    )
  ).toBeVisible();
  await button(page, m.action_next()).click();
  await expect(current(page)).toHaveAttribute(
    'data-question-row',
    (await rows(page).nth(1).getAttribute('data-question-row')) ?? ''
  );
  await button(page, m.action_previous()).click();
  await expect(current(page)).toHaveAttribute(
    'data-question-row',
    (await rows(page).first().getAttribute('data-question-row')) ?? ''
  );
  // Picked up again, it opens at the first question not checked.
  await rows(page).nth(5).click();
  await expect(page.locator('[data-question-id]')).toHaveCount(1);
});

test('a phone shows the list, then one question with a way back', async ({
  page,
}) => {
  await page.setViewportSize({ height: 740, width: 360 });
  await page.goto(STUDY);
  const back = page.getByRole('button', {
    name: m.quiz_editor_all_questions(),
  });
  await expect(back).toBeVisible({ timeout: 30_000 });
  await expect(rows(page).first()).toBeHidden();
  await back.click();
  await expect(rows(page).first()).toBeVisible();
  await expect(back).toBeHidden();
  await rows(page).nth(2).click();
  await expect(back).toBeVisible();
  await expect(rows(page).first()).toBeHidden();
  const overflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth
  );
  expect(overflow).toBeLessThanOrEqual(0);
});

test("the editor's add button lines up with the rows' marks", async ({
  page,
}) => {
  await page.goto('/workspaces/ws_bio?material=qz_1');
  const add = page.getByRole('button', { name: m.quiz_add_question() });
  await expect(add).toBeVisible({ timeout: 30_000 });
  const plus = await add.locator('svg').boundingBox();
  const marks = await rows(page).first().locator('span').last().boundingBox();
  expect(
    Math.abs(
      (plus?.x ?? 0) +
        (plus?.width ?? 0) -
        (marks?.x ?? 0) -
        (marks?.width ?? 0)
    )
  ).toBeLessThanOrEqual(1.5);
});
