/* biome-ignore-all lint/suspicious/noMisplacedAssertion: The helpers execute only inside the Make a quiz specs. */
// The Make a quiz steps a Word or PowerPoint paper takes in the browser, shared by the
// spec on the mock (e2e/editor/make-quiz-office.spec.ts) and the one on UAT
// (e2e/uat/journeys/makeQuiz.spec.ts). Each reads data and attributes only.
import {
  type ConsoleMessage,
  expect,
  type Page,
  type Request,
} from '@playwright/test';
import { m } from '../i18n';

/** Two pages each: page 1 holds questions 1 and 2, page 2 question 3
 * (e2e/fixtures/files/make-quiz/README.md). */
export const QUIZ_PAPERS = [
  { format: 'docx', name: 'paper.docx' },
  { format: 'pptx', name: 'paper.pptx' },
] as const;

export const quizDialog = (page: Page) => page.getByRole('dialog');

export const quizPanel = (page: Page) =>
  page.getByTestId('source-transfer-panel');

/** A page of the file on show in the pages step. */
export const pageSheet = (page: Page, number: number) =>
  page.locator(`[role=group]:not([hidden]) [data-page-sheet="${number}"]`);

/** Keeps each run's request as the page sends it: Playwright doesn't see one the
 * mock's service worker answers, so both specs read them the same way. */
export function keepRunRequests(page: Page) {
  return page.addInitScript(() => {
    const kept: unknown[] = [];
    Object.assign(window, { capyQuizRunRequests: kept });
    const send = window.fetch;
    window.fetch = (input, init) => {
      if (init?.method === 'POST' && String(input).endsWith('/extractions'))
        kept.push(JSON.parse(String(init.body)));
      return send(input, init);
    };
  });
}

export interface SentRun {
  answers: { fileId: string; images?: string[]; pages: number[] }[];
  paper: { fileId: string; images?: string[]; pages: number[] }[];
  title: string;
}

/** The runs this page has asked for, oldest first. */
export const sentRuns = (page: Page) =>
  page.evaluate(
    () =>
      (window as unknown as { capyQuizRunRequests: SentRun[] })
        .capyQuizRunRequests
  );

/** Upload a file, from the files step's first menu. */
export async function uploadPaper(page: Page, name: string, buffer: Buffer) {
  await quizDialog(page)
    .getByRole('button', { name: m.make_quiz_choose_file() })
    .click({ timeout: 30_000 });
  const chooser = page.waitForEvent('filechooser');
  // Upload a file waits for the workspace's upload policy.
  await page.getByRole('button', { name: m.make_quiz_upload_file() }).click();
  await (await chooser).setFiles({
    buffer,
    mimeType: 'application/octet-stream',
    name,
  });
}

/** Continue on a file still being read: the dialog gives way to the upload panel,
 * whose row is the upload's while it reads. */
export async function continueWhileReading(page: Page, name: string) {
  const next = quizDialog(page).getByRole('button', {
    name: m.action_continue(),
  });
  await expect(next).toBeEnabled({ timeout: 60_000 });
  await next.click();
  await expect(quizDialog(page)).toHaveCount(0);
  const panel = quizPanel(page);
  await expect(panel.getByText(name)).toBeVisible();
  await expect(panel.locator('[data-quiz-wait]')).toHaveCount(0);
}

/** The panel's Make quiz, once the file is read: reopens at the pages step, and
 * answers which file it opened. */
export async function makeQuizFromPanel(page: Page, timeout = 60_000) {
  await quizPanel(page)
    .locator('[data-quiz-wait=ready]')
    .getByRole('button', { name: m.make_quiz_make_action() })
    .click({ timeout });
  await expect(page).toHaveURL(/make=pages/);
  await expect(
    page.getByRole('heading', { name: m.make_quiz_pages_title() })
  ).toBeVisible();
  const paper = new URL(page.url()).searchParams.get('paper');
  if (!paper) throw new Error('The pages step names no paper');
  return paper;
}

export interface DrawnSheet {
  base64: string;
  height: number;
  /** Pixels darker than mid grey: a page with nothing drawn has none. */
  ink: number;
  width: number;
}

