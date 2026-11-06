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
