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

/** Out of sight, the board is inert (its opacity is 0, which Playwright counts as
 * visible). */
const putAway = (page: Page) =>
  expect(page.locator('.answer-board')).toHaveAttribute('inert', '', {
    timeout: 30_000,
  });

/** Shows the board with a button of the page, ready to draw. */
async function showBoard(page: Page, open: Locator) {
  const board = page.locator('.answer-board');
  await expect(board.and(page.locator('[inert]'))).toHaveCount(1, {
    timeout: 60_000,
  });
  await open.click();
  await expect(board).not.toHaveAttribute('inert');
  await expect(board.locator('edgeless-pen-tool-button').first()).toBeVisible({
    timeout: 60_000,
  });
}

/** One pen stroke, `down` of the screen's height lower than the first. */
async function stroke(page: Page, down = 0) {
  await page.locator('.answer-board edgeless-pen-tool-button').first().click();
  const { height, width } = page.viewportSize() ?? { height: 0, width: 0 };
  await page.mouse.move(width * 0.45, height * (0.42 + down));
  await page.mouse.down();
  for (let step = 1; step <= 12; step++)
    await page.mouse.move(
      width * (0.45 + step * 0.01),
      height * (0.42 + down + step * 0.008)
    );
  await page.mouse.up();
}

const pressDone = (page: Page) =>
  page
    .locator('.answer-board')
    .getByRole('button', { exact: true, name: m.drawing_board_done() })
    .first()
    .click();

/** Opens the part's board, draws one stroke across its middle, and presses Done.
 * The board is mounted ahead out of sight while the question shows, so Draw only
 * shows it (fix 4), and Done puts it away again. */
async function drawAndDone(page: Page, question: Locator) {
  await showBoard(
    page,
    question.getByRole('button', { name: m.drawing_answer_draw() })
  );
  await stroke(page);
  await pressDone(page);
  await putAway(page);
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
          showAnswers: 'submitted',
          showGrades: 'automatic',
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

type BoardRoot = HTMLElement & {
  gfx: {
    layer: { blocks: unknown[]; canvasElements: { type: string }[] };
    selection: { selectedElements: unknown[] };
  };
};

test('a board put away after Done takes none of the page keys or pastes', async ({
  page,
}) => {
  test.slow();
  await page.setViewportSize({ height: 800, width: 1280 });
  await page.goto('/quizzes/qz_2/attempt');
  await hideMockPanel(page);
  const question = await openQuestion(page);
  await drawAndDone(page, question);

  // Edit drawing, select the stroke without changing it, and Done: the board is put
  // away out of sight, with nothing kept selected (putAway) and reopened from what
  // Done saved.
  await showBoard(
    page,
    question.getByRole('button', { name: m.drawing_answer_edit() })
  );
  await page.keyboard.press('v');
  await page.mouse.click(1280 * 0.51, 800 * 0.468);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            document.querySelector(
              '.answer-board affine-edgeless-root'
            ) as BoardRoot
          ).gfx.selection.selectedElements.length
      )
    )
    .toBe(1);
  await pressDone(page);
  await putAway(page);

  // Another answer on the page takes typing, Backspace and a paste.
  await page.evaluate(() => {
    const other = document.createElement('textarea');
    other.id = 'other-answer';
    document.body.append(other);
  });
  const other = page.locator('#other-answer');
  await other.click();
  await page.keyboard.type('ab');
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Delete');
  await other.evaluate((element) => {
    const data = new DataTransfer();
    data.setData('text/plain', 'pasted');
    element.dispatchEvent(
      new ClipboardEvent('paste', { bubbles: true, clipboardData: data })
    );
  });
  await expect(other).toHaveValue('a');
  // The drawing is as it was: its stroke, and nothing pasted onto it.
  expect(
    await page.evaluate(() => {
      const { layer } = (
        document.querySelector(
          '.answer-board affine-edgeless-root'
        ) as BoardRoot
      ).gfx;
      return {
        blocks: layer.blocks.length,
        canvas: layer.canvasElements.map((element) => element.type),
      };
    })
  ).toEqual({ blocks: 0, canvas: ['brush'] });
});

