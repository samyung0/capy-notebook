import { expect, type Page, test } from '@playwright/test';
import {
  officeEditMenu,
  officeFrame,
  officeTab,
  ribbonCommand,
  runRibbonCommand,
  saveOffice,
} from '../helpers/office';
import { m } from '../i18n';

const open = async (page: Page, format: 'docx' | 'xlsx' | 'pptx') => {
  // Wide enough that every Home group is in the row, none in More.
  await page.setViewportSize({ height: 800, width: 1600 });
  await page.goto(`/workspaces/ws_bio?file=bio-office-${format}&mode=edit`);
  await expect(officeEditMenu(page)).toBeVisible({ timeout: 120_000 });
  const frame = officeFrame(page);
  await expect(frame.locator('canvas').first()).toBeVisible({
    timeout: 120_000,
  });
  return frame;
};

/** An open XLSX cell holding `text`, the Enter not pressed. */
const openCell = async (page: Page, text: string) => {
  const frame = await open(page, 'xlsx');
  const grid = frame.getByTestId('xlsx-scroll');
  const box = await grid.boundingBox();
  if (!box) throw new Error('Grid is not laid out');
  await page.mouse.click(box.x + 300, box.y + 300);
  await page.keyboard.type(text);
  const editor = frame.getByTestId('xlsx-cell-editor');
  await expect(editor).toHaveValue(text);
  const nameBox = frame.getByTestId('xlsx-name-box');
  return { cell: await nameBox.inputValue(), editor, frame, grid, nameBox };
};

/** The cell's text once it shows in the formula bar. */
const cellText = async (page: Page, cell: string) => {
  const frame = officeFrame(page);
  const nameBox = frame.getByTestId('xlsx-name-box');
  await nameBox.fill(cell);
  await nameBox.press('Enter');
  await expect(nameBox).toHaveValue(cell);
  return frame.getByTestId('xlsx-formula-input').inputValue();
};

const docxUndo = (page: Page) => page.getByRole('button', { name: /^Undo/ });

test.describe('an open list owns the keyboard', () => {
  test('XLSX: Escape closes the list and leaves the cell entry alone', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const { editor } = await openCell(page, 'abc');
    await officeTab(page, 'home').click();
    await ribbonCommand(page, 'wrapping').click();
    const list = officeFrame(page).locator('.office-ribbon__menu');
    await expect(list).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(list).toHaveCount(0);
    await expect(editor).toHaveValue('abc');
    // The entry goes on where it was.
    await page.keyboard.type('d');
    await expect(editor).toHaveValue('abcd');
  });

  test('XLSX: typing under an open list reaches neither the cell nor the formula bar', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const { editor } = await openCell(page, 'abc');
    await ribbonCommand(page, 'wrapping').click();
    await page.keyboard.type('zz');
    await expect(editor).toHaveValue('abc');
    await expect(
      officeFrame(page).locator('.office-ribbon__menu')
    ).toBeVisible();
  });

  test('XLSX: arrows and Enter drive the rows, the list opened by mouse', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const { editor } = await openCell(page, 'abc');
    await ribbonCommand(page, 'wrapping').click();
    const list = officeFrame(page).locator('.office-ribbon__menu');
    const rows = list.locator('[data-command]');
    const count = await rows.count();
    expect(count).toBeGreaterThan(1);
    await page.keyboard.press('ArrowDown');
    await expect(rows.first()).toHaveAttribute('data-active', 'true');
    await page.keyboard.press('ArrowDown');
    await expect(rows.nth(1)).toHaveAttribute('data-active', 'true');
    await expect(rows.first()).not.toHaveAttribute('data-active', 'true');
    await page.keyboard.press('ArrowUp');
    await expect(rows.first()).toHaveAttribute('data-active', 'true');
    await expect(editor).toHaveValue('abc');
    await page.keyboard.press('ArrowDown');
    const picked = await rows.nth(1).getAttribute('data-command');
    await page.keyboard.press('Enter');
    await expect(list).toHaveCount(0);
    // A row is a command: it settled the entry first.
    await expect(editor).toHaveCount(0);
    await ribbonCommand(page, 'wrapping').click();
    await expect(
      officeFrame(page).locator(
        `.office-ribbon__menu [data-command="${picked}"]`
      )
    ).toHaveAttribute('aria-checked', 'true');
  });

  test('DOCX: typing, Enter and arrows under an open list leave the document alone', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const frame = await open(page, 'docx');
    await frame
      .locator('[data-page-index="0"]')
      .first()
      .click({
        position: { x: 300, y: 300 },
      });
    const input = frame.getByLabel('Document input');
    await expect(input).toBeFocused();
    await expect(docxUndo(page)).toBeDisabled();
    await officeTab(page, 'view').click();
    await ribbonCommand(page, 'show-ruler').hover();
    await officeTab(page, 'home').click();
    await ribbonCommand(page, 'insert-table').click();
    const list = frame.locator('.office-ribbon__menu');
    await expect(list).toBeVisible();
    await page.keyboard.type('hello');
    await page.keyboard.press('Backspace');
    await expect(list).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(list).toHaveCount(0);
    await page.waitForTimeout(500);
    await expect(docxUndo(page)).toBeDisabled();
    // The caret never left: the next key types.
    await expect(input).toBeFocused();
    await page.keyboard.type('x');
    await expect(docxUndo(page)).toBeEnabled();
  });

  test('PPTX: Escape and typing under an open list leave the text box being edited', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const frame = await open(page, 'pptx');
    const canvas = frame.getByTestId('pptx-slide-canvas');
    const box = await canvas.boundingBox();
    if (!box) throw new Error('Missing slide canvas');
    await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height * 0.45);
    const input = frame.getByTestId('pptx-text-input');
    await expect(input).toBeFocused();
    const selected = await input.evaluate((node: HTMLTextAreaElement) => [
      node.selectionStart,
      node.selectionEnd,
    ]);
    await ribbonCommand(page, 'align-objects').click();
    await expect(frame.locator('.office-ribbon__menu')).toBeVisible();
    const undo = page.getByRole('button', { name: /^Undo/ });
    await expect(undo).toBeDisabled();
    await page.keyboard.type('zz');
    await page.keyboard.press('Escape');
    await expect(frame.locator('.office-ribbon__menu')).toHaveCount(0);
    await expect(input).toBeFocused();
    // Nothing reached the text box under the list.
    await page.waitForTimeout(300);
    await expect(undo).toBeDisabled();
    expect(
      await input.evaluate((node: HTMLTextAreaElement) => [
        node.selectionStart,
        node.selectionEnd,
      ])
    ).toEqual(selected);
  });

  test('IME: a composition started under an open list never reaches the cell', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const { editor } = await openCell(page, 'abc');
    await ribbonCommand(page, 'wrapping').click();
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.imeSetComposition', {
      selectionEnd: 2,
      selectionStart: 2,
      text: '日本',
    });
    await cdp.send('Input.insertText', { text: '日本' });
    await cdp.detach();
    await expect(editor).toHaveValue('abc');
    await page.keyboard.press('Escape');
    await expect(editor).toHaveValue('abc');
  });
});

