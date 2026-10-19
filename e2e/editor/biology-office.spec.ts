import { readFileSync } from 'node:fs';
import { expect, type FrameLocator, type Page, test } from '@playwright/test';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import {
  officeEditMenu,
  officeMenu,
  postToOfficeRuntime,
  saveOffice,
} from '../helpers/office';
import { m } from '../i18n';

declare global {
  interface Window {
    officeInputProbe: { hold: boolean; held: (() => void)[]; flushed: boolean };
    /** The runtime's last `bottom-inset` message, as the host received it. */
    officeInset?: Record<string, unknown>;
  }
}

for (const [format, name] of [
  ['docx', 'exchange-plan.docx'],
  ['xlsx', 'course-guide.xlsx'],
  ['pptx', 'lecture.pptx'],
] as const) {
  test(`Biology ${format} fixture opens in View/Edit and survives scenario reset`, async ({
    page,
  }) => {
    test.setTimeout(format === 'docx' ? 180_000 : 120_000);
    const fileId = `bio-office-${format}`;
    if (format === 'docx') {
      await page.addInitScript(() => {
        window.officeInputProbe = { flushed: false, held: [], hold: false };
        const send = Worker.prototype.postMessage;
        Worker.prototype.postMessage = function (
          message: { type?: string },
          options?: StructuredSerializeOptions | Transferable[]
        ) {
          const release = () => {
            const post = send.bind(this);
            if (Array.isArray(options)) post(message, options);
            else post(message, options);
          };
          if (
            window.officeInputProbe.hold &&
            (message?.type === 'applyInput' || message?.type === 'applyDelete')
          )
            window.officeInputProbe.held.push(release);
          else release();
        };
        window.addEventListener('message', (event) => {
          if (event.data?.type === 'flush')
            window.officeInputProbe.flushed = true;
        });
      });
    }
    await page.goto('/workspaces/ws_bio');
    await page
      .getByRole('tab', { exact: true, name: m.workspace_tab_files() })
      .click();
    await page
      .locator(`[data-workspace-file-tree] a[href*="file=${fileId}"]`)
      .click();
    await expect(
      page.getByRole('heading', { exact: true, name })
    ).toBeVisible();
    const frame = page.frameLocator('iframe[src*="office-runtime"]');
    await expect(frame.locator('canvas').first()).toBeVisible({
      timeout: 60_000,
    });
    if (format === 'xlsx')
      await expect(frame.getByRole('tab', { name: 'Summary' })).toBeVisible();
    if (format === 'pptx')
      await expect(frame.getByRole('region')).toContainText(
        'Rich deck fixture'
      );

    const mode = page.getByRole('button', { name: m.material_mode() });
    await mode.click();
    await expect(mode).toHaveAttribute('aria-pressed', 'true');
    await expect(officeEditMenu(page, format)).toBeVisible({ timeout: 30_000 });
    // File › Save is a menuitem, a ticked row a menuitemcheckbox.
    await saveOffice(page, format);
    await expect(page.locator('[data-save-state="saved"]')).toBeVisible();
    if (format === 'docx') {
      await officeMenu(page, format, 'View').click();
      await expect(
        page.getByRole('menuitemcheckbox', { name: 'Show comments' })
      ).toBeVisible();
      await page.keyboard.press('Escape');
    }
    if (format === 'pptx') {
      await frame.locator('aside button').nth(2).click();
      const canvas = frame.getByTestId('pptx-slide-canvas');
      const box = await canvas.boundingBox();
      if (!box) throw new Error('Missing slide canvas');
      await canvas.click({
        clickCount: 3,
        position: { x: box.width * 0.25, y: box.height * 0.265 },
      });
      const input = frame.getByTestId('pptx-text-input');
      await expect(input).toBeFocused();
      await page
        .context()
        .grantPermissions(['clipboard-read', 'clipboard-write']);
      await page.evaluate(() =>
        navigator.clipboard.writeText('Clipboard input 日本 😀')
      );
      await input.press('ControlOrMeta+V');
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Input.imeSetComposition', {
        selectionEnd: 3,
        selectionStart: 3,
        text: '日本語',
      });
      await cdp.send('Input.insertText', { text: '日本語' });
      await cdp.detach();
      await saveOffice(page, format);
      await expect(page.locator('[data-save-state="saved"]')).toBeVisible();
    }
    await mode.click();
    await expect(mode).toHaveAttribute('aria-pressed', 'false');
    await expect(frame.locator('canvas').first()).toBeVisible({
      timeout: 60_000,
    });
    if (format === 'pptx') {
      await frame.getByTestId('pptx-next-slide').click();
      await frame.getByTestId('pptx-next-slide').click();
      await expect(frame.getByRole('region')).toContainText(
        'Clipboard input 日本 😀日本語'
      );
    }

    const panel = page.getByTestId('mock-scenario-panel');
    await panel.evaluate((node: HTMLDetailsElement) => {
      node.open = true;
    });
    await panel.getByRole('button', { exact: true, name: 'Reset' }).click();
    await expect(panel).toHaveAttribute('data-scenario-status', 'idle');
    const fixture = await page.evaluate(async (id) => {
      const links = await fetch(`/api/files/${id}/links`);
      const session = await fetch(`/api/files/${id}/source-session`);
      return {
        sourceURL: (await links.json()).url,
        workspaceId: (await session.json()).workspaceId,
      };
    }, fileId);
    expect(fixture.sourceURL).toContain(`/rich-content/${name}`);
    expect(fixture.workspaceId).toBe('ws_bio');
    // MSW also closes its client on beforeunload; probe after all API checks.
    if (format === 'docx') {
      await page.goto(`/workspaces/ws_bio?file=${fileId}`);
      await expect(frame.locator('canvas').first()).toBeVisible({
        timeout: 60_000,
      });
      await mode.click();
      await expect(officeEditMenu(page, format)).toBeVisible({
        timeout: 30_000,
      });
      const input = frame.getByTestId('yrs-input');
      const paragraph = frame
        .getByRole('paragraph')
        .filter({ hasText: /^人數：20人$/ });
      // Mirror pages away from the viewport hold only plain text: bring the
      // paragraph's page into view, then point at its positioned glyph.
      const last = frame
        .locator('.layout-page-mirror:not(.layout-page-mirror-text)')
        .getByRole('paragraph')
        .filter({ hasText: /^人數：20人$/ })
        .getByText('人', { exact: true })
        .last();
      await expect(async () => {
        await frame
          .locator('.layout-page-mirror')
          .filter({ has: paragraph })
          .scrollIntoViewIfNeeded({ timeout: 1000 });
        await last.hover({ force: true, timeout: 1000 });
        await expect(frame.locator('.canvas-pages')).toHaveCSS(
          'cursor',
          'text',
          { timeout: 1000 }
        );
        await last.click({ force: true });
        await expect(input).toHaveAttribute('data-pointer-placement', 'ready', {
          timeout: 1000,
        });
      }).toPass({ timeout: 30_000 });
      await input.press('End');
      await expect(page.locator('[data-save-state="saved"]')).toBeVisible();
      const runtime = page
        .frames()
        .find((candidate) => candidate.url().includes('office-runtime'));
      if (!runtime) throw new Error('Missing Office runtime');
      await runtime.evaluate(() => {
        window.officeInputProbe.hold = true;
        window.officeInputProbe.flushed = false;
      });
      try {
        await input.pressSequentially('7');
        await expect
          .poll(() =>
            runtime.evaluate(() => window.officeInputProbe.held.length)
          )
          .toBeGreaterThan(0);
        await expect(page.locator('[data-save-state="syncing"]')).toBeVisible();
        const blocksUnload = () =>
          page.evaluate(() => {
            const event = new Event('beforeunload', { cancelable: true });
            window.dispatchEvent(event);
            return event.defaultPrevented;
          });
        expect(await blocksUnload()).toBe(true);
        await saveOffice(page, format);
        await expect
          .poll(() => runtime.evaluate(() => window.officeInputProbe.flushed))
          .toBe(true);
        await expect(page.locator('[data-save-state="saved"]')).toHaveCount(0);
        expect(await blocksUnload()).toBe(true);
      } finally {
        await runtime.evaluate(() => {
          window.officeInputProbe.hold = false;
          for (const release of window.officeInputProbe.held.splice(0))
            release();
        });
      }
      await expect(page.locator('[data-save-state="saved"]')).toBeVisible();
    }
  });
}

test('DOCX Insert table of contents lists the headings, and Update follows a rename', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ height: 900, width: 1280 });
  await page.goto('/workspaces/ws_bio?file=bio-office-docx');
  const frame = page.frameLocator('iframe[src*="office-runtime"]');
  await expect(frame.locator('canvas').first()).toBeVisible({
    timeout: 60_000,
  });
  await page.getByRole('button', { name: m.material_mode() }).click();
  await expect(officeEditMenu(page, 'docx')).toBeVisible({ timeout: 30_000 });
  const input = frame.getByTestId('yrs-input');
  // The caret goes into a paragraph through one of its positioned glyphs, as
  // in the edit test above.
  const placeIn = async (text: RegExp, glyph: string) => {
    const paragraph = frame.getByRole('paragraph').filter({ hasText: text });
    const target = frame
      .locator('.layout-page-mirror:not(.layout-page-mirror-text)')
      .getByRole('paragraph')
      .filter({ hasText: text })
      .getByText(glyph, { exact: true })
      .last();
    await expect(async () => {
      await frame
        .locator('.layout-page-mirror')
        .filter({ has: paragraph })
        .scrollIntoViewIfNeeded({ timeout: 1000 });
      await target.click({ force: true, timeout: 1000 });
      await expect(input).toHaveAttribute('data-pointer-placement', 'ready', {
        timeout: 1000,
      });
    }).toPass({ timeout: 30_000 });
  };
  const insertMenu = async (name: string) => {
    await officeMenu(page, 'docx', 'Insert').click();
    await page.getByRole('menuitem', { exact: true, name }).click();
  };
  const applyStyle = async (name: string) => {
    await officeMenu(page, 'docx', 'Format').click();
    await page.getByRole('menuitem', { name: 'Paragraph styles' }).click();
    await page.getByRole('menuitemcheckbox', { exact: true, name }).click();
  };
  // A table of contents entry: the heading's text, a tab and its page.
  const entry = (text: string) =>
    frame
      .getByRole('paragraph')
      .filter({ hasText: new RegExp(`^${text}\\s*\\d+$`) });

  // The fixture numbers its headings by hand; two become Heading 1 and 2.
  await placeIn(/^1\. 引言$/, '引');
  await applyStyle('Heading 1');
  await placeIn(/^1\.1\.\s+活動背景$/, '背');
  await applyStyle('Heading 2');
  // Update is offered once the document holds a table of contents.
  await officeMenu(page, 'docx', 'Insert').click();
  await expect(
    page.getByRole('menuitem', { name: 'Update table of contents' })
  ).toHaveCount(0);
  await page.keyboard.press('Escape');

  await placeIn(/^籌委會籌備小組$/, '籌');
  await input.press('Home');
  await insertMenu('Table of contents');
  await expect(entry('1\\. 引言')).toHaveCount(1);
  await expect(entry('1\\.1\\.\\s+活動背景')).toHaveCount(1);
  await expect(
    frame.getByRole('paragraph').filter({ hasText: /^籌委會籌備小組$/ })
  ).toHaveCount(1);

  await placeIn(/^1\. 引言$/, '言');
  await input.press('End');
  await input.pressSequentially('X');
  await insertMenu('Update table of contents');
  await expect(entry('1\\. 引言X')).toHaveCount(1);
  await expect(entry('1\\. 引言')).toHaveCount(0);
  await saveOffice(page, 'docx');
  await expect(page.locator('[data-save-state="saved"]')).toBeVisible();
});

