import { expect, test } from '@playwright/test';

for (const inDialog of [false, true]) {
  test(`toast close button dismisses with${inDialog ? '' : 'out'} a dialog open`, async ({
    page,
  }) => {
    await page.goto('/workspaces/ws_bio');
    await expect(
      page.getByRole('heading', { exact: true, name: 'Biology 101' })
    ).toBeVisible({ timeout: 30_000 });
    if (inDialog) {
      await page
        .getByRole('button', { exact: true, name: 'Workspace settings' })
        .click();
      await expect(page.getByRole('dialog')).toBeVisible();
    }

    for (const variant of ['default', 'success', 'warning', 'error'] as const) {
      await page.evaluate(async (variant) => {
        const toastPath = '/src/components/ui/userToast.tsx';
        const { userToast } = await import(toastPath);
        userToast({ title: 'Dismiss this toast', variant });
      }, variant);
      const toast = page.locator('[data-sonner-toast]').filter({
        hasText: 'Dismiss this toast',
      });
      await toast.getByRole('button', { exact: true, name: 'Close' }).click();
      await expect(toast).toHaveCount(0, { timeout: 1500 });
    }

    if (inDialog) await expect(page.getByRole('dialog')).toBeVisible();
  });
}
