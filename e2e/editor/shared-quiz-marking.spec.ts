import { expect, test } from '@playwright/test';
import { m } from '../i18n';

// Nothing on a shared page counts, for anyone (Epo 2026-11-06, Q663 A). A closed
// part marks; an open answer stays Not marked with its marking points to compare
// (Epo 2026-11-05, Q640 B), and the result counts it apart from wrong (Q664 B).
// These pages read no session, so a signed-in visitor gets the same; the server's
// test signs one in. A phone and a desktop.

const QUIZ = '/share/quizzes/qz_shared.mswSignature0000';
const CARDS = '/share/flashcards/dk_shared.mswSignature0000';
const NOTE = '/share/notes/nt_shared.mswSignature0000';
const SCREENS = [
  { screen: 'a phone', width: 360 },
  { screen: 'desktop', width: 1280 },
];
const CHECK = { exact: true, name: m.question_ui_check() };

for (const { screen, width } of SCREENS) {
  test(`On ${screen}, a closed part marks and an open part stays Not marked through to the result`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ height: 800, width });
    await page.goto(QUIZ);
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
    const number = await page
      .locator('[data-question-id]')
      .evaluateAll(
        (questions) =>
          questions.findIndex(
            (q) => q.getAttribute('data-question-id') === 'q14'
          ) + 1
      );
    await open
      .getByRole('textbox', { name: m.question_ui_your_answer() })
      .first()
      .fill('The curve levels off because CO₂ limits the rate.');
    await open.getByRole('button', CHECK).click();
    await expect(
      open.getByText(m.assignment_not_marked(), { exact: true })
    ).toBeVisible();
    await expect(open.getByText('— / 4').first()).toBeVisible();
    // Not marked is final here: nothing offers to check it again.
    await expect(open.getByRole('button', CHECK)).toHaveCount(0);
    await expect(
      open.getByRole('button', { name: m.question_ui_check_again() })
    ).toHaveCount(0);
    // The marking points, shown in the open beside Not marked (R1).
    await expect(
      open.getByText('Describes the low-CO₂ plateau', { exact: false }).first()
    ).toBeVisible();

    // The rest of the quiz, to its result.
    const checks = page.getByRole('button', CHECK);
    for (let left = await checks.count(); left > 0; left--) {
      await checks.first().click();
      await expect(checks).toHaveCount(left - 1, { timeout: 15_000 });
    }
    await expect(
      page.getByRole('button', {
        name: m.quiz_question_not_marked({ number }),
      })
    ).toBeVisible();
    await expect(
      page.getByText(m.result_not_marked({ count: 1 }))
    ).toBeVisible();
    // Its marks stay in the total.
    await expect(page.getByText(/^\S+ \/ 34$/)).toBeVisible();

    expect(
      await page.evaluate(() => document.documentElement.scrollWidth)
    ).toBeLessThanOrEqual(width);
  });

  test(`On ${screen}, a flashcard's rating stays in this browser`, async ({
    page,
  }) => {
    await page.setViewportSize({ height: 800, width });
    await page.goto(CARDS);
    await expect(page.locator('html')).toHaveAttribute('data-hydrated', '', {
      timeout: 30_000,
    });
    await expect(page.getByText(m.flashcards_saved_in_browser())).toBeVisible();
    await page
      .getByRole('button', { name: m.flashcards_show_answer() })
      .click();
    await page.getByRole('button', { name: m.srs_good() }).click();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            new Promise<number>((resolve, reject) => {
              // The mocks keep their own database (src/lib/localDb.ts).
              const opened = indexedDB.open('capy-local-msw');
              opened.onerror = () => reject(opened.error);
              opened.onsuccess = () => {
                const count = opened.result
                  .transaction('cardReviews')
                  .objectStore('cardReviews')
                  .count();
                count.onsuccess = () => {
                  opened.result.close();
                  resolve(count.result);
                };
              };
            })
        )
      )
      .toBe(1);
  });

  // The mock's embedded quiz has closed parts only; SharedQuiz.test.tsx and the
  // server's test cover an embed's open part.
  test(`On ${screen}, a quiz embedded in a shared note checks through the note's link`, async ({
    page,
  }) => {
    await page.setViewportSize({ height: 800, width });
    await page.goto(NOTE);
    // The server's HTML shows first; the quiz's formula runs MathLive once its
    // island has hydrated, and a click before then is lost.
    await expect(
      page.locator('[data-island="embed"] math-field').first()
    ).toBeAttached({ timeout: 30_000 });
    const question = page.locator('[data-question-id]', {
      hasText: 'Bacteria are eukaryotes',
    });
    await question.getByText(m.question_ui_false(), { exact: true }).click();
    await question.getByRole('button', CHECK).click();
    await expect(
      question.getByText(m.question_ui_result_right()).first()
    ).toBeVisible();
  });
}
