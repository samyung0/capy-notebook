import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { expect, type Page, test } from '@playwright/test';
import * as Y from 'yjs';

/**
 * How a board's Yjs state grows while a person works on it, against the size
 * its save stores. The Canvas page's board (the workspace canvas's) is driven
 * with the mouse and keys, as fast as the page takes them but for typing
 * (KEY_MS), and measured three ways after each phase:
 *
 * - `live`: the board's own document as it is (`snapshot()`). It keeps what
 *   was deleted while the tab's undo history can bring it back.
 * - `room`: a second Yjs document that was sent every update as it happened
 *   and has no undo history, which is what a room and every other tab hold.
 * - `cleaned`: what the save stores today (`save()`): the document copied into
 *   a fresh one, places rounded.
 *
 * One test per kind of work, each on a fresh board, then a mixed hour (MIXED).
 * A phase's per-minute figure is its per-action figure at the pace assumed for
 * it below; change the pace and the figure scales. Each record is printed and
 * appended to bench/collaboration/.results/board-growth.jsonl.
 * GROWTH_MINUTES shortens the mixed hour (60 minutes) for a quick run.
 */

/** Pointer moves in a stroke: two thirds of a second at 60 moves a second. */
const STROKE_MOVES = 40;
const LONG_STROKE_MOVES = 120;
const STROKE_LENGTH = 360;
/** A note's sentence, 80 characters, and a shape's word, 12. */
const SENTENCE =
  'Light reactions in the thylakoid make the ATP and NADPH the Calvin cycle needs. ';
const WORD = 'Mitochondria';
/** An edit: this many characters deleted from a note's end, and as many typed. */
const EDIT = 'photosynth';
/**
 * Between keys. A note grows with its text and writes its size after a key
 * unless the next key comes first, and a size written between two characters
 * costs more than itself: 80 characters typed with no gap store about 900
 * bytes, and from 20 ms a key to 150 ms the same 2.2 KB. So keys come apart,
 * as a person's do.
 */
const KEY_MS = 30;
/** Writes that follow an input by a frame or a resize settle before a measure. */
const SETTLE_MS = 400;

/**
 * The mixed hour, per simulated minute: 8 pen strokes with the last undone, a
 * shape dragged twice and resized once, 40 characters typed into a note, and a
 * plane opened for a point and either a line or a moved point. Every other
 * minute starts a new shape with a 12-character label and a new note, every
 * fourth edits its note first, and every tenth deletes its shape and note and
 * starts a new plane. That is about 14 gestures and 45 keys a minute.
 */
const MIXED = {
  minutes: Number(process.env.GROWTH_MINUTES ?? 60),
  strokes: 8,
  typed: 40,
};

type Vec = readonly [number, number];
type Box = { h: number; w: number; x: number; y: number };

type Item = {
  elementBound: Box;
  flavour?: string;
  id: string;
  type?: string;
};
type PlaneMark = { coords?: Vec | Vec[]; id?: string; type: string };
type PlaneCard = Item & {
  elementList: PlaneMark[];
  writeList(marks: PlaneMark[]): void;
  h: number;
  ppu: number;
  w: number;
  x0: number;
  y0: number;
};
/** What the board's root element holds, as far as the bench reads it. */
type Root = HTMLElement & {
  gfx: {
    doc: { captureSync(): void };
    getElementById(id: string): Item | null;
    layer: {
      blocks: Item[];
      // A stroke's points are bytes; `serialize` gives them as drawn.
      canvasElements: (Item & { serialize(): { points?: unknown[] } })[];
    };
    tool: { currentToolName$: { value: string } };
    viewport: {
      setCenter(x: number, y: number): void;
      toViewCoord(x: number, y: number): [number, number];
      zoom: number;
    };
  };
  std: {
    store: {
      spaceDoc: {
        on(name: 'update', listener: (update: Uint8Array) => void): void;
      };
    };
  };
};

declare global {
  interface Window {
    __board?: {
      save(options?: { finish?: boolean }): { bytes: number; doc: string };
      snapshot(): string;
      stats(): { marks: number };
    };
    /** The board's updates since the last measure. */
    __growthUpdates: Uint8Array[];
  }
}

