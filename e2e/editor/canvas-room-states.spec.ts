import { expect, type Page, test } from '@playwright/test';

/**
 * A canvas's room when things go wrong or change under the board (the
 * browser fix round of 2026-11-18), against the mock room
 * (src/mocks/collaboration.ts, the board room): a viewer on a board whose
 * connector has a label, the keyboard on a board that takes no edits, another
 * person's image, an image still being stored as its board goes, an editor
 * losing access, a full canvas, a dropped socket, and a canvas opened offline.
 */

type Collaboration = typeof import('../../src/mocks/collaboration');
type Canvases = typeof import('../../src/mocks/canvas');
type Peer = ReturnType<Collaboration['mockBoardPeer']>;
type View = { centre: [number, number]; zoom: number };
type Board = {
  images(): { id: string }[];
  presence: {
    boxOf(ids: string[]): { h: number; w: number; x: number; y: number } | null;
    selected(): string[];
    view(): { left: number; top: number; zoom: number };
  };
  snapshot(): string;
  stats(): { canvas: string[] };
  view(): View | null;
};
type Shown = {
  __board?: Board & { kept?: boolean };
  peer?: Peer;
  /** `holdUploads`: how many uploads wait, and what lets them go. */
  uploads?: { held: number; release(): void };
};

/** A workspace's first canvas, as the mocks name it. */
const CANVAS = 'cv_ws_bio_1';

const drawn = (page: Page) =>
  page.evaluate(() => (window as Shown).__board?.stats().canvas ?? null);

/** What is drawn, by kind, whatever their order front to back. */
const kinds = async (page: Page) => [...((await drawn(page)) ?? [])].sort();

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

/** A pen stroke across the board, `down` of the way down it. */
async function drawStroke(page: Page, down = 0.4) {
  await page.locator('edgeless-pen-tool-button').first().click();
  const box = await page.locator('affine-edgeless-root').boundingBox();
  if (!box) throw new Error('no board');
  const at = (x: number, y: number) =>
    [box.x + box.width * x, box.y + box.height * y] as const;
  await page.mouse.move(...at(0.4, down));
  await page.mouse.down();
  for (let step = 1; step <= 10; step++)
    await page.mouse.move(...at(0.4 + step * 0.02, down + step * 0.01));
  await page.mouse.up();
}

/** Another person joins the canvas's room, headless, as `window.peer`. */
const joinPeer = (page: Page, id: string) =>
  page.evaluate(async (canvasId) => {
    const modulePath = '/src/mocks/collaboration.ts';
    const { mockBoardPeer } = (await import(modulePath)) as Collaboration;
    Object.assign(window, { peer: mockBoardPeer(canvasId) });
  }, id);

/** Ben's canvas in the workspace, shared, which this person holds by `role`. */
const memberCanvas = (
  page: Page,
  role: 'editor' | 'viewer',
  title = 'Lab diagrams'
) =>
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

const picker = (page: Page, title: string) =>
  page
    .locator('[data-workspace-canvas]')
    .getByRole('button', { exact: true, name: title });

/** Opens `title` from the picker of the canvas showing as `from`. */
async function switchTo(page: Page, from: string, title: string) {
  await picker(page, from).click();
  await page
    .locator('[data-slot=popover-content]')
    .getByRole('button', { name: title })
    .click();
}

