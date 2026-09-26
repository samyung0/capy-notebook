import path from 'node:path';
import { expect, type Page, test } from '@playwright/test';

async function editPdf(page: Page) {
  await page.getByRole('button', { name: 'Material mode' }).click();
  await expect(page).toHaveURL(/mode=edit/);

  await expect(
    page.getByRole('button', { exact: true, name: 'Draw' })
  ).toBeEnabled();
}

test('Create materials and Files open the shared document page in View', async ({
  page,
}) => {
  await page.goto('/create');
  await page.getByRole('link', { name: /Study journal 001/ }).click();
  await expect(page).toHaveURL(/\/materials\/mat_pagination_1$/);
  await expect(
    page.getByRole('button', { name: 'Material mode' })
  ).toHaveAttribute('aria-pressed', 'false');
  const header = page
    .getByRole('heading', { exact: true, name: 'Study journal 001' })
    .locator('..')
    .locator('..');
  await expect(header.locator('use')).toHaveAttribute('href', /#java-enum$/);
  const mode = header.getByRole('button', { name: 'Material mode' });
  await expect(mode).toHaveText('');
  await mode.click();
  await expect(mode).toHaveAttribute('aria-pressed', 'true');
  await expect(page).toHaveURL(/mode=edit/);
  await page.reload();
  await expect(mode).toHaveAttribute('aria-pressed', 'true');
  await expect(
    page.locator('[data-slate-editor="true"][contenteditable="true"]')
  ).toBeVisible();
  const editor = page.locator(
    '[data-slate-editor="true"][contenteditable="true"]'
  );
  await editor
    .getByText(
      'Study journal 001: review notes and questions for this study session.',
      { exact: true }
    )
    .dblclick();
  await page
    .getByRole('toolbar', { name: 'Document formatting' })
    .getByRole('button', { exact: true, name: 'Comment' })
    .click();
  const commentDialog = page.getByRole('dialog', { name: 'Add comment' });
  await commentDialog
    .getByRole('textbox', { name: 'Comment' })
    .fill('Review this point');
  await commentDialog
    .getByRole('button', { exact: true, name: 'Add comment' })
    .click();
  await expect(commentDialog).toHaveCount(0);
  await expect(editor.locator('[data-comment-decoration]')).toBeVisible();
  await mode.focus();
  await page.keyboard.press('Space');
  await expect(mode).toHaveAttribute('aria-pressed', 'false');
  await expect(page).toHaveURL(/mode=view/);
  await expect(page.locator('[contenteditable="true"]')).toHaveCount(0);
  await expect(
    page.getByRole('button', { exact: true, name: 'Comment' })
  ).toHaveCount(0);

  await header.getByRole('button', { name: 'Open menu' }).click();
  await expect(
    page.getByRole('menuitem', { exact: true, name: 'Move file' })
  ).toHaveCount(0);
  await page.keyboard.press('Escape');
  await header.getByRole('button', { exact: true, name: 'Create' }).click();
  await expect(page).toHaveURL(/\/create$/);

  await page.getByRole('link', { exact: true, name: 'Files' }).click();
  await page.getByRole('link', { name: /Organelles cheatsheet.md/ }).click();
  await expect(page).toHaveURL(/\/files\/f_2$/);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Material mode' })
  ).toHaveAttribute('aria-pressed', 'false');
  const fileHeader = page
    .getByRole('heading', { exact: true, name: 'Organelles cheatsheet.md' })
    .locator('..')
    .locator('..');
  await expect(fileHeader.locator('use')).toHaveAttribute('href', /#markdown$/);
  await fileHeader.getByRole('button', { name: 'Open menu' }).click();
  await expect(
    page.getByRole('menuitem', { exact: true, name: 'Move file' })
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
  await page.goto('/files');
  await page.getByRole('link', { name: /Cell structure.pdf/ }).click();
  await expect(page).toHaveURL(/\/files\/f_1$/);
  await expect(page.getByText('Page 1 of 1', { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  const pdfPage = page.locator('[data-page="1"]');
  await expect(pdfPage.locator('canvas')).toBeVisible();
  const toolbar = page.getByRole('toolbar', { name: 'Private annotations' });
  await expect(
    toolbar.getByRole('button', { exact: true, name: 'Draw' })
  ).toBeDisabled();
  await editPdf(page);

  const select = toolbar.getByRole('button', { exact: true, name: 'Select' });
  const draw = toolbar.getByRole('button', { exact: true, name: 'Draw' });
  await expect(select).toHaveAttribute('aria-pressed', 'true');
  await expect(select).toHaveCSS('width', '32px');
  await expect(draw).toHaveCSS('height', '32px');
  await expect(draw).toHaveCSS('width', '32px');
  await expect(draw.locator('svg')).toHaveCount(1);
  await expect(draw).toHaveAttribute('aria-haspopup', 'dialog');
  await expect(draw).toHaveCSS('gap', '4px');
  for (const svg of await draw.locator('svg').all()) {
    await expect(svg).toHaveCSS('width', '16px');
    await expect(svg).toHaveAttribute('stroke-width', '1.8');
  }

  await toolbar.getByRole('button', { exact: true, name: 'Draw' }).click();
  await page.getByRole('button', { exact: true, name: 'Pen' }).click();
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
  const undo = toolbar.getByRole('button', { exact: true, name: 'Undo' });
  const redo = toolbar.getByRole('button', { exact: true, name: 'Redo' });
  await expect(undo).toBeEnabled();
  await toolbar.getByRole('button', { exact: true, name: 'Eraser' }).click();
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

  await toolbar.getByRole('button', { exact: true, name: 'Text' }).click();
  await page
    .getByRole('textbox', { exact: true, name: 'Text' })
    .fill('Cell membrane');
  await page.getByRole('button', { exact: true, name: 'Place text' }).click();
  await page.mouse.click(start.x + 140, start.y + 80);
  await expect(marks.locator('text')).toHaveText('Cell membrane');
  await expect(undo).toBeEnabled();
  await toolbar.getByRole('button', { exact: true, name: 'Color' }).click();
  await page
    .getByRole('button', { exact: true, name: 'Annotation color #287bb8' })
    .click();
  await toolbar.getByRole('button', { exact: true, name: 'Shape' }).click();
  await page.getByRole('button', { exact: true, name: 'Rectangle' }).click();
  await page.mouse.move(start.x + 220, start.y + 130);
  await page.mouse.down();
  await page.mouse.move(start.x + 350, start.y + 190, { steps: 6 });
  await page.mouse.up();
  await expect(marks.locator('rect')).toHaveAttribute('stroke', '#287bb8');
  await expect(undo).toBeEnabled();
  await toolbar.getByRole('button', { exact: true, name: 'Select' }).click();
  await pdfPage
    .locator('.react-pdf__Page__textContent span')
    .first()
    .evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(range);
    });
  await toolbar.getByRole('button', { exact: true, name: 'Draw' }).click();
  await page.getByRole('button', { exact: true, name: 'Highlight' }).click();
  await expect(marks.locator('rect[fill="#287bb8"]')).toHaveCount(1);
  await expect(undo).toBeEnabled();
  await undo.click();
  await expect(marks.locator('rect[fill="#287bb8"]')).toHaveCount(0);
  await expect(undo).toBeEnabled();
  await toolbar.getByRole('button', { exact: true, name: 'Select' }).click();
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
  await toolbar.getByRole('button', { exact: true, name: 'Draw' }).click();
  await page.getByRole('button', { exact: true, name: 'Highlight' }).click();
  await expect(undo).toBeEnabled();
  await expect(marks.locator('rect[fill="#287bb8"]')).toHaveCount(0);
  await page.getByRole('button', { exact: true, name: 'Zoom in' }).click();
  await expect
    .poll(async () => (await pdfPage.boundingBox())?.width ?? 0)
    .toBeGreaterThan(bounds.width);
  await page.getByRole('button', { exact: true, name: 'Zoom out' }).click();
  await expect
    .poll(async () => (await pdfPage.boundingBox())?.width ?? 0)
    .toBeCloseTo(bounds.width);
  await page.screenshot({
    animations: 'disabled',
    path: test.info().outputPath('pdf-toolbar-desktop.png'),
  });

  // Reopen through client navigation: MSW keeps marks, while component history resets.
  await page.getByRole('button', { exact: true, name: 'Files' }).click();
  await page.getByRole('link', { name: /Cell structure.pdf/ }).click();
  await expect(
    page.getByRole('button', { name: 'Material mode' })
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(marks.locator('polyline')).toHaveCount(1);
  await expect(marks.locator('text')).toHaveText('Cell membrane');
  await expect(undo).toBeDisabled();
  await expect(redo).toBeDisabled();

  await page.setViewportSize({ height: 844, width: 320 });
  await expect(
    page.getByRole('button', { exact: true, name: 'Zoom in' })
  ).toHaveCount(0);
  await expect(
    page.getByRole('button', { exact: true, name: 'Zoom out' })
  ).toHaveCount(0);
  await expect(toolbar).toHaveCSS('scrollbar-width', 'none');
  await expect
    .poll(() =>
      toolbar.evaluate((element) => element.scrollWidth > element.clientWidth)
    )
    .toBe(true);
  await toolbar.evaluate((element) => {
    element.scrollLeft = element.scrollWidth;
  });
  await expect
    .poll(() => toolbar.evaluate((element) => element.scrollLeft))
    .toBeGreaterThan(0);
  await toolbar.getByRole('button', { exact: true, name: 'Color' }).click();
  await expect(
    page.getByRole('button', { exact: true, name: 'Annotation color #287bb8' })
  ).toBeVisible();
  await page.screenshot({
    animations: 'disabled',
    path: test.info().outputPath('pdf-toolbar-mobile.png'),
  });
  await page.keyboard.press('Escape');
});

test('workspace PDF mode survives reload and retains the citation page', async ({
  page,
}) => {
  await page.goto('/workspaces/ws_bio?file=f_1&page=1&mode=edit');
  const mode = page.getByRole('button', { name: 'Material mode' });
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
  const mode = page.getByRole('button', { name: 'Material mode' });
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

test('Create, Files and recent links use saved modes without reloading the app', async ({
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
  await page.goto('/create');
  const origin = await page.evaluate(() => performance.timeOrigin);
  const mode = page.getByRole('button', { name: 'Material mode' });
  await page.getByRole('link', { name: /Study journal 001/ }).click();
  await expect(mode).toHaveAttribute('aria-pressed', 'true', {
    timeout: 30_000,
  });
  await page.getByRole('link', { exact: true, name: 'Files' }).click();
  await page.getByRole('link', { name: /Cell structure.pdf/ }).click();
  await expect(mode).toHaveAttribute('aria-pressed', 'true');

  // Put this fixture in the dashboard's bounded recent list.
  await page.evaluate(async () => {
    const path = '/src/mocks/db.ts';
    const { files } = await import(path);
    files.find((file: { id: string }) => file.id === 'f_1').addedAt =
      new Date().toISOString();
  });
  await page.getByRole('link', { exact: true, name: 'Dashboard' }).click();
  const recent = page
    .getByRole('heading', { name: 'Recent Files' })
    .locator('..');
  await recent.getByRole('link', { name: /Cell structure.pdf/ }).click();
  await expect(page).toHaveURL('/workspaces/ws_bio?file=f_1');
  await expect(mode).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Back to workspaces' }).click();
  await page.getByRole('link', { exact: true, name: 'Dashboard' }).click();
  await recent.getByRole('link', { name: /Editor matrix note/ }).click();
  await expect(page).toHaveURL('/workspaces/ws_bio?material=mat_e2e_editor');
  await expect(mode).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => performance.timeOrigin)).toBe(origin);
});
