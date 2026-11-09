import { expect, type Page, test } from '@playwright/test';
import { m } from '../i18n';

const PAGE = 'e2e/fixtures/files/images/flat.png';

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

// The board train's gates found no spec from a member's upload through Submit
// to staff: two pages handed in show in Approve's whole paper, and once marked
// and closed the paper lists under the member's Files › Submissions. Fails if
// Submit stops carrying the paper with the attempt.
test('a paper of two pages reaches Approve and Files › Submissions', async ({
  page,
}) => {
  test.slow();
  await page.addInitScript(() =>
    sessionStorage.setItem('capy.scenario.last', 'workspace-member')
  );
  await page.goto('/workspaces/ws_bio?study=assignments&assignment=as_upload');
  await page
    .getByRole('button', { exact: true, name: m.assignment_upload_file() })
    .click({ timeout: 30_000 });
  await page.getByRole('button', { name: m.sharing_notice_ok() }).click();
  await expect(
    page.getByRole('button', { name: m.assignment_paper_add() })
  ).toBeEnabled({ timeout: 30_000 });
  await page.locator('input[type=file]').first().setInputFiles([PAGE, PAGE]);
  await expect(page.locator('[data-paper-page="2"]')).toBeVisible({
    timeout: 15_000,
  });
  await page
    .getByRole('button', { exact: true, name: m.assignment_submit() })
    .first()
    .click();
  const submitted = page.waitForResponse(
    (response) =>
      response.url().includes('/submit') &&
      response.request().method() === 'POST'
  );
  await page
    .getByRole('dialog')
    .getByRole('button', { exact: true, name: m.assignment_submit() })
    .click();
  const { id: attemptId } = (await (await submitted).json()) as { id: string };

  await asScenario(
    page,
    null,
    '/workspaces/ws_bio?study=assignments&assignment=as_upload&tab=approve&member=u_1'
  );
  await page
    .getByRole('button', { name: m.assignment_paper_whole() })
    .first()
    .click({ timeout: 30_000 });
  await expect(page.locator('[data-paper-page="2"] img')).toBeVisible({
    timeout: 15_000,
  });

  // Staff mark what waits and close the assignment.
  await page.evaluate(async (id) => {
    const json = { 'Content-Type': 'application/json' };
    const attempt = (await (
      await fetch(`/api/assignment-attempts/${id}`)
    ).json()) as {
      questions: { id: string; parts: { id: string; pending?: boolean }[] }[];
    };
    for (const question of attempt.questions) {
      const parts = question.parts
        .filter((part) => part.pending)
        .map((part) => ({ mark: 0, partId: part.id }));
      if (parts.length)
        await fetch(`/api/assignment-attempts/${id}/marks`, {
          body: JSON.stringify({ parts, questionId: question.id }),
          headers: json,
          method: 'POST',
        });
    }
    await fetch('/api/assignments/as_upload/closed', {
      body: JSON.stringify({ closed: true }),
      headers: json,
      method: 'PUT',
    });
  }, attemptId);

  // Both files, each linking to the attempt they were handed in with.
  await asScenario(page, 'workspace-member', '/files?tab=submissions');
  await expect(
    page.locator(`a[href$="/quizzes/attempts/${attemptId}"]`)
  ).toHaveCount(2, { timeout: 30_000 });
});
