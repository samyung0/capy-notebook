import path from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { m } from '../i18n';

/** Makes f_1 the newest file, so it is on the first Files page and in the
 * dashboard's bounded recent list. Edits the page's MSW database, so it only
 * lasts until a reload. */
async function makeCellStructureNewest(page: Page) {
  await page.evaluate(async () => {
    const path = '/src/mocks/db.ts';
    const { files } = await import(path);
    files.find((file: { id: string }) => file.id === 'f_1').addedAt =
      new Date().toISOString();
  });
}

async function editPdf(page: Page) {
  await page.getByRole('button', { name: m.material_mode() }).click();
  await expect(page).toHaveURL(/mode=edit/);

  await expect(
    page.getByRole('button', { exact: true, name: m.pdf_draw() })
  ).toBeEnabled();
}

test('Blocks and Files open the shared document page in View', async ({
  page,
}) => {
  await page.goto('/files?tab=blocks');
  await page.getByRole('link', { name: /Study journal 001/ }).click();
  await expect(page).toHaveURL(/\/materials\/mat_pagination_1$/);
  await expect(
    page.getByRole('button', { name: m.material_mode() })
  ).toHaveAttribute('aria-pressed', 'false');
  const header = page
    .getByRole('heading', { exact: true, name: 'Study journal 001' })
    .locator('..')
    .locator('..');
  await expect(header.locator('use')).toHaveAttribute('href', /#java-enum$/);
  const mode = header.getByRole('button', { name: m.material_mode() });
  await expect(mode).toHaveText('');
  await mode.click();
  await expect(mode).toHaveAttribute('aria-pressed', 'true');
  await expect(page).toHaveURL(/mode=edit/);
  await page.reload();
  await expect(mode).toHaveAttribute('aria-pressed', 'true');
  await expect(
    page.locator('[data-slate-editor="true"][contenteditable="true"]')
  ).toBeVisible({ timeout: 30_000 });
  await mode.focus();
  await page.keyboard.press('Space');
  await expect(mode).toHaveAttribute('aria-pressed', 'false');
  await expect(page).toHaveURL(/mode=view/);
  await expect(page.locator('[contenteditable="true"]')).toHaveCount(0);

  await header.getByRole('button', { name: m.a11y_open_menu() }).click();
  await expect(
    page.getByRole('menuitem', { exact: true, name: m.content_move_file() })
  ).toHaveCount(0);
  await page.keyboard.press('Escape');
  await header
    .getByRole('button', { exact: true, name: m.files_tab_blocks() })
    .click();
  await expect(page).toHaveURL(/\/files\?tab=blocks$/);

  await page.getByRole('link', { exact: true, name: m.nav_files() }).click();
  await page.getByRole('link', { name: /Organelles cheatsheet.md/ }).click();
  await expect(page).toHaveURL(/\/files\/f_2$/);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const fileHeader = page
    .getByRole('heading', { exact: true, name: 'Organelles cheatsheet.md' })
    .locator('..')
    .locator('..');
  await expect(
    fileHeader.getByRole('button', { name: m.material_mode() })
  ).toHaveAttribute('aria-pressed', 'false', { timeout: 30_000 });
  await expect(fileHeader.locator('use')).toHaveAttribute('href', /#markdown$/);
  await fileHeader.getByRole('button', { name: m.a11y_open_menu() }).click();
  await expect(
    page.getByRole('menuitem', { exact: true, name: m.content_move_file() })
  ).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(
    page.getByText('The cell membrane is a', { exact: false })
  ).toBeVisible();
});

test('PDF tools persist private marks, undo restores IDs, and narrow tools scroll', async ({
  page,
  context,
}) => {
  await context.route(
    'https://raw.githubusercontent.com/mozilla/pdf.js/**',
    (route) =>
      route.fulfill({
        contentType: 'application/pdf',
        headers: { 'access-control-allow-origin': '*' },
        path: path.resolve('e2e/fixtures/files/basic/digital.pdf'),
      })
  );
  await page.goto('/files/f_1');
  await expect(page.getByText('Page 1 of 1', { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  const pdfPage = page.locator('[data-page="1"]');
  await expect(pdfPage.locator('canvas')).toBeVisible();
  const toolbar = page.getByRole('toolbar', {
    name: m.pdf_private_annotations(),
  });
  await expect(
    toolbar.getByRole('button', { exact: true, name: m.pdf_draw() })
  ).toBeDisabled();
  await editPdf(page);

  const select = toolbar.getByRole('button', {
    exact: true,
    name: m.pdf_select(),
  });
  const draw = toolbar.getByRole('button', { exact: true, name: m.pdf_draw() });
  await expect(select).toHaveAttribute('aria-pressed', 'true');
  await expect(draw).toHaveAttribute('aria-haspopup', 'dialog');

  await toolbar
    .getByRole('button', { exact: true, name: m.pdf_draw() })
    .click();
  await page.getByRole('button', { exact: true, name: m.pdf_pen() }).click();
  await expect(draw).toHaveAttribute('aria-pressed', 'true');
  await expect(select).toHaveAttribute('aria-pressed', 'false');
  const bounds = await pdfPage.boundingBox();
  if (!bounds) throw new Error('PDF page has no bounds');
  const start = { x: bounds.x + 90, y: bounds.y + 130 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x, start.y + 220, { steps: 8 });
  await page.mouse.move(start.x + 220, start.y + 220, { steps: 8 });
  await page.mouse.up();
  const marks = pdfPage.locator('svg[aria-hidden="true"] > g');
  await expect(marks.locator('polyline')).toHaveCount(1);
  const undo = toolbar.getByRole('button', {
    exact: true,
    name: m.editor_undo(),
  });
  const redo = toolbar.getByRole('button', {
    exact: true,
    name: m.editor_redo(),
  });
  await expect(undo).toBeEnabled();
  await toolbar
    .getByRole('button', { exact: true, name: m.pdf_eraser() })
    .click();
  await page.mouse.click(start.x + 110, start.y + 110);
  await expect(undo).toBeEnabled();
  await expect(marks.locator('polyline')).toHaveCount(1);
  await page.mouse.click(start.x + 20, start.y + 10);
  await expect(marks.locator('polyline')).toHaveCount(0);
  await expect(undo).toBeEnabled();
  await undo.click();
  await expect(marks.locator('polyline')).toHaveCount(1);
  await expect(undo).toBeEnabled();
  await undo.click();
  await expect(marks.locator('polyline')).toHaveCount(0);
  await expect(redo).toBeEnabled();
  await redo.click();
  await expect(marks.locator('polyline')).toHaveCount(1);
  await expect(redo).toBeEnabled();
  await redo.click();
  await expect(marks.locator('polyline')).toHaveCount(0);
  await expect(undo).toBeEnabled();
  await undo.click();
  await expect(marks.locator('polyline')).toHaveCount(1);
  await expect(undo).toBeEnabled();

  await toolbar
    .getByRole('button', { exact: true, name: m.pdf_text() })
    .click();
  await page
    .getByRole('textbox', { exact: true, name: m.pdf_text() })
    .fill('Cell membrane');
  await page
    .getByRole('button', { exact: true, name: m.pdf_place_text() })
    .click();
  await page.mouse.click(start.x + 140, start.y + 80);
  await expect(marks.locator('text')).toHaveText('Cell membrane');
  await expect(undo).toBeEnabled();
  await toolbar
    .getByRole('button', { exact: true, name: m.common_color() })
    .click();
  await page
    .getByRole('button', {
      exact: true,
      name: m.pdf_annotation_color({ color: '#287bb8' }),
    })
    .click();
  await toolbar
    .getByRole('button', { exact: true, name: m.pdf_shape() })
    .click();
  await page
    .getByRole('button', { exact: true, name: m.pdf_rectangle() })
    .click();
  await page.mouse.move(start.x + 220, start.y + 130);
  await page.mouse.down();
  await page.mouse.move(start.x + 350, start.y + 190, { steps: 6 });
  await page.mouse.up();
  await expect(marks.locator('rect')).toHaveAttribute('stroke', '#287bb8');
  await expect(undo).toBeEnabled();
  await toolbar
    .getByRole('button', { exact: true, name: m.pdf_select() })
    .click();
  await pdfPage
    .locator('.react-pdf__Page__textContent span')
    .first()
    .evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(range);
    });
  await toolbar
    .getByRole('button', { exact: true, name: m.pdf_draw() })
    .click();
  await page
    .getByRole('button', { exact: true, name: m.pdf_highlight() })
    .click();
  await expect(marks.locator('rect[fill="#287bb8"]')).toHaveCount(1);
  await expect(undo).toBeEnabled();
  await undo.click();
  await expect(marks.locator('rect[fill="#287bb8"]')).toHaveCount(0);
  await expect(undo).toBeEnabled();
  await toolbar
    .getByRole('button', { exact: true, name: m.pdf_select() })
    .click();
  await pdfPage
    .locator('.react-pdf__Page__textContent span')
    .first()
    .evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(range);
    });
  await page.mouse.click(start.x + 350, start.y + 40);
  await expect
    .poll(() => page.evaluate(() => window.getSelection()?.toString()))
    .toBe('');
  await toolbar
    .getByRole('button', { exact: true, name: m.pdf_draw() })
    .click();
  await page
    .getByRole('button', { exact: true, name: m.pdf_highlight() })
    .click();
  await expect(undo).toBeEnabled();
  await expect(marks.locator('rect[fill="#287bb8"]')).toHaveCount(0);
  await page
    .getByRole('button', { exact: true, name: m.material_zoom_in() })
    .click();
  await expect
    .poll(async () => (await pdfPage.boundingBox())?.width ?? 0)
    .toBeGreaterThan(bounds.width);
  await page
    .getByRole('button', { exact: true, name: m.material_zoom_out() })
    .click();
  await expect
    .poll(async () => (await pdfPage.boundingBox())?.width ?? 0)
    .toBeCloseTo(bounds.width);

  // Reopen through client navigation: MSW keeps marks, while component history resets.
  await makeCellStructureNewest(page);
  await page.getByRole('button', { exact: true, name: m.nav_files() }).click();
  await page.getByRole('link', { name: /Cell structure.pdf/ }).click();
  await expect(
    page.getByRole('button', { name: m.material_mode() })
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(marks.locator('polyline')).toHaveCount(1);
  await expect(marks.locator('text')).toHaveText('Cell membrane');
  await expect(undo).toBeDisabled();
  await expect(redo).toBeDisabled();

  await page.setViewportSize({ height: 844, width: 320 });
  await expect(
    page.getByRole('button', { exact: true, name: m.material_zoom_in() })
  ).toHaveCount(0);
  await expect(
    page.getByRole('button', { exact: true, name: m.material_zoom_out() })
  ).toHaveCount(0);
  await expect
    .poll(() =>
      toolbar.evaluate((element) => element.scrollWidth > element.clientWidth)
    )
    .toBe(true);
  await toolbar.hover();
  await page.mouse.wheel(0, 1000);
  await expect
    .poll(() => toolbar.evaluate((element) => element.scrollLeft))
    .toBeGreaterThan(0);
  await page.mouse.wheel(0, -1000);
  await expect
    .poll(() => toolbar.evaluate((element) => element.scrollLeft))
    .toBe(0);
  await page.mouse.wheel(0, 1000);
  await expect
    .poll(() => toolbar.evaluate((element) => element.scrollLeft))
    .toBeGreaterThan(0);
  await toolbar
    .getByRole('button', { exact: true, name: m.common_color() })
    .click();
  await expect(
    page.getByRole('button', {
      exact: true,
      name: m.pdf_annotation_color({ color: '#287bb8' }),
    })
  ).toBeVisible();
  await page.keyboard.press('Escape');
});

test('workspace PDF mode survives reload and retains the citation page', async ({
  page,
}) => {
  await page.goto('/workspaces/ws_bio?file=f_1&page=1&mode=edit');
  const mode = page
    .getByTestId('content-header')
    .getByRole('button', { name: m.material_mode() });
  await expect(mode).toHaveAttribute('aria-pressed', 'true', {
    timeout: 30_000,
  });
  await expect(mode).toHaveText('');
  await page.reload();
  await expect(mode).toHaveAttribute('aria-pressed', 'true', {
    timeout: 30_000,
  });
  await mode.click();
  await expect(mode).toHaveAttribute('aria-pressed', 'false');
  await expect
    .poll(() => Object.fromEntries(new URL(page.url()).searchParams))
    .toEqual({ file: 'f_1', mode: 'view', page: '1' });
  await page.reload();
  await expect(mode).toHaveAttribute('aria-pressed', 'false', {
    timeout: 30_000,
  });
});

test('workspace links remember each file and material mode independently', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await page.goto('/workspaces/ws_bio');
  await page
    .getByRole('tab', { exact: true, name: m.workspace_tab_files() })
    .click();
  const origin = await page.evaluate(() => performance.timeOrigin);
  const tree = page.locator('[data-workspace-file-tree]');
  const material = tree.getByRole('link', {
    exact: true,
    name: 'Editor matrix note',
  });
  const file = tree.getByRole('link', {
    exact: true,
    name: 'Cell structure.pdf',
  });
  const mode = page
    .getByTestId('content-header')
    .getByRole('button', { name: m.material_mode() });
  await expect(material).toHaveAttribute(
    'href',
    '/workspaces/ws_bio?material=mat_e2e_editor',
    { timeout: 30_000 }
  );
  await material.click();
  await expect(mode).toHaveAttribute('aria-pressed', 'false');
  await mode.click();
  await expect(page).toHaveURL(/mode=edit/);
  await file.click();
  await expect(mode).toHaveAttribute('aria-pressed', 'false');
  await mode.click();
  await expect(page).toHaveURL(/mode=edit/);
  await material.click();
  await expect(mode).toHaveAttribute('aria-pressed', 'true');
  await mode.click();
  await expect(page).toHaveURL(/mode=view/);
  await file.click();
  await expect(mode).toHaveAttribute('aria-pressed', 'true');
  await material.click();
  await expect(mode).toHaveAttribute('aria-pressed', 'false');
  expect(await page.evaluate(() => performance.timeOrigin)).toBe(origin);

  const currentURL = page.url();
  const popupReady = page.context().waitForEvent('page');
  await file.click({ modifiers: ['ControlOrMeta'] });
  const popup = await popupReady;
  // Only the new tab's URL matters; its full Vite load can exceed 5 s.
  await popup.waitForURL(/file=f_1/, { waitUntil: 'commit' });
  await expect(page).toHaveURL(currentURL);
  await popup.close();

  await page.goto('/workspaces/ws_bio?file=f_1&mode=view');
  await expect(mode).toHaveAttribute('aria-pressed', 'false', {
    timeout: 30_000,
  });
  await page.goto('/files/f_1');
  await expect(mode).toHaveAttribute('aria-pressed', 'false', {
    timeout: 30_000,
  });
});

test('Blocks, Files and recent links use saved modes without reloading the app', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await page.addInitScript(() => {
    for (const key of [
      'file.f_1',
      'material.mat_pagination_1',
      'material.mat_e2e_editor',
    ]) {
      localStorage.setItem(`capy.document.mode.${key}`, 'edit');
    }
  });
  await page.goto('/files?tab=blocks');
  const origin = await page.evaluate(() => performance.timeOrigin);
  const mode = page
    .getByTestId('content-header')
    .getByRole('button', { name: m.material_mode() });
  await page.getByRole('link', { name: /Study journal 001/ }).click();
  await expect(mode).toHaveAttribute('aria-pressed', 'true', {
    timeout: 30_000,
  });
  await makeCellStructureNewest(page);
  await page.getByRole('link', { exact: true, name: m.nav_files() }).click();
  await page.getByRole('link', { name: /Cell structure.pdf/ }).click();
  await expect(mode).toHaveAttribute('aria-pressed', 'true');
  await page
    .getByRole('link', { exact: true, name: m.nav_dashboard() })
    .click();
  const recent = page
    .getByRole('heading', { name: m.dashboard_recent() })
    .locator('xpath=../..');
  await recent.getByRole('link', { name: /Cell structure.pdf/ }).click();
  await expect(page).toHaveURL('/workspaces/ws_bio?file=f_1');
  await expect(mode).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: m.workspace_back_to() }).click();
  await page
    .getByRole('link', { exact: true, name: m.nav_dashboard() })
    .click();
  await recent.getByRole('link', { name: /Editor matrix note/ }).click();
  await expect(page).toHaveURL('/workspaces/ws_bio?material=mat_e2e_editor');
  await expect(mode).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => performance.timeOrigin)).toBe(origin);
});
