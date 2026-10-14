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
  // The keystroke's save can take over 5 s on a loaded CI runner.
  await expect(page.locator('[data-save-state="saved"]')).toBeVisible({
    timeout: 30_000,
  });
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

// XLSX: the card is the first sheet, so only its edits count; a tab click
// right after one draws it before the switch.
test('an XLSX capture follows only first-sheet edits', async ({ page }) => {
  test.setTimeout(180_000);
  const captures: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/thumbnail'))
      captures.push(new URL(request.url()).pathname);
  });
  await page.setViewportSize({ height: 800, width: 1280 });
  await page.goto('/workspaces/ws_bio?file=bio-office-xlsx');
  const frame = page.frameLocator('iframe[src*="office-runtime"]');
  await expect(frame.locator('canvas').first()).toBeVisible({
    timeout: 60_000,
  });
  await page.getByRole('button', { name: m.material_mode() }).click();
  await expect(officeEditMenu(page, 'xlsx')).toBeVisible({ timeout: 30_000 });
  const saved = page.locator('[data-save-state="saved"]');
  await expect(saved).toBeVisible();

  const tabs = frame.getByRole('tab');
  const typeInCell = async () => {
    const box = await frame.getByTestId('xlsx-scroll').boundingBox();
    if (!box) throw new Error('Grid is not laid out');
    await page.mouse.click(box.x + 150, box.y + 75);
    await page.keyboard.press('7');
    await page.keyboard.press('Enter');
    await page.keyboard.press('ArrowUp');
    await expect(frame.getByTestId('xlsx-formula-input')).toHaveValue('7');
    await expect(saved).toBeVisible();
  };
  const hide = () =>
    page.evaluate(() => window.dispatchEvent(new Event('pagehide')));

  // A first-sheet edit, then straight to the second sheet: drawn on the way
  // (after 5 s), and an edit there neither counts nor drops that drawing.
  await typeInCell();
  await tabs.nth(1).click();
  await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
  await page.waitForTimeout(7000);
  await typeInCell();
  await page.waitForTimeout(8000);
  await expect
    .poll(
      async () => {
        await hide();
        return captures.length;
      },
      { intervals: [1000], timeout: 15_000 }
    )
    .toBe(1);
  await page.waitForTimeout(1000);
  await hide();
  await page.waitForTimeout(1000);
  expect(captures).toEqual(['/api/files/bio-office-xlsx/thumbnail']);
});

// Epo 2026-10-14: an editor opening a file whose card is older than its saved
// document (an agent's edit, an Undo; the mock marks it) uploads page 1 once,
// with no edit of its own. Once captured, the next open uploads nothing.
test('opening a stale card for editing uploads it once', async ({ page }) => {
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
  // Set once (not as an init script, which every runtime frame would run).
  await page.evaluate(() =>
    sessionStorage.setItem('capy.mock.thumbnailStale.bio-office-pptx', 'true')
  );
  const mode = page.getByRole('button', { name: m.material_mode() });
  const editor = officeEditMenu(page, 'pptx');
  await mode.click();
  await expect(editor).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => captures.length, { timeout: 30_000 }).toBe(1);

  // Nothing sends it again: the page hiding, leaving for View, a fresh open.
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  await mode.click();
  await expect(mode).toHaveAttribute('aria-pressed', 'false');
  await mode.click();
  await expect(editor).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('[data-save-state="saved"]')).toBeVisible();
  await page.waitForTimeout(8000);
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  await page.waitForTimeout(1000);
  expect(captures).toEqual(['/api/files/bio-office-pptx/thumbnail']);
});