test.describe('a ribbon command settles input first and the next key lands in the document', () => {
  test('XLSX Delete values with a cell open writes nothing back', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const { cell, editor, grid } = await openCell(page, 'abc');
    await runRibbonCommand(page, 'edit', 'deleteValues');
    await expect(editor).toHaveCount(0);
    await expect(grid).toBeFocused();
    // Enter only moves: no draft comes back.
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
    expect(await cellText(page, cell)).toBe('');
  });

  test('XLSX Select all with a cell open commits it and keeps the whole sheet selected', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const { cell, editor, grid, nameBox } = await openCell(page, 'abc');
    await runRibbonCommand(page, 'edit', 'selectAll');
    await expect(editor).toHaveCount(0);
    await expect(grid).toBeFocused();
    // The name box names the active cell; a selection of many can merge.
    await expect(nameBox).toHaveValue(cell);
    await officeTab(page, 'format').click();
    await expect(ribbonCommand(page, 'merge:all')).toBeEnabled();
    expect(await cellText(page, cell)).toBe('abc');
  });

  for (const [tab, id] of [
    ['insert', 'insertRowAbove'],
    ['edit', 'deleteRows'],
    ['format', 'clearFormatting'],
    ['view', 'freezeRows:1'],
  ] as const) {
    test(`XLSX ${id} with a cell open commits it, and the next key opens a cell`, async ({
      page,
    }) => {
      test.setTimeout(180_000);
      const { editor, grid } = await openCell(page, 'abc');
      await officeTab(page, tab).click();
      const direct = ribbonCommand(page, id);
      if (id.startsWith('freeze')) await ribbonCommand(page, 'freeze').click();
      await direct.click();
      await expect(editor).toHaveCount(0);
      await expect(grid).toBeFocused();
      await page.keyboard.type('q');
      await expect(editor).toHaveValue('q');
    });
  }

  test('DOCX Insert waits for the typed text still queued', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await page.addInitScript(() => {
      const held = { hold: false, list: [] as (() => void)[] };
      (window as unknown as { docxQueue: typeof held }).docxQueue = held;
      const send = Worker.prototype.postMessage;
      Worker.prototype.postMessage = function (
        message: { type?: string },
        options?: StructuredSerializeOptions | Transferable[]
      ) {
        const release = () => {
          if (Array.isArray(options)) send.call(this, message, options);
          else send.call(this, message, options);
        };
        if (held.hold && message?.type === 'applyInput')
          held.list.push(release);
        else release();
      };
    });
    const frame = await open(page, 'docx');
    const input = frame.getByLabel('Document input');
    await input.focus();
    await input.press('ControlOrMeta+End');
    const runtime = page
      .frames()
      .find((candidate) => candidate.url().includes('office-runtime'));
    if (!runtime) throw new Error('Missing Office runtime');
    const queue = (body: string) =>
      runtime.evaluate(
        (code) =>
          // biome-ignore lint/security/noGlobalEval: the probe's small steps, in the test's own frame
          eval(`(() => { const q = window.docxQueue; ${code} })()`),
        body
      );
    const undo = docxUndo(page);
    await queue('q.hold = true;');
    await input.pressSequentially('Q');
    await expect.poll(() => queue('return q.list.length;')).toBeGreaterThan(0);
    // Held, the typed text hasn't reached the document's history.
    await expect(undo).toBeDisabled();
    await officeTab(page, 'insert').click();
    await ribbonCommand(page, 'insert-page-break').click();
    // The break waits: the document has neither change yet, as the old menu's
    // click held its command until the flush was done.
    await page.waitForTimeout(600);
    await expect(undo).toBeDisabled();
    await queue('q.hold = false; for (const go of q.list.splice(0)) go();');
    await expect(undo).toBeEnabled();
    await expect(input).toBeFocused();
  });

  test('IME: a click on a DOCX command ends the composition first', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const frame = await open(page, 'docx');
    const input = frame.getByLabel('Document input');
    await input.focus();
    await input.press('ControlOrMeta+End');
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.imeSetComposition', {
      selectionEnd: 2,
      selectionStart: 2,
      text: '日本',
    });
    await officeTab(page, 'insert').click();
    await ribbonCommand(page, 'insert-page-break').click();
    await cdp.detach();
    await expect(docxUndo(page)).toBeEnabled();
    await expect(input).toBeFocused();
  });

  test('IME: a click on a command ends the composition first, and it lands', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const { cell, editor } = await openCell(page, 'a');
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.imeSetComposition', {
      selectionEnd: 2,
      selectionStart: 2,
      text: '日本',
    });
    await runRibbonCommand(page, 'format', 'clearFormatting');
    await cdp.detach();
    await expect(editor).toHaveCount(0);
    expect(await cellText(page, cell)).toBe('a日本');
  });

  test('the next key lands in the document after a command in all three formats', async ({
    page,
  }) => {
    test.setTimeout(240_000);
    const docx = await open(page, 'docx');
    await runRibbonCommand(page, 'edit', 'select-all');
    await expect(docx.getByLabel('Document input')).toBeFocused();

    const xlsx = await open(page, 'xlsx');
    await runRibbonCommand(page, 'format', 'clearFormatting');
    await expect(xlsx.getByTestId('xlsx-scroll')).toBeFocused();
    await page.keyboard.type('n');
    await expect(xlsx.getByTestId('xlsx-cell-editor')).toHaveValue('n');
    await page.keyboard.press('Escape');

    const pptx = await open(page, 'pptx');
    const canvas = pptx.getByTestId('pptx-slide-canvas');
    await runRibbonCommand(page, 'slide', 'slide.new');
    // The slide's stage has the keys: Delete would remove what's selected.
    await expect
      .poll(() =>
        canvas.evaluate((node) => {
          const active = node.ownerDocument.activeElement;
          return (
            !!active &&
            active !== node.ownerDocument.body &&
            active.contains(node)
          );
        })
      )
      .toBe(true);
  });
});

