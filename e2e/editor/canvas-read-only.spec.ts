import { readFile } from 'node:fs/promises';
import { expect, type Page, test } from '@playwright/test';

/**
 * What a canvas's board does beyond editing (wave 3 of the canvas room,
 * 2026-11-19), against the mock room (src/mocks/collaboration.ts): a board
 * that takes no edits selects and copies and writes nothing, on a desktop and
 * on a phone; the menu's Download as image, size row and the save status's
 * slot; an image while it uploads, for its uploader and for a peer.
 */

type Collaboration = typeof import('../../src/mocks/collaboration');
type Canvases = typeof import('../../src/mocks/canvas');
type Peer = ReturnType<Collaboration['mockBoardPeer']>;
type Box = { h: number; w: number; x: number; y: number };
type Board = {
  images(): { id: string }[];
  presence: {
    boxOf(ids: string[]): Box | null;
    selected(): string[];
    view(): { left: number; top: number; zoom: number };
  };
  setRoomSize(size: { bytes: number; max: number } | null): void;
  snapshot(): string;
  stats(): { blocks: string[]; canvas: string[] };
  statusSlot: HTMLElement;
  view(): { centre: [number, number]; zoom: number } | null;
};
type Shown = {
  __board?: Board & { kept?: boolean };
  copied?: string[];
  peer?: Peer;
  uploads?: { held: number; release(): void };
};

const CANVAS = 'cv_ws_bio_1';
const BEN = { avatar: null, name: 'Ben', person: 5 };

async function boardShown(page: Page) {
  await page.waitForFunction(() => (window as Shown).__board);
  // The dev scenario panel sits over the toolbar's right end.
  await page.addStyleTag({
    content: '[data-testid="mock-scenario-panel"] { display: none; }',
  });
}

async function openCanvas(page: Page) {
  await page.goto('/workspaces/ws_bio?view=canvas');
  await boardShown(page);
}

const drawn = (page: Page) =>
  page.evaluate(() => (window as Shown).__board?.stats().canvas ?? null);
const documentOf = (page: Page) =>
  page.evaluate(() => (window as Shown).__board?.snapshot() ?? null);
const selected = (page: Page) =>
  page.evaluate(() =>
    [...((window as Shown).__board?.presence.selected() ?? [])].sort()
  );
const keep = (page: Page) =>
  page.evaluate(() =>
    Object.assign((window as Shown).__board ?? {}, { kept: true })
  );
const kept = (page: Page) =>
  page.evaluate(() => (window as Shown).__board?.kept === true);

/** Ben's canvas in the workspace, shared, which this person holds by `role`. */
const memberCanvas = (page: Page, role: 'editor' | 'viewer', title: string) =>
  page.evaluate(
    async ([held, name]) => {
      const modulePath = '/src/mocks/canvas.ts';
      const { mockMemberCanvas } = (await import(modulePath)) as Canvases;
      return mockMemberCanvas({
        creatorName: 'Ben',
        role: held,
        title: name,
        workspaceId: 'ws_bio',
      });
    },
    [role, title] as const
  );

/** Opens `title` from the picker of the canvas showing as `from`. */
async function switchTo(page: Page, from: string, title: string) {
  await page
    .locator('[data-workspace-canvas]')
    .getByRole('button', { exact: true, name: from })
    .click();
  await page
    .locator('[data-slot=popover-content]')
    .getByRole('button', { name: title })
    .click();
}

/** Ben joins the canvas's room, headless, as `window.peer`, once the board
 * has opened it. */
async function joinBen(page: Page, id: string) {
  await expect
    .poll(() =>
      page.evaluate(
        async ([canvasId, identity]) => {
          const modulePath = '/src/mocks/collaboration.ts';
          const { mockBoardPeer } = (await import(modulePath)) as Collaboration;
          try {
            Object.assign(window, { peer: mockBoardPeer(canvasId, identity) });
            return true;
          } catch {
            return false;
          }
        },
        [id, BEN] as const
      )
    )
    .toBe(true);
}