test('DOCX view mode selects and copies text from its text layer', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.setViewportSize({ height: 800, width: 1280 });
  await page.goto('/workspaces/ws_bio?file=bio-office-docx');
  const frame = page.frameLocator('iframe[src*="office-runtime"]');
  await expect(frame.locator('canvas').first()).toBeVisible({
    timeout: 60_000,
  });
  const run = (text: string) =>
    frame
      .locator(
        '.canvas-page-mirror--selectable .layout-page-mirror:not(.layout-page-mirror-text) .layout-run-text'
      )
      .filter({ hasText: new RegExp(`^${text}$`) })
      .first();
  const clipboard = () => page.evaluate(() => navigator.clipboard.readText());
  const copy = async () => {
    await page.evaluate(() => navigator.clipboard.writeText(''));
    await page.keyboard.press('ControlOrMeta+c');
  };

  // Drag across the title's three paragraphs: one line each, as the editor
  // copies them.
  const from = await run('2').boundingBox();
  const to = await run('書').boundingBox();
  if (!from || !to) throw new Error('Missing title runs');
  await page.mouse.move(from.x + 1, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width - 1, to.y + to.height / 2, {
    steps: 8,
  });
  await page.mouse.up();
  await copy();
  await expect
    .poll(clipboard)
    .toBe('2022 至 2023 年度\n香港大學工程學院 \n交流學習團活動計劃書');

  // A double click takes the word, a triple click the paragraph.
  await run('3').dblclick();
  await copy();
  await expect.poll(clipboard).toBe('2023');
  await run('團').click({ clickCount: 3 });
  await copy();
  await expect.poll(clipboard).toBe('交流學習團活動計劃書');

  // The selection survives its page leaving the viewport and coming back.
  const viewer = frame.locator('.docx-runtime-viewer');
  await viewer.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  // The window has moved once the pages near the top went plain text; the
  // first page keeps its positioned mirror while it holds the selection.
  const mirrors = frame.locator('.layout-page-mirror');
  await expect(mirrors.nth(2)).toHaveClass(/layout-page-mirror-text/, {
    timeout: 15_000,
  });
  await expect(mirrors.first()).not.toHaveClass(/layout-page-mirror-text/);
  await viewer.evaluate((element) => {
    element.scrollTop = 0;
  });
  await copy();
  await expect.poll(clipboard).toBe('交流學習團活動計劃書');

  // Select all takes the whole document, far pages included.
  await page.keyboard.press('ControlOrMeta+a');
  await copy();
  await expect
    .poll(clipboard)
    .toMatch(
      /^ {2}2022 至 2023 年度\n香港大學工程學院 \n交流學習團活動計劃書\n/
    );
  const all = await clipboard();
  expect(all).toContain(
    '\n7:00-8:00\t香港快運航空\t酒店早餐\t酒店早餐\t酒店早餐\n'
  );
  expect(all).toContain('並且在回港後，本會會向保險公司索償。');
});

test('Office viewer keeps its iframe when the workspace layout changes', async ({
  page,
}) => {
  test.setTimeout(120_000);
  let sessions = 0;
  page.on('request', (request) => {
    if (request.url().includes('/source-session')) sessions++;
  });
  await page.setViewportSize({ height: 800, width: 1280 });
  await page.goto('/workspaces/ws_bio?file=bio-office-docx');
  const frame = page.frameLocator('iframe[src*="office-runtime"]');
  await expect(frame.locator('canvas').first()).toBeVisible({
    timeout: 60_000,
  });
  const iframe = page.locator('iframe[src*="office-runtime"]');
  await iframe.evaluate((element) => {
    element.dataset.layoutProbe = 'kept';
  });
  const opened = sessions;

  // One column below lg, two columns at lg: both switch the surrounding layout.
  // Below lg an open Office file keeps chat to its round button.
  for (const [width, role, tools] of [
    [900, 'button', m.workspace_tab_chat()],
    [1280, 'tab', m.workspace_tab_files()],
  ] as const) {
    await page.setViewportSize({ height: 800, width });
    await expect(page.getByRole(role, { name: tools }).first()).toBeVisible();
    await expect(iframe).toHaveAttribute('data-layout-probe', 'kept');
  }
  expect(sessions).toBe(opened);
});

test('XLSX keyboard selection scrolls into view and takes typing', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ height: 800, width: 1280 });
  await page.goto('/workspaces/ws_bio');
  await page
    .getByRole('tab', { exact: true, name: m.workspace_tab_files() })
    .click();
  await page
    .locator('[data-workspace-file-tree] a[href*="file=bio-office-xlsx"]')
    .click();
  const frame = page.frameLocator('iframe[src*="office-runtime"]');
  await expect(frame.locator('canvas').first()).toBeVisible({
    timeout: 60_000,
  });
  await page.getByRole('button', { name: m.material_mode() }).click();
  await expect(officeEditMenu(page, 'xlsx')).toBeVisible({ timeout: 30_000 });

  // CC info freezes columns A:B and rows 1:2; H is past the window's right edge.
  const grid = frame.getByTestId('xlsx-scroll');
  const nameBox = frame.getByTestId('xlsx-name-box');
  const formula = frame.getByTestId('xlsx-formula-input');
  const box = await grid.boundingBox();
  if (!box) throw new Error('Grid is not laid out');
  // Near B4; the arrows correct a click that lands a cell off.
  await page.mouse.click(box.x + 150, box.y + 75);
  await expect(nameBox).toHaveValue(/^[A-Z]\d+$/);
  const clicked = await nameBox.inputValue();
  const [column, row] = [clicked.slice(0, 1), clicked.slice(1)];
  const walk = async (from: number, to: number, back: string, on: string) => {
    for (let at = from; at !== to; at += at < to ? 1 : -1)
      await page.keyboard.press(at < to ? on : back);
  };
  await walk(
    column.charCodeAt(0),
    'B'.charCodeAt(0),
    'ArrowLeft',
    'ArrowRight'
  );
  await walk(Number(row), 4, 'ArrowUp', 'ArrowDown');
  await expect(nameBox).toHaveValue('B4');

  for (let step = 0; step < 6; step += 1)
    await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowDown');
  await expect(nameBox).toHaveValue('H5');
  await expect(formula).toHaveValue('2');

  await page.keyboard.press('7');
  const editor = frame.getByTestId('xlsx-cell-editor');
  await expect(editor).toBeFocused();
  await expect(editor).toHaveValue('7');
  const cell = await editor.boundingBox();
  if (!cell) throw new Error('The cell editor is not laid out');
  expect(cell.x).toBeGreaterThanOrEqual(box.x);
  expect(cell.x + cell.width).toBeLessThanOrEqual(box.x + box.width);
  await page.keyboard.press('Enter');
  await expect(nameBox).toHaveValue('H6');
  await page.keyboard.press('ArrowUp');
  await expect(formula).toHaveValue('7');

  // An open edit wheeled out of view keeps its input focused; the next key is
  // typed into it and scrolls the cell back.
  await page.keyboard.press('8');
  await expect(editor).toBeFocused();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, 4000);
  await expect(editor).toHaveCSS('opacity', '0');
  await expect(editor).toBeFocused();
  await page.keyboard.press('9');
  await expect(editor).toHaveCSS('opacity', '1');
  await expect(editor).toHaveValue('89');
  const back = await editor.boundingBox();
  if (!back) throw new Error('The cell editor is not laid out');
  expect(back.y).toBeGreaterThanOrEqual(box.y);
  expect(back.y + back.height).toBeLessThanOrEqual(box.y + box.height);
  await page.keyboard.press('Enter');
  await page.keyboard.press('ArrowUp');
  await expect(nameBox).toHaveValue('H5');
  await expect(formula).toHaveValue('89');

  // Clicking the formula bar commits a cell edit and keeps the formula bar
  // focused, twice in a row; a formula-bar edit then stands.
  for (const typed of ['1', '2']) {
    await page.keyboard.press(typed);
    await expect(editor).toHaveValue(typed);
    await formula.click();
    await expect(formula).toBeFocused();
    await expect(editor).toHaveCount(0);
    await expect(formula).toHaveValue(typed);
    await page.keyboard.press('Escape');
  }
  await formula.fill('3');
  await page.keyboard.press('Enter');
  await expect(nameBox).toHaveValue('H6');
  // A grid click would land an edit left open over the formula bar's.
  await page.mouse.click(box.x + 150, box.y + 75);
  await expect(nameBox).not.toHaveValue('H6');
  const landed = await nameBox.inputValue();
  await walk(
    landed.charCodeAt(0),
    'H'.charCodeAt(0),
    'ArrowLeft',
    'ArrowRight'
  );
  await walk(Number(landed.slice(1)), 5, 'ArrowUp', 'ArrowDown');
  await expect(nameBox).toHaveValue('H5');
  await expect(formula).toHaveValue('3');

  // A press on nothing focusable (the fx label) commits the edit and gives the
  // grid the keys back; so does clicking a sheet tab.
  await page.keyboard.press('4');
  await expect(editor).toHaveValue('4');
  await frame.getByText('fx', { exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect(formula).toHaveValue('4');
  await page.keyboard.press('ArrowDown');
  await expect(nameBox).toHaveValue('H6');
  await frame.getByRole('tab', { name: 'Summary' }).click();
  await page.keyboard.press('ArrowRight');
  await expect(nameBox).toHaveValue('B1');
});

test('XLSX zooms from View › Zoom in both modes, keeping the top-left cell, hit-testing at the zoom and still copying', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ height: 800, width: 1280 });
  await page.goto('/workspaces/ws_bio');
  await page
    .getByRole('tab', { exact: true, name: m.workspace_tab_files() })
    .click();
  await page
    .locator('[data-workspace-file-tree] a[href*="file=bio-office-xlsx"]')
    .click();
  const frame = page.frameLocator('iframe[src*="office-runtime"]');
  await expect(frame.locator('canvas').first()).toBeVisible({
    timeout: 60_000,
  });
  const grid = frame.getByRole('tabpanel');
  const nameBox = frame.getByRole('textbox', {
    name: m.files_office_spreadsheet_name_box(),
  });
  const contents = frame.getByRole('textbox', {
    name: m.files_office_spreadsheet_cell_contents(),
  });
  const box = await grid.boundingBox();
  if (!box) throw new Error('Grid is not laid out');
  const zoomTo = async (percent: string) => {
    await officeMenu(page, 'xlsx', 'View').click();
    await page.getByRole('menuitem', { name: 'Zoom' }).click();
    await page
      .getByRole('menuitemcheckbox', { exact: true, name: percent })
      .click();
  };

  // CC info at 100%: B2 is the header "Course Name" under (150, 75), and the
  // point twice as far from the grid's corner is another cell.
  await page.mouse.click(box.x + 300, box.y + 150);
  await expect(nameBox).not.toHaveValue('B2');
  await zoomTo('200%');
  await page.mouse.click(box.x + 300, box.y + 150);
  await expect(nameBox).toHaveValue('B2');
  await expect(contents).toHaveValue('Course Name');

  // The top-left cell holds across a zoom change: the scroll halves at 100%.
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, 600);
  await expect
    .poll(() => grid.evaluate((node) => node.scrollTop))
    .toBeGreaterThan(0);
  const scrolled = await grid.evaluate((node) => node.scrollTop);
  await zoomTo('100%');
  await expect
    .poll(async () =>
      Math.abs((await grid.evaluate((node) => node.scrollTop)) - scrolled / 2)
    )
    .toBeLessThanOrEqual(1);

  // The selected cell's text still copies from the read-only formula bar.
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await contents.focus();
  await contents.press('ControlOrMeta+A');
  await contents.press('ControlOrMeta+C');
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe('Course Name');

  // Edit mode keeps the top-left cell too, in a real browser's layout.
  await page.getByRole('button', { name: m.material_mode() }).click();
  await expect(officeEditMenu(page, 'xlsx')).toBeVisible({ timeout: 30_000 });
  const editGrid = frame.getByTestId('xlsx-scroll');
  const editBox = await editGrid.boundingBox();
  if (!editBox) throw new Error('Grid is not laid out');
  await zoomTo('200%');
  await page.mouse.move(
    editBox.x + editBox.width / 2,
    editBox.y + editBox.height / 2
  );
  await page.mouse.wheel(0, 600);
  await expect
    .poll(() => editGrid.evaluate((node) => node.scrollTop))
    .toBeGreaterThan(0);
  const editScrolled = await editGrid.evaluate((node) => node.scrollTop);
  await zoomTo('100%');
  await expect
    .poll(async () =>
      Math.abs(
        (await editGrid.evaluate((node) => node.scrollTop)) - editScrolled / 2
      )
    )
    .toBeLessThanOrEqual(1);
});

