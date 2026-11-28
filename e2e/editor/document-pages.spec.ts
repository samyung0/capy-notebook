import path from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { FILES_VIEW_ONLY } from '../helpers/filesViewOnly';
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

/** Files page cards select on a click and open on a double click. */
const openItem = (page: Page, name: string) =>
  page
    .getByRole('button', { exact: true, name: m.files_select_item({ name }) })
    .dblclick();

test('Files page rows open the shared document page', async ({ page }) => {
  // biome-ignore lint/suspicious/noSkippedTests: files are view-only (Q853 A).
  test.skip(true, FILES_VIEW_ONLY);
  await page.goto('/files');
  await openItem(page, 'Study journal 001');
  await expect(page).toHaveURL(/\/materials\/mat_pagination_1$/);
  const header = page
    .getByRole('heading', { exact: true, name: 'Study journal 001' })
    .locator('..')
    .locator('..');
  await expect(header.locator('use')).toHaveAttribute('href', /#java-enum$/);
  // At the highest mode its reader may have, with no switch; an old link's mode
  // goes.
  await expect(
    page.locator('[data-slate-editor="true"][contenteditable="true"]')
  ).toBeVisible({ timeout: 30_000 });
  await expect(
    header.getByRole('button', { name: m.material_mode() })
  ).toHaveCount(0);
  await page.goto('/materials/mat_pagination_1?mode=view');
  await expect(
    page.locator('[data-slate-editor="true"][contenteditable="true"]')
  ).toBeVisible({ timeout: 30_000 });
  await expect(page).not.toHaveURL(/mode=/);

  await header.getByRole('button', { name: m.a11y_open_menu() }).click();
  await expect(
    page.getByRole('menuitem', { exact: true, name: m.content_move_file() })
  ).toHaveCount(0);
  await page.keyboard.press('Escape');
  await header
    .getByRole('button', { exact: true, name: m.nav_files() })
    .click();
  await expect(page).toHaveURL(/\/files$/);

  // The markdown samples are newer than f_2 and fill the first Files page.
  await makeNewest(page, { files: ['f_2'] });
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
  // The body comes after the header: the markdown worker loads and converts
  // it first, which on a cold dev server takes several seconds.
  await expect(
    page.getByText('The cell membrane is a', { exact: false })
  ).toBeVisible({ timeout: 30_000 });
});

/** Subpaths in the page's ink: a pen mark draws each stroke as its own. */
const subpaths = (path: ReturnType<Page['locator']>) =>
  path.evaluate(
    (element) => (element.getAttribute('d') ?? '').split('M').length - 1
  );

// PDF marks round 1 (Epo 2026-11-24): marks draw at once and save behind,
// select, move and resize, take comments beside the page, and persist.
test('PDF marks draw at once, select and move, take comments and persist', async ({
  page,
  context,
}) => {
  test.setTimeout(120_000);
  await context.route(
    'https://raw.githubusercontent.com/mozilla/pdf.js/**',
    (route) =>
      route.fulfill({
        contentType: 'application/pdf',
        headers: { 'access-control-allow-origin': '*' },
        path: path.resolve('e2e/fixtures/files/basic/digital.pdf'),
      })
  );
  await page.setViewportSize({ height: 900, width: 1280 });
  await page.goto('/files/f_1');
  await expect(page.getByText('Page 1 of 1', { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  const pdfPage = page.locator('[data-page="1"]');
  await expect(pdfPage.locator('canvas')).toBeVisible();
  const toolbar = page.getByRole('toolbar', {
    name: m.pdf_private_annotations(),
  });
  const button = (name: string) =>
    toolbar.getByRole('button', { exact: true, name });
  // Marks are private, so the tools are on from the start, with no Edit.
  await expect(button(m.pdf_pen())).toBeEnabled();
  await expect(button(m.pdf_select())).toHaveAttribute('aria-pressed', 'true');

  const ink = pdfPage.locator('svg[data-pdf-marks] path[d]:not([data-live])');
  const bounds = await pdfPage.boundingBox();
  if (!bounds) throw new Error('PDF page has no bounds');
  const at = (x: number, y: number) => ({ x: bounds.x + x, y: bounds.y + y });
  const stroke = async (points: { x: number; y: number }[]) => {
    await page.mouse.move(points[0].x, points[0].y);
    await page.mouse.down();
    for (const point of points.slice(1))
      await page.mouse.move(point.x, point.y, { steps: 8 });
    await page.mouse.up();
  };

  // Two strokes in quick succession are one pen mark (D6); undo takes the
  // second off, redo puts it back.
  await button(m.pdf_pen()).click();
  await expect(button(m.pdf_pen())).toHaveAttribute('aria-pressed', 'true');
  await stroke([at(90, 130), at(90, 350), at(310, 350)]);
  await stroke([at(330, 130), at(330, 200)]);
  await expect(ink).toHaveCount(1);
  expect(await subpaths(ink)).toBe(2);
  await button(m.editor_undo()).click();
  expect(await subpaths(ink)).toBe(1);
  await button(m.editor_redo()).click();
  expect(await subpaths(ink)).toBe(2);

  // The eraser cuts the stroke where it crosses (D7), not the whole mark.
  await button(m.pdf_eraser()).click();
  await stroke([at(60, 240), at(120, 240)]);
  await expect.poll(() => subpaths(ink)).toBe(3);
  await button(m.editor_undo()).click();
  await expect.poll(() => subpaths(ink)).toBe(2);

  // A shape opens selected with its bar (Epo 2026-11-24); the bar recolours it.
  await button(m.pdf_shape()).click();
  await page.getByRole('button', { name: m.pdf_rectangle() }).click();
  await stroke([at(420, 130), at(560, 200)]);
  const rect = pdfPage.locator('svg[data-pdf-marks] rect[stroke]');
  await expect(rect).toHaveCount(1);
  const bar = page.locator('[data-pdf-bar]');
  await bar
    .getByRole('button', { exact: true, name: m.pdf_color_blue() })
    .click();
  await expect(rect).toHaveAttribute('stroke', '#287bb8');
  // Its width is a button in the bar, drawn as a line (Epo 2026-11-24).
  await bar
    .getByRole('button', { exact: true, name: m.pdf_width_thick() })
    .click();
  await expect(rect).toHaveAttribute('stroke-width', '5.5');

  // Placing it went back to Select, which drags it by its outline; a comment
  // goes beside the page (D11 B).
  await expect(button(m.pdf_select())).toHaveAttribute('aria-pressed', 'true');
  const before = await rect.boundingBox();
  await stroke([at(420, 165), at(440, 205)]);
  await expect
    .poll(async () => (await rect.boundingBox())?.y ?? 0)
    .toBeGreaterThan((before?.y ?? 0) + 30);
  await bar
    .getByRole('button', { exact: true, name: m.editor_comment() })
    .click();
  await page
    .getByRole('textbox', { name: m.editor_comment() })
    .fill('Membrane width');
  await page
    .getByRole('button', { exact: true, name: m.action_save() })
    .click();
  const comments = button(m.pdf_comments({ count: '1' }));
  await expect(comments).toHaveAttribute('aria-pressed', 'true');
  // A card shows its comment as text; collapsed, an icon names it instead.
  const card = page.locator('button[data-mark]', { hasText: 'Membrane width' });
  await expect(card).toBeVisible();
  await comments.click();
  await expect(card).toHaveCount(0);
  await expect(
    page.getByRole('button', {
      name: m.pdf_comment_label({ comment: 'Membrane width' }),
    })
  ).toBeVisible();
  await comments.click();

  // Placed text switches to Select; Escape closes the box selected with its
  // bar (Epo 2026-11-24).
  await button(m.pdf_text()).click();
  await page.mouse.click(bounds.x + 140, bounds.y + 420);
  await page.keyboard.type('Cell membrane');
  await expect(button(m.pdf_select())).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Escape');
  await expect(bar).toBeVisible();
  await expect(
    pdfPage.getByText('Cell membrane', { exact: true })
  ).toBeVisible();

  // Selected text takes its bar (D3); a dot highlights it.
  await page.mouse.click(bounds.x + bounds.width - 20, bounds.y + 20);
  const span = pdfPage.locator('.react-pdf__Page__textContent span').first();
  const text = await span.boundingBox();
  if (!text) throw new Error('No PDF text');
  await stroke([
    { x: text.x + 1, y: text.y + text.height / 2 },
    { x: text.x + text.width - 1, y: text.y + text.height / 2 },
  ]);
  await bar
    .getByRole('button', {
      exact: true,
      name: m.pdf_highlight_color({ color: m.pdf_color_yellow() }),
    })
    .click();
  await expect(
    pdfPage.locator('svg[data-pdf-marks] rect[fill="#dfa626"]')
  ).not.toHaveCount(0);

  // The Marks list holds every mark in page order (D5).
  await button(m.pdf_marks()).click();
  const list = page.getByRole('dialog');
  for (const kind of [
    m.pdf_pen(),
    m.pdf_rectangle(),
    m.pdf_text(),
    m.pdf_highlight(),
  ])
    await expect(
      list.getByText(m.pdf_mark_place({ kind, page: 1 }))
    ).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByText(m.editor_status_saved()).first()).toBeVisible();

  // Reopen through client navigation: marks persist, history starts over.
  await makeNewest(page, { files: ['f_1'] });
  await page.getByRole('button', { exact: true, name: m.nav_files() }).click();
  await openItem(page, 'Cell structure.pdf');
  await expect(ink).toHaveCount(1);
  await expect(
    pdfPage.getByText('Cell membrane', { exact: true })
  ).toBeVisible();
  await expect(button(m.editor_undo())).toBeDisabled();

  // A narrow pane has no margin: the tools scroll and Comments lists them.
  await page.setViewportSize({ height: 844, width: 360 });
  const tools = toolbar.locator('.scroll-fade-x');
  await expect
    .poll(() =>
      tools.evaluate((element) => element.scrollWidth > element.clientWidth)
    )
    .toBe(true);
  await button(m.pdf_comments({ count: '1' })).click();
  await expect(
    page.getByRole('dialog').getByText('Membrane width')
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // A placed note moves with Select; a click opens its comment.
  const commentBox = page.getByRole('textbox', { name: m.editor_comment() });
  await button(m.pdf_note()).click();
  const narrow = await pdfPage.boundingBox();
  if (!narrow) throw new Error('PDF page has no bounds');
  // A blank spot below the marks drawn so far.
  await page.mouse.click(narrow.x + 60, narrow.y + 330);
  await commentBox.fill('Ribosomes');
  await page
    .getByRole('button', { exact: true, name: m.action_save() })
    .click();
  await button(m.pdf_select()).click();
  const note = pdfPage.locator('svg[data-pdf-marks] g[transform]');
  const from = await note.boundingBox();
  if (!from) throw new Error('The note has no bounds');
  const middle = { x: from.x + from.width / 2, y: from.y + from.height / 2 };
  await stroke([middle, { x: middle.x + 40, y: middle.y + 40 }]);
  await expect
    .poll(async () => (await note.boundingBox())?.x ?? 0)
    .toBeGreaterThan(from.x + 30);
  await expect(commentBox).toHaveCount(0);
  // Marks sit under the text layer; the page finds them where they are.
  const moved = await note.boundingBox();
  if (!moved) throw new Error('The note has no bounds');
  await page.mouse.click(moved.x + moved.width / 2, moved.y + moved.height / 2);
  await expect(commentBox).toHaveValue('Ribosomes');
});

test('a PDF stays on the same spot of its page through zoom and a narrower pane', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.goto('/workspaces/ws_scenarios');
  const panel = page.getByTestId('mock-scenario-panel');
  await panel.locator('summary').click({ timeout: 60_000 });
  await panel.locator('[data-scenario="chat-answer-overview"]').click();
  const source = page.getByTitle(m.chat_source_number({ n: 2 })).first();
  await expect(source).toBeVisible({ timeout: 60_000 });
  await source.click();
  const pages = page.locator('[data-page]');
  await expect(pages).toHaveCount(3, { timeout: 60_000 });

  // The page under the pane's middle, and how far down it.
  const place = () =>
    pages.first().evaluate((first) => {
      let scroller = first.parentElement as HTMLElement;
      while (getComputedStyle(scroller).overflowY !== 'auto')
        scroller = scroller.parentElement as HTMLElement;
      const box = scroller.getBoundingClientRect();
      const middle = box.top + scroller.clientHeight / 2;
      const under = [...document.querySelectorAll('[data-page]')].find(
        (candidate) => candidate.getBoundingClientRect().bottom >= middle
      ) as HTMLElement;
      const rect = under.getBoundingClientRect();
      return {
        fraction: (middle - rect.top) / rect.height,
        page: Number(under.dataset.page),
      };
    });
  const expectPlace = async (before: { fraction: number; page: number }) => {
    await expect
      .poll(() => place().then(({ page: at }) => at))
      .toBe(before.page);
    const { fraction } = await place();
    expect(Math.abs(fraction - before.fraction)).toBeLessThan(0.02);
  };

  // The citation's own scroll has landed on page 2 before the reader moves.
  await expect(page.locator('[data-page="2"][data-painted]')).toBeVisible({
    timeout: 60_000,
  });
  await page.waitForTimeout(600);
  await pages
    .nth(1)
    .evaluate((node) => node.scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(300);
  const reading = await place();
  expect(reading.page).toBe(2);

  const zoomIn = page.getByRole('button', { name: m.material_zoom_in() });
  await zoomIn.click();
  await zoomIn.click();
  await expectPlace(reading);
  await page.getByRole('button', { name: m.material_zoom_out() }).click();
  await expectPlace(reading);

  await page.setViewportSize({ height: 800, width: 1000 });
  await expectPlace(reading);
});

test('a chat citation opens the note and flashes its passage, once per click', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.goto('/workspaces/ws_bio');
  const panel = page.getByTestId('mock-scenario-panel');
  await panel.locator('summary').click({ timeout: 60_000 });
  await panel.locator('[data-scenario="chat-answer-note-citation"]').click();
  const source = page.getByTitle(m.chat_source_number({ n: 1 })).first();
  await expect(source).toBeVisible({ timeout: 60_000 });
  await source.click();
  await expect(page).toHaveURL(/material=mat_e2e_editor/);
  const flashed = page.locator('[data-citation-flash]');
  await expect(flashed).toHaveText('Third paragraph gamma', {
    timeout: 30_000,
  });
  await expect(flashed).toHaveCount(0);
  await source.click();
  await expect(flashed).toHaveText('Third paragraph gamma');
});

test('a chat citation finds its note block by id after the text changed', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.goto('/workspaces/ws_bio');
  const panel = page.getByTestId('mock-scenario-panel');
  await panel.locator('summary').click({ timeout: 60_000 });
  await panel.locator('[data-scenario="chat-answer-note-block"]').click();
  const source = page.getByTitle(m.chat_source_number({ n: 1 })).first();
  await expect(source).toBeVisible({ timeout: 60_000 });
  await source.click();
  await expect(page.locator('[data-citation-flash]')).toHaveText(
    'Second paragraph beta',
    { timeout: 30_000 }
  );
});

test('workspace file mode survives reload', async ({ page }) => {
  // biome-ignore lint/suspicious/noSkippedTests: files are view-only (Q853 A).
  test.skip(true, FILES_VIEW_ONLY);
  await page.goto('/workspaces/ws_bio?file=f_2&mode=edit');
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
    .toEqual({ file: 'f_2', mode: 'view' });
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
  await panel.locator('[data-scenario="chat-answer-overview"]').click();
  const source = page.getByTitle(m.chat_source_number({ n: 2 })).first();
  await expect(source).toBeVisible({ timeout: 60_000 });
  await recordCitationFlashes(page);
  await source.click();
  await expect(page).toHaveURL(/file=mock-scenario-pdf&page=2/);

  // The flash starts once the page has painted and the scroll has landed
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

// Notes open at their reader's highest mode with no switch, so only files
// remember one (Epo 2026-11-24 took the PDF's switch too).
test("workspace links remember each file's mode independently", async ({
  page,
}) => {
  // biome-ignore lint/suspicious/noSkippedTests: files are view-only (Q853 A).
  test.skip(true, FILES_VIEW_ONLY);
  test.setTimeout(90_000);
  await page.goto('/workspaces/ws_bio');
  await showPanelView(page, m.workspace_tab_files());
  const origin = await page.evaluate(() => performance.timeOrigin);
  const tree = page.locator('[data-workspace-file-tree]');
  const file = tree.getByRole('link', {
    exact: true,
    name: 'Organelles cheatsheet.md',
  });
  const other = tree.getByRole('link', {
    exact: true,
    name: 'Cell cycle notes.md',
  });
  const mode = page
    .getByTestId('content-header')
    .getByRole('button', { name: m.material_mode() });
  // Each toggle shows once its file, its links and the viewer chunk load,
  // the reads one after another through the mock's 1 s latency.
  await file.click();
  await expect(mode).toHaveAttribute('aria-pressed', 'false', {
    timeout: 30_000,
  });
  await mode.click();
  await expect(page).toHaveURL(/mode=edit/);
  await other.click();
  await expect(mode).toHaveAttribute('aria-pressed', 'false', {
    timeout: 30_000,
  });
  await file.click();
  await expect(mode).toHaveAttribute('aria-pressed', 'true', {
    timeout: 30_000,
  });
  await mode.click();
  await expect(page).toHaveURL(/mode=view/);
  await other.click();
  await expect(mode).toHaveAttribute('aria-pressed', 'false', {
    timeout: 30_000,
  });
  expect(await page.evaluate(() => performance.timeOrigin)).toBe(origin);

  const currentURL = page.url();
  const popupReady = page.context().waitForEvent('page');
  await file.click({ modifiers: ['ControlOrMeta'] });
  const popup = await popupReady;
  // Only the new tab's URL matters; its full Vite load can exceed 5 s.
  await popup.waitForURL(/file=f_2/, { waitUntil: 'commit' });
  await expect(page).toHaveURL(currentURL);
  await popup.close();

  await page.goto('/workspaces/ws_bio?file=f_2&mode=view');
  await expect(mode).toHaveAttribute('aria-pressed', 'false', {
    timeout: 30_000,
  });
  await page.goto('/files/f_2');
  await expect(mode).toHaveAttribute('aria-pressed', 'false', {
    timeout: 30_000,
  });
});

test('Files page and recent links use saved modes without reloading the app', async ({
  page,
}) => {
  // biome-ignore lint/suspicious/noSkippedTests: files are view-only (Q853 A).
  test.skip(true, FILES_VIEW_ONLY);
  test.setTimeout(90_000);
  await page.addInitScript(() =>
    localStorage.setItem('capy.document.mode.file.f_2', 'edit')
  );
  await page.goto('/workspaces');
  const origin = await page.evaluate(() => performance.timeOrigin);
  const mode = page
    .getByTestId('content-header')
    .getByRole('button', { name: m.material_mode() });
  // The markdown samples are newer than f_2 and fill the first Files page.
  await makeNewest(page, { files: ['f_2'] });
  await page.getByRole('link', { exact: true, name: m.nav_files() }).click();
  await openItem(page, 'Organelles cheatsheet.md');
  await expect(mode).toHaveAttribute('aria-pressed', 'true', {
    timeout: 30_000,
  });
  // Workspaces, the workspace's card, then its Dashboard's Recent files.
  await page
    .getByRole('link', { exact: true, name: m.nav_workspaces() })
    .click();
  await page
    .getByRole('link', { name: /Biology 101/ })
    .first()
    .click();
  await page
    .getByRole('link', { name: /Organelles cheatsheet.md/ })
    .first()
    .click();
  await expect(page).toHaveURL('/workspaces/ws_bio?file=f_2');
  await expect(mode).toHaveAttribute('aria-pressed', 'true', {
    timeout: 30_000,
  });
  expect(await page.evaluate(() => performance.timeOrigin)).toBe(origin);
});
