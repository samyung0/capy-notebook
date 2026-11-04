import { expect, type Page, test } from '@playwright/test';
import { openWorkspaceSettings } from '../helpers/workspace';
import { m } from '../i18n';

async function showToast(
  page: Page,
  options: { title: string; variant?: 'error' | 'success' }
) {
  await page.evaluate(async (options) => {
    const toastPath = '/src/components/ui/userToast.ts';
    const { userToast } = await import(toastPath);
    userToast(options);
  }, options);
}

for (const inDialog of [false, true]) {
  test(`an error toast closes with its × with${inDialog ? '' : 'out'} a dialog open`, async ({
    page,
  }) => {
    await page.goto('/workspaces/ws_bio');
    await expect(
      page.getByRole('heading', { exact: true, name: 'Biology 101' })
    ).toBeVisible({ timeout: 30_000 });
    if (inDialog) {
      await openWorkspaceSettings(page);
      await expect(page.getByRole('dialog')).toBeVisible();
    }

    await showToast(page, { title: 'Dismiss this toast', variant: 'error' });
    const toast = page.locator('[data-toast]').filter({
      hasText: 'Dismiss this toast',
    });
    await toast
      .getByRole('button', { exact: true, name: m.action_close() })
      .click();
    await expect(toast).toHaveCount(0, { timeout: 1500 });

    if (inDialog) await expect(page.getByRole('dialog')).toBeVisible();
  });
}

test('an open error stays at the bottom; other toasts show above it one at a time', async ({
  page,
}) => {
  await page.goto('/workspaces/ws_bio');
  await expect(
    page.getByRole('heading', { exact: true, name: 'Biology 101' })
  ).toBeVisible({ timeout: 30_000 });
  const toasts = page.locator('[data-toast]');
  const error = page.locator('[data-toast="error"]');

  await showToast(page, { title: 'Could not save', variant: 'error' });
  await showToast(page, { title: 'Could not save', variant: 'error' });
  await showToast(page, { title: 'Saved', variant: 'success' });
  await showToast(page, { title: 'Copied', variant: 'success' });
  await expect(toasts).toHaveCount(2);
  await expect(error).toContainText('×2');
  await expect(page.locator('[data-toast="success"]')).toHaveText('Saved');
  // Above the error.
  const [saved, failed] = await Promise.all([
    page.locator('[data-toast="success"]').boundingBox(),
    error.boundingBox(),
  ]);
  expect(saved!.y).toBeLessThan(failed!.y);

  await error.getByRole('button', { name: m.action_close() }).click();
  await expect(error).toHaveCount(0);
  await expect(page.locator('[data-toast="success"]')).toHaveText('Saved');
});