/** The peer draws two squares, `from` and `to`. */
const peerSquares = (page: Page) =>
  page.evaluate(() => {
    const peer = (window as Shown).peer;
    if (!peer) throw new Error('no peer');
    // Every field a tab's own shape stores: the board draws what it reads.
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

/** Marks the board that shows now, to tell whether it is still the one. */
const keep = (page: Page) =>
  page.evaluate(() =>
    Object.assign((window as Shown).__board ?? {}, { kept: true })
  );
const kept = (page: Page) =>
  page.evaluate(() => (window as Shown).__board?.kept === true);

const viewOf = (page: Page) =>
  page.evaluate(() => (window as Shown).__board?.view() ?? null);

/** Calls one of the mock room's e2e switches for a canvas. */
const room = (
  page: Page,
  call: 'mockFillBoard' | 'mockRevokeBoard',
  id: string
) =>
  page.evaluate(
    async ([name, canvasId]) => {
      const modulePath = '/src/mocks/collaboration.ts';
      const mocks = (await import(modulePath)) as Collaboration;
      mocks[name](canvasId);
    },
    [call, id] as const
  );
const socket = (page: Page, id: string, up: boolean) =>
  page.evaluate(
    async ([canvasId, back]) => {
      const modulePath = '/src/mocks/collaboration.ts';
      const { mockBoardSocket } = (await import(modulePath)) as Collaboration;
      mockBoardSocket(canvasId, back);
    },
    [id, up] as const
  );

test("a viewer stays on a board whose connector has a label, through its maker's moves and a second open", async ({
  page,
}) => {
  test.slow();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await openCanvas(page);
  const theirs = await memberCanvas(page, 'viewer');
  await switchTo(page, 'Biology 101', 'Lab diagrams');
  await expect(page).toHaveURL(new RegExp(`c=${theirs}`));
  await expect.poll(() => drawn(page)).toEqual([]);
  await keep(page);

  // Ben joins two shapes with a labelled connector, then moves one of them.
  await joinPeer(page, theirs);
  await peerSquares(page);
  await page.evaluate(() => {
    (window as Shown).peer?.add('join', {
      index: 'a1',
      labelDisplay: true,
      labelOffset: { distance: 0.5 },
      labelXYWH: [220, 38, 60, 24],
      mode: 0,
      rough: false,
      roughness: 1.4,
      seed: 2,
      source: { id: 'from' },
      stroke: '#000000',
      strokeStyle: 'solid',
      strokeWidth: 2,
      target: { id: 'to' },
      text: 'feeds',
      type: 'connector',
    });
  });
  await expect.poll(() => drawn(page)).toEqual(['shape', 'shape', 'connector']);
  await page.evaluate(() =>
    (window as Shown).peer?.change('from', { xywh: '[0,300,100,100]' })
  );
  // A tab that wrote the label's place would have its read channel closed and
  // its room opened afresh, over and over: this board is still the first.
  await page.waitForTimeout(2500);
  expect(await kept(page)).toBe(true);
  expect(await drawn(page)).toEqual(['shape', 'shape', 'connector']);

  // Opened again with the connector already there.
  await switchTo(page, 'Lab diagrams', 'Biology 101');
  await expect.poll(() => drawn(page)).toEqual([]);
  await switchTo(page, 'Biology 101', 'Lab diagrams');
  await expect.poll(() => drawn(page)).toEqual(['shape', 'shape', 'connector']);
  await keep(page);
  await page.waitForTimeout(2500);
  expect(await kept(page)).toBe(true);
  expect(errors).toEqual([]);
});

/** The board's document as it stands: the same text while nothing wrote. */
const documentOf = (page: Page) =>
  page.evaluate(() => (window as Shown).__board?.snapshot() ?? null);

/** Selects everything on the board from the keyboard and nudges it right;
 * answers how many elements were selected. */
async function nudgeAll(page: Page) {
  await page.locator('.capy-board').click({ position: { x: 300, y: 200 } });
  await page.keyboard.press('ControlOrMeta+a');
  const selected = await page.evaluate(
    () => (window as Shown).__board?.presence.selected().length ?? 0
  );
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Shift+ArrowDown');
  return selected;
}

/** Picks the select tool with `key` (Escape first: nothing is selected), then
 * presses on the element `id`, `across` and `down` of the way over its box,
 * and drags it away; answers what is selected after. */
async function dragElement(
  page: Page,
  key: 'Escape' | 'v',
  id: string,
  [across, down]: [number, number]
) {
  const [x, y] = await page.evaluate(
    ([element, fx, fy]) => {
      const board = (window as Shown).__board;
      const host = document.querySelector('.capy-board');
      const box = board?.presence.boxOf([element]);
      if (!(board && host && box)) throw new Error(`no ${element}`);
      const view = board.presence.view();
      const place = host.getBoundingClientRect();
      return [
        place.x + view.left + (box.x + box.w * fx) * view.zoom,
        place.y + view.top + (box.y + box.h * fy) * view.zoom,
      ];
    },
    [id, across, down] as const
  );
  await page.keyboard.press('Escape');
  if (key === 'v') await page.keyboard.press('v');
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 90, y + 60, { steps: 6 });
  await page.mouse.up();
  return page.evaluate(
    () => (window as Shown).__board?.presence.selected() ?? []
  );
}

test('the keyboard and a drag move nothing on a board that takes no edits', async ({
  page,
}) => {
  test.slow();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await openCanvas(page);

  // A viewer's board, with two squares its maker drew.
  const viewed = await memberCanvas(page, 'viewer');
  await switchTo(page, 'Biology 101', 'Lab diagrams');
  await expect(page).toHaveURL(new RegExp(`c=${viewed}`));
  await expect.poll(() => drawn(page)).toEqual([]);
  await joinPeer(page, viewed);
  await peerSquares(page);
  await expect.poll(() => drawn(page)).toEqual(['shape', 'shape']);
  await keep(page);
  const shown = await documentOf(page);
  // Selecting still works; the move writes nothing.
  expect(await nudgeAll(page)).toBe(2);
  expect(await documentOf(page)).toBe(shown);
  // On the select tool (`v`) a press on a square's outline selects it, and the
  // drag moves nothing.
  expect(await dragElement(page, 'v', 'from', [0, 0.5])).toEqual(['from']);
  expect(await documentOf(page)).toBe(shown);
  // A write on a read channel would close it and open the room afresh.
  await page.waitForTimeout(2500);
  expect(await kept(page)).toBe(true);
  expect(await documentOf(page)).toBe(shown);
  expect(
    await page.evaluate(() => (window as Shown).peer?.elements().from.xywh)
  ).toBe('[0,0,100,100]');

  // An editor's board, locked once their access is taken back.
  const edited = await memberCanvas(page, 'editor', 'Field notes');
  await switchTo(page, 'Lab diagrams', 'Field notes');
  await expect(page).toHaveURL(new RegExp(`c=${edited}`));
  await expect.poll(() => drawn(page)).toEqual([]);
  await expect(page.locator('edgeless-pen-tool-button').first()).toBeVisible();
  await drawStroke(page);
  await expect.poll(() => drawn(page)).toEqual(['brush']);
  await keep(page);
  await room(page, 'mockRevokeBoard', edited);
  await expect(page.getByText('You no longer have access')).toBeVisible();
  const locked = await documentOf(page);
  expect(await nudgeAll(page)).toBe(1);
  expect(await documentOf(page)).toBe(locked);
  // The toolbar's Escape puts a locked board on the select tool.
  const [stroke] = await page.evaluate(
    () => (window as Shown).__board?.presence.selected() ?? []
  );
  expect(await dragElement(page, 'Escape', stroke, [0.5, 0.5])).toEqual([
    stroke,
  ]);
  expect(await documentOf(page)).toBe(locked);
  expect(await kept(page)).toBe(true);
  expect(errors).toEqual([]);
});

/** Pastes an image of one colour where the board's focus is, as the clipboard
 * hands one over (the same picture again is stored already, and stores
 * nothing). */
const pasteFile = (page: Page, colour: string) =>
  page.evaluate(async (fill) => {
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

/** Pastes an image on the board itself, nothing being edited. */
async function pasteImage(page: Page, colour = '#2f7d56') {
  await page.locator('.capy-board').click({ position: { x: 300, y: 200 } });
  // Nothing selected: a click on a selected image would start editing it.
  await page.keyboard.press('Escape');
  await pasteFile(page, colour);
}

/** Holds this page's image uploads back from now, as a slow line would,
 * until `releaseUploads`. */
const holdUploads = (page: Page) =>
  page.evaluate(() => {
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
      }
      return send(...sent);
    };
  });

/** Waits until an image's upload is at the hold: its file is being stored. */
const uploadHeld = (page: Page) =>
  page.waitForFunction(() => ((window as Shown).uploads?.held ?? 0) > 0);

const releaseUploads = (page: Page) =>
  page.evaluate(() => (window as Shown).uploads?.release());

const imageIds = (page: Page) =>
  page.evaluate(
    () => (window as Shown).__board?.images().map(({ id }) => id) ?? null
  );

// The upload itself (its ticket has a path of its own).
const isUpload = (url: string) =>
  new URL(url).pathname.endsWith('/editor-assets/uploads');

test("another person's image is theirs: this tab stores nothing for it and leaves it be", async ({
  page,
}) => {
  test.slow();
  await openCanvas(page);
  const uploads: string[] = [];
  page.on('request', (request) => {
    if (isUpload(request.url())) uploads.push(request.url());
  });
  // The other person pastes an image stored for another item, which this
  // person can read too.
  await joinPeer(page, CANVAS);
  await page.evaluate(() =>
    (window as Shown).peer?.image('peer-image', 'asset_mock_cell_diagram')
  );
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document.querySelector<HTMLImageElement>('affine-edgeless-image img')
            ?.naturalWidth ?? 0
      )
    )
    .toBeGreaterThan(0);
  await page.waitForTimeout(2000);
  expect(uploads).toEqual([]);
  expect(await imageIds(page)).toEqual(['asset_mock_cell_diagram']);
});