/** Ben draws two squares, `from` and `to`, 100 units each, 300 apart. */
const benSquares = (page: Page) =>
  page.evaluate(() => {
    const peer = (window as Shown).peer;
    if (!peer) throw new Error('no peer');
    const square = (x: number) => ({
      fillColor: '#ffffff',
      filled: false,
      index: 'a0',
      radius: 0,
      rotate: 0,
      roughness: 1.4,
      seed: 1,
      shapeStyle: 'General',
      shapeType: 'rect',
      strokeColor: '#000000',
      strokeStyle: 'solid',
      strokeWidth: 2,
      type: 'shape',
      xywh: `[${x},0,100,100]`,
    });
    peer.add('from', square(0));
    peer.add('to', square(400));
  });

/** Where the board point (`x`, `y`) is on the page now. */
const onPage = (page: Page, x: number, y: number) =>
  page.evaluate(
    ([boardX, boardY]) => {
      const view = (window as Shown).__board?.presence.view();
      const host = document.querySelector('.capy-board');
      if (!(view && host)) throw new Error('no board');
      const box = host.getBoundingClientRect();
      return [
        box.x + view.left + boardX * view.zoom,
        box.y + view.top + boardY * view.zoom,
      ] as [number, number];
    },
    [x, y] as const
  );

/** What the page puts on the clipboard from now: each write's HTML. */
const watchClipboard = (page: Page) =>
  page.evaluate(() => {
    const copied: string[] = [];
    Object.assign(window, { copied });
    navigator.clipboard.write = async (items) => {
      for (const item of items)
        if (item.types.includes('text/html'))
          copied.push(await (await item.getType('text/html')).text());
    };
  });
const copied = (page: Page) =>
  page.evaluate(() => (window as Shown).copied ?? []);

/** Pastes `html` where the board's focus is, as the clipboard hands it over. */
const pasteHtml = (page: Page, html: string) =>
  page.evaluate((text) => {
    const data = new DataTransfer();
    data.setData('text/html', text);
    document.querySelector('.capy-board editor-host')?.dispatchEvent(
      new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData: data,
        composed: true,
      })
    );
  }, html);

/** A viewer's board with Ben's two squares on it. */
async function viewersBoard(page: Page) {
  await openCanvas(page);
  const viewed = await memberCanvas(page, 'viewer', 'Lab diagrams');
  await switchTo(page, 'Biology 101', 'Lab diagrams');
  await expect(page).toHaveURL(new RegExp(`c=${viewed}`));
  await joinBen(page, viewed);
  await benSquares(page);
  await expect.poll(() => drawn(page)).toEqual(['shape', 'shape']);
  // Both squares in view.
  await page.locator('.capy-board-menu .capy-menu-button').click();
  await page.getByRole('menuitem', { name: 'Fit to screen' }).click();
}