test('XLSX view mode opens a sheet at its saved scroll after a short sheet, zoomed out', async ({
  context,
  page,
}) => {
  test.setTimeout(120_000);
  // Faculty Database saved with row 1 frozen and row 400 at the pane's top.
  const files = unzipSync(
    readFileSync('e2e/fixtures/files/rich-content/course-guide.xlsx')
  );
  const sheet = 'xl/worksheets/sheet2.xml';
  files[sheet] = strToU8(
    strFromU8(files[sheet]).replace(
      '<sheetView workbookViewId="0"/>',
      '<sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A400" activePane="bottomLeft" state="frozen"/></sheetView>'
    )
  );
  const body = Buffer.from(zipSync(files));
  // The workbook's bytes, not the `?url` module that names them.
  const workbook = (url: URL) =>
    url.pathname.endsWith('/rich-content/course-guide.xlsx') && !url.search;
  await context.route(workbook, (route) =>
    route.fulfill({
      body,
      contentType:
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    })
  );
  await page.setViewportSize({ height: 800, width: 1280 });
  await page.goto('/workspaces/ws_bio?file=bio-office-xlsx');
  const frame = page.frameLocator('iframe[src*="office-runtime"]');
  await expect(frame.locator('canvas').first()).toBeVisible({
    timeout: 60_000,
  });
  const grid = frame.getByRole('tabpanel');
  await officeMenu(page, 'xlsx', 'View').click();
  await page.getByRole('menuitem', { name: 'Zoom' }).click();
  await page
    .getByRole('menuitemcheckbox', { exact: true, name: '50%' })
    .click();

  // Summary's few rows make a scroll area shorter than the window; the next
  // sheet's saved scroll must wait for that sheet's size.
  await frame.getByRole('tab', { name: 'Summary' }).click();
  await expect.poll(() => grid.evaluate((node) => node.scrollTop)).toBe(0);
  await frame.getByRole('tab', { name: 'Faculty Database' }).click();
  await expect
    .poll(() => grid.evaluate((node) => node.scrollTop))
    .toBeGreaterThan(2000);
});

test('XLSX view mode name box goes to a typed cell on this sheet or another', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ height: 800, width: 1280 });
  await page.goto('/workspaces/ws_bio?file=bio-office-xlsx');
  const frame = page.frameLocator('iframe[src*="office-runtime"]');
  await expect(frame.locator('canvas').first()).toBeVisible({
    timeout: 60_000,
  });
  const grid = frame.getByRole('tabpanel');
  const nameBox = frame.getByRole('textbox', {
    name: m.files_office_spreadsheet_name_box(),
  });
  await expect(nameBox).toHaveValue('A1');

  // Far past the used range: the scroll area grows to show the cell.
  await nameBox.fill('h5000');
  await nameBox.press('Enter');
  await expect(nameBox).toHaveValue('H5000');
  await expect
    .poll(() => grid.evaluate((node) => node.scrollTop))
    .toBeGreaterThan(50_000);
  // Past the browsers' element size limit the cell is selected and the scroll
  // area stops at the fork's 15,000,000 px cap (MAX_SCROLL_EXTENT_PX).
  await nameBox.fill('a1048576');
  await nameBox.press('Enter');
  await expect(nameBox).toHaveValue('A1048576');
  await expect
    .poll(() => grid.evaluate((node) => node.scrollTop))
    .toBeGreaterThan(14_000_000);
  expect(await grid.evaluate((node) => node.scrollHeight)).toBeLessThanOrEqual(
    15_000_000
  );

  // Another sheet's address opens it; a range goes to its first cell.
  await nameBox.fill("'summary'!b3:c4");
  await nameBox.press('Enter');
  await expect(frame.getByRole('tab', { name: 'Summary' })).toHaveAttribute(
    'aria-selected',
    'true'
  );
  await expect(nameBox).toHaveValue('B3');

  // Text that names no cell stays in the box until Escape restores it.
  await nameBox.fill('nowhere');
  await nameBox.press('Enter');
  await expect(nameBox).toHaveValue('nowhere');
  await nameBox.press('Escape');
  await expect(nameBox).toHaveValue('B3');
});

for (const format of ['docx', 'xlsx', 'pptx'] as const) {
  test(`${format} zoom carries across View and Edit while the file is open, and stays usable while paused`, async ({
    page,
  }) => {
    // Four frame loads, two of them editors.
    test.setTimeout(format === 'docx' ? 300_000 : 180_000);
    await page.setViewportSize({ height: 800, width: 1280 });
    const fileId = `bio-office-${format}`;
    await page.goto(`/workspaces/ws_bio?file=${fileId}`);
    const frame = page.frameLocator('iframe[src*="office-runtime"]');
    await expect(frame.locator('canvas').first()).toBeVisible({
      timeout: 120_000,
    });
    const mode = page.getByRole('button', { name: m.material_mode() });
    const zoomMenu = async () => {
      await officeMenu(page, format, 'View').click();
      await page.getByRole('menuitem', { name: 'Zoom' }).click();
    };
    const zoomTo = async (level: string) => {
      await zoomMenu();
      await page
        .getByRole('menuitemcheckbox', { exact: true, name: level })
        .click();
      // The closed menu hands the frame the focus; a menu opened before
      // that would close under the next click.
      await expect(page.locator('iframe[src*="office-runtime"]')).toBeFocused();
    };
    const ticked = async (level: string) => {
      await zoomMenu();
      await expect(
        page.getByRole('menuitemcheckbox', { exact: true, name: level })
      ).toBeChecked();
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');
    };
    // What the zoom scales: a page, the slide, the viewer's scroll area (the
    // editor's also reaches past the sheet, so XLSX edit checks the box).
    const size = (editing: boolean) =>
      (format === 'docx'
        ? frame.locator('[data-page-index="0"]').first()
        : format === 'pptx'
          ? editing
            ? frame.getByTestId('pptx-slide-canvas')
            : frame.locator('.pptx-viewer-stage canvas')
          : frame.getByRole('tabpanel').locator(':scope > div').first()
      ).evaluate((node) => (node as HTMLElement).offsetWidth);
    // A PPTX slide wider than its stage scrolls from its left edge.
    const scrollsFromEdge = async (editing: boolean) =>
      expect(
        await frame
          .locator(
            editing
              ? '[data-testid="pptx-slide-canvas"]'
              : '.pptx-viewer-stage canvas'
          )
          .evaluate((node) => {
            const stage = node.parentElement?.parentElement;
            if (!stage) throw new Error('Missing slide stage');
            stage.scrollTo(0, 0);
            return (
              node.getBoundingClientRect().left -
              stage.getBoundingClientRect().left
            );
          })
      ).toBeGreaterThanOrEqual(0);
    // While a zoomed slide scrolls, the viewer's Notes button keeps its corner.
    const notesStay = async () => {
      const notes = frame.getByTestId('pptx-notes-toggle');
      const before = await notes.boundingBox();
      expect(
        await frame.locator('.pptx-viewer-scroll').evaluate((node) => {
          node.scrollTo(node.scrollWidth, node.scrollHeight);
          return node.scrollLeft > 0 && node.scrollTop > 0;
        })
      ).toBe(true);
      expect(await notes.boundingBox()).toEqual(before);
    };
    const scaled = async (editing: boolean, factor: number) =>
      expect
        .poll(async () => Math.abs((await size(editing)) - base * factor), {
          timeout: 60_000,
        })
        .toBeLessThanOrEqual(2);
    // The toolbar's zoom control in edit mode.
    const toolbarZoom =
      format === 'docx'
        ? frame.getByRole('combobox', { name: /^Zoom/ })
        : frame.getByTestId(`${format}-zoom`);
    const showsZoom = (level: string) =>
      format === 'xlsx'
        ? expect(toolbarZoom).toHaveValue(level)
        : expect(toolbarZoom).toContainText(level);

    // PPTX opens fitted to the window; 100% is the base for all three.
    if (format === 'pptx') await zoomTo('100%');
    const base = await size(false);
    await zoomTo('150%');
    await scaled(false, 1.5);
    await ticked('150%');

    await mode.click();
    await expect(officeEditMenu(page, format)).toBeVisible({
      timeout: 120_000,
    });
    await showsZoom('150%');
    await ticked('150%');
    if (format !== 'xlsx') await scaled(true, 1.5);
    if (format === 'pptx') await scrollsFromEdge(true);

    await mode.click();
    await expect(mode).toHaveAttribute('aria-pressed', 'false');
    await expect(frame.locator('canvas').first()).toBeVisible({
      timeout: 120_000,
    });
    await scaled(false, 1.5);
    await ticked('150%');
    if (format === 'pptx') {
      await scrollsFromEdge(false);
      await notesStay();
    }

    // Paused (a newer version replaced the session): zoom edits nothing, so
    // the toolbar's control still works.
    await mode.click();
    await expect(officeEditMenu(page, format)).toBeVisible({
      timeout: 120_000,
    });
    await saveOffice(page, format);
    await expect(page.locator('[data-save-state="saved"]')).toBeVisible();
    await page.evaluate(async (id) => {
      const modulePath = '/src/mocks/collaboration.ts';
      const { announceSourceEpoch } = (await import(
        modulePath
      )) as typeof import('../../src/mocks/collaboration');
      announceSourceEpoch(id, 2);
    }, fileId);
    await expect(page.getByText(m.source_edit_replaced())).toBeVisible();
    await expect(toolbarZoom).toBeEnabled();
    if (format === 'xlsx') {
      // A typed zoom takes 50–200% as Google Sheets does: 300 is 200%.
      await toolbarZoom.fill('300');
      await toolbarZoom.press('Enter');
    } else {
      await toolbarZoom.click();
      await frame
        .getByRole(format === 'docx' ? 'option' : 'menuitem', {
          exact: true,
          name: '200%',
        })
        .click();
    }
    await showsZoom('200%');
    if (format !== 'xlsx') await scaled(true, 2);
  });
}