type Sizes = {
  cleaned: number;
  cleanedGzip: number;
  live: number;
  liveGzip: number;
  room: number;
  roomGzip: number;
  /** Updates the board has emitted since it opened, and their bytes. */
  updateBytes: number;
  updates: number;
};

type Board = {
  /** A point on the page, from the board's top left corner. */
  at(x: number, y: number): Vec;
  page: Page;
  room: Y.Doc;
  updateBytes: number;
  updates: number;
};

const resultsDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '.results'
);

async function record(entry: object) {
  console.log(JSON.stringify(entry));
  await mkdir(resultsDir, { recursive: true });
  await appendFile(
    path.join(resultsDir, 'board-growth.jsonl'),
    `${JSON.stringify(entry)}\n`
  );
}

const rootOf = (page: Page) => page.locator('affine-edgeless-root');

/** A fresh canvas on the Canvas page, its updates kept for the room copy. */
async function openBoard(page: Page): Promise<Board> {
  await page.goto('/canvas');
  await page.waitForFunction(() => window.__board, null, { timeout: 300_000 });
  // The dev scenario panel sits over the toolbar's right end.
  await page.addStyleTag({
    content: '[data-testid="mock-scenario-panel"] { display: none; }',
  });
  // Places below are in pixels, so the board is read at 100%.
  await expect
    .poll(() => rootOf(page).evaluate((root: Root) => root.gfx.viewport.zoom))
    .toBe(1);
  const start = await rootOf(page).evaluate((root: Root) => {
    window.__growthUpdates = [];
    root.std.store.spaceDoc.on('update', (update) =>
      window.__growthUpdates.push(update)
    );
    return window.__board?.snapshot() ?? '';
  });
  const room = new Y.Doc();
  Y.applyUpdate(room, Buffer.from(start, 'base64'));
  const box = await page.locator('.capy-board').boundingBox();
  if (!box) throw new Error('no board');
  return {
    at: (x, y) => [box.x + x, box.y + y],
    page,
    room,
    updateBytes: 0,
    updates: 0,
  };
}

async function measure(board: Board): Promise<Sizes> {
  await board.page.waitForTimeout(SETTLE_MS);
  const read = await board.page.evaluate(() => {
    const base64 = (bytes: Uint8Array) => {
      let text = '';
      for (let i = 0; i < bytes.length; i += 32_768)
        text += String.fromCharCode(...bytes.subarray(i, i + 32_768));
      return btoa(text);
    };
    const handle = window.__board;
    if (!handle) throw new Error('no board');
    return {
      cleaned: handle.save({ finish: false }).doc,
      live: handle.snapshot(),
      updates: window.__growthUpdates.splice(0).map(base64),
    };
  });
  for (const update of read.updates) {
    const bytes = Buffer.from(update, 'base64');
    board.updates += 1;
    board.updateBytes += bytes.byteLength;
    Y.applyUpdate(board.room, bytes);
  }
  const live = Buffer.from(read.live, 'base64');
  const cleaned = Buffer.from(read.cleaned, 'base64');
  const room = Y.encodeStateAsUpdate(board.room);
  // The copy holds every change the board does.
  expect(Y.decodeStateVector(Y.encodeStateVector(board.room))).toEqual(
    Y.decodeStateVector(Y.encodeStateVectorFromUpdate(live))
  );
  return {
    cleaned: cleaned.byteLength,
    cleanedGzip: gzipSync(cleaned).byteLength,
    live: live.byteLength,
    liveGzip: gzipSync(live).byteLength,
    room: room.byteLength,
    roomGzip: gzipSync(room).byteLength,
    updateBytes: board.updateBytes,
    updates: board.updates,
  };
}

const KINDS = ['live', 'room', 'cleaned'] as const;

/**
 * One kind of action, `actions` times, measured before, half way and after:
 * its bytes per action, and per minute at `perMinute` actions a minute. The
 * two halves' figures show whether growth stays even.
 */