test("a viewer's board selects and copies what an editor's copy does, and writes nothing", async ({
  page,
}) => {
  test.slow();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await viewersBoard(page);
  await keep(page);
  const shown = await documentOf(page);
  await watchClipboard(page);
  // No toolbar: nothing here edits.
  await expect(page.locator('edgeless-toolbar-widget')).toHaveCount(0);

  // A click on a square's outline selects it, and Copy sits above it (once
  // the board has laid the square out where it is drawn).
  await expect(async () => {
    await page.mouse.click(...(await onPage(page, 0, 50)));
    expect(await selected(page)).toEqual(['from']);
  }).toPass();
  const bar = page.locator('.capy-copy-bar');
  await expect(bar.getByRole('button', { name: 'Copy' })).toBeVisible();
  const barBox = await bar.boundingBox();
  const [, squareTop] = await onPage(page, 0, 0);
  expect(barBox && barBox.y + barBox.height).toBeLessThan(squareTop);

  // A drag on empty board selects by its box.
  await page.mouse.move(...(await onPage(page, -60, -60)));
  await page.mouse.down();
  await page.mouse.move(...(await onPage(page, 560, 160)), { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => selected(page)).toEqual(['from', 'to']);

  // ⌘C and the bar's Copy put the board's own copy on the clipboard.
  await page.keyboard.press('ControlOrMeta+c');
  await expect.poll(() => copied(page)).toHaveLength(1);
  await bar.getByRole('button', { name: 'Copy' }).click();
  await expect.poll(() => copied(page)).toHaveLength(2);
  const [byKey, byBar] = await copied(page);
  expect(byKey).toContain('data-blocksuite-snapshot');
  expect(byBar).toBe(byKey);
  await expect(page.getByText('Copied to clipboard')).toBeVisible();

  // Cut copies only; a paste and a double click on empty board add nothing.
  // (The board hears keys again once the pointer is back over it.)
  await page.mouse.move(...(await onPage(page, 250, 300)));
  await page.keyboard.press('ControlOrMeta+x');
  await expect.poll(() => copied(page)).toHaveLength(3);
  await pasteHtml(page, byKey);
  await page.mouse.dblclick(...(await onPage(page, 250, 300)));
  // With a square selected, Delete, Backspace and the arrows change nothing.
  await expect(async () => {
    await page.mouse.click(...(await onPage(page, 0, 50)));
    expect(await selected(page)).toEqual(['from']);
  }).toPass();
  for (const key of ['Delete', 'Backspace', 'ArrowRight', 'Shift+ArrowDown'])
    await page.keyboard.press(key);
  expect(await selected(page)).toEqual(['from']);
  await page.waitForTimeout(2500);
  // A write on a read channel would close it and open the room afresh.
  expect(await kept(page)).toBe(true);
  expect(await documentOf(page)).toBe(shown);
  expect(await drawn(page)).toEqual(['shape', 'shape']);

  // The menu keeps Download as image, and no edit rows.
  await page.locator('.capy-board-menu .capy-menu-button').click();
  await expect(page.getByRole('menuitem')).toHaveText([
    'Fit to screen',
    'Download as image',
  ]);
  await page.keyboard.press('Escape');

  // An editor's paste of that copy lands both squares on their own canvas.
  await switchTo(page, 'Lab diagrams', 'Biology 101');
  await expect(page).toHaveURL(new RegExp(`c=${CANVAS}`));
  await boardShown(page);
  await expect(page.locator('edgeless-pen-tool-button').first()).toBeVisible();
  const before = ((await drawn(page)) ?? []).length;
  await page.locator('.capy-board').click({ position: { x: 300, y: 200 } });
  await page.keyboard.press('Escape');
  await pasteHtml(page, byKey);
  await expect.poll(async () => (await drawn(page))?.length).toBe(before + 2);
  expect(errors).toEqual([]);
});

test("an editor's board that stops taking edits selects and copies, with no toolbar", async ({
  page,
}) => {
  test.slow();
  await openCanvas(page);
  const edited = await memberCanvas(page, 'editor', 'Field notes');
  await switchTo(page, 'Biology 101', 'Field notes');
  await expect(page).toHaveURL(new RegExp(`c=${edited}`));
  await expect(page.locator('edgeless-pen-tool-button').first()).toBeVisible();
  await joinBen(page, edited);
  await benSquares(page);
  await expect.poll(() => drawn(page)).toEqual(['shape', 'shape']);
  // Lowered to a viewer: the canvas still reads, its board takes no edits.
  // (Its access taken back, the canvas goes instead: canvas-room-states.)
  await page.evaluate(async (canvasId) => {
    const modulePath = '/src/mocks/collaboration.ts';
    const { mockDemoteBoard } = (await import(modulePath)) as Collaboration;
    mockDemoteBoard(canvasId);
  }, edited);
  await expect(page.locator('[data-canvas-strip]')).toContainText(
    'This file is read-only now.'
  );
  await expect(page.locator('edgeless-pen-tool-button')).toHaveCount(0);
  const locked = await documentOf(page);
  await page.mouse.click(...(await onPage(page, 400, 50)));
  await expect.poll(() => selected(page)).toEqual(['to']);
  await expect(
    page.locator('.capy-copy-bar').getByRole('button', { name: 'Copy' })
  ).toBeVisible();
  expect(await documentOf(page)).toBe(locked);
});

test.describe('on a phone', () => {
  test.use({ hasTouch: true, viewport: { height: 720, width: 360 } });

  test("a tap selects on a viewer's board, one finger pans, and Copy sits above", async ({
    page,
  }) => {
    test.slow();
    await viewersBoard(page);
    const shown = await documentOf(page);
    await expect(async () => {
      await page.touchscreen.tap(...(await onPage(page, 0, 50)));
      expect(await selected(page)).toEqual(['from']);
    }).toPass();
    const bar = page.locator('.capy-copy-bar');
    await expect(bar.getByRole('button', { name: 'Copy' })).toBeVisible();
    expect((await bar.boundingBox())?.height).toBe(44);

    // One finger on empty board pans, as before.
    const centre = await page.evaluate(
      () => (window as Shown).__board?.view()?.centre
    );
    const [x, y] = await onPage(page, 200, 300);
    const cdp = await page.context().newCDPSession(page);
    const touch = (type: string, points: { x: number; y: number }[]) =>
      cdp.send('Input.dispatchTouchEvent', { touchPoints: points, type });
    await touch('touchStart', [{ x, y }]);
    for (let step = 1; step <= 8; step++)
      await touch('touchMove', [{ x: x + step * 10, y: y + step * 6 }]);
    await touch('touchEnd', []);
    await expect
      .poll(() =>
        page.evaluate(() => (window as Shown).__board?.view()?.centre)
      )
      .not.toEqual(centre);
    expect(await documentOf(page)).toBe(shown);
  });
});

/** Holds this page's image uploads back from now until `release`; with
 * `refuse`, answers them as the server does a full account. */
const holdUploads = (page: Page, refuse = false) =>
  page.evaluate((refused) => {
    const send = window.fetch;
    const uploads = { held: 0, release: () => {} };
    const released = new Promise<void>((resolve) => {
      uploads.release = resolve;
    });
    Object.assign(window, { uploads });
    window.fetch = async (...sent) => {
      const [to] = sent;
      const url = to instanceof Request ? to.url : String(to);
      if (new URL(url, location.href).pathname.endsWith('/uploads')) {
        uploads.held += 1;
        await released;
        if (refused)
          return new Response(
            JSON.stringify({ code: 'storage_quota_exceeded', detail: 'Full' }),
            { headers: { 'Content-Type': 'application/json' }, status: 413 }
          );
      }
      return send(...sent);
    };
  }, refuse);

/** Pastes an image of one colour on the board, 320 by 200. */
async function pasteImage(page: Page, colour: string) {
  await page.locator('.capy-board').click({ position: { x: 300, y: 200 } });
  await page.keyboard.press('Escape');
  await page.evaluate(async (fill) => {
    const painted = document.createElement('canvas');
    painted.width = 320;
    painted.height = 200;
    const context = painted.getContext('2d');
    if (!context) throw new Error('no 2d canvas');
    context.fillStyle = fill;
    context.fillRect(0, 0, 320, 200);
    const png = await new Promise<Blob | null>((resolve) =>
      painted.toBlob(resolve, 'image/png')
    );
    if (!png) throw new Error('no image');
    const clipboard = new DataTransfer();
    clipboard.items.add(new File([png], 'pasted.png', { type: 'image/png' }));
    document.querySelector('.capy-board editor-host')?.dispatchEvent(
      new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData: clipboard,
        composed: true,
      })
    );
  }, colour);
}

