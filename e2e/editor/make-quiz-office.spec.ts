import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import {
  continueWhileReading,
  drawnSheets,
  expectRealPages,
  extractPage,
  keepRunRequests,
  makeQuizFromPanel,
  pageSheet,
  QUIZ_PAPERS,
  sentRuns,
  uploadPaper,
} from '../helpers/makeQuiz';
import { m } from '../i18n';
import { hideScenarioPanel } from './helpers';

// Make a quiz on the mock with the real Office runtime: the paper is read by the mock,
// and its pages drawn by the engines. e2e/uat/journeys/makeQuiz.spec.ts takes the same
// papers through a real run on UAT.
for (const { format, name } of QUIZ_PAPERS) {
  test(`a ${format} still reading reopens from the panel, its pages drawn by the engine and the picked one sent`, async ({
    page,
  }) => {
    // The first frame on a cold dev server compiles the runtime and its engine.
    test.setTimeout(240_000);
    await keepRunRequests(page);
    await page.goto('/workspaces/ws_bio');
    await page
      .getByRole('button', { name: m.dashboard_make_quiz() })
      .click({ timeout: 30_000 });
    await uploadPaper(
      page,
      name,
      readFileSync(
        new URL(`../fixtures/files/make-quiz/${name}`, import.meta.url)
      )
    );
    await continueWhileReading(page, name);
    const fileId = await makeQuizFromPanel(page);

    const drawn = await drawnSheets(page, 2);
    expectRealPages(drawn, format);

    await hideScenarioPanel(page);
    await extractPage(page, 2);
    expect(await sentRuns(page)).toEqual([
      {
        answers: [],
        paper: [{ fileId, images: [drawn[1].base64], pages: [2] }],
        title: 'paper',
      },
    ]);
    // Cancel on the mock's questions found goes back with the pick still on.
    await expect(
      page.getByRole('heading', {
        name: m.make_quiz_found_title({ count: 12 }),
      })
    ).toBeVisible({ timeout: 30_000 });
    await page
      .getByRole('dialog')
      .getByRole('button', { name: m.action_cancel() })
      .click();
    await expect(pageSheet(page, 2)).toHaveAttribute('aria-pressed', 'true', {
      timeout: 30_000,
    });
  });
}

// A real file's link is a presigned bucket URL, on another origin from the app, which the
// mock's are not: the page count reads the bytes here, as the analysis worker refuses it.
test('a Word file on a bucket shows its pages and its count', async ({
  page,
}) => {
  test.setTimeout(240_000);
  await page.goto('/workspaces/ws_bio');
  await page
    .getByRole('button', { name: m.dashboard_make_quiz() })
    .click({ timeout: 30_000 });
  await uploadPaper(
    page,
    'paper.docx',
    readFileSync(
      new URL('../fixtures/files/make-quiz/paper.docx', import.meta.url)
    )
  );
  await continueWhileReading(page, 'paper.docx');
  await page.evaluate(() => {
    const real = window.fetch;
    const bucket = 'https://bucket.example.test/';
    window.fetch = async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith(bucket))
        return real(decodeURIComponent(url.slice(bucket.length)));
      const response = await real(input, init);
      if (!/\/api\/files\/[^/]+\/links$/.test(url)) return response;
      const links = await response.json();
      return Response.json({
        ...links,
        url: bucket + encodeURIComponent(links.url),
      });
    };
  });
  await makeQuizFromPanel(page);
  await drawnSheets(page, 2);
  await page.getByRole('button', { name: m.make_quiz_change_files() }).click();
  await expect(
    page
      .getByRole('dialog')
      .getByText(m.source_pages({ count: 2 }), { exact: true })
  ).toBeVisible({ timeout: 30_000 });
});