async function phase(
  board: Board,
  scenario: string,
  perMinute: number,
  actions: number,
  act: (index: number) => Promise<void>
) {
  const start = await measure(board);
  let mid = start;
  for (let i = 0; i < actions; i++) {
    if (i === actions / 2) mid = await measure(board);
    await act(i);
  }
  const end = await measure(board);
  // Every action reached the document.
  expect(end.updates - start.updates).toBeGreaterThanOrEqual(actions);
  const each = (from: Sizes, to: Sizes, count: number) =>
    Object.fromEntries(
      KINDS.map((kind) => [kind, Math.round((to[kind] - from[kind]) / count)])
    );
  const perAction = each(start, end, actions);
  await record({
    actions,
    assumedPerMinute: perMinute,
    end,
    perAction: {
      ...perAction,
      updateBytes: Math.round((end.updateBytes - start.updateBytes) / actions),
      updates: (end.updates - start.updates) / actions,
    },
    perActionByHalf: [
      each(start, mid, actions / 2),
      each(mid, end, actions / 2),
    ],
    perMinute: Object.fromEntries(
      KINDS.map((kind) => [kind, Math.round(perAction[kind] * perMinute)])
    ),
    scenario,
    start,
  });
}

/** Moves the view, which is not part of the document: its middle to a place on
 * the board, so each part of a run has clear canvas. */
const pan = (page: Page, x: number, y: number) =>
  rootOf(page).evaluate(
    (root: Root, [x, y]) => root.gfx.viewport.setCenter(x, y),
    [x, y]
  );

/** The newest card or block of a kind (an element's type, a block's flavour). */
async function newest(page: Page, kind: string) {
  const id = await rootOf(page).evaluate(
    ({ gfx }: Root, kind) =>
      [...gfx.layer.canvasElements, ...gfx.layer.blocks]
        .filter((item) => (item.type ?? item.flavour) === kind)
        .at(-1)?.id,
    kind
  );
  if (!id) throw new Error(`no ${kind} on the board`);
  return id;
}

/** Where a card or block is on the page. */
const boxOf = (page: Page, id: string) =>
  rootOf(page).evaluate((root: Root, id) => {
    const item = root.gfx.getElementById(id);
    if (!item) throw new Error(`no ${id} on the board`);
    const { h, w, x, y } = item.elementBound;
    const rect = root.getBoundingClientRect();
    const [left, top] = root.gfx.viewport.toViewCoord(x, y);
    return { h, w, x: rect.x + left, y: rect.y + top };
  }, id);

const middle = ({ h, w, x, y }: Box): Vec => [x + w / 2, y + h / 2];

const TOOL_BUTTONS = {
  brush: 'edgeless-pen-tool-button',
  default: 'edgeless-default-tool-button',
  eraser: 'edgeless-eraser-tool-button',
};

/** Picks a toolbar tool, unless it is the one in hand already. */
async function useTool(page: Page, tool: keyof typeof TOOL_BUTTONS) {
  const current = await rootOf(page).evaluate(
    (root: Root) => root.gfx.tool.currentToolName$.value
  );
  if (current !== tool) await page.locator(TOOL_BUTTONS[tool]).first().click();
}

/** A press, `moves` pointer moves along a straight path, and a release. */
async function drag(page: Page, from: Vec, by: Vec, moves: number) {
  await page.mouse.move(...from);
  await page.mouse.down();
  for (let i = 1; i <= moves; i++)
    await page.mouse.move(
      from[0] + (by[0] * i) / moves,
      from[1] + (by[1] * i) / moves
    );
  await page.mouse.up();
}

/** A wavy pen stroke to the right of `from`, one point per move. */
async function stroke(page: Page, from: Vec, moves: number) {
  await useTool(page, 'brush');
  await page.mouse.move(...from);
  await page.mouse.down();
  for (let i = 1; i <= moves; i++)
    await page.mouse.move(
      from[0] + (STROKE_LENGTH * i) / moves,
      from[1] + Math.sin((i * STROKE_MOVES) / moves / 4) * 12
    );
  await page.mouse.up();
}

