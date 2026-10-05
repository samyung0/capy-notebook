import { expect, test } from '@playwright/test';
import { officeEditMenu, officeMenu, saveOffice } from '../helpers/office';

declare global {
  interface Window {
    officeInputProbe: { hold: boolean; held: (() => void)[]; flushed: boolean };
  }
}

for (const [format, name] of [
  ['docx', 'exchange-plan.docx'],
  ['xlsx', 'course-guide.xlsx'],
  ['pptx', 'lecture.pptx'],
]) {
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
    await page.getByRole('button', { exact: true, name: 'Files' }).click();
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

    const mode = page.getByRole('button', { name: 'Material mode' });
    await mode.click();
    await expect(mode).toHaveAttribute('aria-pressed', 'true');
    await expect(officeEditMenu(page)).toBeVisible({ timeout: 30_000 });
    // File › Save is a menuitem, a ticked row a menuitemcheckbox.
    await saveOffice(page);
    await expect(
      page.getByRole('status').filter({ hasText: /^Saved$/ })
    ).toBeVisible();
    if (format === 'docx') {
      await officeMenu(page, 'View').click();
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
      await saveOffice(page);
      await expect(
        page.getByRole('status').filter({ hasText: /^Saved$/ })
      ).toBeVisible();
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
      await expect(officeEditMenu(page)).toBeVisible({ timeout: 30_000 });
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
      await expect(
        page.getByRole('status').filter({ hasText: /^Saved$/ })
      ).toBeVisible();
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
        await expect(
          page.getByRole('status').filter({ hasText: /^Syncing/ })
        ).toBeVisible();
        const blocksUnload = () =>
          page.evaluate(() => {
            const event = new Event('beforeunload', { cancelable: true });
            window.dispatchEvent(event);
            return event.defaultPrevented;
          });
        expect(await blocksUnload()).toBe(true);
        await saveOffice(page);
        await expect
          .poll(() => runtime.evaluate(() => window.officeInputProbe.flushed))
          .toBe(true);
        await expect(
          page.getByRole('status').filter({ hasText: /^Saved$/ })
        ).toHaveCount(0);
        expect(await blocksUnload()).toBe(true);
      } finally {
        await runtime.evaluate(() => {
          window.officeInputProbe.hold = false;
          for (const release of window.officeInputProbe.held.splice(0))
            release();
        });
      }
      await expect(
        page.getByRole('status').filter({ hasText: /^Saved$/ })
      ).toBeVisible();
    }
  });
}

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
  // Below lg an open Office file folds the workspace tools into one button.
  for (const [width, tools] of [
    [900, 'Workspace tools'],
    [1280, 'Files'],
  ] as const) {
    await page.setViewportSize({ height: 800, width });
    await expect(
      page.getByRole('button', { name: tools }).first()
    ).toBeVisible();
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
  await page.getByRole('button', { exact: true, name: 'Files' }).click();
  await page
    .locator('[data-workspace-file-tree] a[href*="file=bio-office-xlsx"]')
    .click();
  const frame = page.frameLocator('iframe[src*="office-runtime"]');
  await expect(frame.locator('canvas').first()).toBeVisible({
    timeout: 60_000,
  });
  await page.getByRole('button', { name: 'Material mode' }).click();
  await expect(officeEditMenu(page)).toBeVisible({ timeout: 30_000 });

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

test('XLSX cell edit ends when focus moves into Capy, not on a window switch', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ height: 800, width: 1280 });
  await page.goto('/workspaces/ws_bio');
  await page.getByRole('button', { exact: true, name: 'Files' }).click();
  await page
    .locator('[data-workspace-file-tree] a[href*="file=bio-office-xlsx"]')
    .click();
  const frame = page.frameLocator('iframe[src*="office-runtime"]');
  await expect(frame.locator('canvas').first()).toBeVisible({
    timeout: 60_000,
  });
  await page.getByRole('button', { name: 'Material mode' }).click();
  await expect(officeEditMenu(page)).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { exact: true, name: 'Chat' }).click();
  const chat = page.getByRole('textbox', { name: 'Ask about your sources…' });
  await expect(chat).toBeVisible();

  const grid = frame.getByTestId('xlsx-scroll');
  const formula = frame.getByTestId('xlsx-formula-input');
  const editor = frame.getByTestId('xlsx-cell-editor');
  const saved = page.getByRole('status').filter({ hasText: /^Saved$/ });
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
  await expect(page.getByText("We couldn't load this file.")).toHaveCount(0);
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
  await expect(page.getByText('An update is ready')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reload' })).toBeVisible();
});

