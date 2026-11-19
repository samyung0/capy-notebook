import { expect, test } from '@playwright/test';
import { officeEditMenu, officeMenu } from '../helpers/office';
import { m } from '../i18n';

// Q752 B: a CJK font slice that fails while a DOCX is edited (offline) keeps
// the editor open with a notice, and the slice is asked for again once the
// browser is back online. Print and the list-card capture wait for every
// outline their page draws, so meanwhile Print fails through its usual toast
// and the capture's cycle ends with nothing to send.
test('a DOCX font slice failing offline is a notice, fails Print and the capture, and loads back online', async ({
  context,
  page,
}) => {
  test.setTimeout(240_000);
  // An outline chunk of a sliced CJK face, from any realm (page or worker).
  const chunk = /fonts-cjk\/assets\/[\w-]+\/c\d+\.zst/;
  const failed = new Set<string>();
  const loaded = new Set<string>();
  context.on('requestfailed', (request) => {
    if (chunk.test(request.url())) failed.add(request.url());
  });
  context.on('requestfinished', async (request) => {
    if (chunk.test(request.url()) && (await request.response())?.ok())
      loaded.add(request.url());
  });
  const captures: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/thumbnail'))
      captures.push(request.url());
  });
  const warnings: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'warning') warnings.push(message.text());
  });
  // Leaving uploads a capture already drawn, as the page hiding does.
  const hide = () =>
    page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  await page.goto('/workspaces/ws_bio?file=bio-office-docx&mode=edit');
  const frame = page.frameLocator('iframe[src*="office-runtime"]');
  await expect(frame.locator('canvas').first()).toBeVisible({
    timeout: 120_000,
  });
  await expect(officeEditMenu(page)).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('[data-save-state="saved"]')).toBeVisible({
    timeout: 30_000,
  });

  await context.setOffline(true);
  // A Traditional Chinese character exchange-plan.docx never draws: its
  // chunk of the document's face has not loaded.
  await frame.getByTestId('yrs-input').pressSequentially('齉');
  await expect(
    page.getByText(m.files_office_font_slice_unavailable())
  ).toBeVisible({ timeout: 30_000 });
  await expect(officeEditMenu(page)).toBeVisible();
  await expect(page.getByText(m.error_file_body())).toHaveCount(0);

  await officeMenu(page, 'docx', 'File').click();
  await page.getByRole('menuitem', { exact: true, name: 'Print' }).click();
  await expect(page.getByText(m.files_office_print_failed())).toBeVisible({
    timeout: 60_000,
  });
  await expect(officeEditMenu(page)).toBeVisible();
  expect(failed.size).toBeGreaterThan(0);
  const missing = [...failed];
  // Page 1's capture, drawn 5 s after the key, failed the same way: its
  // cycle ends, so leaving has nothing to send.
  await expect
    .poll(
      () => warnings.some((text) => text.includes('Thumbnail capture failed')),
      { timeout: 30_000 }
    )
    .toBe(true);
  await hide();
  await page.waitForTimeout(1000);
  expect(captures).toEqual([]);

  // Back online, every chunk that failed loads.
  await context.setOffline(false);
  await expect
    .poll(() => missing.filter((url) => !loaded.has(url)), {
      timeout: 30_000,
    })
    .toEqual([]);
  // The next edit starts a new capture cycle, which draws and sends.
  await frame.getByTestId('yrs-input').pressSequentially('X');
  await expect
    .poll(
      async () => {
        await hide();
        return captures.length;
      },
      { intervals: [1000], timeout: 30_000 }
    )
    .toBe(1);
});
