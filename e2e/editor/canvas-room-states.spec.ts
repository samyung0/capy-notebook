import { type BrowserContext, expect, type Page, test } from '@playwright/test';

/**
 * A canvas's room when things go wrong or change under the board (the
 * browser fix round of 2026-11-18), against the mock room
 * (src/mocks/collaboration.ts, the board room): a viewer on a board whose
 * connector has a label, the keyboard on a board that takes no edits, another
 * person's image, an image still being stored as its board goes, an editor
 * losing access, a full canvas, a dropped socket, a canvas opened offline,
 * an editor narrowed or demoted while it is open, the service down at open,
 * saving delayed, and a canvas opened from the Trash.
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
  call: 'mockDemoteBoard' | 'mockFillBoard' | 'mockRevokeBoard',
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
/** The mock user's account or a storage is full or frozen on a canvas. */
const narrow = (page: Page, id: string, how: 'frozen' | 'payer' | 'self') =>
  page.evaluate(
    async ([canvasId, why]) => {
      const modulePath = '/src/mocks/collaboration.ts';
      const { mockNarrowBoard } = (await import(modulePath)) as Collaboration;
      mockNarrowBoard(canvasId, why);
    },
    [id, how] as const
  );
const storeFails = (page: Page, id: string, failing: boolean) =>
  page.evaluate(
    async ([canvasId, fails]) => {
      const modulePath = '/src/mocks/collaboration.ts';
      const { mockBoardStoreFails } = (await import(
        modulePath
      )) as Collaboration;
      mockBoardStoreFails(canvasId, fails);
    },
    [id, failing] as const
  );
const tokensFail = (page: Page, id: string, failing: boolean) =>
  page.evaluate(
    async ([canvasId, fails]) => {
      const modulePath = '/src/mocks/canvas.ts';
      const { failMockCanvasTokens } = (await import(modulePath)) as Canvases;
      failMockCanvasTokens(canvasId, fails);
    },
    [id, failing] as const
  );
/** The scenarios workspace's first canvas: it keeps drafts and a device copy
 * under the mocks, as every MSW scenario fixture does (editDrafts.ts,
 * deviceCopy.ts), where a plain mock canvas keeps neither. */
const SCENARIO = 'mock-scenario-canvas-1';
const SCENARIO_PAGE = '/workspaces/ws_scenarios?view=canvas';
/** The canvas's room stands at its cap: it refuses whatever grows the board. */
const atCap = (page: Page, id: string, capped: boolean) =>
  page.evaluate(
    async ([canvasId, on]) => {
      const modulePath = '/src/mocks/collaboration.ts';
      const { mockBoardAtCap } = (await import(modulePath)) as Collaboration;
      mockBoardAtCap(canvasId, on);
    },
    [id, capped] as const
  );
/** The user's open budget is spent: a room's join waits, told so. */
const slowed = (page: Page, on: boolean) =>
  page.evaluate(async (value) => {
    const modulePath = '/src/mocks/collaboration.ts';
    const { setCollaborationSlowed } = (await import(
      modulePath
    )) as Collaboration;
    setCollaborationSlowed(value);
  }, on);
/** Whether this device holds a copy of the canvas's room. */
const copied = (page: Page, id: string) =>
  page.evaluate(async (materialId) => {
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      for (const request of await cache.keys())
        if (request.url.includes(`copy/${materialId}/`)) return true;
    }
    return false;
  }, id);
const SLOWED_LINE =
  'Opening is slowed because many large files were opened recently.';
const strip = (page: Page) => page.locator('[data-canvas-strip]');
/** The save status beside the board's ☰. */
const status = (page: Page) => page.locator('.capy-board-status [role=status]');
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