test('an Office citation highlights its passage again after the runtime reloads', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.goto('/workspaces/ws_bio');
  await page.getByRole('button', { exact: true, name: 'Chat' }).click();
  await page.getByRole('button', { name: 'Chat history' }).click();
  await page.getByRole('button', { name: 'OpenUI: Office citation' }).click();
  await page.getByTitle('Source 1').click();
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
    await expect(officeEditMenu(page)).toBeVisible({ timeout: 30_000 });
    await saveOffice(page);
    await expect(
      page.getByRole('status').filter({ hasText: /^Saved$/ })
    ).toBeVisible();

    // A newer version is published while the saved editor is open: the
    // session is replaced and the editor pauses under the reload banner.
    await page.evaluate(async (id) => {
      const modulePath = '/src/mocks/collaboration.ts';
      const { announceSourceEpoch } = (await import(
        modulePath
      )) as typeof import('../../src/mocks/collaboration');
      announceSourceEpoch(id, 2);
    }, fileId);
    await expect(page.getByText('A newer version of this file')).toBeVisible();

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
      await officeMenu(page, 'Edit').click();
      await page.getByRole('menuitem', { name: /^Select all/ }).click();
      await page.keyboard.press('ControlOrMeta+C');
      await expect
        .poll(() => page.evaluate(() => navigator.clipboard.readText()))
        .not.toBe('EMPTY');
      return page.evaluate(() => navigator.clipboard.readText());
    };

    // Paused menus: what edits is disabled, File › Save included.
    await officeMenu(page, 'File').click();
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
      await officeMenu(page, 'Edit').click();
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
    await page.evaluate(
      (id) => {
        const iframe = document.querySelector<HTMLIFrameElement>(
          'iframe[src*="office-runtime"]'
        );
        if (!iframe?.contentWindow) throw new Error('Missing Office runtime');
        iframe.contentWindow.postMessage(
          { id, type: 'menu-command', version: 7 },
          new URL(iframe.src).origin
        );
      },
      format === 'docx' ? 'insert-page-break' : 'insertRowAbove'
    );
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
    await officeMenu(page, 'File').click();
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

// A pause that ends hands nothing to the editor: a host field keeps the
// focus and the typing.
test('a DOCX editor resuming from a pause leaves the focus where it was', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.goto('/workspaces/ws_bio?file=bio-office-docx&mode=edit');
  const frame = page.frameLocator('iframe[src*="office-runtime"]');
  await expect(frame.locator('canvas').first()).toBeVisible({
    timeout: 120_000,
  });
  await expect(officeEditMenu(page)).toBeVisible({ timeout: 30_000 });
  const chat = page.getByRole('textbox', { name: 'Ask about your sources…' });
  await chat.click();
  const capabilities = (canEdit: boolean) =>
    page.evaluate((canEdit) => {
      const iframe = document.querySelector<HTMLIFrameElement>(
        'iframe[src*="office-runtime"]'
      );
      if (!iframe?.contentWindow) throw new Error('Missing Office runtime');
      iframe.contentWindow.postMessage(
        { canEdit, type: 'set-capabilities', version: 7 },
        new URL(iframe.src).origin
      );
    }, canEdit);
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
  await officeMenu(page, 'Edit').click();
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
  await officeMenu(page, 'Edit').click();
  await page.getByRole('menuitem', { name: /^Select all/ }).click();
  await officeMenu(page, 'Insert').click();
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

// A newly opened DOCX editor takes the focus, unless Capy's focus is in a
// field taking typing when it finishes loading.
test('a newly opened DOCX editor leaves the focus in the chat box', async ({
  page,
}) => {
  test.setTimeout(240_000);
  await page.goto('/workspaces/ws_bio?file=bio-office-docx&mode=edit');
  const frame = page.frameLocator('iframe[src*="office-runtime"]');
  await expect(frame.locator('canvas').first()).toBeVisible({
    timeout: 120_000,
  });
  await expect(officeEditMenu(page)).toBeVisible({ timeout: 30_000 });
  await expect(frame.getByLabel('Document input')).toBeFocused();

  await page.goto('/workspaces/ws_bio?file=bio-office-docx&mode=edit');
  const chat = page.getByRole('textbox', { name: 'Ask about your sources…' });
  await chat.click();
  await page.keyboard.type('hi');
  await expect(frame.locator('canvas').first()).toBeVisible({
    timeout: 120_000,
  });
  await expect(officeEditMenu(page)).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(1500);
  await expect(chat).toBeFocused();
  await page.keyboard.type(' there');
  await expect(chat).toHaveValue('hi there');
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
  await page.evaluate(() => {
    const iframe = document.querySelector<HTMLIFrameElement>(
      'iframe[src*="office-runtime"]'
    );
    if (!iframe?.contentWindow) throw new Error('Missing Office runtime');
    iframe.contentWindow.postMessage(
      { canEdit: false, type: 'set-capabilities', version: 7 },
      new URL(iframe.src).origin
    );
  });
  // CCHU8003, the first course code under the headers.
  await grid.click({ position: { x: 60, y: 60 } });
  const contents = frame.getByLabel('Cell contents');
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
    await officeMenu(page, 'View').click();
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

  // Below lg the floating tools button sits above the open notes box.
  await page.setViewportSize({ height: 800, width: 390 });
  const tools = page.getByRole('button', { name: 'Workspace tools' });
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
  const mode = page.getByRole('button', { name: 'Material mode' });
  await mode.click();
  await expect(officeEditMenu(page)).toBeVisible({ timeout: 30_000 });
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
