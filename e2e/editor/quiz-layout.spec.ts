import { expect, type Page, test } from '@playwright/test';
import { startAssignmentAsMember } from '../helpers/assignments';
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
});

test('a phone shows the list, then one question with a way back', async ({
  page,
}) => {
  await page.setViewportSize({ height: 740, width: 360 });
  await page.goto(STUDY);
  const back = page.getByRole('button', {
    name: m.quiz_editor_all_questions(),
  });
  await expect(rows(page).first()).toBeVisible({ timeout: 30_000 });
  await expect(back).toBeHidden();
  await rows(page).nth(2).click();
  await expect(back).toBeVisible();
  await expect(back).toBeFocused();
  await expect(rows(page).first()).toBeHidden();
  await back.click();
  await expect(rows(page).nth(2)).toBeFocused();
  await expect(
    page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth
    )
  ).resolves.toBeLessThanOrEqual(0);
});

test('the list keeps the open question in view, and each opens at its top', async ({
  page,
}) => {
  await page.setViewportSize({ height: 420, width: 1280 });
  await page.goto('/workspaces/ws_bio?material=qz_bio_near');
  await expect(rows(page).first()).toBeVisible({ timeout: 30_000 });
  const pane = page.locator('[data-quiz-pane]');
  await pane.evaluate((box) => {
    box.scrollTop = 500;
  });
  await rows(page).nth(14).scrollIntoViewIfNeeded();
  await rows(page).nth(14).click();
  await expect(pane).toHaveJSProperty('scrollTop', 0);
  await expect(rows(page).nth(14)).toBeInViewport();
});

test.describe('taking an assignment', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() =>
      sessionStorage.setItem('capy.scenario.last', 'workspace-member')
    );
  });
  const start = (page: Page) => startAssignmentAsMember(page, 'as_paper');

  test('a phone has a strip of numbers and no header, with its clock, Submit and a way out', async ({
    page,
  }) => {
    await page.setViewportSize({ height: 740, width: 360 });
    await start(page);
    const take = page.locator('[data-assignment-take]');
    const strip = take.getByRole('navigation', {
      name: m.assignment_questions_nav(),
    });
    await expect(strip).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('[data-center-header]')).toBeHidden();
    await expect(page.locator('[data-chat-dock]')).toBeHidden();
    await expect(
      take.getByRole('button', { name: m.assignment_submit() }).last()
    ).toBeVisible();
    await expect(rows(page).first()).toBeHidden();
    await page.getByText('Mitochondria', { exact: true }).click();
    // Its name goes on with its state ("Question 2, Not answered"), and 20
    // and 21 start the same.
    const second = strip.getByRole('button', {
      name: new RegExp(`^${m.assignment_question_n({ number: 2 })}(,|$)`),
    });
    await second.click();
    await expect(second).toHaveAttribute('aria-current', 'step');
    await expect(
      strip.getByRole('button', {
        name: `${m.assignment_question_n({ number: 1 })}, ${m.assignment_legend_answered()}`,
      })
    ).toBeVisible();
    await take.getByRole('link', { name: m.assignment_leave() }).click();
    await expect(take).toHaveCount(0);
    await expect(page.locator('[data-center-header]')).toBeVisible();
  });

  // A wider screen lists the numbers as a grid (Epo 2026-11-19), not the
  // phone's strip.
  test('the grid on a wider screen says which are answered', async ({
    page,
  }) => {
    await start(page);
    await page.getByText('Mitochondria', { exact: true }).click();
    const take = page.locator('[data-assignment-take]');
    await expect(
      take.getByRole('button', {
        name: `${m.assignment_question_n({ number: 1 })}, ${m.assignment_legend_answered()}`,
      })
    ).toBeVisible({ timeout: 30_000 });
    // One set of the paper's 21 numbers: the grid's, the strip hidden.
    await expect(
      take.getByRole('button', {
        name: new RegExp(
          `^${m.assignment_question_n({ number: 0 }).replace('0', '\\d+')}, `
        ),
      })
    ).toHaveCount(21);
  });
});