test('a canvas another person filled to its cap goes removals-only from its size, and takes a stroke once Clear all made room', async ({
  page,
}) => {
  test.slow();
  await openCanvas(page);
  await drawStroke(page);
  await expect.poll(() => drawn(page)).toEqual(['brush']);
  await room(page, 'mockFillBoard', CANVAS);
  await expect.poll(() => drawn(page)).toHaveLength(2);
  const board = page.locator('.capy-board');
  // The room's size (its receipts, and what it heard since) reaches the cap's
  // margin: the board takes only removals (client-limits A), and the pen goes
  // back to select. A room's own refusal is the scenario canvas's test below.
  await expect(board).toHaveAttribute('data-full', '');
  await keep(page);
  await page.locator('edgeless-pen-tool-button').first().click();
  await expect(board).toHaveAttribute('data-tool', 'default');
  await expect(
    page.getByText('Only edits that remove content will be saved.').first()
  ).toBeVisible();
  // Something deleted makes room: once stored, the next stroke is taken.
  await page.locator('.capy-board-menu .capy-menu-button').click();
  await page.getByRole('menuitem', { name: 'Clear all' }).click();
  await page.keyboard.press('Escape');
  await expect(board).not.toHaveAttribute('data-full', '');
  await drawStroke(page, 0.6);
  await expect.poll(() => drawn(page)).toContain('brush');
  await page.waitForTimeout(1500);
  expect(await kept(page)).toBe(true);
  await expect(strip(page)).toHaveCount(0);
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

// A canvas this device keeps no copy of: under the mocks a plain canvas keeps
// none (deviceCopy.ts); one with a copy paints it offline (the scenario
// canvas's test below).
test('a canvas shows the pane loader while it opens; one with no copy on this device opened offline waits, and opens by itself when the connection is back', async ({
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

test('an editor demoted while offline drops to view under the read-only strip, keeping what was saved before', async ({
  page,
}) => {
  test.slow();
  await openCanvas(page);
  const theirs = await memberCanvas(page, 'editor');
  await switchTo(page, 'Biology 101', 'Lab diagrams');
  await expect(page).toHaveURL(new RegExp(`c=${theirs}`));
  await boardShown(page);
  await drawStroke(page);
  await expect.poll(() => drawn(page)).toEqual(['brush']);
  await expect(status(page)).toHaveAttribute('data-save-state', 'saved');

  // Drawn while cut off, then demoted: the unsent stroke goes, the saved one
  // stays, and the board takes no edits under the strip (Epo 2026-09-29).
  await socket(page, theirs, false);
  await drawStroke(page, 0.6);
  await expect.poll(() => drawn(page)).toEqual(['brush', 'brush']);
  await room(page, 'mockDemoteBoard', theirs);
  await socket(page, theirs, true);
  await expect(strip(page)).toContainText('This file is read-only now.');
  await expect.poll(() => drawn(page)).toEqual(['brush']);
  await expect(page.locator('edgeless-pen-tool-button')).toHaveCount(0);
});

test('a frozen account opens a canvas under the read-only strip, a full storage under the storage strip', async ({
  page,
}) => {
  test.slow();
  await openCanvas(page);
  await expect(strip(page)).toHaveCount(0);
  // The mocks are the page's: narrowed before the canvas opens, in place.
  const frozen = await memberCanvas(page, 'editor', 'Lab diagrams');
  await narrow(page, frozen, 'frozen');
  const full = await memberCanvas(page, 'editor', 'Field notes');
  await narrow(page, full, 'payer');

  await switchTo(page, 'Biology 101', 'Lab diagrams');
  await expect(page).toHaveURL(new RegExp(`c=${frozen}`));
  await boardShown(page);
  await expect(strip(page)).toContainText('This file is read-only now.');
  await expect(page.locator('edgeless-pen-tool-button')).toHaveCount(0);

  await switchTo(page, 'Lab diagrams', 'Field notes');
  await expect(page).toHaveURL(new RegExp(`c=${full}`));
  await expect(strip(page)).toContainText(
    'Owner of the file has insufficient storage.'
  );
  await expect(page.locator('edgeless-pen-tool-button')).toHaveCount(0);
});

test('with the service down at open the canvas says so at 30 s, and Retry opens it', async ({
  page,
}) => {
  test.slow();
  await openCanvas(page);
  // The mocks are the page's: the service fails for a canvas not yet open.
  const theirs = await memberCanvas(page, 'editor');
  await tokensFail(page, theirs, true);
  await switchTo(page, 'Biology 101', 'Lab diagrams');
  await expect(page).toHaveURL(new RegExp(`c=${theirs}`));
  // Loading, never waiting on a connection the browser has.
  await expect(page.locator('.pane-loading')).toBeVisible();
  await expect(page.getByText('Waiting for connection')).toHaveCount(0);
  await expect(strip(page)).toContainText(
    'The live collaboration service is unavailable.',
    { timeout: 40_000 }
  );
  await tokensFail(page, theirs, false);
  await strip(page).getByRole('button', { name: 'Retry' }).click();
  await boardShown(page);
  await expect(page.locator('edgeless-pen-tool-button').first()).toBeVisible();
  await expect(strip(page)).toHaveCount(0);
});

test('saving is delayed while the room cannot store, and the strip goes once it does', async ({
  page,
}) => {
  test.slow();
  await openCanvas(page);
  await storeFails(page, CANVAS, true);
  await drawStroke(page);
  await expect(status(page)).toHaveAttribute('data-save-state', 'syncing');
  // The room says its store failed with the stroke unsaved.
  await storeFails(page, CANVAS, true);
  await expect(strip(page)).toContainText('Saving is delayed.');
  await storeFails(page, CANVAS, false);
  await expect(strip(page)).toHaveCount(0);
  await expect(status(page)).toHaveAttribute('data-save-state', 'saved');
});

test('a deleted canvas opens read-only from the Trash, and Restore opens it live', async ({
  page,
}) => {
  test.slow();
  await openCanvas(page);
  await drawStroke(page);
  await expect.poll(() => drawn(page)).toEqual(['brush']);
  await expect(status(page)).toHaveAttribute('data-save-state', 'saved');
  await picker(page, 'Biology 101').click();
  await page
    .locator('[data-slot=popover-content]')
    .getByRole('button', { name: 'Delete' })
    .click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Delete' })
    .click();
  await expect(page).not.toHaveURL(new RegExp(`c=${CANVAS}`));

  // In the app, not a fresh page: the mocks are the page's.
  await page.evaluate(() => {
    history.pushState({}, '', '/files?tab=trash');
    dispatchEvent(new PopStateEvent('popstate'));
  });
  await page
    .getByRole('button', { exact: true, name: 'Select Biology 101' })
    .dblclick();
  await expect(page).toHaveURL(new RegExp(`c=${CANVAS}`));
  await boardShown(page);
  await expect(strip(page)).toContainText('Restore');
  await expect.poll(() => drawn(page)).toEqual(['brush']);
  await expect(page.locator('edgeless-pen-tool-button')).toHaveCount(0);
  await expect(status(page)).toHaveCount(0);

  await strip(page).getByRole('button', { name: 'Restore' }).click();
  await expect(strip(page)).toHaveCount(0);
  await expect(page.locator('edgeless-pen-tool-button').first()).toBeVisible();
  await expect.poll(() => drawn(page)).toEqual(['brush']);
});

test('a canvas whose room is at its cap keeps the stroke it refused for copying, and Reload asks before it opens what the room holds', async ({
  page,
}) => {
  test.slow();
  await page.goto(SCENARIO_PAGE);
  await boardShown(page);
  await drawStroke(page);
  await expect.poll(() => drawn(page)).toEqual(['brush']);
  await expect(status(page)).toHaveAttribute('data-save-state', 'saved');
  await atCap(page, SCENARIO, true);
  await keep(page);

  // The stroke the room refuses is kept on this device, shown read-only on a
  // board of its own under the recovery strip (Developer 2026-09-30).
  await drawStroke(page, 0.6);
  await expect(strip(page)).toContainText('Copy anything you need');
  await page.waitForFunction(
    () => (window as Shown).__board && !(window as Shown).__board?.kept
  );
  await expect.poll(() => drawn(page)).toHaveLength(2);
  await expect(page.locator('edgeless-pen-tool-button')).toHaveCount(0);

  // Reload asks first; Cancel keeps the edits.
  const ask = page.getByRole('dialog', {
    name: 'Discard these edits and reload?',
  });
  await strip(page).getByRole('button', { name: 'Reload' }).click();
  await expect(ask).toBeVisible();
  await ask.getByRole('button', { name: 'Cancel' }).click();
  await expect(ask).toHaveCount(0);
  await expect(strip(page)).toContainText('Copy anything you need');
  await expect.poll(() => drawn(page)).toHaveLength(2);
  // Confirmed, the room opens afresh on what it holds, with the tools.
  await strip(page).getByRole('button', { name: 'Reload' }).click();
  await ask.getByRole('button', { name: 'Reload' }).click();
  await expect(strip(page)).toHaveCount(0);
  await expect(page.locator('edgeless-pen-tool-button').first()).toBeVisible();
  await expect.poll(() => drawn(page)).toEqual(['brush']);
});

/** Opens the scenario canvas, draws a stroke, and leaves it, which writes
 * its copy with the tab's room token; then opens it again offline from the
 * copy. */
async function fromCopyOffline(page: Page, context: BrowserContext) {
  await page.goto(SCENARIO_PAGE);
  await boardShown(page);
  await drawStroke(page);
  await expect.poll(() => drawn(page)).toEqual(['brush']);
  await expect(status(page)).toHaveAttribute('data-save-state', 'saved');
  await page.getByRole('button', { name: 'Dashboard' }).click();
  await expect(page.locator('.capy-board')).toHaveCount(0);
  await expect.poll(() => copied(page, SCENARIO)).toBe(true);
  await context.setOffline(true);
  await page.getByRole('button', { name: 'Canvas' }).click();
  await boardShown(page);
  await expect.poll(() => drawn(page)).toEqual(['brush']);
}

// Epo 2026-11-19 (Q27 b1, as AFFiNE does): an editor's board painted from its
// copy before the join takes edits, under the client id of the copy's token
// (Q236), kept as drafts, and they sync as ordinary edits at the join.
test("a canvas opened offline from this device's copy takes a stroke, which reaches the room and another person once it is back", async ({
  page,
  context,
}) => {
  test.slow();
  await fromCopyOffline(page, context);
  await expect(strip(page)).toContainText("Can't connect to Capy.");
  await keep(page);
  await drawStroke(page, 0.6);
  await expect.poll(() => drawn(page)).toHaveLength(2);

  await context.setOffline(false);
  await expect(status(page)).toHaveAttribute('data-save-state', 'saved');
  await expect(strip(page)).toHaveCount(0);
  // The same board all along.
  expect(await kept(page)).toBe(true);
  await joinPeer(page, SCENARIO);
  await expect
    .poll(() =>
      page.evaluate(
        () => Object.keys((window as Shown).peer?.elements() ?? {}).length
      )
    )
    .toBe(2);
});

// "Reject nothing": a stroke the room refuses for its id (the earlier id held
// for someone else) stays on this device for copying.
test('a stroke drawn on the copy under an id the room no longer gives this tab is kept for copying', async ({
  page,
  context,
}) => {
  test.slow();
  await fromCopyOffline(page, context);
  await drawStroke(page, 0.6);
  await expect.poll(() => drawn(page)).toHaveLength(2);
  await page.evaluate(async (id) => {
    const modulePath = '/src/mocks/canvas.ts';
    const { refuseMockCanvasIds } = (await import(modulePath)) as Canvases;
    refuseMockCanvasIds(id);
  }, SCENARIO);

  await context.setOffline(false);
  await expect(strip(page)).toContainText('Copy anything you need');
  await expect.poll(() => drawn(page)).toHaveLength(2);
  await expect(page.locator('edgeless-pen-tool-button')).toHaveCount(0);
  // Reload, confirmed, opens what the room holds.
  await strip(page).getByRole('button', { name: 'Reload' }).click();
  await page
    .getByRole('dialog', { name: 'Discard these edits and reload?' })
    .getByRole('button', { name: 'Reload' })
    .click();
  await expect(strip(page)).toHaveCount(0);
  await expect.poll(() => drawn(page)).toEqual(['brush']);
});

test("a viewer's copy opened offline takes no edits", async ({
  page,
  context,
}) => {
  test.slow();
  await page.goto(SCENARIO_PAGE);
  await boardShown(page);
  const theirs = await page.evaluate(async () => {
    const modulePath = '/src/mocks/canvas.ts';
    const { mockMemberCanvas } = (await import(modulePath)) as Canvases;
    return mockMemberCanvas({
      creatorName: 'Ben',
      role: 'viewer',
      title: 'Lab diagrams',
      workspaceId: 'ws_scenarios',
    });
  });
  await switchTo(page, 'User scenarios', 'Lab diagrams');
  await expect(page).toHaveURL(new RegExp(`c=${theirs}`));
  await boardShown(page);
  await joinPeer(page, theirs);
  await peerSquares(page);
  await expect.poll(() => drawn(page)).toHaveLength(2);
  await page.getByRole('button', { name: 'Dashboard' }).click();
  await expect.poll(() => copied(page, theirs)).toBe(true);

  await context.setOffline(true);
  await page.goBack();
  await boardShown(page);
  await expect.poll(() => drawn(page)).toHaveLength(2);
  await expect(page.locator('edgeless-pen-tool-button')).toHaveCount(0);
  const before = await page.evaluate(() =>
    (window as Shown).__board?.snapshot()
  );
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Delete');
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => (window as Shown).__board?.snapshot())).toBe(
    before
  );
  await context.setOffline(false);
});

test('a slowed open says why after 5 s, under the loader and, painted from the copy, under the save status; the canvas opens once the budget allows', async ({
  page,
}) => {
  test.slow();
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('slowed-once')) {
      sessionStorage.setItem('slowed-once', 'true');
      sessionStorage.setItem('capy.mock.collaboration.slowed', 'true');
    }
  });
  await page.goto(SCENARIO_PAGE);
  // Nothing on this device yet: the pane's loader says it.
  await expect(
    page.locator('[data-workspace-canvas]').getByText(SLOWED_LINE)
  ).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.capy-board')).toHaveCount(0);
  await slowed(page, false);
  await boardShown(page);
  await drawStroke(page);
  await expect.poll(() => drawn(page)).toEqual(['brush']);
  await expect(status(page)).toHaveAttribute('data-save-state', 'saved');
  await page.getByRole('button', { name: 'Dashboard' }).click();
  await expect.poll(() => copied(page, SCENARIO)).toBe(true);

  // Painted from the copy, the status's tooltip holds the line open.
  await slowed(page, true);
  await page.getByRole('button', { name: 'Canvas' }).click();
  await boardShown(page);
  await expect(
    page
      .locator('[data-slot="tooltip-content"][data-open]')
      .getByText(SLOWED_LINE, { exact: true })
  ).toBeVisible({ timeout: 15_000 });
  await slowed(page, false);
  await expect(status(page)).toHaveAttribute('data-save-state', 'saved');
  await expect(page.getByText(SLOWED_LINE)).toHaveCount(0);
});

