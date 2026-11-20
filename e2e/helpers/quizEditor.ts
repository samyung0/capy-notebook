import { expect, type Page } from '@playwright/test';

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