/** A second canvas to leave for, back on the first. */
async function withSecondCanvas(page: Page) {
  await openCanvas(page);
  await picker(page, 'Biology 101').click();
  await page.getByRole('button', { name: 'New canvas' }).click();
  await expect(page).toHaveURL(/c=cv_ws_bio_2/);
  await boardShown(page);
  await switchTo(page, 'Untitled canvas', 'Biology 101');
  await expect(page).toHaveURL(new RegExp(`c=${CANVAS}`));
  await boardShown(page);
  // Taking edits (not for the moment a room spends sending what was kept).
  await expect(page.locator('edgeless-pen-tool-button').first()).toBeVisible();
}

/** Leaves for the second canvas while an image's upload is held, lets it go
 * there, and comes back once it is stored: the first canvas holds only
 * `held`. */
async function leaveWhileStoring(page: Page, held: string[]) {
  const late = page.waitForResponse((response) => isUpload(response.url()));
  await uploadHeld(page);
  await switchTo(page, 'Biology 101', 'Untitled canvas');
  await expect(page).toHaveURL(/c=cv_ws_bio_2/);
  await releaseUploads(page);
  await late;
  await switchTo(page, 'Untitled canvas', 'Biology 101');
  await expect(page).toHaveURL(new RegExp(`c=${CANVAS}`));
  await boardShown(page);
  await expect.poll(() => imageIds(page)).toEqual(held);
  await page.waitForTimeout(1000);
  expect(await imageIds(page)).toEqual(held);
}