test('tab-line Undo and Redo run, and show the editor and pause states', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const frame = await open(page, 'docx');
  const undo = docxUndo(page);
  const redo = page.getByRole('button', { name: /^Redo/ });
  await expect(undo).toBeDisabled();
  await expect(redo).toBeDisabled();
  const input = frame.getByLabel('Document input');
  await input.focus();
  await input.press('ControlOrMeta+End');
  await input.pressSequentially('Zq');
  await expect(undo).toBeEnabled();
  await undo.click();
  await expect(redo).toBeEnabled();
  await redo.click();
  await expect(redo).toBeDisabled();
  await expect(undo).toBeEnabled();
  // The caret kept the keys through both.
  await expect(input).toBeFocused();
  await saveOffice(page, 'docx');
  await expect(page.locator('[data-save-state="saved"]')).toBeVisible();
  // Paused: both off.
  await page.evaluate(async () => {
    const path = '/src/mocks/collaboration.ts';
    const { announceSourcePaused } = (await import(
      path
    )) as typeof import('../../src/mocks/collaboration');
    announceSourcePaused('bio-office-docx');
  });
  await expect(frame.getByText(m.source_edit_paused())).toBeVisible();
  await expect(undo).toBeDisabled();
  await expect(redo).toBeDisabled();
});

