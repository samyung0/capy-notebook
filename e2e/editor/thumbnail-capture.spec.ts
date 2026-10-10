import { expect, test } from '@playwright/test';
import { officeEditMenu } from '../helpers/office';
import { m } from '../i18n';

// openwiki/thumbnails.md, phase 2a: an edit is drawn after 5 s idle, and the
// page hiding uploads that capture, once; so does leaving the editor for View.
test('a PPTX edit sends one thumbnail capture', async ({ page }) => {
  test.setTimeout(120_000);
  const captures: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/thumbnail'))
      captures.push(new URL(request.url()).pathname);
  });
  await page.goto('/workspaces/ws_bio?file=bio-office-pptx');
  const frame = page.frameLocator('iframe[src*="office-runtime"]');
  await expect(frame.locator('canvas').first()).toBeVisible({
    timeout: 60_000,
  });
  const mode = page.getByRole('button', { name: m.material_mode() });
  await mode.click();
  await expect(officeEditMenu(page, 'pptx')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('[data-save-state="saved"]')).toBeVisible();

  const runtime = page
    .frames()
    .find((item) => item.url().includes('office-runtime'));
  if (!runtime) throw new Error('Missing the Office runtime frame');
  const edit = async () => {
    await runtime.evaluate(() =>
      window.dispatchEvent(
        new CustomEvent('capy-scenario-edit-slide', { detail: 'Captured ' })
      )
    );
    await expect(page.locator('[data-save-state="saved"]')).toBeVisible();
  };
  await edit();
  const hide = () =>
    page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  // Nothing is drawn for 5 s after the edit; then the page hiding sends it.
  await expect
    .poll(
      async () => {
        await hide();
        return captures.length;
      },
      { intervals: [1000], timeout: 30_000 }
    )
    .toBe(1);
  await page.waitForTimeout(1000);
  await hide();
  await page.waitForTimeout(1000);
  expect(captures).toEqual(['/api/files/bio-office-pptx/thumbnail']);

  // A later edit, drawn after 5 s, goes up when the editor closes for View.
  await edit();
  await page.waitForTimeout(8000);
  await mode.click();
  await expect(mode).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(() => captures.length, { timeout: 15_000 }).toBe(2);
});

// Phase 2b: DOCX draws page 1 from Print's raster of it, on the same triggers.
test('a DOCX edit sends one thumbnail capture', async ({ page }) => {
  test.setTimeout(180_000);
  const captures: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/thumbnail'))
      captures.push(new URL(request.url()).pathname);
  });
  await page.goto('/workspaces/ws_bio?file=bio-office-docx');
  const frame = page.frameLocator('iframe[src*="office-runtime"]');
  await expect(frame.locator('canvas').first()).toBeVisible({
    timeout: 60_000,
  });
  await page.getByRole('button', { name: m.material_mode() }).click();
  await expect(officeEditMenu(page, 'docx')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('[data-save-state="saved"]')).toBeVisible();

  await frame.getByTestId('yrs-input').pressSequentially('X');
  await expect(page.locator('[data-save-state="saved"]')).toBeVisible();
  const hide = () =>
    page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  await expect
    .poll(
      async () => {
        await hide();
        return captures.length;
      },
      { intervals: [1000], timeout: 30_000 }
    )
    .toBe(1);
  await page.waitForTimeout(1000);
  await hide();
  await page.waitForTimeout(1000);
  expect(captures).toEqual(['/api/files/bio-office-docx/thumbnail']);
});
