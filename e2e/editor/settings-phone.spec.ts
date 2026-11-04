import { expect, test } from '@playwright/test';
import { m } from '../i18n';

test.use({
  hasTouch: true,
  isMobile: true,
  viewport: { height: 740, width: 360 },
});

test('account Settings shows the tabs first and each tab as a page', async ({
  page,
}) => {
  await page.goto('/settings');
  const tab = page.getByRole('tab', { name: m.settings_tab_notifications() });
  await tab.click({ timeout: 60_000 });
  await expect(
    page.getByRole('heading', { name: m.settings_tab_notifications() })
  ).toHaveCount(1);
  await expect(page).toHaveURL(/tab=notifications/);
  await expect(
    page.getByRole('switch', { name: m.settings_email_billing() })
  ).toBeVisible();

  await page.getByRole('button', { name: m.action_back() }).click();
  await expect(tab).toBeVisible();

  await page
    .getByRole('textbox', { name: m.workspace_settings_search() })
    .fill(m.settings_theme());
  await expect(page.getByRole('tab')).toHaveCount(1);
  await expect(page).toHaveURL(/q=/);
});
