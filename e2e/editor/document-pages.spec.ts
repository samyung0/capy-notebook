import path from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { showPanelView } from '../helpers/panelView';
import { m } from '../i18n';

/** Makes the given files and materials the newest, so they are on the first
 * Files page and in the dashboard's bounded recent list. Edits the page's MSW
 * database, so it only lasts until a reload. */
async function makeNewest(
  page: Page,
  ids: { files?: string[]; materials?: string[] }
) {
  await page.evaluate(
    async ({ files: fileIds = [], materials: materialIds = [] }) => {
      const path = '/src/mocks/db.ts';
      const { files, materials } = await import(path);
      const now = new Date().toISOString();
      for (const id of fileIds)
        files.find((file: { id: string }) => file.id === id).addedAt = now;
      for (const id of materialIds)
        materials.find(
          (material: { id: string }) => material.id === id
        ).createdAt = now;
    },
    ids
  );
}

/** Files and Blocks cards select on a click and open on a double click. */
const openItem = (page: Page, name: string) =>
  page
    .getByRole('button', { exact: true, name: m.files_select_item({ name }) })
    .dblclick();

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
  await openItem(page, 'Study journal 001');
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
  await openItem(page, 'Organelles cheatsheet.md');
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

// TODO: better UX for PDF highlighting and overlays. These need the PDF's
// Edit/View switch, hidden until then (ANNOTATION_TOOLS in PdfView.tsx).
// biome-ignore lint/suspicious/noSkippedTests: PDF tools are hidden for now.
test.fixme('PDF tools persist private marks, undo restores IDs, and narrow tools scroll', async ({
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
  await makeNewest(page, { files: ['f_1'] });
  await page.getByRole('button', { exact: true, name: m.nav_files() }).click();
  await openItem(page, 'Cell structure.pdf');
  await expect(
    page.getByRole('button', { name: m.material_mode() })
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(marks.locator('polyline')).toHaveCount(1);
  await expect(marks.locator('text')).toHaveText('Cell membrane');
  await expect(undo).toBeDisabled();
  await expect(redo).toBeDisabled();

  // Phone toolbars use compact buttons (2026-10-10), so at 320px wide the
  // tools just fit; 280px (a folded phone) is narrow enough to overflow.
  await page.setViewportSize({ height: 844, width: 280 });
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

// biome-ignore lint/suspicious/noSkippedTests: needs the PDF's Edit/View switch (ANNOTATION_TOOLS in PdfView.tsx).
test.fixme('workspace PDF mode survives reload and retains the citation page', async ({
  page,
}) => {
  await page.goto('/workspaces/ws_bio?file=f_1&page=1&mode=edit');
  const mode = page
    .getByTestId('content-header')
    .getByRole('button', { name: m.material_mode() });
  await expect(mode).toHaveAttribute('aria-pressed', 'true', {
    timeout: 30_000,
  });
  // From lg the toggle is labelled with the mode it switches to.
  await expect(mode).toHaveText(m.material_mode_view());
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

type CitationFlash = {
  centerOffset: number;
  end?: number;
  painted: boolean;
  start: number;
};

/** Records each flash of a PDF citation box: when it starts and ends, whether
 * its page had painted, and how far its centre sat from the viewer's centre
 * when it started. */
function recordCitationFlashes(page: Page) {
  return page.evaluate(() => {
    const flashes: CitationFlash[] = [];
    (globalThis as unknown as { flashes: CitationFlash[] }).flashes = flashes;
    new MutationObserver((records) => {
      for (const { target } of records) {
        if (!(target instanceof HTMLElement)) continue;
        if (target.dataset.flash === undefined) {
          const last = flashes.at(-1);
          if (last) last.end = performance.now();
          continue;
        }
        const scroller = target.closest('.overflow-auto');
        if (!scroller) throw new Error('Missing scroller');
        const box = target.getBoundingClientRect();
        const pane = scroller.getBoundingClientRect();
        flashes.push({
          centerOffset: box.top + box.height / 2 - (pane.top + pane.height / 2),
          painted: !!target.closest('[data-page][data-painted]'),
          start: performance.now(),
        });
      }
    }).observe(document.body, {
      attributeFilter: ['data-flash'],
      attributes: true,
      subtree: true,
    });
  });
}

const endedFlashes = (page: Page) =>
  page.evaluate(() =>
    (globalThis as unknown as { flashes: CitationFlash[] }).flashes.filter(
      (flash) => flash.end
    )
  );

test('a chat citation opens the PDF, scrolls its box to the middle, then flashes it', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.goto('/workspaces/ws_scenarios');
  // The scenario sends a chat whose source 2 is Scenario annotations.pdf,
  // cited mid-page 2 (chatFixtures' scenarioPdfRegion).
  const panel = page.getByTestId('mock-scenario-panel');
  await panel.locator('summary').click({ timeout: 60_000 });
  await panel.locator('[data-scenario="chat-openui-overview"]').click();
  const source = page.getByTitle(m.chat_source_number({ n: 2 })).first();
  await expect(source).toBeVisible({ timeout: 60_000 });
  await recordCitationFlashes(page);
  await source.click();
  await expect(page).toHaveURL(/file=mock-scenario-pdf&page=2/);

  // The flash starts once the page has painted and the scroll has settled
  // with the box in the middle, and ends after its 1.6 s.
  await expect
    .poll(() => endedFlashes(page), { timeout: 30_000 })
    .toHaveLength(1);
  const [flash] = await endedFlashes(page);
  expect(flash.painted).toBe(true);
  expect(Math.abs(flash.centerOffset)).toBeLessThan(4);
  expect(flash.end! - flash.start).toBeGreaterThanOrEqual(1500);

  // The box is on the cited line.
  const box = await page
    .locator('[data-citation-region-index="0"]')
    .boundingBox();
  const line = await page
    .locator('[data-page="2"] .react-pdf__Page__textContent')
    .getByText('Osmosis moves water across the membrane.', { exact: true })
    .boundingBox();
  if (!box || !line) throw new Error('Missing boxes');
  expect(box.x).toBeLessThanOrEqual(line.x);
  expect(box.y).toBeLessThanOrEqual(line.y);
  expect(box.x + box.width).toBeGreaterThanOrEqual(line.x + line.width);
  expect(box.y + box.height).toBeGreaterThanOrEqual(line.y + line.height);

  // From the top of the file, the same citation scrolls and flashes again.
  await page
    .locator('[data-page="1"]')
    .evaluate((node) => node.scrollIntoView({ block: 'start' }));
  await source.click();
  await expect
    .poll(() => endedFlashes(page), { timeout: 30_000 })
    .toHaveLength(2);
  const [, again] = await endedFlashes(page);
  expect(again.painted).toBe(true);
  expect(Math.abs(again.centerOffset)).toBeLessThan(4);
});

// biome-ignore lint/suspicious/noSkippedTests: needs the PDF's Edit/View switch (ANNOTATION_TOOLS in PdfView.tsx).
test.fixme('workspace links remember each file and material mode independently', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await page.goto('/workspaces/ws_bio');
  await showPanelView(page, m.workspace_tab_files());
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
  // The PDF's toggle shows once the file, its links and the viewer chunk
  // load, the two reads one after another through the mock's 1 s latency.
  await expect(mode).toHaveAttribute('aria-pressed', 'false', {
    timeout: 30_000,
  });
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

// biome-ignore lint/suspicious/noSkippedTests: needs the PDF's Edit/View switch (ANNOTATION_TOOLS in PdfView.tsx).
test.fixme('Blocks, Files and recent links use saved modes without reloading the app', async ({
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
  await openItem(page, 'Study journal 001');
  await expect(mode).toHaveAttribute('aria-pressed', 'true', {
    timeout: 30_000,
  });
  await makeNewest(page, { files: ['f_1'], materials: ['mat_e2e_editor'] });
  await page.getByRole('link', { exact: true, name: m.nav_files() }).click();
  await openItem(page, 'Cell structure.pdf');
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
