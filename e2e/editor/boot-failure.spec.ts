import { expect, test } from '@playwright/test';
import { m } from '../i18n';

// A page whose entry script fails to load (a fresh load between the assets
// and app Worker deploys gets the old index.html, whose entry the new release
// removed) shows the reload message from index.html instead of the boot
// spinner forever (Epo 2026-10-17). The dev server's entry is /src/main.tsx;
// a build's is /assets/main-*.js.

for (const [locale, browserLocale] of [
  ['en', 'en-US'],
  ['zh', 'zh-CN'],
] as const) {
  test.describe(`in ${browserLocale}`, () => {
    test.use({ locale: browserLocale });

    test('a 404 entry script shows the reload message', async ({ page }) => {
      await page.route('**/src/main.tsx', (route) =>
        route.fulfill({ status: 404 })
      );
      await page.goto('/');
      const message = page.getByRole('alert');
      await expect(
        message.getByRole('heading', {
          exact: true,
          name: m.error_chunk_title({}, { locale }),
        })
      ).toBeVisible();
      await expect(
        message.getByText(m.error_chunk_body({}, { locale }), { exact: true })
      ).toBeVisible();
      await expect(page.getByRole('status')).toHaveCount(0);
      // Reload loads the page again.
      await page.evaluate(() => Object.assign(window, { beforeReload: true }));
      await Promise.all([
        page.waitForEvent('load'),
        message
          .getByRole('button', {
            exact: true,
            name: m.error_action_reload({}, { locale }),
          })
          .click(),
      ]);
      expect(await page.evaluate(() => 'beforeReload' in window)).toBe(false);
    });
  });
}
