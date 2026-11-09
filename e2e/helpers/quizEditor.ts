import { expect, type Page } from '@playwright/test';
import { m } from '../i18n';

/** The quiz editor page (board X2): the question dialog of the question open
 * on it, through its ⋮. */
export async function openQuestionDialog(page: Page, number = 1) {
  await page
    .getByRole('button', {
      name: m.quiz_editor_question_actions({ number }),
    })
    .click({ timeout: 30_000 });
  await page
    .getByRole('button', { exact: true, name: m.quiz_editor_more_details() })
    .click();
  await expect(page.getByRole('dialog')).toBeVisible();
}