test('an image lands once it is stored, and one still being stored as its board goes lands nowhere', async ({
  page,
}) => {
  test.slow();
  await withSecondCanvas(page);
  await holdUploads(page);

  // Its block is not on the board while its file is stored, and is under the
  // stored id from the moment it is.
  const stored = page.waitForResponse((response) => isUpload(response.url()));
  await pasteImage(page);
  await uploadHeld(page);
  expect(await imageIds(page)).toEqual([]);
  await releaseUploads(page);
  await stored;
  await expect
    .poll(() => imageIds(page))
    .toEqual([expect.stringMatching(/^asset_mock_/)]);
  const held = (await imageIds(page)) ?? [];

  // Another one, and the person leaves for the other canvas before it is
  // stored: it is stored, and no block of it is left behind.
  await holdUploads(page);
  await pasteImage(page, '#7d2f56');
  await leaveWhileStoring(page, held);
});

test("an image pasted into a note's text is stored before it lands too, and lands nowhere once its board has gone", async ({
  page,
}) => {
  test.slow();
  await withSecondCanvas(page);
  // A note being typed in: BlockSuite's page paste takes the file.
  const box = await page.locator('affine-edgeless-root').boundingBox();
  if (!box) throw new Error('no board');
  await page.mouse.dblclick(box.x + box.width / 2, box.y + 220);
  await page.waitForFunction(
    () => document.activeElement?.closest('affine-edgeless-note') != null
  );
  await page.keyboard.type('Cells divide');
  await holdUploads(page);

  const stored = page.waitForResponse((response) => isUpload(response.url()));
  await pasteFile(page, '#2f7d56');
  await uploadHeld(page);
  expect(await imageIds(page)).toEqual([]);
  await releaseUploads(page);
  await stored;
  await expect
    .poll(() => imageIds(page))
    .toEqual([expect.stringMatching(/^asset_mock_/)]);
  await expect(page.locator('affine-edgeless-note img')).toHaveCount(1);
  const held = (await imageIds(page)) ?? [];

  // Another, into a second note (a paste over the first note's selected image
  // would replace it), and the person leaves before it is stored.
  await page.mouse.dblclick(box.x + 150, box.y + 460);
  await page.waitForFunction(
    () =>
      document.activeElement?.closest('affine-edgeless-note') != null &&
      document.querySelectorAll('affine-edgeless-note').length === 2
  );
  await page.keyboard.type('Cells grow');
  await holdUploads(page);
  await pasteFile(page, '#7d2f56');
  await leaveWhileStoring(page, held);
});