const imageCount = (page: Page) =>
  page.evaluate(() => (window as Shown).__board?.images().length ?? 0);

/** What Ben hears of the other tabs' uploads. */
const benHears = (page: Page) =>
  page.evaluate(() => {
    const awareness = (window as Shown).peer?.awareness;
    if (!awareness) throw new Error('no peer');
    return [...awareness.getStates()]
      .filter(([client]) => client !== awareness.clientID)
      .flatMap(([, state]) => (state as { uploads?: string[] }).uploads ?? []);
  });

test('an image shows a box where it will land while it uploads, for its uploader and for others, and a refused one says why and leaves nothing', async ({
  page,
}) => {
  test.slow();
  await openCanvas(page);
  await expect(page.locator('edgeless-pen-tool-button').first()).toBeVisible();
  await joinBen(page, CANVAS);
  const images = await imageCount(page);

  // While it goes up: the box at once, its share uploaded, and Ben hears
  // where it will land; no block yet.
  await holdUploads(page);
  await pasteImage(page, '#2f7d56');
  const box = page.locator('.capy-upload[role=status]');
  await expect(box).toHaveText(/0% uploaded/);
  const size = await box.boundingBox();
  const zoom = await page.evaluate(
    () => (window as Shown).__board?.presence.view().zoom ?? 0
  );
  expect(size?.width).toBeCloseTo(320 * zoom, 0);
  expect(size?.height).toBeCloseTo(200 * zoom, 0);
  await expect.poll(() => benHears(page)).toHaveLength(1);
  expect(await imageCount(page)).toBe(images);
  // Landed: the box goes, and so does what Ben hears.
  await page.evaluate(() => (window as Shown).uploads?.release());
  await expect.poll(() => imageCount(page)).toBe(images + 1);
  await expect(box).toHaveCount(0);
  await expect.poll(() => benHears(page)).toEqual([]);

  // Refused: the box says why, nothing lands, and Close takes it away.
  await holdUploads(page, true);
  await pasteImage(page, '#7d2f56');
  await expect(box).toBeVisible();
  await page.evaluate(() => (window as Shown).uploads?.release());
  const refused = page.locator('.capy-upload-refused');
  await expect(refused).toContainText("The image couldn't be added.");
  await expect(box).toHaveCount(0);
  await page.waitForTimeout(500);
  expect(await imageCount(page)).toBe(images + 1);
  await refused.getByRole('button', { name: 'Close' }).click();
  await expect(refused).toHaveCount(0);

  // Ben's own upload shows as Uploading where it will land, with his name.
  await page.evaluate(() =>
    (window as Shown).peer?.awareness.setLocalState({
      uploads: [[0, 300, 320, 200].map((unit) => unit.toString(36)).join(',')],
    })
  );
  const theirs = page.locator('[data-remote-upload="Ben"]');
  await expect(theirs).toHaveText('Uploading');
  await expect(page.locator('[data-remote-run="Ben"]')).toContainText('Ben');
  await page.evaluate(() =>
    (window as Shown).peer?.awareness.setLocalState({})
  );
  await expect(theirs).toHaveCount(0);
});

