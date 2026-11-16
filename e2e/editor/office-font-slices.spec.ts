import { expect, test } from '@playwright/test';
import { officeEditMenu, officeMenu } from '../helpers/office';
import { m } from '../i18n';

// Q752 B: a CJK font slice that fails while a DOCX is edited (offline) keeps
// the editor open with a notice, and the slice is asked for again once the
// browser is back online. Print waits for every outline its pages draw, so
// it fails meanwhile through its usual toast.
test('a DOCX font slice failing offline is a notice, fails Print, and loads back online', async ({
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

  // Back online, every chunk that failed loads.
  await context.setOffline(false);
  await expect
    .poll(() => missing.filter((url) => !loaded.has(url)), {
      timeout: 30_000,
    })
    .toEqual([]);
});