/** The eraser across a stroke drawn from `from`. */
async function erase(page: Page, from: Vec) {
  await useTool(page, 'eraser');
  await drag(page, [from[0] + STROKE_LENGTH / 2, from[1] - 40], [0, 80], 8);
}

const type = (page: Page, text: string) =>
  page.keyboard.type(text, { delay: KEY_MS });

/** A square from the shapes panel, placed by a click at its middle. */
async function placeShape(page: Page, at: Vec) {
  await page.locator('capy-shape-button').first().click();
  await page.getByRole('button', { exact: true, name: 'Square' }).click();
  await page.mouse.click(...at);
  return newest(page, 'shape');
}

/** Types a shape's label: a double click opens it, Escape leaves, and Escape
 * again drops the selection, whose handles would take the next click nearby. */
async function labelShape(page: Page, id: string, text: string) {
  await page.mouse.dblclick(...middle(await boxOf(page, id)));
  // The editor's own element has no size, so it never counts as visible.
  const editor = page.locator('edgeless-shape-text-editor');
  await editor.waitFor({ state: 'attached' });
  await type(page, text);
  await page.keyboard.press('Escape');
  await expect(editor).toHaveCount(0);
  await page.keyboard.press('Escape');
}

/** The Delete key takes what is selected: `id`, after a click at `at` when it
 * isn't yet (a shape just placed is). A shape with no label is hollow, and a
 * click in it selects nothing. */
async function remove(page: Page, id: string, at?: Vec) {
  if (at) {
    await useTool(page, 'default');
    await page.mouse.click(...at);
  }
  await page.keyboard.press('Delete');
  await expect
    .poll(() =>
      rootOf(page).evaluate(
        (root: Root, id) => !root.gfx.getElementById(id),
        id
      )
    )
    .toBe(true);
}

/** A point on a note's first line of text. */
async function onNote(page: Page, id: string): Promise<Vec> {
  const { h, x, y } = await boxOf(page, id);
  return [x + 20, y + h / 2];
}

const typingInNote = (page: Page) =>
  page.waitForFunction(
    () => document.activeElement?.closest('affine-edgeless-note') != null,
    null,
    { timeout: 30_000 }
  );

/** A note is left by a click on clear canvas: on two spots in turn, lest two
 * leaves in a row be read as the double click that places a note. */
let leaves = 0;
async function leaveNote(board: Board) {
  leaves += 1;
  await board.page.mouse.click(...board.at(960, leaves % 2 ? 90 : 140));
}

/** A double click on clear canvas places a note and types in it. */
async function writeNote(board: Board, at: Vec, text: string) {
  await useTool(board.page, 'default');
  await board.page.mouse.dblclick(...at);
  await typingInNote(board.page);
  await type(board.page, text);
  const id = await newest(board.page, 'affine:note');
  await leaveNote(board);
  return id;
}

/** Back into a note with the caret at its end, for `edit`, then out. */
async function editNote(board: Board, id: string, edit: () => Promise<void>) {
  const { page } = board;
  await useTool(page, 'default');
  await page.mouse.dblclick(...(await onNote(page, id)));
  await typingInNote(page);
  // Select all then right: the end of the text on every platform.
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('ArrowRight');
  await edit();
  await leaveNote(board);
}

async function retype(page: Page, text: string) {
  for (let i = 0; i < text.length; i++)
    await page.keyboard.press('Backspace', { delay: KEY_MS });
  await type(page, text);
}

/** A coordinate plane card from the Graphs slot, its middle at `at`. */
async function placePlane(page: Page, at: Vec) {
  await useTool(page, 'default');
  await page
    .locator('capy-graph-slot .piece[data-kind="cart"]')
    .first()
    .click();
  await page.mouse.move(...at, { steps: 4 });
  await page.mouse.click(...at);
  return newest(page, 'plane');
}

/** Opens a plane's editor with its objects list shut, which covers the plane's
 * left. Returns a point on the plane, from 0 to 1 across the screen: the card
 * shows the middle of it, 480 by 320. */