test("the menu downloads the board as an image, ends with the canvas's size from 75%, takes only removals at the cap, and has a slot for the save status", async ({
  page,
}) => {
  test.slow();
  await openCanvas(page);
  await expect(page.locator('edgeless-pen-tool-button').first()).toBeVisible();
  // Something to download: an empty board's row is greyed out.
  await joinBen(page, CANVAS);
  await benSquares(page);
  await expect.poll(() => drawn(page)).toEqual(['shape', 'shape']);
  const menu = page.locator('.capy-board-menu');
  await menu.locator('.capy-menu-button').click();
  await page.getByRole('menuitem', { name: 'Fit to screen' }).click();
  // The slot sits just left of ☰, taking no room while empty.
  const slot = await page.evaluate(() => {
    const status = (window as Shown).__board?.statusSlot;
    const button = document.querySelector('.capy-board-menu .capy-menu-button');
    status?.append(
      Object.assign(document.createElement('span'), { textContent: 'Saved' })
    );
    const [left, right] = [status, button].map((element) =>
      element?.getBoundingClientRect()
    );
    return left && right ? right.left - left.right : null;
  });
  expect(slot).toBe(12);

  await menu.locator('.capy-menu-button').click();
  await expect(page.getByRole('menuitem')).toHaveText([
    'Undo',
    'Redo',
    'Fit to screen',
    'Download as image',
    'Clear all',
  ]);
  await expect(menu.locator('.capy-menu-note')).toHaveCount(0);
  const download = page.waitForEvent('download');
  await page.getByRole('menuitem', { name: 'Download as image' }).click();
  const file = await download;
  // Named by the canvas's title once the page gives it (`title`).
  expect(file.suggestedFilename()).toMatch(/^(Biology 101|canvas)\.png$/);
  const bytes = await readFile(await file.path());
  expect(bytes.subarray(1, 4).toString()).toBe('PNG');

  const sized = async (bytes: number) => {
    await page.evaluate(
      (held) =>
        (window as Shown).__board?.setRoomSize({
          bytes: held,
          max: 4096 * 1024,
        }),
      bytes
    );
    await menu.locator('.capy-menu-button').click();
    const note = menu.locator('.capy-menu-note');
    const shown = (await note.count()) ? await note.textContent() : null;
    const error = (await note.count())
      ? await note.evaluate((row) =>
          row.classList.contains('capy-menu-note-error')
        )
      : null;
    await page.keyboard.press('Escape');
    return { error, shown: shown?.trim() ?? null };
  };
  expect(await sized(3000 * 1024)).toEqual({ error: null, shown: null });
  expect(await sized(3150 * 1024)).toEqual({
    error: false,
    shown: 'Size: 3,150/4,096 KB',
  });
  expect(await sized(4096 * 1024)).toEqual({
    error: true,
    shown:
      'Size: 4,096/4,096 KB · Only edits that remove content will be saved.',
  });
  // The room's 64 KiB margin: removals only from 4,032 KB, as the row says.
  expect(await sized(4031 * 1024)).toEqual({
    error: false,
    shown: 'Size: 4,031/4,096 KB',
  });
  expect(await sized(4040 * 1024)).toEqual({
    error: true,
    shown:
      'Size: 4,040/4,096 KB · Only edits that remove content will be saved.',
  });

  // There the board takes only removals: the pen goes back to select, ⌘D,
  // Duplicate and a paste land nothing, and Delete still removes.
  const tool = () => page.locator('.capy-board').getAttribute('data-tool');
  const pen = page.locator('edgeless-pen-tool-button').first();
  await pen.click();
  await expect.poll(tool).toBe('default');
  await expect(
    page.getByText('Only edits that remove content will be saved.').first()
  ).toBeVisible();
  await page.mouse.click(...(await onPage(page, 0, 50)));
  await expect.poll(() => selected(page)).toEqual(['from']);
  await page.keyboard.press('ControlOrMeta+c');
  const shown = await documentOf(page);
  await page.keyboard.press('ControlOrMeta+d');
  await page.evaluate(() => {
    const data = new DataTransfer();
    data.setData('text/plain', 'more words');
    document.querySelector('.capy-board editor-host')?.dispatchEvent(
      new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData: data,
        composed: true,
      })
    );
  });
  await page.locator('editor-icon-button[aria-label="More"]').click();
  await page.locator('editor-menu-action[aria-label="Duplicate"]').click();
  await page.waitForTimeout(500);
  expect(await documentOf(page)).toBe(shown);
  // Delete still takes what is selected.
  await page.keyboard.press('Escape');
  await expect(async () => {
    await page.mouse.click(...(await onPage(page, 0, 50)));
    expect(await selected(page)).toEqual(['from']);
  }).toPass();
  await page.keyboard.press('Delete');
  await expect.poll(() => drawn(page)).toEqual(['shape']);
  // Below the cap the pen comes back.
  await page.evaluate(() =>
    (window as Shown).__board?.setRoomSize({ bytes: 0, max: 4096 * 1024 })
  );
  await pen.click();
  await expect.poll(tool).toBe('brush');
});

test('a board with no room shows no size row and an empty status slot', async ({
  page,
}) => {
  await page.goto('/dev/drawing');
  await page.waitForFunction(() => (window as Shown).__board);
  await page.locator('.capy-board-menu .capy-menu-button').click();
  await expect(
    page.getByRole('menuitem', { name: 'Download as image' })
  ).toBeVisible();
  await expect(page.locator('.capy-menu-note')).toHaveCount(0);
  await expect(page.locator('.capy-board-status')).toBeHidden();
});