type Gfx = {
  doc: {
    addBlock(flavour: string, props: object, parent: string): string;
    blobSync: { set(blob: Blob): Promise<string> };
    getModelById(id: string): {
      text: { insert(text: string, at: number): void };
    };
    root: { id: string };
  };
  layer: { generateIndex(): string };
  surface: { id: string };
};

/** A note card and a pasted image on the open board, in its answer area. */
const addCardAndImage = (page: Page) =>
  page.evaluate(async () => {
    const { gfx } = document.querySelector(
      '.answer-board affine-edgeless-root'
    ) as unknown as { gfx: Gfx };
    const { doc } = gfx;
    const note = doc.addBlock(
      'affine:note',
      { index: gfx.layer.generateIndex(), xywh: '[200,200,320,120]' },
      doc.root.id
    );
    const paragraph = doc.addBlock('affine:paragraph', {}, note);
    doc.getModelById(paragraph).text.insert('Offspring: AA, Aa, aa', 0);
    const sourceId = await doc.blobSync.set(
      new Blob(
        [
          '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="120"><rect width="200" height="120" fill="#4dabf7"/></svg>',
        ],
        { type: 'image/svg+xml' }
      )
    );
    doc.addBlock(
      'affine:image',
      { index: gfx.layer.generateIndex(), sourceId, xywh: '[700,200,200,120]' },
      gfx.surface.id
    );
  });

const CARDS = '.answer-board :is(affine-edgeless-note, affine-edgeless-image)';

/** How many of the board's elements and cards show, and whether a pointer over
 * each card lands on the board. */
const boardSeen = (page: Page) =>
  page.evaluate((cards) => {
    const seen = (element: Element) =>
      element.checkVisibility({
        opacityProperty: true,
        visibilityProperty: true,
      });
    const board = document.querySelector('.answer-board') as HTMLElement;
    const placed = [...document.querySelectorAll(cards)];
    return {
      cardsShown: placed.filter(seen).length,
      hits: placed.map((card) => {
        const { height, width, x, y } = card.getBoundingClientRect();
        return Boolean(
          document
            .elementFromPoint(x + width / 2, y + height / 2)
            ?.closest('.answer-board')
        );
      }),
      shown: [board, ...board.querySelectorAll('*')].filter(seen).length,
    };
  }, CARDS);

/** Put away and mounted again from what Done saved: its card and image are drawn,
 * BlockSuite giving each an inline `visibility: visible`, and none of it shows. */
async function expectCardsUnseen(page: Page) {
  await putAway(page);
  await expect
    .poll(
      () =>
        page.evaluate(
          (cards) =>
            [...document.querySelectorAll(cards)].filter(
              (card) => getComputedStyle(card).visibility === 'visible'
            ).length,
          CARDS
        ),
      { timeout: 60_000 }
    )
    .toBe(2);
  expect(await boardSeen(page)).toEqual({
    cardsShown: 0,
    hits: [false, false],
    shown: 0,
  });
}

test('a board put away shows none of its note card or image, and Draw shows them', async ({
  page,
}) => {
  test.slow();
  await page.setViewportSize({ height: 800, width: 1280 });
  await page.goto('/quizzes/qz_2/attempt');
  await hideMockPanel(page);
  const question = await openQuestion(page);
  await showBoard(
    page,
    question.getByRole('button', { name: m.drawing_answer_draw() })
  );
  await addCardAndImage(page);
  await pressDone(page);
  await expectCardsUnseen(page);

  await question.getByRole('button', { name: m.drawing_answer_edit() }).click();
  await expect(page.locator('.answer-board')).not.toHaveAttribute('inert');
  await expect.poll(async () => (await boardSeen(page)).cardsShown).toBe(2);
});

