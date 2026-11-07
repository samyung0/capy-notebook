import { expect, type Locator, type Page, test } from '@playwright/test';
import { m } from '../i18n';

/**
 * A drawing answer from the board to its marks: practice draws, Done and Check,
 * marked by the mock's stand-in for the vision model (a drawing earns every
 * point but the last); an assignment's member draws, Done stores the drawing,
 * and Submit hands it in; its owner runs Mark with AI on it and approves. On a
 * phone and on desktop.
 */

const SCREENS = [
  { screen: 'a phone', width: 360 },
  { screen: 'desktop', width: 1280 },
];
/** qz_2's drawing part: two marking points of one mark each. */
const DRAWN = 'q_draw';

/** Opens the part's board, draws one stroke across its middle, and presses Done. */
async function drawAndDone(page: Page, question: Locator) {
  await question.getByRole('button', { name: m.drawing_answer_draw() }).click();
  const board = page.locator('.answer-board');
  await expect(board.locator('edgeless-pen-tool-button').first()).toBeVisible({
    timeout: 60_000,
  });
  await board.locator('edgeless-pen-tool-button').first().click();
  const { height, width } = page.viewportSize() ?? { height: 0, width: 0 };
  await page.mouse.move(width * 0.45, height * 0.42);
  await page.mouse.down();
  for (let step = 1; step <= 12; step++)
    await page.mouse.move(
      width * (0.45 + step * 0.01),
      height * (0.42 + step * 0.008)
    );
  await page.mouse.up();
  await board
    .getByRole('button', { exact: true, name: m.drawing_board_done() })
    .first()
    .click();
  await expect(board).toHaveCount(0, { timeout: 30_000 });
}

/** The dev server's mock scenario panel sits over a phone's board toolbar. */
const hideMockPanel = (page: Page) =>
  page.addStyleTag({
    content:
      '[data-testid="mock-scenario-panel"] { display: none !important; }',
  });

/** The part's question by its row in the list, or on an assignment's phone
 * page, where the list is hidden, by its number in the strip above. */
async function openQuestion(page: Page) {
  const row = page.locator(`[data-question-row="${DRAWN}"]`).first();
  await row.waitFor({ state: 'attached', timeout: 60_000 });
  if (await row.isVisible()) await row.click();
  else {
    const number = await row.evaluate(
      (el) =>
        [...document.querySelectorAll('[data-question-row]')].indexOf(el) + 1
    );
    await page
      .getByRole('navigation', { name: m.assignment_questions_nav() })
      .getByRole('button', {
        name: new RegExp(`^${m.assignment_question_n({ number })}(,|$)`),
      })
      .click();
  }
  return page.locator(`[data-question-id="${DRAWN}"]`).first();
}

/** Switches the page's mocks to another scenario, keeping their data, and
 * opens url in this tab as a bookmark would. */
async function asScenario(page: Page, scenario: string | null, url: string) {
  await page.evaluate(
    async ({ id, to }) => {
      const [{ worker }, { getMockScenarioHandlers }, { queryClient }] =
        await Promise.all([
          import('/src/mocks/browser.ts' as string),
          import('/src/mocks/scenarios.ts' as string),
          import('/src/api/queryClient.ts' as string),
        ]);
      worker.resetHandlers();
      if (id) worker.use(...getMockScenarioHandlers(id));
      queryClient.clear();
      history.pushState({}, '', to);
      dispatchEvent(new PopStateEvent('popstate'));
    },
    { id: scenario, to: url }
  );
}

for (const { screen, width } of SCREENS) {
  test(`On ${screen}, practice draws, Done and Check marks the drawing`, async ({
    page,
  }) => {
    test.slow();
    await page.setViewportSize({ height: 800, width });
    await page.goto('/quizzes/qz_2/attempt');
    await hideMockPanel(page);
    const question = await openQuestion(page);
    await drawAndDone(page, question);
    await expect(
      question.getByRole('img', { name: m.drawing_answer_image() })
    ).toBeVisible();
    await question
      .getByRole('button', { exact: true, name: m.question_ui_check() })
      .click();
    // The stand-in model gives the first point and not the second.
    await expect(question.getByText('1 / 2').first()).toBeVisible({
      timeout: 30_000,
    });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth)
    ).toBeLessThanOrEqual(width);
  });

  test(`On ${screen}, a member's drawing goes in with Done and Submit, and the owner marks it with AI`, async ({
    page,
  }) => {
    test.slow();
    await page.setViewportSize({ height: 800, width });
    // A class member's page; the mock takes the owner's new assignment all the same.
    await page.addInitScript(() =>
      sessionStorage.setItem('capy.scenario.last', 'workspace-member')
    );
    await page.goto('/workspaces/ws_bio');
    await hideMockPanel(page);
    // A class tells a member once what it shares, before anything else.
    await page
      .getByRole('button', { name: m.sharing_notice_ok() })
      .click({ timeout: 60_000 });
    const assignment = await page.evaluate(async () => {
      const response = await fetch('/api/workspaces/ws_bio/assignments', {
        body: JSON.stringify({
          assignAll: true,
          assignees: [],
          attempts: 1,
          draft: false,
          dueAt: new Date(Date.now() + 86_400_000).toISOString(),
          files: [],
          kind: 'marked',
          latePenaltyPct: 0,
          marking: 'ai_approve',
          noLate: false,
          quizId: 'qz_2',
          showAnswers: true,
          shuffle: false,
          title: 'Drawn answers',
        }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      });
      return ((await response.json()) as { id: string }).id;
    });

    // The member draws, and Done stores the drawing at once. With no time
    // limit the assignment opens straight into its attempt.
    await page.evaluate((to) => {
      history.pushState({}, '', to);
      dispatchEvent(new PopStateEvent('popstate'));
    }, `/workspaces/ws_bio?study=assignments&assignment=${assignment}`);
    const take = page.locator('[data-assignment-take]');
    await expect(take).toBeVisible({ timeout: 30_000 });
    await openQuestion(page);
    await drawAndDone(page, take);
    // Shown from the board Done stored (the mock serves it back by its id).
    await expect(
      take.getByRole('img', { name: m.drawing_answer_image() })
    ).toBeVisible();
    await page
      .getByRole('button', { exact: true, name: m.assignment_submit() })
      .first()
      .click();
    await page
      .getByRole('dialog')
      .getByRole('button', { exact: true, name: m.assignment_submit() })
      .click();
    await expect(take).toHaveCount(0, { timeout: 30_000 });

    // The owner: the drawing waits, Mark with AI marks it, Approve takes it.
    await page.evaluate(async (id) => {
      const { giveMockAttemptsTo } = await import(
        '/src/mocks/assignments.ts' as string
      );
      giveMockAttemptsTo(id, 'u_mock_sara');
    }, assignment);
    await asScenario(
      page,
      null,
      `/workspaces/ws_bio?study=assignments&assignment=${assignment}&tab=approve`
    );
    await expect(
      page.getByRole('img', { name: m.drawing_answer_image() })
    ).toBeVisible({ timeout: 60_000 });
    await page
      .getByRole('button', { exact: true, name: m.assignment_mark_with_ai() })
      .click();
    await expect(
      page.getByText(m.assignment_ai_mark({ mark: '1 / 2' })).first()
    ).toBeVisible({ timeout: 15_000 });
    await page
      .getByRole('button', { exact: true, name: m.assignment_approve() })
      .click();
    await expect(page.getByText('1 / 2').first()).toBeVisible();
  });
}
