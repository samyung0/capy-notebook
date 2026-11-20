import { expect, type Locator, type Page, test } from '@playwright/test';
import { m } from '../i18n';

/* Pressing Preview loads the code the note's blocks need first, the pane's
 * loader showing meanwhile, for at most 30 s; a block or part whose code could
 * not load, or had not arrived by then, says "This block cannot be shown" in
 * its place and the rest of Preview stays (Epo 2026-11-20). */

const MATRIX = '/workspaces/ws_bio?material=mat_note_bio_feature_matrix';
const DRAWING_QUIZ = '/workspaces/ws_bio?material=mat_e2e_drawing_quiz';
const DRAWING_QUIZ_ID = 'mat_e2e_drawing_quiz_embed';

const editable = (page: Page) =>
  page.locator('[data-slate-editor="true"][contenteditable="true"]');
const preview = (page: Page) => page.getByTestId('material-preview');
const loading = (page: Page) =>
  page.getByText(m.files_loading_preview(), { exact: true });
const notice = (scope: Locator) =>
  scope.getByText(m.material_unsupported_block(), { exact: true });
const pressPreview = (page: Page) =>
  page
    .getByRole('button', { exact: true, name: m.editor_embed_preview() })
    .click();

async function openNote(page: Page, url: string) {
  await page.goto(url);
  await expect(editable(page)).toBeVisible({ timeout: 30_000 });
}

/** Holds the requests `glob` matches until the returned call says how each
 * ends. */
async function hold(page: Page, glob: string) {
  let decide: (how: 'abort' | 'continue') => void = () => {};
  const decided = new Promise<'abort' | 'continue'>((resolve) => {
    decide = resolve;
  });
  await page.context().route(glob, async (route) => {
    if ((await decided) === 'abort') await route.abort();
    else await route.continue();
  });
  return decide;
}

/** The editor's embed of the drawing quiz, once it shows question `number`. */
const editorQuestion = (page: Page, number: number) =>
  expect(
    page
      .locator('[data-note-mount="live"] .slate-material_ref')
      .getByRole('button', {
        exact: true,
        name: m.question_ui_edit_question_number({ number }),
      })
  ).toBeVisible({ timeout: 30_000 });

/** Preview has not drawn a second on, its loader showing. */
async function stillLoading(page: Page) {
  await expect(loading(page)).toBeVisible();
  await page.waitForTimeout(1000);
  await expect(preview(page)).toHaveCount(0);
  await expect(loading(page)).toBeVisible();
}

test("Preview shows the pane's loader until its blocks' code has loaded", async ({
  page,
}) => {
  test.setTimeout(120_000);
  // An HTML embed's View source, which the editor never loaded.
  const decide = await hold(page, '**/HtmlEmbedSourceDialog.tsx*');
  await openNote(page, MATRIX);
  await pressPreview(page);
  await stillLoading(page);
  decide('continue');
  await expect(preview(page)).toBeVisible({ timeout: 30_000 });
  await expect(loading(page)).toHaveCount(0);
  await expect(notice(preview(page))).toHaveCount(0);
});

test('a drawing part whose board could not load offline says so, and the rest of the quiz answers; back online, Reload is offered', async ({
  page,
}) => {
  test.setTimeout(120_000);
  // The drawing board's code, which Preview asks for, never reaches this tab.
  const decide = await hold(page, '**/DrawingBoardScreen.tsx*');
  // MSW answers from its worker even offline: reads fail in the page instead.
  await page.addInitScript(() => {
    const original = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (sessionStorage.getItem('e2e.reads.fail') && url.includes('/api/'))
        return Promise.reject(new TypeError('Failed to fetch'));
      return original(input, init);
    };
  });
  await openNote(page, DRAWING_QUIZ);
  await editorQuestion(page, 2);
  await page.evaluate(async () => {
    const path = '/src/mocks/collaboration.ts';
    const { setCollaborationReachable } = await import(path);
    setCollaborationReachable(false);
    sessionStorage.setItem('e2e.reads.fail', 'true');
  });
  await pressPreview(page);
  // Preview waits for the board its drawing part opens; the device goes
  // offline before the load fails.
  await stillLoading(page);
  await page.context().setOffline(true);
  decide('abort');
  const quiz = preview(page).locator('.slate-material_ref');
  await expect(quiz.getByText('Sketch an animal cell')).toBeVisible({
    timeout: 30_000,
  });
  await expect(notice(quiz)).toBeVisible();
  await expect(
    quiz.getByRole('button', { name: m.drawing_answer_draw() })
  ).toHaveCount(0);
  const answer = quiz.getByRole('button', { name: /Nucleus/ });
  await answer.click();
  await expect(answer).toHaveAttribute('aria-pressed', 'true');
  // No error toast offline: the page's own offline toast shares its title, so
  // its words tell them apart.
  const reload = page.getByRole('button', {
    exact: true,
    name: m.error_action_reload(),
  });
  await expect(reload).toHaveCount(0);
  await expect(
    page.getByText(m.error_offline_body(), { exact: true })
  ).toHaveCount(0);
  // Back online, the reload that brings the board is offered once.
  await page.context().setOffline(false);
  await expect(reload).toBeVisible({ timeout: 10_000 });
  await expect(reload).toHaveCount(1);
  await expect(
    page.getByText(m.error_chunk_offline_title(), { exact: true })
  ).toBeVisible();
});

