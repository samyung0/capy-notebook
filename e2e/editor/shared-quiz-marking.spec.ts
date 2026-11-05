import { expect, test } from '@playwright/test';
import { m } from '../i18n';

// A shared page marks what has one right answer and leaves an open answer Not
// marked, with its marking points to compare (Epo 2026-11-05, Q640 B). MSW has no
// Clerk: `?anonymous` is the signed-out page and its absence the signed-in one,
// and a shared quiz treats them the same. A phone and a desktop.

const QUIZ = '/share/quizzes/qz_shared.mswSignature0000';
const NOTE = '/share/notes/nt_shared.mswSignature0000';
const SCREENS = [
  { screen: 'a phone', width: 360 },
  { screen: 'desktop', width: 1280 },
];
const CHECK = { exact: true, name: m.question_ui_check() };

for (const { query, visitor } of [
  { query: '?anonymous', visitor: 'A signed-out visitor' },
  { query: '', visitor: 'A signed-in visitor' },
])
  for (const { screen, width } of SCREENS)
    test(`${visitor} on ${screen}: a closed part marks, an open part stays Not marked`, async ({
      page,
    }) => {
      await page.setViewportSize({ height: 800, width });
      await page.goto(`${QUIZ}${query}`);
      await expect(page.locator('html')).toHaveAttribute('data-hydrated', '', {
        timeout: 30_000,
      });

      const closed = page.locator('[data-question-id="q2"]');
      await closed.getByText(m.question_ui_true(), { exact: true }).click();
      await closed.getByRole('button', CHECK).click();
      await expect(
        closed.getByText(m.question_ui_result_right()).first()
      ).toBeVisible();

      const open = page.locator('[data-question-id="q14"]');
      await open
        .getByRole('textbox', { name: m.question_ui_your_answer() })
        .first()
        .fill('The curve levels off because CO₂ limits the rate.');
      await open.getByRole('button', CHECK).click();
      await expect(
        open.getByText(m.assignment_not_marked(), { exact: true })
      ).toBeVisible();
      // Not marked is final here: nothing offers to check it again.
      await expect(open.getByRole('button', CHECK)).toHaveCount(0);
      await expect(
        open.getByRole('button', { name: m.question_ui_check_again() })
      ).toHaveCount(0);
      // The marking points and solution, closed until asked for.
      const scheme = open
        .getByText(m.question_ui_scheme_and_solution())
        .first();
      await scheme.click();
      await expect(
        open
          .getByText('Describes the low-CO₂ plateau', { exact: false })
          .first()
      ).toBeVisible();

      expect(
        await page.evaluate(() => document.documentElement.scrollWidth)
      ).toBeLessThanOrEqual(width);
    });

// The mock's embedded quiz has closed parts only; SharedQuiz.test.tsx and the
// server's test cover an embed's open part.
for (const { screen, width } of SCREENS)
  test(`A quiz embedded in a shared note on ${screen} checks through the note's link`, async ({
    page,
  }) => {
    await page.setViewportSize({ height: 800, width });
    await page.goto(NOTE);
    await page.waitForLoadState('networkidle');
    const question = page.locator('[data-question-id]', {
      hasText: 'Bacteria are eukaryotes',
    });
    await question.getByText(m.question_ui_false(), { exact: true }).click();
    await question.getByRole('button', CHECK).click();
    await expect(
      question.getByText(m.question_ui_result_right()).first()
    ).toBeVisible();
  });