test.describe('DOCX on a phone', () => {
  // Touch, so a pinch reaches the runtime frame as touches.
  test.use({
    hasTouch: true,
    isMobile: true,
    viewport: { height: 740, width: 360 },
  });

  const open = async (page: Page) => {
    await page.goto('/workspaces/ws_bio?file=bio-office-docx');
    const frame = page.frameLocator('iframe[src*="office-runtime"]');
    await expect(frame.locator('canvas').first()).toBeVisible({
      timeout: 120_000,
    });
    return frame;
  };
  // The first page's width and its scroll pane's (the viewer's or editor's).
  const widths = (frame: FrameLocator) =>
    frame
      .locator('[data-page-index="0"]')
      .first()
      .evaluate((node) => {
        const pane = node.closest<HTMLElement>(
          '.docx-runtime-viewer, .docx-editor__scroll-container'
        );
        if (!pane) throw new Error('Missing DOCX scroll pane');
        return {
          page: (node as HTMLElement).offsetWidth,
          pane: pane.clientWidth,
        };
      });
  const pageWidth = async (frame: FrameLocator) => (await widths(frame)).page;
  // The 816 px page and the column's 24 px padding each side fill the pane.
  const fitted = async (frame: FrameLocator) => {
    await expect
      .poll(
        async () => {
          const { page, pane } = await widths(frame);
          return Math.abs(page - Math.min(816, pane - 48));
        },
        { timeout: 30_000 }
      )
      .toBeLessThanOrEqual(1);
    return pageWidth(frame);
  };
  const resize = (page: Page, width: number, height = 740) =>
    page.setViewportSize({ height, width });
  const editMode = async (page: Page) => {
    await page.getByRole('button', { name: m.material_mode() }).click();
    await expect(officeEditMenu(page, 'docx')).toBeVisible({
      timeout: 120_000,
    });
    // The pages come after the menus: on a CI runner the document is still
    // loading for several seconds once the Edit menu shows.
    await expect(
      page
        .frameLocator('iframe[src*="office-runtime"]')
        .locator('.docx-editor__scroll-container canvas[data-page-index="0"]')
    ).toBeVisible({ timeout: 120_000 });
  };
  const pinchFrame = async (page: Page, scaleFactor: number) => {
    const box = await page
      .locator('iframe[src*="office-runtime"]')
      .boundingBox();
    if (!box) throw new Error('Missing Office runtime');
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.synthesizePinchGesture', {
      gestureSourceType: 'touch',
      scaleFactor,
      x: box.x + box.width / 2,
      y: box.y + box.height / 2,
    });
    await cdp.detach();
  };

  test('a DOCX opens fitted and re-fits on resize in View and Edit until View › Zoom picks a level', async ({
    page,
  }) => {
    test.setTimeout(300_000);
    const frame = await open(page);
    const narrow = await fitted(frame);
    expect(narrow).toBeLessThan(816);
    await resize(page, 390);
    expect(await fitted(frame)).toBeGreaterThan(narrow);
    // Landscape, then a desktop width: still fitted, at most 100%. The right
    // rail keeps at least 400px, so 100% needs a window wider than 1280px.
    await resize(page, 844, 390);
    expect(await fitted(frame)).toBeGreaterThan(narrow);
    await resize(page, 1440, 900);
    expect(await fitted(frame)).toBe(816);
    await resize(page, 390);
    await fitted(frame);

    // The fit carries into Edit and keeps following the pane there.
    await editMode(page);
    await fitted(frame);
    await resize(page, 360);
    await fitted(frame);

    await officeMenu(page, 'docx', 'View').click();
    await page.getByRole('menuitem', { name: 'Zoom' }).click();
    // At 360 px the submenu opens over its parent menu, which takes the
    // pointer while it settles.
    await page
      .getByRole('menuitemcheckbox', { exact: true, name: '100%' })
      .dispatchEvent('click');
    await expect.poll(() => pageWidth(frame)).toBe(816);
    await resize(page, 390);
    await page.waitForTimeout(1000);
    expect(await pageWidth(frame)).toBe(816);
    // The picked level carries back to View.
    await page.getByRole('button', { name: m.material_mode() }).click();
    await expect(frame.locator('.docx-runtime-viewer')).toBeVisible({
      timeout: 120_000,
    });
    await expect.poll(() => pageWidth(frame)).toBe(816);
  });

  test('a pinch zooms the document, not the page, and ends the re-fit', async ({
    page,
  }) => {
    test.setTimeout(300_000);
    const frame = await open(page);
    const narrow = await fitted(frame);
    await pinchFrame(page, 2);
    await expect.poll(() => pageWidth(frame)).toBeGreaterThan(narrow * 1.5);
    const pinched = await pageWidth(frame);
    // Capy's page keeps its scale: the header and menus stay their size.
    expect(await page.evaluate(() => window.visualViewport?.scale)).toBe(1);
    await resize(page, 390);
    await page.waitForTimeout(1000);
    expect(await pageWidth(frame)).toBe(pinched);

    // In Edit too, from the carried level.
    await editMode(page);
    await expect.poll(() => pageWidth(frame)).toBe(pinched);
    await pinchFrame(page, 0.5);
    await expect.poll(() => pageWidth(frame)).toBeLessThan(pinched * 0.75);
    expect(await page.evaluate(() => window.visualViewport?.scale)).toBe(1);
  });

  // The page at the top of Edit's pane, while the caret stays on page 1.
  for (const level of ['fitted', '100%'] as const) {
    test(`Edit keeps the page at the top across a rotation, ${level}, leaving the caret`, async ({
      page,
    }) => {
      test.setTimeout(300_000);
      await resize(page, 390);
      const frame = await open(page);
      await editMode(page);
      if (level === '100%') {
        await officeMenu(page, 'docx', 'View').click();
        await page.getByRole('menuitem', { name: 'Zoom' }).click();
        await page
          .getByRole('menuitemcheckbox', { exact: true, name: '100%' })
          .dispatchEvent('click');
        await expect.poll(() => pageWidth(frame)).toBe(816);
      } else await fitted(frame);
      const pane = frame.locator('.docx-editor__scroll-container');
      const topPage = () =>
        pane.evaluate((node) => {
          const box = node.getBoundingClientRect();
          return [
            ...node.querySelectorAll<HTMLElement>('canvas[data-page-index]'),
          ].find(
            (canvas) => canvas.getBoundingClientRect().bottom > box.top + 1
          )?.dataset.pageIndex;
        });
      // Edit opens with the caret at the start, on page 1 (the document input
      // takes the focus back from the menu); the reader scrolls to page 6.
      await frame.getByLabel('Document input').focus();
      await expect(frame.getByLabel('Document input')).toBeFocused();
      await pane.evaluate((node) => {
        const sixth = node.querySelector<HTMLElement>(
          'canvas[data-page-index="5"]'
        );
        if (!sixth) throw new Error('Missing page 6');
        node.scrollTop +=
          sixth.getBoundingClientRect().top -
          node.getBoundingClientRect().top +
          40;
      });
      await page.waitForTimeout(500);
      expect(await topPage()).toBe('5');
      await resize(page, 844, 390);
      if (level === 'fitted') await fitted(frame);
      await page.waitForTimeout(2000);
      expect(await topPage()).toBe('5');
      await resize(page, 390);
      if (level === 'fitted') await fitted(frame);
      await page.waitForTimeout(2000);
      expect(await topPage()).toBe('5');
      // A re-fit alone, with no faces left to load: the zoom change itself.
      await resize(page, 430);
      if (level === 'fitted') await fitted(frame);
      await page.waitForTimeout(2000);
      expect(await topPage()).toBe('5');
      // The caret stayed on page 1: typing lands there and scrolls to it.
      await page.keyboard.type('Q');
      await expect.poll(topPage).toBe('0');
    });
  }

  // The highlight's place as a fraction of its page's width, the same at any zoom.
  const highlightOnPage = (frame: FrameLocator) =>
    frame
      .locator('[data-citation-highlight]')
      .first()
      .evaluate((node) => {
        const box = node as HTMLElement;
        const canvas = box.parentElement?.querySelector<HTMLCanvasElement>(
          'canvas[data-page-index]'
        );
        const width = canvas?.getBoundingClientRect().width ?? 0;
        return [box.offsetLeft, box.offsetTop, box.offsetWidth].map(
          (value) => value / width
        );
      });
  const closeTo = (actual: number[], expected: number[]) => {
    expect(actual).toHaveLength(expected.length);
    for (const [index, value] of actual.entries())
      expect(Math.abs(value - (expected[index] ?? Number.NaN))).toBeLessThan(
        0.005
      );
  };

  test('a chat citation opens the DOCX fitted with its passage highlighted in view, also after a rotation', async ({
    page,
  }) => {
    test.setTimeout(300_000);
    const quote = '工程學會亦因此已經三年沒有舉辦交流學習團';
    // The highlight at 100% (md), the reference.
    const reference = await page.context().newPage();
    await reference.setViewportSize({ height: 1024, width: 768 });
    const referenceFrame = await open(reference);
    expect(await pageWidth(referenceFrame)).toBe(816);
    await postToOfficeRuntime(reference, {
      citation: { quote },
      type: 'set-citation',
    });
    await expect(
      referenceFrame.locator('[data-citation-highlight]').first()
    ).toBeAttached({ timeout: 60_000 });
    const expected = await highlightOnPage(referenceFrame);
    await reference.close();

    await page.goto('/workspaces/ws_bio');
    await page
      .getByRole('button', { exact: true, name: m.workspace_tab_chat() })
      .click({ timeout: 60_000 });
    // The MSW User scenarios panel floats over the chat field's history button.
    await page.getByRole('button', { name: m.chat_history() }).press('Enter');
    await page.getByRole('button', { name: 'OpenUI: Office citation' }).click();
    await page.getByTitle(m.chat_source_number({ n: 1 })).click();
    const frame = page.frameLocator('iframe[src*="office-runtime"]');
    const highlight = frame.locator('[data-citation-highlight]').first();
    await expect(highlight).toBeAttached({ timeout: 120_000 });
    await fitted(frame);
    // In view in the viewer, with nothing scrolled sideways.
    const inView = () =>
      highlight.evaluate((node) => {
        const viewer = node.closest<HTMLElement>('.docx-runtime-viewer');
        if (!viewer) throw new Error('Missing viewer');
        const box = node.getBoundingClientRect();
        const pane = viewer.getBoundingClientRect();
        return {
          sideways: viewer.scrollWidth - viewer.clientWidth,
          visible: box.top >= pane.top && box.bottom <= pane.bottom,
        };
      });
    await expect.poll(inView).toEqual({ sideways: 0, visible: true });
    closeTo(await highlightOnPage(frame), expected);

    // A rotation re-fits the page; the highlight stays on its passage.
    await resize(page, 740, 360);
    await fitted(frame);
    closeTo(await highlightOnPage(frame), expected);
    await resize(page, 360);
    await fitted(frame);
    closeTo(await highlightOnPage(frame), expected);
  });

  test('a DOCX with comments opens fitted below md with its comments sidebar closed and no sideways scroll, and at md with it open', async ({
    context,
    page,
  }) => {
    test.setTimeout(300_000);
    // exchange-plan.docx with a comment on its first paragraph, and the room
    // state seeded from it (scripts/dev/seed-scenario-office.ts).
    const source = readFileSync(
      'e2e/fixtures/files/rich-content/exchange-plan-comments.docx'
    );
    const state = readFileSync(
      'src/mocks/fixtures/comments-docx-checkpoint.bin'
    );
    await context.route(
      (url) =>
        url.pathname.endsWith('/rich-content/exchange-plan.docx') &&
        !url.search,
      (route) =>
        route.fulfill({
          body: source,
          contentType:
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        })
    );
    await context.route(
      (url) =>
        url.pathname.endsWith('/rich-docx-checkpoint.bin') && !url.search,
      (route) =>
        route.fulfill({ body: state, contentType: 'application/octet-stream' })
    );
    const sidebar = (frame: FrameLocator) =>
      frame.locator('.docx-unified-sidebar');
    await resize(page, 390);
    const frame = await open(page);
    await editMode(page);
    await fitted(frame);
    await page.waitForTimeout(2000);
    await expect(sidebar(frame)).toHaveCount(0);
    const pane = frame.locator('.docx-editor__scroll-container');
    expect(
      await pane.evaluate((node) => node.scrollWidth - node.clientWidth)
    ).toBeLessThanOrEqual(1);
    // At md the editor opens it by itself, as before (one page on the file).
    await page.close();
    const desktop = await context.newPage();
    await desktop.setViewportSize({ height: 900, width: 1280 });
    // Edit, as the file was left (not toggled back to View).
    await desktop.goto('/workspaces/ws_bio?file=bio-office-docx&mode=edit');
    await expect(officeEditMenu(desktop, 'docx')).toBeVisible({
      timeout: 120_000,
    });
    const desktopFrame = desktop.frameLocator('iframe[src*="office-runtime"]');
    await expect(sidebar(desktopFrame)).toBeVisible({ timeout: 60_000 });
    await desktop.close();
  });

  test('md and up opens a DOCX at 100% in View and Edit', async ({ page }) => {
    test.setTimeout(300_000);
    await resize(page, 768, 1024);
    const frame = await open(page);
    expect(await pageWidth(frame)).toBe(816);
    await editMode(page);
    await expect.poll(() => pageWidth(frame)).toBe(816);
  });

  test('at the fitted, fractional zoom a click places the caret, a drag selects and a double click takes the word', async ({
    page,
  }) => {
    test.setTimeout(300_000);
    await page
      .context()
      .grantPermissions(['clipboard-read', 'clipboard-write']);
    const frame = await open(page);
    await editMode(page);
    expect(await fitted(frame)).toBeLessThan(816 * 0.4);
    const run = (text: string) =>
      frame
        .locator(
          '.layout-page-mirror:not(.layout-page-mirror-text) .layout-run-text'
        )
        .filter({ hasText: new RegExp(`^${text}$`) })
        .first();
    const box = async (text: string) => {
      // The screen-reader mirror is built after the pages, at idle.
      await expect(run(text)).toBeAttached({ timeout: 60_000 });
      const found = await run(text).boundingBox();
      if (!found) throw new Error(`Missing run ${text}`);
      return found;
    };
    const clipboard = () => page.evaluate(() => navigator.clipboard.readText());
    const copy = async () => {
      await page.evaluate(() => navigator.clipboard.writeText(''));
      await page.keyboard.press('ControlOrMeta+c');
    };

    // Drag across the title's three paragraphs.
    const from = await box('2');
    const to = await box('書');
    await page.mouse.move(from.x + 0.5, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(to.x + to.width - 0.5, to.y + to.height / 2, {
      steps: 8,
    });
    await page.mouse.up();
    await copy();
    await expect
      .poll(clipboard)
      .toBe('2022 至 2023 年度\n香港大學工程學院 \n交流學習團活動計劃書');

    // The canvas above the mirror takes the pointer.
    const three = await box('3');
    await page.mouse.dblclick(
      three.x + three.width / 2,
      three.y + three.height / 2
    );
    await copy();
    await expect.poll(clipboard).toBe('2023');

    // A click in the right half of 團 puts the caret after it.
    const tuan = await box('團');
    await page.mouse.click(
      tuan.x + tuan.width * 0.75,
      tuan.y + tuan.height / 2
    );
    await page.keyboard.type('Z');
    const ji = await box('計');
    await page.mouse.click(ji.x + ji.width / 2, ji.y + ji.height / 2, {
      clickCount: 3,
    });
    await copy();
    await expect.poll(clipboard).toBe('交流學習團Z活動計劃書');
  });
});

