import { expect, test } from '@playwright/test';
import { m } from '../i18n';

// A page whose entry script fails to load (a fresh load between the assets
// and app Worker deploys gets the old index.html, whose entry the new release
// removed) shows the reload message from index.html instead of the boot
// spinner forever (Epo 2026-10-17). The dev server's entry is /src/main.tsx;
// a build's is /assets/main-*.js. A failed same-origin stylesheet shows it
// too, and the app then never boots unstyled.

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

test.describe('a stylesheet', () => {
  test.use({ locale: 'en-US' });

  test('a 404 stylesheet shows the reload message and the app never boots', async ({
    page,
  }) => {
    // A build links its stylesheet from index.html, which the dev server
    // leaves to scripts: add one that 404s.
    await page.route('/', async (route) => {
      const response = await route.fetch();
      const body = (await response.text()).replace(
        '</head>',
        '<link href="/assets/boot.css" rel="stylesheet"></head>'
      );
      await route.fulfill({ body, response });
    });
    await page.route('**/assets/boot.css', (route) =>
      route.fulfill({ status: 404 })
    );
    await page.goto('/');
    const message = page.getByRole('alert');
    await expect(
      message.getByRole('heading', {
        exact: true,
        name: m.error_chunk_title({}, { locale: 'en' }),
      })
    ).toBeVisible();
    // The entry ran (MSW controls the page) and left the message: React
    // never took #root.
    await page.waitForFunction(() => navigator.serviceWorker.controller);
    await page.waitForTimeout(500);
    expect(
      await page.evaluate(() =>
        Object.keys(document.getElementById('root') ?? {}).some((key) =>
          key.startsWith('__reactContainer')
        )
      )
    ).toBe(false);
    await expect(message).toBeVisible();
  });
});