async function openPlane(page: Page, id: string) {
  // A card can grow with its marks, so its middle is brought into view.
  await rootOf(page).evaluate((root: Root, id) => {
    const card = root.gfx.getElementById(id);
    if (!card) throw new Error(`no ${id} on the board`);
    const { h, w, x, y } = card.elementBound;
    root.gfx.viewport.setCenter(x + w / 2, y + h / 2);
  }, id);
  await page.mouse.dblclick(...middle(await boxOf(page, id)));
  const editor = page.locator('.capy-graph-editor');
  await editor.waitFor();
  const list = editor.getByRole('button', { name: 'Objects' });
  if ((await list.getAttribute('aria-pressed')) === 'true') await list.click();
  const box = await editor.boundingBox();
  if (!box) throw new Error('no plane editor');
  return (x: number, y: number): Vec => [
    box.x + x * box.width,
    box.y + y * box.height,
  ];
}

async function closePlane(page: Page) {
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(page.locator('.capy-graph-editor')).toHaveCount(0);
}

const planeTool = (page: Page, name: string) =>
  page.getByRole('button', { exact: true, name }).click();

/** An open plane's points on the page, in the order they were plotted: the
 * editor opens at the card's scale with the card's middle in its own. */
const planePoints = (page: Page, id: string) =>
  rootOf(page).evaluate((root: Root, id) => {
    const card = root.gfx.getElementById(id) as PlaneCard;
    const editor = document.querySelector('.capy-graph-editor');
    if (!editor) throw new Error('no plane editor');
    const box = editor.getBoundingClientRect();
    const centre = [
      card.x0 + card.w / 2 / card.ppu,
      card.y0 - card.h / 2 / card.ppu,
    ];
    return card.elementList
      .filter((mark) => mark.type === 'point')
      .map(({ coords }): [number, number] => {
        const [x, y] = coords as Vec;
        return [
          box.x + box.width / 2 + (x - centre[0]) * card.ppu,
          box.y + box.height / 2 + (centre[1] - y) * card.ppu,
        ];
      });
  }, id);

test('pen strokes', async ({ page }) => {
  const board = await openBoard(page);
  const { at } = board;
  await phase(board, 'pen stroke, 40 points', 30, 100, (i) =>
    stroke(page, at(60 + (i % 2) * 30, 80 + (i % 25) * 22), STROKE_MOVES)
  );
  await phase(board, 'pen stroke, 120 points', 30, 20, (i) =>
    stroke(page, at(520, 80 + i * 27), LONG_STROKE_MOVES)
  );
  const points = await rootOf(page).evaluate((root: Root) =>
    root.gfx.layer.canvasElements.map(
      (stroke) => stroke.serialize().points?.length
    )
  );
  expect(points).toHaveLength(120);
  await record({
    first: points[0],
    last: points[119],
    scenario: 'pen stroke points',
  });
});

test('moving and resizing', async ({ page }) => {
  const board = await openBoard(page);
  // Labelled, so a press in a shape's middle takes hold of it.
  const shapes: string[] = [];
  for (let i = 0; i < 6; i++) {
    const at = board.at(150 + (i % 3) * 300, 180 + Math.floor(i / 3) * 250);
    shapes.push(await placeShape(page, at));
    await labelShape(page, shapes[i], WORD);
  }
  // Each shape there and back in turn; the second half with four times the
  // pointer moves, to see whether a drag's length in moves is written.
  const moves = (i: number) => (i < 30 ? 10 : 40);
  const turn = (i: number) => (Math.floor(i / 6) % 2 ? -1 : 1);
  await phase(board, 'shape dragged', 12, 60, async (i) => {
    const from = middle(await boxOf(page, shapes[i % 6]));
    await drag(page, from, [90 * turn(i), 50 * turn(i)], moves(i));
  });
  await phase(board, 'shape resized', 6, 60, async (i) => {
    const box = await boxOf(page, shapes[i % 6]);
    await page.mouse.click(...middle(box));
    // Its bottom right corner, out and back in.
    await drag(
      page,
      [box.x + box.w, box.y + box.h],
      [40 * turn(i), 40 * turn(i)],
      moves(i)
    );
  });
});