test('XLSX cell edit ends when focus moves into Capy, not on a window switch', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ height: 800, width: 1280 });
  await page.goto('/workspaces/ws_bio');
  await page
    .getByRole('tab', { exact: true, name: m.workspace_tab_files() })
    .click();
  await page
    .locator('[data-workspace-file-tree] a[href*="file=bio-office-xlsx"]')
    .click();
  const frame = page.frameLocator('iframe[src*="office-runtime"]');
  await expect(frame.locator('canvas').first()).toBeVisible({
    timeout: 60_000,
  });
  await page.getByRole('button', { name: m.material_mode() }).click();
  await expect(officeEditMenu(page, 'xlsx')).toBeVisible({ timeout: 30_000 });
  await page
    .getByRole('tab', { exact: true, name: m.workspace_tab_chat() })
    .click();
  const chat = page.getByRole('textbox', { name: m.chat_placeholder() });
  await expect(chat).toBeVisible();

  const grid = frame.getByTestId('xlsx-scroll');
  const formula = frame.getByTestId('xlsx-formula-input');
  const editor = frame.getByTestId('xlsx-cell-editor');
  const saved = page.locator('[data-save-state="saved"]');
  const box = await grid.boundingBox();
  if (!box) throw new Error('Grid is not laid out');

  // Into Capy's chat: the edit commits and saves; the chat keeps the focus.
  await page.mouse.click(box.x + 150, box.y + 75);
  await page.keyboard.press('5');
  await expect(editor).toHaveValue('5');
  await expect(saved).toHaveCount(0);
  await chat.click();
  await expect(chat).toBeFocused();
  await expect(editor).toHaveCount(0);
  await expect(formula).toHaveValue('5');
  await expect(saved).toBeVisible({ timeout: 30_000 });

  // The same where the frame cannot tell from its own blur (it sees no focus,
  // as on a switch): Capy's focus-left message ends the edit.
  const frameFocus = (has: boolean) =>
    frame.locator(':root').evaluate((_, value) => {
      document.hasFocus = value ? Document.prototype.hasFocus : () => false;
    }, has);
  await page.mouse.click(box.x + 150, box.y + 75);
  await page.keyboard.press('8');
  await expect(editor).toHaveValue('8');
  await frameFocus(false);
  await chat.click();
  await expect(chat).toBeFocused();
  await expect(editor).toHaveCount(0);
  await expect(formula).toHaveValue('8');

  await frameFocus(true);

  // An app or browser-tab switch takes focus from the whole page: the edit
  // stays open and takes the next key on return.
  await page.mouse.click(box.x + 150, box.y + 75);
  await page.keyboard.press('6');
  await expect(editor).toHaveValue('6');
  // During a real switch neither document has focus and focus stays in the
  // frame (Capy's window gets no focus event): stub both, blur in the frame.
  for (const target of [page, frame.locator(':root')])
    await target.evaluate(() => {
      document.hasFocus = () => false;
    });
  await editor.evaluate((input) => input.blur());
  await expect(editor).not.toBeFocused();
  await expect(editor).toHaveValue('6');
  for (const target of [page, frame.locator(':root')])
    await target.evaluate(() => {
      document.hasFocus = Document.prototype.hasFocus;
    });
  await editor.focus();
  await page.keyboard.press('7');
  await page.keyboard.press('Enter');
  await expect(editor).toHaveCount(0);
  await page.keyboard.press('ArrowUp');
  await expect(formula).toHaveValue('67');

  // Input the engine refuses: the editor reports it in the frame, and Capy
  // shows no file error for a save nobody asked for.
  await page.mouse.click(box.x + 150, box.y + 75);
  await page.keyboard.press('9');
  await editor.fill('x'.repeat(40_000));
  await frameFocus(false);
  await chat.click();
  await expect(frame.getByTestId('xlsx-error')).toBeVisible();
  await expect(page.getByText(m.error_file_body())).toHaveCount(0);
});

test("Office runtime keeps Capy's theme after reloading and asks for a page reload on a protocol mismatch", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.addInitScript(() => localStorage.setItem('capy.theme', 'mocha'));
  await page.goto('/workspaces/ws_bio?file=bio-office-docx');
  const frame = page.frameLocator('iframe[src*="office-runtime"]');
  await expect(frame.locator('canvas').first()).toBeVisible({
    timeout: 60_000,
  });
  await expect(frame.locator('html')).toHaveAttribute('data-theme', 'mocha');
  const runtime = page
    .frames()
    .find((candidate) => candidate.url().includes('office-runtime'));
  if (!runtime) throw new Error('Missing Office runtime');

  // The runtime document reloads by itself; the host sends the theme again.
  const reloaded = page.waitForEvent(
    'framenavigated',
    (navigated) => navigated === runtime
  );
  await runtime.evaluate(() => setTimeout(() => location.reload()));
  await reloaded;
  await expect(frame.locator('canvas').first()).toBeVisible({
    timeout: 60_000,
  });
  await expect(frame.locator('html')).toHaveAttribute('data-theme', 'mocha');

  // A runtime from another deploy starts under another protocol version.
  await runtime.evaluate(() =>
    parent.postMessage({ type: 'initialized', version: 0 }, '*')
  );
  await expect(page.getByText(m.error_chunk_title())).toBeVisible();
  await expect(
    page.getByRole('button', { name: m.error_action_reload() })
  ).toBeVisible();
});

test('an Office citation highlights its passage again after the runtime reloads', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.goto('/workspaces/ws_bio');
  await page
    .getByRole('tab', { exact: true, name: m.workspace_tab_chat() })
    .click();
  await page.getByRole('button', { name: m.chat_history() }).click();
  await page.getByRole('button', { name: 'OpenUI: Office citation' }).click();
  await page.getByTitle(m.chat_source_number({ n: 1 })).click();
  const frame = page.frameLocator('iframe[src*="office-runtime"]');
  const highlight = frame.locator('[data-citation-highlight]').first();
  await expect(highlight).toBeVisible({ timeout: 60_000 });
  // The passage's size and place, to find the same highlight after the reload.
  const place = async () =>
    Object.values((await highlight.boundingBox()) ?? {}).map(Math.round);
  const cited = await place();
  const runtime = page
    .frames()
    .find((candidate) => candidate.url().includes('office-runtime'));
  if (!runtime) throw new Error('Missing Office runtime');

  // The runtime document reloads by itself; the host's new load carries the citation.
  const reloaded = page.waitForEvent(
    'framenavigated',
    (navigated) => navigated === runtime
  );
  await runtime.evaluate(() => setTimeout(() => location.reload()));
  await reloaded;
  await expect(highlight).toBeVisible({ timeout: 60_000 });
  await expect.poll(place).toEqual(cited);
});

test('a PPTX citation on a zoomed slide scrolls into view', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ height: 800, width: 1280 });
  await page.goto('/workspaces/ws_bio?file=bio-office-pptx');
  const frame = page.frameLocator('iframe[src*="office-runtime"]');
  await expect(frame.locator('canvas').first()).toBeVisible({
    timeout: 120_000,
  });
  await officeMenu(page, 'pptx', 'View').click();
  await page.getByRole('menuitem', { name: 'Zoom' }).click();
  await page
    .getByRole('menuitemcheckbox', { exact: true, name: '200%' })
    .click();
  const scroller = frame.locator('.pptx-viewer-scroll');
  // Where the scroller's centre is on the slide, in 200% pixels.
  const centre = () =>
    scroller.evaluate((node) => ({
      x: node.scrollLeft + node.clientWidth / 2,
      y: node.scrollTop + node.clientHeight / 2,
    }));
  const position = () =>
    scroller.evaluate((node) => [node.scrollLeft, node.scrollTop]);
  const cite = () =>
    postToOfficeRuntime(page, {
      citation: { quote: 'UAT_RUN_MARKER' },
      type: 'set-citation',
    });
  // Slide 1's UAT_RUN_MARKER line, centred across the 960x540 slide in a box
  // from y 333 to 485, is out of view at 200% from the top-right.
  await scroller.evaluate((node) => node.scrollTo(node.scrollWidth, 0));
  await cite();
  await expect
    .poll(async () => {
      const { x, y } = await centre();
      return Math.abs(x - 960) < 40 && y > 666 && y < 970;
    })
    .toBe(true);

  // A citation already in view leaves the scroll alone.
  await scroller.evaluate((node) => node.scrollBy(0, 150));
  const shifted = await position();
  await cite();
  await page.waitForTimeout(1500);
  expect(await position()).toEqual(shifted);

  // Each highlight scrolls once: a repaint (the window resizing) keeps where
  // the reader scrolled to.
  await scroller.evaluate((node) => node.scrollTo(0, 0));
  await page.setViewportSize({ height: 790, width: 1270 });
  await page.waitForTimeout(1500);
  expect(await position()).toEqual([0, 0]);
});

