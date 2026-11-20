import { expect, test } from '@playwright/test';
import { m } from '../i18n';

/** A row's AI grade to approve: its grade in a purple chip titled To approve
 * (the question already says AI marked; Epo 2026-11-19). */
const AI_GRADE = `[title="${m.assignment_section_to_approve()}"]`;

// Epo 2026-11-03: what the AI has not graded waits until the owner runs it; its
// grades wait for approval, and Approve all takes a question's. On Approve AI
// grades (Epo 2026-11-14) such an answer's row reads Not graded and its pane
// says why (mock T3): Ben Lee's grade failed, Farah Ali had no credits.
test('Grade with AI fills the waiting grades, and Approve all takes them', async ({
  page,
}) => {
  await page.goto(
    '/workspaces/ws_bio/assignments?assignment=as_paper&tab=grading'
  );
  const answers = page.locator('[data-answer-row]');
  await expect(
    answers.filter({ hasText: m.assignment_not_graded_badge() }).first()
  ).toBeVisible({ timeout: 60_000 });
  await answers.filter({ hasText: 'Ben Lee' }).click();
  await expect(page.getByText(m.assignment_not_graded_error())).toBeVisible();
  await answers.filter({ hasText: 'Farah Ali' }).first().click();
  await expect(page.getByText(m.assignment_not_graded_credits())).toBeVisible();
  const approveAll = page.getByRole('button', {
    exact: true,
    name: m.assignment_approve_all(),
  });
  await expect(approveAll).toBeDisabled();

  // Grade with AI runs on every answer the AI has not graded: Ben's one,
  // Farah's two and Gus's two (src/mocks/assignments.ts).
  await page
    .getByRole('button', {
      exact: true,
      name: m.assignment_grade_count_with_ai({ count: 5 }),
    })
    .click();
  await expect(answers.first().locator(AI_GRADE)).toBeVisible({
    timeout: 15_000,
  });
  await expect(
    answers.filter({ hasText: m.assignment_not_graded_badge() })
  ).toHaveCount(0);
  await expect(approveAll).toBeEnabled();

  // A broken rule shows above the marking points, and clears from the answer.
  const warning = page.locator('[data-ai-warning]');
  await expect(warning).toHaveText('Offered two answers for one point.');
  await page
    .getByRole('button', { exact: true, name: m.assignment_clear_warning() })
    .click();
  await expect(warning).toHaveCount(0);
  await expect(
    page.getByRole('button', {
      exact: true,
      name: m.assignment_clear_warning(),
    })
  ).toHaveCount(0);

  await approveAll.click();
  await expect(answers.locator(AI_GRADE)).toHaveCount(0, { timeout: 15_000 });
  await expect(approveAll).toBeDisabled();
});
