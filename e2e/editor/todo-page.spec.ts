import { expect, test } from '@playwright/test';
import { m } from '../i18n';

test('To do groups each class, and a row opens its details', async ({
  page,
}) => {
  await page.goto('/todo');
  await expect(
    page.getByRole('heading', { exact: true, name: m.nav_todo() })
  ).toBeVisible({ timeout: 30_000 });
  await expect(
    page.getByRole('button', { name: /Biology 101/ })
  ).toHaveAttribute('aria-expanded', 'true', { timeout: 30_000 });
  // The mock's past paper waits for approval: its row's details lead there.
  await page
    .getByRole('button', { name: new RegExp(m.dashboard_approve_on()) })
    .first()
    .click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: m.todo_approve_marks() })
    .click();
  await expect(page).toHaveURL(/assignment=.*tab=approve/, { timeout: 30_000 });
});

// Epo 2026-11-10: a row's box selects it, and the selection bar marks it done;
// a quiz is done by handing it in, so marking one by hand asks first.
test('a quiz marked done by hand asks first', async ({ page }) => {
  await page.goto('/todo');
  await page
    .getByRole('checkbox', { name: 'Photosynthesis quiz' })
    .click({ timeout: 30_000 });
  await page.getByRole('button', { name: m.assignment_mark_as_done() }).click();
  const ask = page.getByRole('dialog');
  await expect(ask).toContainText(m.todo_check_quiz_body());
  await ask.getByRole('button', { name: m.assignment_mark_as_done() }).click();
  // Done for them is done: it moves to Done, not handed in.
  await expect(
    page.getByRole('checkbox', { name: 'Photosynthesis quiz' })
  ).toHaveCount(0, { timeout: 30_000 });
  await page.getByRole('tab', { name: m.todo_tab_done() }).click();
  await expect(
    page.getByRole('row', { name: /Photosynthesis quiz/ })
  ).toContainText(m.todo_not_handed_in(), { timeout: 30_000 });
});

test("a Dashboard's Recent files opens the item", async ({ page }) => {
  await page.goto('/workspaces/ws_bio');
  await page
    .getByRole('link', { name: /exchange-plan.docx/ })
    .first()
    .click({ timeout: 30_000 });
  await expect(page).toHaveURL(/\/workspaces\/ws_bio\?.*file=/, {
    timeout: 30_000,
  });
});

test('a new workspace lists first', async ({ page }) => {
  await page.goto('/');
  await page
    .getByRole('button', { exact: true, name: m.action_new_workspace() })
    .click({ timeout: 30_000 });
  await page
    .getByRole('dialog')
    .locator('input')
    .first()
    .fill('Newest workspace');
  await page.keyboard.press('Enter');
  await expect(page.locator('h3').first()).toHaveText('Newest workspace', {
    timeout: 30_000,
  });
});