// A paused editor is read-only in every pause state; a replaced session is
// the one the mocks drive.
for (const [format, text] of [
  ['docx', '交流學習團活動計劃書'],
  ['xlsx', 'Course Code'],
] as const) {
  test(`a paused ${format} editor copies but takes no edit, a composition included, also after the runtime reloads`, async ({
    page,
  }) => {
    test.setTimeout(300_000);
    // The runtime takes each `load` 1.5 s late, so the host's set-capabilities
    // comes first, as when a runtime boots before the source loads.
    await page.addInitScript(() => {
      if (!location.pathname.includes('office-runtime')) return;
      const add = window.addEventListener.bind(window);
      window.addEventListener = ((
        type: string,
        listener: EventListenerOrEventListenerObject,
        options?: boolean | AddEventListenerOptions
      ) => {
        if (type !== 'message' || typeof listener !== 'function')
          return add(type, listener, options);
        return add(
          type,
          (event: Event) => {
            if ((event as MessageEvent).data?.type === 'load')
              setTimeout(() => listener.call(window, event), 1500);
            else listener.call(window, event);
          },
          options
        );
      }) as typeof window.addEventListener;
    });
    const fileId = `bio-office-${format}`;
    await page.goto(`/workspaces/ws_bio?file=${fileId}&mode=edit`);
    const frame = page.frameLocator('iframe[src*="office-runtime"]');
    await expect(frame.locator('canvas').first()).toBeVisible({
      timeout: 120_000,
    });
    await expect(officeEditMenu(page, format)).toBeVisible({ timeout: 30_000 });
    await saveOffice(page, format);
    await expect(page.locator('[data-save-state="saved"]')).toBeVisible();

    // A newer version is published while the saved editor is open: the
    // session is replaced and the editor pauses under the reload banner.
    await page.evaluate(async (id) => {
      const modulePath = '/src/mocks/collaboration.ts';
      const { announceSourceEpoch } = (await import(
        modulePath
      )) as typeof import('../../src/mocks/collaboration');
      announceSourceEpoch(id, 2);
    }, fileId);
    await expect(page.getByText(m.source_edit_replaced())).toBeVisible();

    const updates = await page.evaluateHandle(() => {
      const seen = { count: 0 };
      window.addEventListener('message', (event) => {
        if (event.data?.type === 'update') seen.count += 1;
      });
      return seen;
    });
    // DOCX writes the copy event's data, XLSX the clipboard from its keydown.
    await page
      .context()
      .grantPermissions(['clipboard-read', 'clipboard-write']);
    const copySelectAll = async () => {
      await page.evaluate(() => navigator.clipboard.writeText('EMPTY'));
      await officeMenu(page, format, 'Edit').click();
      await page.getByRole('menuitem', { name: /^Select all/ }).click();
      await page.keyboard.press('ControlOrMeta+C');
      await expect
        .poll(() => page.evaluate(() => navigator.clipboard.readText()))
        .not.toBe('EMPTY');
      return page.evaluate(() => navigator.clipboard.readText());
    };

    // Paused menus: what edits is disabled, File › Save included.
    await officeMenu(page, format, 'File').click();
    await expect(page.getByRole('menuitem', { name: /^Save/ })).toHaveAttribute(
      'aria-disabled',
      'true'
    );
    await expect(
      page.getByRole('menuitem', { name: 'Download' })
    ).not.toHaveAttribute('aria-disabled', 'true');
    await page.keyboard.press('Escape');
    if (format === 'docx') {
      // Find opens and takes typing; Replace stays disabled.
      await officeMenu(page, format, 'Edit').click();
      await page.getByRole('menuitem', { name: /^Find and replace/ }).click();
      const find = frame.getByLabel('Find text');
      await find.click();
      await page.keyboard.type('Course');
      await expect(find).toHaveValue('Course');
      await expect(
        frame.getByRole('button', { exact: true, name: 'Replace' })
      ).toBeDisabled();
      await find.press('Escape');
      await expect(find).toHaveCount(0);
    }
    const before = await copySelectAll();
    expect(before).toContain(text);

    // Typing through an IME where editing would take it (the document input,
    // the grid that opens a cell editor), and editing commands posted to the
    // runtime.
    if (format === 'docx')
      await expect(frame.getByLabel('Document input')).toBeFocused();
    else {
      await expect(frame.getByTestId('xlsx-scroll')).toBeFocused();
      await page.keyboard.type('x');
      await expect(frame.getByTestId('xlsx-cell-editor')).toHaveCount(0);
    }
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.imeSetComposition', {
      selectionEnd: 3,
      selectionStart: 3,
      text: '日本語',
    });
    await cdp.send('Input.insertText', { text: '日本語' });
    await cdp.detach();
    await page.keyboard.press('Backspace');
    await postToOfficeRuntime(page, {
      id: format === 'docx' ? 'insert-page-break' : 'insertRowAbove',
      type: 'menu-command',
    });
    await page.waitForTimeout(1500);
    expect(await updates.evaluate((seen) => seen.count)).toBe(0);
    expect(await copySelectAll()).toBe(before);

    if (format === 'xlsx') {
      // The formula bar stays read-only, not disabled: its text copies, and
      // typing changes nothing.
      await frame
        .getByTestId('xlsx-scroll')
        .click({ position: { x: 60, y: 95 } });
      const formula = frame.getByTestId('xlsx-formula-input');
      await expect(formula).not.toHaveValue('');
      const value = await formula.inputValue();
      await formula.click();
      await page.keyboard.press('ControlOrMeta+A');
      await page.keyboard.press('ControlOrMeta+C');
      await expect
        .poll(() => page.evaluate(() => navigator.clipboard.readText()))
        .toBe(value);
      await page.keyboard.type('Z');
      await page.keyboard.press('Enter');
      await expect(formula).toHaveValue(value);
      await page.waitForTimeout(1500);
      expect(await updates.evaluate((seen) => seen.count)).toBe(0);
    }

    // The runtime document reloads by itself; its new load is paused too.
    const runtime = page
      .frames()
      .find((candidate) => candidate.url().includes('office-runtime'));
    if (!runtime) throw new Error('Missing Office runtime');
    const reloaded = page.waitForEvent(
      'framenavigated',
      (navigated) => navigated === runtime
    );
    await runtime.evaluate(() => setTimeout(() => location.reload()));
    await reloaded;
    await expect(frame.locator('canvas').first()).toBeVisible({
      timeout: 60_000,
    });
    await officeMenu(page, format, 'File').click();
    await expect(page.getByRole('menuitem', { name: /^Save/ })).toHaveAttribute(
      'aria-disabled',
      'true'
    );
    await page.keyboard.press('Escape');
    expect(await copySelectAll()).toBe(before);
    await page.keyboard.type('Q');
    await page.waitForTimeout(1500);
    expect(await updates.evaluate((seen) => seen.count)).toBe(0);
    expect(await copySelectAll()).toBe(before);
  });
}

// One open DOCX (exchange-plan.docx) for these focus checks: the runtime
// boots once. Its load arrives 5 s late on every open (the init script), so
// typing in the chat box comes first.
test('DOCX editor focus: chat typing while it opens, first open before a save receipt, resuming from a pause and an open menu', async ({
  page,
}) => {
  test.setTimeout(420_000);
  await page.addInitScript(() => {
    if (!location.pathname.includes('office-runtime')) return;
    const add = window.addEventListener.bind(window);
    window.addEventListener = ((
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions
    ) => {
      if (type !== 'message' || typeof listener !== 'function')
        return add(type, listener, options);
      return add(
        type,
        (event: Event) => {
          if ((event as MessageEvent).data?.type === 'load')
            setTimeout(() => listener.call(window, event), 5000);
          else listener.call(window, event);
        },
        options
      );
    }) as typeof window.addEventListener;
  });
  const frame = page.frameLocator('iframe[src*="office-runtime"]');
  const chat = page.getByRole('textbox', { name: m.chat_placeholder() });
  const mode = page.getByRole('button', { name: m.material_mode() });
  const documentInput = frame.getByLabel('Document input');

  await test.step('a newly opened editor leaves the focus in the chat box', async () => {
    await page.goto('/workspaces/ws_bio?file=bio-office-docx&mode=edit');
    // The workspace panel opens on Files, also with a file in the URL.
    await page
      .getByRole('tab', { exact: true, name: m.workspace_tab_chat() })
      .click();
    await chat.click();
    await page.keyboard.type('hi');
    // Typed before the editor was ready.
    await expect(officeEditMenu(page, 'docx')).toHaveCount(0);
    await expect(frame.locator('canvas').first()).toBeVisible({
      timeout: 120_000,
    });
    await expect(officeEditMenu(page, 'docx')).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(1500);
    await expect(chat).toBeFocused();
    await page.keyboard.type(' there');
    await expect(chat).toHaveValue('hi there');
  });

  // The room's first save receipt, held back here as a busy room sends it
  // late, is not waited for: the editor edits from its first sync.
  await test.step('a newly opened editor is focused and editable before its first save receipt', async () => {
    await mode.click();
    await expect(officeEditMenu(page, 'docx')).toHaveCount(0, {
      timeout: 30_000,
    });
    await expect(frame.locator('canvas').first()).toBeVisible({
      timeout: 60_000,
    });
    const receipts = (hold: boolean) =>
      page.evaluate(async (hold) => {
        const modulePath = '/src/mocks/collaboration.ts';
        const { holdSourceSaveReceipts } = (await import(
          modulePath
        )) as typeof import('../../src/mocks/collaboration');
        holdSourceSaveReceipts(hold);
      }, hold);
    await receipts(true);
    const updates = await page.evaluateHandle(() => {
      const seen = { count: 0 };
      window.addEventListener('message', (event) => {
        if (event.data?.type === 'update') seen.count += 1;
      });
      return seen;
    });
    await mode.click();
    await expect(officeEditMenu(page, 'docx')).toBeVisible({ timeout: 60_000 });
    await expect(documentInput).toBeFocused();
    // Connecting ends at the first sync, before the receipt.
    await expect(page.getByTestId('editor-save-state')).toHaveAttribute(
      'data-save-state',
      'saved'
    );
    await page.keyboard.type('Hello');
    // A slow machine posts the first update seconds after the keys.
    await expect
      .poll(() => updates.evaluate((seen) => seen.count), { timeout: 30_000 })
      .toBeGreaterThan(0);
    await receipts(false);
    // Every key lands and saves before the next step counts updates: the
    // rest of "Hello" can still be in the editor's input queue here.
    await expect(page.getByTestId('editor-save-state')).toHaveAttribute(
      'data-save-state',
      'saved',
      { timeout: 30_000 }
    );
  });

  // A pause that ends hands nothing to the editor: a host field keeps the
  // focus and the typing.
  await test.step('resuming from a pause leaves the focus where it was', async () => {
    await chat.fill('');
    await chat.click();
    const capabilities = (canEdit: boolean) =>
      postToOfficeRuntime(page, { canEdit, type: 'set-capabilities' });
    await capabilities(false);
    await page.waitForTimeout(1000);
    const updates = await page.evaluateHandle(() => {
      const seen = { count: 0 };
      window.addEventListener('message', (event) => {
        if (event.data?.type === 'update') seen.count += 1;
      });
      return seen;
    });
    await capabilities(true);
    await page.waitForTimeout(1000);
    await expect(chat).toBeFocused();
    await page.keyboard.type('qq');
    await expect(chat).toHaveValue('qq');
    await page.waitForTimeout(1000);
    expect(await updates.evaluate((seen) => seen.count)).toBe(0);

    // Find, typed into while paused, keeps the focus: the next keys search.
    await capabilities(false);
    await page.waitForTimeout(1000);
    await officeMenu(page, 'docx', 'Edit').click();
    await page.getByRole('menuitem', { name: /^Find and replace/ }).click();
    const find = frame.getByLabel('Find text');
    await find.click();
    await page.keyboard.type('Cours');
    await capabilities(true);
    await page.waitForTimeout(1000);
    await expect(find).toBeFocused();
    await page.keyboard.type('e');
    await page.keyboard.press('Enter');
    await expect(find).toHaveValue('Course');
    await page.waitForTimeout(1000);
    expect(await updates.evaluate((seen) => seen.count)).toBe(0);
    await find.press('Escape');
    await expect(find).toHaveCount(0);

    // A new comment being typed hides while paused and comes back with its
    // draft; keys typed after the pause reach neither it nor the document.
    await officeMenu(page, 'docx', 'Edit').click();
    await page.getByRole('menuitem', { name: /^Select all/ }).click();
    await officeMenu(page, 'docx', 'Insert').click();
    await page.getByRole('menuitem', { name: /^Comment/ }).click();
    const note = frame.getByPlaceholder('Add a comment...');
    await expect(note).toBeFocused();
    await page.keyboard.type('Note');
    await capabilities(false);
    await page.waitForTimeout(1000);
    await expect(note).toBeHidden();
    await capabilities(true);
    await page.waitForTimeout(1000);
    await expect(note).toHaveValue('Note');
    await page.keyboard.type('x');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1000);
    await expect(note).toHaveValue('Note');
    expect(await updates.evaluate((seen) => seen.count)).toBe(0);
    await note.click();
    await page.keyboard.type(' more');
    await expect(note).toHaveValue('Note more');

    // A reply restored after a pause keeps its draft, and the keys typed after
    // the pause reach neither it nor the document.
    await page.keyboard.press('Enter');
    await frame.locator('.docx-comment-card', { hasText: 'Note more' }).click();
    const reply = frame.getByPlaceholder('Reply or add others with @');
    await reply.click();
    await expect(reply).toBeFocused();
    await page.keyboard.type('Re');
    await capabilities(false);
    await page.waitForTimeout(1000);
    await expect(reply).toBeHidden();
    const settled = await updates.evaluate((seen) => seen.count);
    await capabilities(true);
    await page.waitForTimeout(1000);
    await expect(reply).toHaveValue('Re');
    await page.keyboard.type('x');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1000);
    await expect(reply).toHaveValue('Re');
    expect(await updates.evaluate((seen) => seen.count)).toBe(settled);
  });

  // An open Capy menu keeps the focus too: it stays open and takes the keys.
  await test.step('a newly opened editor leaves the focus in an open Capy menu', async () => {
    await mode.click();
    await expect(officeEditMenu(page, 'docx')).toHaveCount(0, {
      timeout: 30_000,
    });
    await expect(frame.locator('canvas').first()).toBeVisible({
      timeout: 60_000,
    });
    const ready = await page.evaluateHandle(() => {
      const seen = { count: 0 };
      window.addEventListener('message', (event) => {
        if (event.data?.type === 'collaboration-ready') seen.count += 1;
      });
      return seen;
    });
    await mode.click();
    await page
      .getByRole('tab', { exact: true, name: m.workspace_tab_files() })
      .click();
    await page
      .locator('[data-workspace-file-tree]')
      .locator('..')
      .getByRole('button', { exact: true, name: m.action_add_file() })
      .first()
      .click();
    const menu = page.getByRole('menu');
    await expect(menu).toBeVisible();
    expect(await ready.evaluate((seen) => seen.count)).toBe(0);
    await expect
      .poll(() => ready.evaluate((seen) => seen.count), { timeout: 60_000 })
      .toBeGreaterThan(0);
    await page.waitForTimeout(1500);
    await expect(menu).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
  });
});