/** Waits for the Office runtime to draw `count` pages and answers each: the frame that
 * drew them goes, and a sheet shows the JPEG the run would be sent. */
export async function drawnSheets(page: Page, count: number) {
  await expect(page.locator('iframe[src*="office-runtime"]')).toBeAttached({
    timeout: 30_000,
  });
  const sheets = page.locator('[role=group]:not([hidden]) [data-page-sheet]');
  // What the page and its frame saw, for a failure on a deployed host, which keeps no
  // trace of the frame.
  const heard: string[] = [];
  const onConsole = (message: ConsoleMessage) => {
    if (message.type() === 'error') heard.push(message.text().slice(0, 200));
  };
  const onFailed = (request: Request) => {
    heard.push(
      `${request.failure()?.errorText} ${request.url().split('?')[0]}`
    );
  };
  page.on('console', onConsole);
  page.on('requestfailed', onFailed);
  try {
    await expect(sheets).toHaveCount(count, { timeout: 120_000 });
  } catch (cause) {
    const alerts = await page.getByRole('alert').allInnerTexts();
    const frames = await page.locator('iframe[src*="office-runtime"]').count();
    throw new Error(
      `${count} pages not drawn: ${await sheets.count()} sheets, ${frames} frames, alerts ${JSON.stringify(alerts)}, heard ${JSON.stringify(heard.slice(-12))}`,
      { cause }
    );
  } finally {
    page.off('console', onConsole);
    page.off('requestfailed', onFailed);
  }
  await expect(page.locator('iframe[src*="office-runtime"]')).toHaveCount(0);
  const drawn: DrawnSheet[] = [];
  for (const sheet of await sheets.all()) {
    await expect(sheet).toHaveAttribute('aria-pressed', 'false');
    drawn.push(
      await sheet.locator('img').evaluate(async (image: HTMLImageElement) => {
        await image.decode();
        const canvas = new OffscreenCanvas(
          image.naturalWidth,
          image.naturalHeight
        );
        const context = canvas.getContext('2d');
        if (!context) throw new Error('No canvas to read the page with');
        context.drawImage(image, 0, 0);
        const { data } = context.getImageData(
          0,
          0,
          canvas.width,
          canvas.height
        );
        let ink = 0;
        for (let at = 0; at < data.length; at += 4)
          if (data[at] + data[at + 1] + data[at + 2] < 384) ink += 1;
        return {
          base64: image.src.replace(/^data:image\/jpeg;base64,/, ''),
          height: image.naturalHeight,
          ink,
          width: image.naturalWidth,
        };
      })
    );
  }
  return drawn;
}

/** A real page of `format`: a Word page stands, a slide lies, each holds ink, none is a
 * copy of another, and each is the JPEG the sheet says. */
export function expectRealPages(drawn: DrawnSheet[], format: 'docx' | 'pptx') {
  for (const page of drawn) {
    expect(page.base64.startsWith('/9j/')).toBe(true);
    expect(page.ink).toBeGreaterThan(0);
    if (format === 'docx') expect(page.width).toBeLessThan(page.height);
    else expect(page.width).toBeGreaterThan(page.height);
  }
  expect(new Set(drawn.map((page) => page.base64)).size).toBe(drawn.length);
}

/** Selects `number` alone and presses Extract questions: the sheet says it is picked,
 * the bar counts one, and Extract waits for nothing. Answers the run's id. */
export async function extractPage(page: Page, number: number) {
  await pageSheet(page, number).click();
  await expect(pageSheet(page, number)).toHaveAttribute('aria-pressed', 'true');
  await expect(
    page.getByText(m.make_quiz_pages_count({ count: 1, max: 40 }))
  ).toBeVisible();
  await page.getByRole('button', { name: m.make_quiz_extract() }).click();
  await expect(page).toHaveURL(/make=run/, { timeout: 60_000 });
  const run = new URL(page.url()).searchParams.get('run');
  if (!run) throw new Error('The run step names no run');
  return run;
}
