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
  const ASSIGNMENT = '/workspaces/ws_bio?study=assignments&assignment=as_paper';
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() =>
      sessionStorage.setItem('capy.scenario.last', 'workspace-member')
    );
  });
  const start = async (page: Page) => {
    await page.goto(ASSIGNMENT);
    await page
      .getByRole('button', { exact: true, name: m.assignment_start() })
      .click({ timeout: 30_000 });
    await page.getByRole('button', { name: m.sharing_notice_ok() }).click();
  };

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
    const second = strip.getByRole('button', {
      name: m.assignment_question_n({ number: 2 }),
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

  test('the list on a wider screen says which are answered', async ({
    page,
  }) => {
    await start(page);
    await page.getByText('Mitochondria', { exact: true }).click();
    await expect(
      rows(page).first().getByRole('img', {
        name: m.assignment_legend_answered(),
      })
    ).toBeVisible({ timeout: 30_000 });
    await expect(
      page.getByRole('button', {
        name: m.assignment_question_n({ number: 2 }),
      })
    ).toBeHidden();
  });
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