test('an editor whose access is taken back keeps the board as it was, read-only, where they were looking', async ({
  page,
}) => {
  test.slow();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await openCanvas(page);
  const theirs = await memberCanvas(page, 'editor');
  await switchTo(page, 'Biology 101', 'Lab diagrams');
  await expect(page).toHaveURL(new RegExp(`c=${theirs}`));
  await boardShown(page);
  const pen = page.locator('edgeless-pen-tool-button').first();
  await expect(pen).toBeVisible();
  await drawStroke(page);
  await expect.poll(() => drawn(page)).toEqual(['brush']);
  // Somewhere of their own to look.
  await page.mouse.move(600, 300);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -300);
  await page.keyboard.up('Control');
  await page.mouse.wheel(120, 80);
  await page.waitForTimeout(400);
  const before = await viewOf(page);
  await keep(page);

  await room(page, 'mockRevokeBoard', theirs);
  await expect(page.getByText('You no longer have access')).toBeVisible();
  // The same board, at the same view, with the stroke, and no tools.
  await expect(pen).toBeHidden();
  expect(await kept(page)).toBe(true);
  expect(await viewOf(page)).toEqual(before);
  expect(await drawn(page)).toEqual(['brush']);
  // A drag draws nothing now.
  const box = await page.locator('affine-edgeless-root').boundingBox();
  if (!box) throw new Error('no board');
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.6);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.7, {
    steps: 5,
  });
  await page.mouse.up();
  expect(await drawn(page)).toEqual(['brush']);
  // Closed, the strip leaves nothing over the board, which stays as it is.
  const strip = page.locator('[data-canvas-strip]');
  await expect(strip).toBeVisible();
  await strip.getByRole('button', { name: 'Close' }).click();
  await expect(strip).toBeHidden();
  await expect(pen).toBeHidden();
  expect(errors).toEqual([]);
});