test("a picture on an answer board is kept with the device's draft through Done and a reload", async ({
  page,
}) => {
  test.slow();
  await page.setViewportSize({ height: 800, width: 1280 });
  await page.goto('/quizzes/qz_2/attempt');
  await hideMockPanel(page);
  let question = await openQuestion(page);
  await showBoard(
    page,
    question.getByRole('button', { name: m.drawing_answer_draw() })
  );
  await addCardAndImage(page);
  await pressDone(page);
  await putAway(page);

  // Practice keeps the board on the device until Check: after a reload the
  // draft opens with the picture's file, which no server holds yet.
  await page.reload();
  await hideMockPanel(page);
  question = await openQuestion(page);
  await showBoard(
    page,
    question.getByRole('button', { name: m.drawing_answer_draw() })
  );
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document.querySelector<HTMLImageElement>(
            '.answer-board affine-edgeless-image img'
          )?.naturalWidth ?? 0
      )
    )
    .toBeGreaterThan(0);
});

test('a drawn sample put away in the quiz editor shows none of its note card or image', async ({
  page,
}) => {
  test.slow();
  await page.setViewportSize({ height: 800, width: 1280 });
  await page.goto('/materials/qz_2');
  await hideMockPanel(page);
  await page
    .locator(`[data-question-row="${DRAWN}"]`)
    .first()
    .click({ timeout: 60_000 });
  await showBoard(
    page,
    page.getByRole('button', { name: m.drawing_sample_draw() })
  );
  await addCardAndImage(page);
  await pressDone(page);
  const edit = page.getByRole('button', { name: m.drawing_sample_edit() });
  await expect(edit).toBeEnabled({ timeout: 30_000 });
  await expectCardsUnseen(page);

  await edit.click();
  await expect(page.locator('.answer-board')).not.toHaveAttribute('inert');
  await expect.poll(async () => (await boardSeen(page)).cardsShown).toBe(2);
});

/** The strokes the answer's drawing shows: one path each. */
const paths = async (image: Locator) =>
  decodeURIComponent((await image.getAttribute('src')) ?? '').split('<path ')
    .length - 1;

const brushes = (page: Page) =>
  page.evaluate(
    () =>
      (
        document.querySelector(
          '.answer-board affine-edgeless-root'
        ) as BoardRoot
      ).gfx.layer.canvasElements.filter(({ type }) => type === 'brush').length
  );

test('a board put away takes strokes when shown again, and the last stroke before Done stays', async ({
  page,
}) => {
  test.slow();
  await page.setViewportSize({ height: 800, width: 1280 });
  await page.goto('/quizzes/qz_2/attempt');
  await hideMockPanel(page);
  const question = await openQuestion(page);
  const draw = question.getByRole('button', { name: m.drawing_answer_draw() });
  const root = page.locator('.answer-board affine-edgeless-root');

  // Done on an empty board puts the same board away, not mounted again.
  await showBoard(page, draw);
  await root.evaluate((element) => element.setAttribute('data-kept', ''));
  await pressDone(page);
  await putAway(page);
  await showBoard(page, draw);
  await expect(root).toHaveAttribute('data-kept', '');

  // A stroke the device keeps, then another and Done within the draft's 800 ms.
  await stroke(page);
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const { localDrawingDraft } = await import(
            '/src/lib/localDb.ts' as string
          );
          return Boolean(await localDrawingDraft('quiz:qz_2:q_draw:part'));
        }),
      { timeout: 10_000 }
    )
    .toBe(true);
  await stroke(page, 0.1);
  await pressDone(page);
  await putAway(page);
  const drawing = question.getByRole('img', { name: m.drawing_answer_image() });
  await expect.poll(() => paths(drawing)).toBe(2);

  // Edit drawing has both, and the next Done keeps them with a third.
  await showBoard(
    page,
    question.getByRole('button', { name: m.drawing_answer_edit() })
  );
  await expect.poll(() => brushes(page)).toBe(2);
  await stroke(page, 0.2);
  await pressDone(page);
  await putAway(page);
  await expect.poll(() => paths(drawing)).toBe(3);
});