// Closing a header from its Options menu gives the document the focus back
// (lesson.docx, the DOCX scenario's file, has a header; exchange-plan.docx
// has none).
test('closing DOCX header editing gives the document the focus back', async ({
  page,
}) => {
  test.setTimeout(240_000);
  await page.goto('/workspaces/ws_bio');
  const panel = page.getByTestId('mock-scenario-panel');
  await panel.evaluate((node: HTMLDetailsElement) => {
    node.open = true;
  });
  await panel.locator('[data-scenario="office-docx-save"]').click();
  await expect(panel).toHaveAttribute('data-scenario-status', 'ready', {
    timeout: 60_000,
  });
  const frame = page.frameLocator('iframe[src*="office-runtime"]');
  const pageCanvas = frame.locator('canvas[data-page-index="0"]');
  await expect(pageCanvas).toBeVisible({ timeout: 120_000 });
  await expect(officeEditMenu(page, 'docx')).toBeVisible({ timeout: 30_000 });
  const box = await pageCanvas.boundingBox();
  if (!box) throw new Error('Missing page canvas');
  // One double click on the header band near the page's top edge opens it.
  const options = frame.getByRole('button', { name: /^Options/ });
  const openHeader = async () => {
    await pageCanvas.dblclick({
      position: { x: box.width / 2, y: box.height * 0.06 },
    });
    await expect(options).toBeVisible();
  };
  await openHeader();
  await options.click();
  await frame.getByRole('button', { name: 'Close header editing' }).click();
  await expect(frame.getByLabel('Document input')).toBeFocused();

  // Escape from the Options button closes the header too.
  await openHeader();
  await options.click();
  await page.keyboard.press('Escape');
  await expect(options).toHaveCount(0);
  await expect(frame.getByLabel('Document input')).toBeFocused();
});

// A view-only user's host sends canEdit:false; a viewer has nothing to pause,
// so its cells still select and copy.
test('a view-only XLSX viewer still selects and copies a cell after canEdit:false', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/workspaces/ws_bio?file=bio-office-xlsx');
  const frame = page.frameLocator('iframe[src*="office-runtime"]');
  const grid = frame.locator('canvas').first();
  await expect(grid).toBeVisible({ timeout: 60_000 });
  await postToOfficeRuntime(page, { canEdit: false, type: 'set-capabilities' });
  // CCHU8003, the first course code under the headers.
  await grid.click({ position: { x: 60, y: 60 } });
  const contents = frame.getByLabel(m.files_office_spreadsheet_cell_contents());
  await expect(contents).not.toHaveValue('');
  const value = await contents.inputValue();
  await contents.click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.press('ControlOrMeta+C');
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(value);
});

test('PPTX speaker notes start hidden, and one remembered toggle serves view and edit', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ height: 800, width: 1280 });
  await page.goto('/workspaces/ws_bio?file=bio-office-pptx');
  const frame = page.frameLocator('iframe[src*="office-runtime"]');
  await expect(frame.locator('canvas').first()).toBeVisible({
    timeout: 60_000,
  });
  const viewNotes = frame.getByRole('note');
  const notesButton = frame.getByTestId('pptx-notes-toggle');
  const showNotes = page.getByRole('menuitemcheckbox', {
    name: 'Show speaker notes',
  });
  const openView = async () => {
    await officeMenu(page, 'pptx', 'View').click();
    await expect(showNotes).toBeVisible();
  };

  // View mode: the Notes button and View › Show speaker notes flip one state.
  await expect(notesButton).toBeVisible();
  await expect(viewNotes).toHaveCount(0);
  await notesButton.click();
  await expect(viewNotes).toBeVisible();
  await openView();
  await expect(showNotes).toHaveAttribute('aria-checked', 'true');
  await showNotes.click();
  await expect(viewNotes).toHaveCount(0);
  await expect(notesButton).toHaveAttribute('aria-pressed', 'false');
  await openView();
  await expect(showNotes).toHaveAttribute('aria-checked', 'false');
  await showNotes.click();
  await expect(viewNotes).toBeVisible();

  // Below lg the chat button sits above the open notes box.
  await page.setViewportSize({ height: 800, width: 390 });
  const tools = page.locator('[data-workspace-chat-button]');
  await expect(tools).toBeVisible();
  await expect(async () => {
    const toolsBox = await tools.boundingBox();
    const notesBox = await viewNotes.boundingBox();
    expect(toolsBox && notesBox).toBeTruthy();
    if (toolsBox && notesBox)
      expect(toolsBox.y + toolsBox.height).toBeLessThanOrEqual(notesBox.y);
  }).toPass();
  await page.setViewportSize({ height: 800, width: 1280 });

  // Edit mode opens with the same choice, and hiding it there carries back.
  const mode = page.getByRole('button', { name: m.material_mode() });
  await mode.click();
  await expect(officeEditMenu(page, 'pptx')).toBeVisible({ timeout: 30_000 });
  const editNotes = frame.getByTestId('pptx-notes-textarea');
  await expect(editNotes).toBeVisible();
  await notesButton.click();
  await expect(editNotes).toHaveCount(0);
  await mode.click();
  await expect(frame.locator('canvas').first()).toBeVisible({
    timeout: 60_000,
  });
  await expect(notesButton).toHaveAttribute('aria-pressed', 'false');
  await expect(viewNotes).toHaveCount(0);
});

test('PPTX Present fills the screen, and Presenter view drives the show from a speaker notes window', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ height: 800, width: 1280 });
  await page.goto('/workspaces/ws_bio?file=bio-office-pptx');
  const frame = page.frameLocator('iframe[src*="office-runtime"]');
  await expect(frame.locator('canvas').first()).toBeVisible({
    timeout: 60_000,
  });
  const show = frame.getByRole('dialog', { name: 'Slide presentation' });
  const fullscreen = () =>
    page.evaluate(() => document.fullscreenElement?.tagName ?? null);

  // Present: the slides in full screen in this tab, no second window.
  await page.getByRole('button', { exact: true, name: 'Present' }).click();
  await expect(show).toBeVisible();
  await expect.poll(fullscreen).toBe('IFRAME');
  await show.press('Escape');
  await expect(show).toHaveCount(0);
  await expect.poll(fullscreen).toBeNull();

  // Presenter view: the notes window opens beside the tab's show.
  await page
    .getByRole('button', { name: m.files_office_present_options() })
    .click();
  const opened = page.waitForEvent('popup');
  await page.getByRole('menuitem', { name: 'Presenter view' }).click();
  const notes = await opened;
  await expect(
    notes.getByRole('main', { name: 'Presenter view' })
  ).toBeVisible();
  await expect(notes.getByText('Slide 1 of 20')).toBeVisible();
  await expect(notes.getByText('No speaker notes')).toBeVisible();
  await expect(show.getByText('1 / 20')).toBeVisible();

  // Next in the notes window advances the tab, which shows slide 2's notes.
  await notes.getByRole('button', { name: 'Next slide' }).click();
  await expect(show.getByText('2 / 20')).toBeVisible();
  await expect(notes.getByText('Slide 2 of 20')).toBeVisible();
  await expect(notes.getByTestId('pptx-presenter-notes')).toHaveText(
    'Speaker note: the rehearsal takes 12 minutes.'
  );

  // End closes the notes window and returns to the file at that slide.
  const closed = notes.waitForEvent('close');
  await notes.getByRole('button', { exact: true, name: 'End' }).click();
  await closed;
  await expect(show).toHaveCount(0);
  await expect(
    frame.getByText(m.files_office_slide_position({ current: 2, total: 20 }))
  ).toBeVisible();

  // The runtime reloading by itself takes the notes window with it, and the
  // next Presenter view gets a fresh one that shows its notes.
  const presenterView = async () => {
    await page
      .getByRole('button', { name: m.files_office_present_options() })
      .click();
    const popup = page.waitForEvent('popup');
    await page.getByRole('menuitem', { name: 'Presenter view' }).click();
    return popup;
  };
  const stale = await presenterView();
  await expect(stale.getByText('Slide 2 of 20')).toBeVisible();
  const runtime = page
    .frames()
    .find((candidate) => candidate.url().includes('office-runtime'));
  if (!runtime) throw new Error('Missing Office runtime');
  const gone = stale.waitForEvent('close');
  await runtime.evaluate(() => setTimeout(() => location.reload()));
  await gone;
  await expect(frame.locator('canvas').first()).toBeVisible({
    timeout: 60_000,
  });
  const fresh = await presenterView();
  await expect(fresh.getByText('Slide 1 of 20')).toBeVisible();
  await fresh.getByRole('button', { exact: true, name: 'End' }).click();
  await expect(show).toHaveCount(0);
});