test("a graph whose engine could not load says so in the graph's place, in Edit and in Preview", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page
    .context()
    .route('**/src/features/questions/graphPaint.ts*', (route) =>
      route.abort()
    );
  await openNote(page, MATRIX);
  const graph = page.locator('[data-note-mount="live"] .slate-graph');
  await graph.scrollIntoViewIfNeeded();
  await expect(notice(graph)).toBeVisible({ timeout: 30_000 });
  await expect(graph.locator('canvas')).toHaveCount(0);
  await pressPreview(page);
  await expect(notice(preview(page).locator('.slate-graph'))).toBeVisible({
    timeout: 30_000,
  });
  await expect(preview(page)).toContainText('Block equation');
  // Online, the error toast offers Reload: the failed import stays failed
  // until the page reloads.
  await expect(
    page.getByRole('button', { exact: true, name: m.error_action_reload() })
  ).toBeVisible();
});

test("Preview waits for the code of the quiz the editor's room holds, not its stored read", async ({
  page,
}) => {
  test.setTimeout(120_000);
  // The stored reads lack the drawing question; the room has it.
  await page.addInitScript((quizId) => {
    const original = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const response = await original(input, init);
      const url = input instanceof Request ? input.url : String(input);
      const path = new URL(url, location.href).pathname;
      const quizPath = `/api/quizzes/${quizId}`;
      if (path !== quizPath && path !== `${quizPath}/edit`) return response;
      const quiz = await response.json();
      quiz.questions = quiz.questions.filter(
        (question: { id: string }) => !question.id.endsWith(':drawing')
      );
      return new Response(JSON.stringify(quiz), {
        headers: response.headers,
        status: response.status,
      });
    };
  }, DRAWING_QUIZ_ID);
  const decide = await hold(page, '**/DrawingBoardScreen.tsx*');
  await openNote(page, DRAWING_QUIZ);
  // Only the room shows a second question.
  await editorQuestion(page, 2);
  const stored = await page.evaluate(async (quizId) => {
    const path = '/src/api/queryClient.ts';
    const { queryClient } = await import(path);
    return queryClient.getQueryData(['quiz', quizId])?.questions.length;
  }, DRAWING_QUIZ_ID);
  expect(stored).toBe(1);
  await pressPreview(page);
  await stillLoading(page);
  decide('continue');
  const quiz = preview(page).locator('.slate-material_ref');
  await expect(
    quiz.getByRole('button', { name: m.drawing_answer_draw() })
  ).toBeVisible({ timeout: 30_000 });
  await expect(notice(quiz)).toHaveCount(0);
});

test('at 30 s Preview draws, and a block whose code has not arrived says so until Preview opens again', async ({
  page,
}) => {
  test.setTimeout(120_000);
  // Time runs as usual, and jumps where the test says.
  await page.clock.install();
  const decide = await hold(page, '**/src/features/questions/graphPaint.ts*');
  await openNote(page, MATRIX);
  await pressPreview(page);
  await stillLoading(page);
  await page.clock.fastForward(30_000);
  const graph = preview(page).locator('.slate-graph');
  await expect(notice(graph)).toBeVisible({ timeout: 30_000 });
  await expect(preview(page)).toContainText('Block equation');
  await expect(loading(page)).toHaveCount(0);
  // The engine arriving now leaves this open's notice.
  const arrived = page.waitForResponse(
    '**/src/features/questions/graphPaint.ts*'
  );
  decide('continue');
  await arrived;
  await page.waitForTimeout(500);
  await expect(notice(graph)).toBeVisible();
  // Opened again, Preview checks again: the engine is here.
  await page
    .getByRole('button', { exact: true, name: m.action_edit() })
    .click();
  await expect(
    page.getByRole('button', { exact: true, name: m.editor_embed_preview() })
  ).toBeVisible();
  await pressPreview(page);
  await expect(graph.locator('canvas')).toBeVisible({ timeout: 30_000 });
  await expect(notice(graph)).toHaveCount(0);
});
