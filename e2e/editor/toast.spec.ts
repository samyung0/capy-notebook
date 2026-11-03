import { expect, type Page, test } from '@playwright/test';
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
      // The rail's gear (its aria-label); the empty viewer's quick action shares
      // the name as text and appears once the recent files load.
      await page
        .getByLabel(m.workspace_settings(), { exact: true })
        .first()
        .click();
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

test('one toast at a time: the same toast counts up, another waits its turn', async ({
  page,
}) => {
  await page.goto('/workspaces/ws_bio');
  await expect(
    page.getByRole('heading', { exact: true, name: 'Biology 101' })
  ).toBeVisible({ timeout: 30_000 });
  const toasts = page.locator('[data-toast]');

  await showToast(page, { title: 'Could not save', variant: 'error' });
  await showToast(page, { title: 'Could not save', variant: 'error' });
  await showToast(page, { title: 'Saved', variant: 'success' });
  await expect(toasts).toHaveCount(1);
  await expect(toasts).toContainText('Could not save');
  await expect(toasts).toContainText('×2');

  await toasts.getByRole('button', { name: m.action_close() }).click();
  await expect(toasts).toHaveText('Saved');
});