test('plane edits', async ({ page }) => {
  const board = await openBoard(page);
  const plane = await placePlane(page, board.at(500, 330));
  const on = await openPlane(page, plane);
  await planeTool(page, 'Point');
  await phase(board, 'plane point plotted', 10, 60, (i) =>
    page.mouse.click(
      ...on(0.1 + (i % 10) * 0.085, 0.14 + Math.floor(i / 10) * 0.11)
    )
  );
  expect(await page.evaluate(() => window.__board?.stats().marks)).toBe(60);
  await phase(board, 'plane line through two points', 6, 20, async (i) => {
    await planeTool(page, 'Line through two points');
    // Short of the toolbar, whose tooltips take a click just above it.
    await page.mouse.click(...on(0.12 + i * 0.04, 0.74));
    await page.mouse.click(...on(0.14 + i * 0.04, 0.84));
  });
  expect(await page.evaluate(() => window.__board?.stats().marks)).toBe(80);
  await planeTool(page, 'Select');
  const points = await planePoints(page, plane);
  await phase(board, 'plane point moved', 10, 40, (i) =>
    drag(page, points[i], [26, -22], i < 20 ? 10 : 40)
  );
  await closePlane(page);
});

// The figure in `save()`'s comment (606 KB live, 7.5 KB saved) came from this:
// one point written 200 times through the plane's own call, a step of undo
// each, before planes kept one entry per element
// (e2e/editor/drawing-board.spec.ts, 'a saved board leaves its undo history out').
test('one plane point written 200 times', async ({ page }) => {
  const board = await openBoard(page);
  const plane = await placePlane(page, board.at(500, 330));
  await phase(board, 'plane point written, by the old measure', 10, 200, (i) =>
    rootOf(page).evaluate(
      ({ gfx }: Root, [id, i]) => {
        gfx.doc.captureSync();
        (gfx.getElementById(id) as PlaneCard).writeList([
          { coords: [(i + 1) / 20, (i + 1) / 40], id: 'm', type: 'point' },
        ]);
      },
      [plane, i] as const
    )
  );
});

test('notes', async ({ page }) => {
  const board = await openBoard(page);
  const notes: string[] = [];
  await phase(board, 'note typed, 80 characters', 2.5, 20, async (i) => {
    notes.push(await writeNote(board, board.at(80, 80 + i * 28), SENTENCE));
  });
  await phase(
    board,
    'note edited, 10 characters deleted and 10 typed',
    6,
    20,
    (i) => editNote(board, notes[i], () => retype(page, EDIT))
  );
  await phase(board, 'note deleted', 6, 20, async (i) =>
    remove(page, notes[i], await onNote(page, notes[i]))
  );
});

test('shapes with text', async ({ page }) => {
  const board = await openBoard(page);
  await phase(
    board,
    'shape placed and labelled, 12 characters',
    5,
    30,
    async (i) => {
      const at = board.at(80 + (i % 8) * 120, 110 + Math.floor(i / 8) * 110);
      await labelShape(page, await placeShape(page, at), WORD);
    }
  );
});

test('adding then deleting', async ({ page }) => {
  const board = await openBoard(page);
  const { at } = board;
  await phase(board, 'stroke drawn, then erased', 15, 30, async () => {
    await stroke(page, at(100, 200), STROKE_MOVES);
    await erase(page, at(100, 200));
  });
  await phase(board, 'stroke drawn, then undone', 15, 30, async () => {
    await stroke(page, at(100, 200), STROKE_MOVES);
    await page.keyboard.press('ControlOrMeta+z');
  });
  await phase(board, 'shape placed, then deleted', 10, 30, async () =>
    remove(page, await placeShape(page, at(300, 400)))
  );
  await phase(
    board,
    'note typed (80 characters), then deleted',
    2,
    10,
    async () => {
      const note = await writeNote(board, at(80, 300), SENTENCE);
      await remove(page, note, await onNote(page, note));
    }
  );
  const left = await rootOf(page).evaluate(
    ({ gfx }: Root) => gfx.layer.canvasElements.length + gfx.layer.blocks.length
  );
  expect(left).toBe(0);
});

