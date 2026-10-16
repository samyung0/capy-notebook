import { expect, type Page, test } from '@playwright/test';
import { m } from '../i18n';

// An open tab stays usable when the connection drops (Epo 2026-10-17).
// Set to a folder to keep screenshots of the offline page state.
const shots = process.env.OFFLINE_SCREENSHOTS;

// Chromium's offline emulation does not reliably fire the window events.
async function setOnline(page: Page, online: boolean) {
  await page.context().setOffline(!online);
  await page.evaluate(
    (event) => window.dispatchEvent(new Event(event)),
    online ? 'online' : 'offline'
  );
}

async function openDashboard(page: Page) {
  await page.goto('/');
  const cards = page.locator('section a[href^="/workspaces/"]');
  await expect(cards.first()).toBeVisible({ timeout: 30_000 });
  return cards;
}

test('a page whose code is not loaded shows the offline state in the same page, and opens once the connection is back', async ({
  page,
}) => {
  await openDashboard(page);
  // A full page load would drop this.
  await page.evaluate(() => {
    (window as unknown as { samePage: boolean }).samePage = true;
  });
  await setOnline(page, false);
  await page
    .getByRole('link', { exact: true, name: m.nav_workspaces() })
    .click();
  const offline = page
    .getByRole('alert')
    .getByText(m.error_offline_title(), { exact: true });
  await expect(offline).toBeVisible({ timeout: 30_000 });
  expect(new URL(page.url()).pathname).toBe('/workspaces');
  expect(
    await page.evaluate(
      () => (window as unknown as { samePage?: boolean }).samePage
    )
  ).toBe(true);
  if (shots) {
    await page.screenshot({ path: `${shots}/offline-page.png` });
    await page.setViewportSize({ height: 740, width: 360 });
    await page.screenshot({ path: `${shots}/offline-page-360.png` });
    await page.setViewportSize({ height: 720, width: 1280 });
  }

  // The browser keeps a failed import for the document, so the retry on
  // reconnect loads the whole page, now online.
  await page.context().setOffline(false);
  await page
    .evaluate(() => setTimeout(() => window.dispatchEvent(new Event('online'))))
    .catch(() => undefined);
  await expect(page.locator('button[data-sort]')).toBeVisible({
    timeout: 30_000,
  });
  await expect(offline).toBeHidden();
});

test('lists holding data keep showing it while their refetch waits for the connection', async ({
  page,
}) => {
  const cards = await openDashboard(page);
  const count = await cards.count();
  await setOnline(page, false);
  // Every list refetches, as a stale or restored one does on its next use,
  // and waits for the connection.
  const paused = () =>
    page.evaluate(async () => {
      const path = '/src/api/queryClient.ts';
      const { queryClient } = await import(path);
      void queryClient.invalidateQueries();
      return queryClient
        .getQueryCache()
        .findAll()
        .filter(
          (query: { state: { fetchStatus: string } }) =>
            query.state.fetchStatus === 'paused'
        ).length;
    });
  await expect.poll(paused).toBeGreaterThan(0);
  await expect(page.getByText(m.connection_waiting())).toHaveCount(0);
  await expect(cards).toHaveCount(count);
  if (shots) {
    await page.screenshot({ path: `${shots}/offline-dashboard.png` });
    await page.setViewportSize({ height: 740, width: 360 });
    await page.screenshot({ path: `${shots}/offline-dashboard-360.png` });
  }
});
