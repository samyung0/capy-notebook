import { expect, type Page } from '@playwright/test';
import { m } from '../i18n';

/** A quiz page's question `number` opened from the rail: its card, which
 * edits in place (Epo 2026-11-15, Google Forms cards). Until the quiz's rooms
 * sync the cards wait (inert), so it waits for Saved first. */
export async function openQuestionCard(page: Page, url: string, number = 1) {
  await page.goto(url);
  await expect(page.locator('[data-save-state="saved"]')).toBeVisible({
    timeout: 30_000,
  });
  await page
    .locator('[data-question-row]')
    .nth(number - 1)
    .click({ timeout: 30_000 });
  const card = page.locator('[data-question-open]');
  await expect(card).toBeVisible();
  return card;
}

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