test('a mixed hour', async ({ page }) => {
  const board = await openBoard(page);
  const { at } = board;
  const start = await measure(board);
  let shape = '';
  let note = '';
  let plane = '';
  for (let minute = 0; minute < MIXED.minutes; minute++) {
    // Two minutes on each stretch of clear canvas.
    const pair = Math.floor(minute / 2);
    const second = minute % 2 === 1;
    const sign = second ? -1 : 1;
    await pan(
      page,
      10_000 + (pair % 6) * 2500,
      10_000 + Math.floor(pair / 6) * 2000
    );
    if (!second) {
      shape = await placeShape(page, at(700, 200));
      await labelShape(page, shape, WORD);
    }
    for (let s = 0; s < MIXED.strokes; s++)
      await stroke(page, at(50, 80 + s * 28 + (second ? 14 : 0)), STROKE_MOVES);
    await page.keyboard.press('ControlOrMeta+z');

    await useTool(page, 'default');
    for (const turn of [1, -1])
      await drag(
        page,
        middle(await boxOf(page, shape)),
        [90 * turn, 50 * turn],
        10
      );
    const box = await boxOf(page, shape);
    await page.mouse.click(...middle(box));
    await drag(
      page,
      [box.x + box.w, box.y + box.h],
      [30 * sign, 30 * sign],
      10
    );

    const text = SENTENCE.slice(0, MIXED.typed);
    if (second)
      await editNote(board, note, async () => {
        if (pair % 2) await retype(page, EDIT);
        await type(page, text);
      });
    else note = await writeNote(board, at(60, 420), text);
    if (minute % 10 === 9) {
      await remove(page, shape, middle(await boxOf(page, shape)));
      await remove(page, note, await onNote(page, note));
    }

    // The plane of these ten minutes, on its own stretch of canvas; its marks
    // within what the card shows.
    const slot = minute % 10;
    if (slot === 0) {
      await pan(page, 10_000 + Math.floor(minute / 10) * 2500, 5000);
      plane = await placePlane(page, at(500, 330));
    }
    const on = await openPlane(page, plane);
    await planeTool(page, 'Point');
    await page.mouse.click(...on(0.3 + slot * 0.04, 0.4));
    if (second) {
      await planeTool(page, 'Select');
      const points = await planePoints(page, plane);
      await drag(page, points[points.length - 1], [12, -10], 10);
    } else {
      await planeTool(page, 'Line through two points');
      await page.mouse.click(...on(0.3 + slot * 0.04, 0.5));
      await page.mouse.click(...on(0.32 + slot * 0.04, 0.65));
    }
    await closePlane(page);

    if (minute % 5 === 4) {
      const held = await rootOf(page).evaluate(({ gfx }: Root) => {
        const on: Record<string, number> = {};
        for (const item of [...gfx.layer.canvasElements, ...gfx.layer.blocks]) {
          const kind = item.type ?? item.flavour ?? '';
          on[kind] = (on[kind] ?? 0) + 1;
        }
        // 41 a stroke, unless a busy machine merged pointer moves.
        const strokePoints = gfx.layer.canvasElements.reduce(
          (sum, item) => sum + (item.serialize().points?.length ?? 0),
          0
        );
        return { on, strokePoints };
      });
      await record({
        minute: minute + 1,
        scenario: 'mixed hour',
        ...(await measure(board)),
        marks: await page.evaluate(() => window.__board?.stats().marks),
        ...held,
      });
    }
  }
  const end = await measure(board);
  await record({
    scenario: 'mixed hour, per minute',
    ...Object.fromEntries(
      KINDS.map((kind) => [
        kind,
        Math.round((end[kind] - start[kind]) / MIXED.minutes),
      ])
    ),
    updateBytes: Math.round(
      (end.updateBytes - start.updateBytes) / MIXED.minutes
    ),
    updates: (end.updates - start.updates) / MIXED.minutes,
  });
});