test("the picker stops short of the save status and the board's ☰ at 360 and 700 px, whatever the status says", async ({
  page,
}) => {
  test.slow();
  await openCanvas(page);
  const menu = page.locator('.capy-board-menu .capy-menu-button');
  // 8px between each (mock StatusPhone), give or take a pixel.
  const apart = async () => {
    for (const width of [360, 700]) {
      await page.setViewportSize({ height: 740, width });
      await expect(async () => {
        const [pick, shown, button] = await Promise.all([
          picker(page, 'Biology 101').boundingBox(),
          status(page).boundingBox(),
          menu.boundingBox(),
        ]);
        if (!(pick && shown && button)) throw new Error('not shown');
        expect(shown.x - (pick.x + pick.width)).toBeGreaterThanOrEqual(7);
        expect(button.x - (shown.x + shown.width)).toBeGreaterThanOrEqual(7);
      }).toPass();
    }
    await page.setViewportSize({ height: 720, width: 1280 });
  };
  await expect(status(page)).toHaveAttribute('data-save-state', 'saved');
  await apart();
  await storeFails(page, CANVAS, true);
  await drawStroke(page);
  await expect(status(page)).toHaveAttribute('data-save-state', 'syncing');
  await apart();
  await storeFails(page, CANVAS, false);
  // Cut off past the rejoin's 30 s grace: Offline.
  await socket(page, CANVAS, false);
  await expect(status(page)).toHaveAttribute('data-save-state', 'offline', {
    timeout: 45_000,
  });
  await apart();
  await socket(page, CANVAS, true);
});