test('DOCX View › Show ruler is remembered, edit mode only, and stays usable while paused', async ({
  page,
}) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ height: 800, width: 1280 });
  await page.goto('/workspaces/ws_bio?file=bio-office-docx&mode=edit');
  const frame = page.frameLocator('iframe[src*="office-runtime"]');
  await expect(frame.locator('canvas').first()).toBeVisible({
    timeout: 120_000,
  });
  await expect(officeEditMenu(page, 'docx')).toBeVisible({ timeout: 30_000 });
  const rulers = frame.locator('.docx-horizontal-ruler, .docx-vertical-ruler');
  const showRuler = page.getByRole('menuitemcheckbox', { name: 'Show ruler' });
  const toggleRuler = async (checked: boolean) => {
    await officeMenu(page, 'docx', 'View').click();
    await expect(showRuler).toHaveAttribute('aria-checked', String(checked));
    await showRuler.click();
  };

  // Hidden until View › Show ruler; both rulers line up with the first page.
  await expect(rulers).toHaveCount(0);
  await toggleRuler(false);
  await expect(rulers).toHaveCount(2);
  const ruler = await frame.locator('.docx-horizontal-ruler').boundingBox();
  const firstPage = await frame.locator('.canvas-page').first().boundingBox();
  expect(ruler?.x).toBeCloseTo(firstPage?.x ?? -1, 0);
  expect(ruler?.width).toBeCloseTo(firstPage?.width ?? -1, 0);
  // The vertical ruler starts at the first page's top.
  const vertical = await frame.locator('.docx-vertical-ruler').boundingBox();
  expect(vertical?.y).toBeCloseTo(firstPage?.y ?? -1, 0);

  // View mode draws no ruler and offers no toggle; edit opens with the choice.
  const mode = page.getByRole('button', { name: m.material_mode() });
  await mode.click();
  await expect(mode).toHaveAttribute('aria-pressed', 'false');
  await expect(frame.locator('canvas').first()).toBeVisible({
    timeout: 60_000,
  });
  await expect(rulers).toHaveCount(0);
  await officeMenu(page, 'docx', 'View').click();
  await expect(page.getByRole('menuitem', { name: 'Zoom' })).toBeVisible();
  await expect(showRuler).toHaveCount(0);
  await page.keyboard.press('Escape');
  await mode.click();
  await expect(officeEditMenu(page, 'docx')).toBeVisible({ timeout: 60_000 });
  await expect(rulers).toHaveCount(2);

  // Paused, the rulers stay and the toggle still works.
  await postToOfficeRuntime(page, { canEdit: false, type: 'set-capabilities' });
  await officeMenu(page, 'docx', 'File').click();
  await expect(page.getByRole('menuitem', { name: /^Save/ })).toHaveAttribute(
    'aria-disabled',
    'true'
  );
  await page.keyboard.press('Escape');
  await expect(rulers).toHaveCount(2);
  await toggleRuler(true);
  await expect(rulers).toHaveCount(0);
});

// Format › Table runs the table items in the engine: Auto-fit shrinks a new
// table to its text and Center then moves it right; the ticks follow the
// caret's table and a paused editor disables them all.
test('DOCX Format › Table fits, centres and pins a table, a drag keeps the fit, and it pauses with the editor', async ({
  page,
}) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ height: 800, width: 1280 });
  await page.goto('/workspaces/ws_bio?file=bio-office-docx&mode=edit');
  const frame = page.frameLocator('iframe[src*="office-runtime"]');
  await expect(frame.locator('canvas').first()).toBeVisible({
    timeout: 120_000,
  });
  await expect(officeEditMenu(page, 'docx')).toBeVisible({ timeout: 30_000 });
  await officeMenu(page, 'docx', 'Insert').click();
  await page.getByRole('menuitem', { exact: true, name: 'Table' }).click();
  await page.getByRole('gridcell', { name: 'Insert 2 by 2 table' }).click();
  // Format › Table's `item`, or `choice` in its submenu.
  const table = async (
    item: string,
    choice?: string,
    role: 'menuitem' | 'menuitemcheckbox' | 'menuitemradio' = 'menuitemcheckbox'
  ) => {
    await officeMenu(page, 'docx', 'Format').click();
    await page.getByRole('menuitem', { exact: true, name: 'Table' }).click();
    if (!choice) return page.getByRole(role, { exact: true, name: item });
    await page.getByRole('menuitem', { exact: true, name: item }).click();
    return page.getByRole(role, { exact: true, name: choice });
  };
  const pin = await table('Pin header row');
  await expect(pin).toHaveAttribute('aria-checked', 'false');
  await pin.click();
  // The table items hand the caret back to its cell.
  await page.keyboard.type('Cell');
  // The positioned mirror draws one run per glyph.
  const cell = frame
    .locator('.layout-page-mirror:not(.layout-page-mirror-text)')
    .getByRole('paragraph')
    .filter({ hasText: /^Cell$/ })
    .getByText('C', { exact: true });
  await expect(cell).toBeAttached();
  const left = (await cell.boundingBox())?.x ?? Number.NaN;
  // exchange-plan.docx is a Word 2013+ (mode 15) document: the new table's
  // border sits at the margin, so its text is one cell margin (7.2px) in.
  const body = frame
    .locator('.layout-page-mirror:not(.layout-page-mirror-text)')
    .getByRole('paragraph')
    .filter({ hasText: /^籌委會籌備小組$/ })
    .getByText('籌', { exact: true })
    .first();
  const inset = left - ((await body.boundingBox())?.x ?? Number.NaN);
  expect(inset).toBeGreaterThan(5);
  expect(inset).toBeLessThan(10);

  await table('Auto-fit to contents', undefined, 'menuitem').then((item) =>
    item.click()
  );
  const center = await table('Table alignment', 'Center', 'menuitemradio');
  await expect(center).toHaveAttribute('aria-checked', 'false');
  await center.click();
  // The columns shrink to "Cell" and to the empty cell's margins, so the
  // centred table starts over 100px further right.
  await expect
    .poll(async () => ((await cell.boundingBox())?.x ?? left) - left)
    .toBeGreaterThan(100);
  await expect(
    await table('Table alignment', 'Center', 'menuitemradio')
  ).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect(await table('Pin header row')).toHaveAttribute(
    'aria-checked',
    'true'
  );
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');

  // A column drag starts from the drawn columns: widening the last one keeps
  // the first at its fitted width instead of snapping back to the old grid.
  const edge = frame.locator('.layout-table-edge-handle-right').first();
  const span = async () =>
    ((await edge.boundingBox())?.x ?? Number.NaN) -
    ((await cell.boundingBox())?.x ?? Number.NaN);
  await expect.poll(span).toBeLessThan(150);
  const before = await span();
  const handle = await edge.boundingBox();
  if (!handle) throw new Error('Missing the table edge handle');
  await page.mouse.move(handle.x + handle.width / 2, handle.y + 4);
  await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2 + 40, handle.y + 4, {
    steps: 5,
  });
  await page.mouse.up();
  await expect.poll(span).toBeGreaterThan(before + 20);
  expect(await span()).toBeLessThan(before + 60);

  await postToOfficeRuntime(page, { canEdit: false, type: 'set-capabilities' });
  await officeMenu(page, 'docx', 'Format').click();
  await expect(
    page.getByRole('menuitem', { exact: true, name: 'Table' })
  ).toHaveAttribute('aria-disabled', 'true');
});

test('below lg the chat button sits 8px above the sheet tabs, the slide strip and the notes box', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ height: 780, width: 360 });
  const tools = page.locator('[data-workspace-chat-button]');
  const frame = page.frameLocator('iframe[src*="office-runtime"]');
  // From the button's bottom edge to the top of the chrome in the frame
  // (boxes are in page pixels, frame contents included).
  const gap = async (chrome: ReturnType<FrameLocator['locator']>) => {
    const [button, top] = await Promise.all([
      tools.boundingBox(),
      chrome.boundingBox(),
    ]);
    return button && top
      ? Math.round(top.y - (button.y + button.height))
      : null;
  };

  await page.addInitScript(() => {
    window.addEventListener('message', (event) => {
      if (event.data?.type === 'bottom-inset') window.officeInset = event.data;
    });
  });
  await page.goto('/workspaces/ws_bio?file=bio-office-xlsx&mode=edit');
  const tabs = frame.getByTestId('xlsx-sheet-tabs');
  await expect(tabs).toBeVisible({ timeout: 60_000 });
  await expect.poll(() => gap(tabs)).toBe(8);
  // A runtime claiming a huge inset (a hostile document) leaves the button
  // on the page: the host clamps it to the frame's height.
  const sent = await page.evaluate(() => window.officeInset);
  const runtime = page.frames().find((f) => f.url().includes('office-runtime'));
  expect(sent && runtime).toBeTruthy();
  const resting = (await tools.boundingBox())?.y ?? 0;
  await runtime?.evaluate(
    (message) => window.parent.postMessage({ ...message, inset: 1e9 }, '*'),
    sent
  );
  await expect
    .poll(async () => (await tools.boundingBox())?.y ?? resting)
    .toBeLessThan(resting - 100);
  expect((await tools.boundingBox())?.y).toBeGreaterThanOrEqual(0);

  await page.goto('/workspaces/ws_bio?file=bio-office-pptx&mode=edit');
  const strip = frame.getByRole('complementary', { name: 'Slides' });
  await expect(strip).toBeVisible({ timeout: 60_000 });
  await expect.poll(() => gap(strip)).toBe(8);
  const closed = (await tools.boundingBox())?.y ?? 0;
  // The notes box opens under the strip: the button rises with it.
  await frame.getByTestId('pptx-notes-toggle').click();
  await expect(frame.getByTestId('pptx-notes-textarea')).toBeVisible();
  await expect.poll(() => gap(strip)).toBe(8);
  expect((await tools.boundingBox())?.y ?? 0).toBeLessThan(closed - 40);
  await frame.getByTestId('pptx-notes-toggle').click();
  await expect(frame.getByTestId('pptx-notes-textarea')).toHaveCount(0);
  // The dock eases its bottom, which can settle a subpixel off.
  await expect
    .poll(async () => (await tools.boundingBox())?.y ?? 0)
    .toBeCloseTo(closed, 0);
});

test('Office toolbars take the note toolbar scale: 36px rows and 30px buttons in a phone-width frame, 40px and 32px from 640px', async ({
  page,
}) => {
  test.setTimeout(180_000);
  for (const [width, row, button, icon] of [
    [360, 36, 30, 18],
    [768, 40, 32, 18],
  ] as const) {
    await page.setViewportSize({ height: 800, width });
    await page.goto('/workspaces/ws_bio?file=bio-office-xlsx&mode=edit');
    const frame = page.frameLocator('iframe[src*="office-runtime"]');
    const bar = frame.getByTestId('xlsx-formatting-toolbar');
    await expect(bar).toBeVisible({ timeout: 60_000 });
    const bold = bar.getByRole('button', { exact: true, name: 'Bold' });
    const [rowBox, buttonBox, iconBox] = await Promise.all([
      bar.boundingBox(),
      bold.boundingBox(),
      bold.locator('svg').boundingBox(),
    ]);
    expect(rowBox?.height).toBe(row);
    expect([buttonBox?.width, buttonBox?.height]).toEqual([button, button]);
    expect(iconBox?.width).toBe(icon);
  }
});