test('a full canvas says so once, drops the stroke it could not take, and leaves an editable board on what the room holds', async ({
  page,
}) => {
  test.slow();
  await openCanvas(page);
  await drawStroke(page);
  await expect.poll(() => drawn(page)).toEqual(['brush']);
  await room(page, 'mockFillBoard', CANVAS);
  await expect.poll(() => drawn(page)).toHaveLength(2);
  const held = await kinds(page);
  const before = await viewOf(page);
  await keep(page);

  // The stroke the room cannot take.
  await drawStroke(page, 0.6);
  const full = page.getByText(
    'This canvas is full. Delete something to keep drawing.'
  );
  await expect(full).toHaveCount(1);
  // The room opens afresh: what it holds, without the refused stroke, at the
  // same view, with the tools.
  await page.waitForFunction(
    () => (window as Shown).__board && !(window as Shown).__board?.kept
  );
  await expect.poll(() => kinds(page)).toEqual(held);
  await expect(page.locator('edgeless-pen-tool-button').first()).toBeVisible();
  expect(await viewOf(page)).toEqual(before);
  await expect(page.getByText('Copy anything you need')).toHaveCount(0);
  // And stays: nothing kept on this device is sent, refused and reopened again.
  await keep(page);
  await page.waitForTimeout(3000);
  expect(await kept(page)).toBe(true);
  expect(await kinds(page)).toEqual(held);
  // Something deleted makes room: the first stroke goes, and the next is taken.
  await page.locator('.capy-board-menu .capy-menu-button').click();
  await page.getByRole('menuitem', { name: 'Clear all' }).click();
  await page.keyboard.press('Escape');
  await drawStroke(page, 0.6);
  await expect.poll(() => drawn(page)).toContain('brush');
  await page.waitForTimeout(1500);
  expect(await kept(page)).toBe(true);
});

test("a tab cut off from the room keeps drawing, and both people's drawing is there once it is back", async ({
  page,
}) => {
  test.slow();
  await openCanvas(page);
  await drawStroke(page);
  await expect.poll(() => drawn(page)).toEqual(['brush']);
  await joinPeer(page, CANVAS);
  const [stroke] = await page.evaluate(() =>
    Object.values((window as Shown).peer?.elements() ?? {})
  );
  await keep(page);

  await socket(page, CANVAS, false);
  // Each draws without the other.
  await drawStroke(page, 0.6);
  await page.evaluate((fields) => {
    (window as Shown).peer?.add('peer-stroke', { ...fields, index: 'a5' });
  }, stroke);
  await expect.poll(() => drawn(page)).toEqual(['brush', 'brush']);
  expect(
    await page.evaluate(
      () => Object.keys((window as Shown).peer?.elements() ?? {}).length
    )
  ).toBe(2);

  await socket(page, CANVAS, true);
  await expect.poll(() => drawn(page)).toEqual(['brush', 'brush', 'brush']);
  await expect
    .poll(() =>
      page.evaluate(
        () => Object.keys((window as Shown).peer?.elements() ?? {}).length
      )
    )
    .toBe(3);
  // The same board all along, still taking edits.
  expect(await kept(page)).toBe(true);
  await expect(page.locator('edgeless-pen-tool-button').first()).toBeVisible();
});

test('a canvas shows the pane loader while it opens; opened offline it waits, and opens by itself when the connection is back', async ({
  page,
  context,
}) => {
  test.slow();
  const panel = page.locator('[data-workspace-canvas]');
  // While the canvas opens, before its board: the loader a file's pane has
  // (there for a moment under the mock, so it is watched for, not polled).
  await page.addInitScript(() => {
    new MutationObserver(() => {
      const loader = document.querySelector(
        '[data-workspace-canvas] .pane-loading'
      );
      if (loader && !document.querySelector('.capy-board'))
        Object.assign(window, { loaderShown: true });
    }).observe(document, { childList: true, subtree: true });
  });
  await page.goto('/workspaces/ws_bio?view=canvas');
  await boardShown(page);
  expect(
    await page.evaluate(() => (window as { loaderShown?: boolean }).loaderShown)
  ).toBe(true);
  await expect(panel.locator('.pane-loading')).toHaveCount(0);
  await drawStroke(page);
  await expect.poll(() => drawn(page)).toEqual(['brush']);
  await page.getByRole('button', { name: 'Dashboard' }).click();
  await expect(page.locator('.capy-board')).toHaveCount(0);

  await context.setOffline(true);
  await page.getByRole('button', { name: 'Canvas' }).click();
  await expect(panel.getByText('Waiting for connection')).toBeVisible();
  await expect(page.locator('.capy-board')).toHaveCount(0);

  await context.setOffline(false);
  await boardShown(page);
  await expect.poll(() => drawn(page)).toEqual(['brush']);
  await expect(panel.getByText('Waiting for connection')).toHaveCount(0);
});
