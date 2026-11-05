import { expect, test } from '@playwright/test';
import { m } from '../i18n';

test('To do lists a class, its heading opens the Dashboard and a row its assignment', async ({
  page,
}) => {
  await page.goto('/todo');
  await expect(
    page.getByRole('heading', { exact: true, name: m.nav_todo() })
  ).toBeVisible({ timeout: 30_000 });
  const approve = page.getByRole('link', {
    name: new RegExp(m.dashboard_approve_on()),
  });
  await expect(approve).toBeVisible({ timeout: 30_000 });
  await expect(approve).toHaveAttribute('href', /tab=approve/);
  await page
    .getByRole('heading', { name: 'Biology 101' })
    .getByRole('link')
    .click();
  await expect(page).toHaveURL(/\/workspaces\/ws_bio\?panel=none$/, {
    timeout: 30_000,
  });
  await page.goto('/todo');
  await approve.click();
  await expect(page).toHaveURL(/assignment=.*tab=approve/, { timeout: 30_000 });
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