test('typing sends no menus message per key', async ({ page }) => {
  test.setTimeout(240_000);
  await page.addInitScript(() => {
    if (window !== window.top) return;
    const seen = { menus: 0 };
    (window as unknown as { menusSeen: typeof seen }).menusSeen = seen;
    window.addEventListener('message', (event) => {
      if (event.data?.type === 'menus') seen.menus += 1;
    });
  });
  const counted = () =>
    page.evaluate(
      () =>
        (window as unknown as { menusSeen: { menus: number } }).menusSeen.menus
    );
  const type = async (run: () => Promise<void>) => {
    await page.waitForTimeout(1500);
    const before = await counted();
    await run();
    await page.waitForTimeout(800);
    return (await counted()) - before;
  };
  const keys = 'abcdefghijklmnopqrstuvwxyz';
  const docx = await open(page, 'docx');
  const input = docx.getByLabel('Document input');
  await input.focus();
  // Undo turning on is the one change typing makes to the tab line.
  expect(
    await type(() => input.pressSequentially(keys, { delay: 40 }))
  ).toBeLessThanOrEqual(2);

  const xlsx = await open(page, 'xlsx');
  const grid = xlsx.getByTestId('xlsx-scroll');
  await grid.click({ position: { x: 300, y: 300 } });
  expect(
    await type(() => page.keyboard.type(keys, { delay: 40 }))
  ).toBeLessThanOrEqual(2);
});

test('the keyboard route: from the tab line into the commands and back, and a row hands the keys to the document', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const frame = await open(page, 'docx');
  const scroll = frame.locator('.office-ribbon__scroll');
  const inRibbon = () =>
    scroll.evaluate((node) => {
      const active = node.ownerDocument.activeElement;
      return !!active && node.contains(active);
    });
  const focused = () =>
    scroll.evaluate((node) => node.ownerDocument.activeElement?.outerHTML);
  const home = officeTab(page, 'home');
  await home.focus();
  await page.keyboard.press('ArrowRight');
  await expect(officeTab(page, 'edit')).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(home).toBeFocused();
  // In: the tab's first command has the keys.
  await page.keyboard.press('Enter');
  await expect.poll(inRibbon).toBe(true);
  // Back.
  await page.keyboard.press('Escape');
  await expect(home).toBeFocused();
  // ArrowDown goes in too; arrows walk the commands.
  await page.keyboard.press('ArrowDown');
  await expect.poll(inRibbon).toBe(true);
  const first = await focused();
  await page.keyboard.press('ArrowRight');
  expect(await focused()).not.toBe(first);
  await page.keyboard.press('Escape');
  await expect(home).toBeFocused();
  // Another tab's dropdown: a row closes it and the document has the keys.
  await officeTab(page, 'insert').focus();
  await page.keyboard.press('Enter');
  await expect(frame.locator('.office-ribbon__bar')).toHaveAttribute(
    'data-tab',
    'insert'
  );
  await expect.poll(inRibbon).toBe(true);
  await ribbonCommand(page, 'insert-table').focus();
  await page.keyboard.press('Enter');
  const cell = frame.getByRole('gridcell', { name: '1x1' });
  await expect(cell).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(frame.getByRole('gridcell', { name: '1x2' })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(frame.getByRole('gridcell', { name: '2x2' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(cell).toHaveCount(0);
  await expect(frame.getByLabel('Document input')).toBeFocused();
});

test('PPTX: a size picked in the box hands the keys back to the text', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const frame = await open(page, 'pptx');
  const canvas = frame.getByTestId('pptx-slide-canvas');
  const box = await canvas.boundingBox();
  if (!box) throw new Error('Missing slide canvas');
  await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height * 0.45);
  const input = frame.getByTestId('pptx-text-input');
  await expect(input).toBeFocused();
  const size = frame.getByTestId('pptx-font-size');
  await size.click();
  await frame.getByRole('option', { exact: true, name: '24' }).click();
  await expect(input).toBeFocused();
  await size.click();
  await size.fill('28');
  await size.press('Enter');
  await expect(input).toBeFocused();
  await size.click();
  await page.keyboard.press('Escape');
  await expect(input).toBeFocused();
});

test('XLSX: a size picked in the box hands the keys back to the grid', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const frame = await open(page, 'xlsx');
  const grid = frame.getByTestId('xlsx-scroll');
  await grid.click({ position: { x: 300, y: 300 } });
  const size = frame.getByRole('combobox', { name: /font size/i });
  await size.click();
  await size.fill('24');
  await size.press('Enter');
  await expect(grid).toBeFocused();
  await page.keyboard.type('q');
  await expect(frame.getByTestId('xlsx-cell-editor')).toHaveValue('q');
});
