import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { cpus, loadavg } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { type Browser, expect, type Page, test } from '@playwright/test';
import * as Y from 'yjs';
import { BOARD_CATALOG } from '../../../src/api/board.generated';
import { encodeStrokePoints } from '../../../src/features/blocksuite/strokePoints';
import { cdpSession, percentile, throttleCpu } from './metrics';

/**
 * How long a canvas takes to open when its room's state is at half its size
 * cap and at the cap (4 MiB, Epo 2026-11-18). Report only.
 *
 * The board is one in the mix of the growth bench's mixed hour
 * (bench/collaboration/scripts/board-growth.growth.ts): per simulated minute
 * seven pen strokes of 41 points and an eighth drawn and removed, 40
 * characters typed into a note, a shape moved twice and resized once; every
 * other minute a new shape with a 12-character label and a new note; every
 * fourth minute ten characters of the note retyped; every tenth minute that
 * shape and note deleted. Planes are left out; `calibrate` puts a minute of
 * this mix against the mixed hour's minute with them.
 *
 * `calibrate` writes ten minutes of it on the Canvas page, through the board's
 * own API and the mock collaboration room, one transaction per stroke, key and
 * move, and reports what a stroke, a typed note and a labelled shape cost
 * against the growth bench's figures from real input. `fill` then writes the
 * same mix into a Yjs document in the runner, from copies of what the board
 * wrote, and keeps the state when it nears 2 MiB and again when it nears the
 * cap (see the note above `mixWriter`).
 *
 * `open` then opens a blank canvas and each kept state OPENS times, each in a
 * fresh browser context: through the room (the Canvas page, the state fed to
 * the mock room as its stored state) and with no room (the board's own page,
 * the state as a saved board). It records the first frame holding every
 * element, the end of the last long frame before 3 s with none (the board
 * has settled), the JS heap after a forced GC, and, on the settled board,
 * wheel pans, a pen stroke and one write under a sampling profile (`writes`).
 * A room's open also fails the run if the board wrote anything as it opened.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RESULTS = path.join(HERE, '..', '.results', 'board-cap');
const CAP = BOARD_CATALOG.limits.CANVAS_BOARD_MAX;
const MIB = 1024 * 1024;
/** The sizes kept, in bytes of the room's state; each lands within MARGIN under. */
const TARGETS = [2 * MIB, CAP];
const MARGIN = 20 * 1024;
/** Cold opens per board and path; the median is the figure. */
const OPENS = Number(process.env.PERF_CAP_OPENS ?? 3);
const OPENS_NULL = Array.from({ length: OPENS }, () => null);
const WHEELS = 20;
const WHEEL_CADENCE_MS = 100;
const PEN_MOVES = 40;
const PEN_CADENCE_MS = 32;
/** The mock room keeps a board under this key (src/mocks/collaboration.ts). */
const KEPT_KEY = 'capy.mock.board.';

type Counts = { brush: number; notes: number; shape: number };
type Kept = {
  bytes: number;
  characters: number;
  counts: Counts;
  minutes: number;
  /** The mock room's stored state: `{ state: base64, version }`. */
  stored: string;
};

declare global {
  interface Window {
    __capGen?: {
      /** One action of a kind, off the mix's patches, for `calibrate`. */
      probe(kind: 'note' | 'shape' | 'stroke', index: number): void;
      run(from: number, to: number): GenTotals;
    };
    __capInputs?: { at: number[]; presents: number[] };
    __capKept: Map<string, string>;
    __capOpen?: {
      loafs: {
        blocking: number;
        duration: number;
        end: number;
        /** Each script of the frame: its file and its time. */
        scripts: { file: string; ms: number }[];
      }[];
      painted?: number;
      read?: number;
    };
  }
}

type GenTotals = Counts & { characters: number };

type Model = { id: string };
type TextModel = Model & {
  props: {
    text: {
      delete(index: number, length: number): void;
      insert(text: string, index: number): void;
      length: number;
      yText: { constructor: new (text?: string) => YText };
    };
  };
};
type YText = { insert(index: number, text: string): void };
/** What the board's root element holds, as far as the bench uses it. */
type Root = HTMLElement & {
  gfx: {
    getElementById(id: string): (Model & { text?: YText }) | null;
    layer: {
      blocks: { flavour: string }[];
      canvasElements: { id: string; type: string; xywh: string }[];
    };
    surface: {
      addElement(props: object): string;
      deleteElement(id: string): void;
    };
    updateElement(element: Model, props: object): void;
    viewport: { zoom: number };
  };
  std: {
    store: {
      addBlock(flavour: string, props: object, parent: string): string;
      deleteBlock(model: Model): void;
      getBlock(id: string): { model: Model } | null;
      resetHistory(): void;
      root: { id: string };
      transact(fn: () => void): void;
      updateBlock(model: Model, props: object): void;
    };
  };
};

/** The mock room's stored boards in memory instead of sessionStorage, whose
 * quota (about 5.2 million characters) is under a 4 MiB state in base64; and
 * `seed` as the stored state of every board room this page opens. */
async function holdKept(page: Page, seed: string | null) {
  await page.addInitScript(
    ({ key, seed }) => {
      const kept = new Map<string, string>();
      window.__capKept = kept;
      const { getItem, removeItem, setItem } = Storage.prototype;
      Storage.prototype.getItem = function (name: string) {
        if (!name.startsWith(key)) return getItem.call(this, name);
        // The mock room reads its state as it starts the join.
        if (window.__capOpen) window.__capOpen.read ??= performance.now();
        return kept.get(name) ?? seed;
      };
      Storage.prototype.setItem = function (name: string, value: string) {
        if (name.startsWith(key)) kept.set(name, value);
        else setItem.call(this, name, value);
      };
      Storage.prototype.removeItem = function (name: string) {
        if (name.startsWith(key)) kept.delete(name);
        else removeItem.call(this, name);
      };
    },
    { key: KEPT_KEY, seed }
  );
}

const boardReady = (page: Page) =>
  page.waitForFunction(
    () =>
      !!(document.querySelector('affine-edgeless-root') as Root | null)?.gfx
        ?.surface,
    null,
    { timeout: 180_000 }
  );

/** The mock room's stored state of the page's one canvas, once it holds what
 * the board wrote (the room stores 300 ms after its last update). */
async function keptState(page: Page) {
  await page.waitForTimeout(700);
  const stored = await page.evaluate(
    () => [...window.__capKept.values()][0] ?? null
  );
  if (!stored) throw new Error('the mock room stored nothing');
  const { state } = JSON.parse(stored) as { state: string };
  return { bytes: Buffer.from(state, 'base64').byteLength, stored };
}

/** Installs the writer of the mix on the page: `run(from, to)` writes those
 * simulated minutes and answers what the board holds of each kind since. */
async function installWriter(page: Page) {
  await page.evaluate(() => {
    const root = document.querySelector('affine-edgeless-root') as Root;
    const { gfx, std } = root;
    const { store } = std;
    const SENTENCE =
      'Light reactions in the thylakoid make the ATP and NADPH the Calvin cycle needs. ';
    const WORD = 'Mitochondria';
    const EDIT = 'photosynth';
    // A fixed sequence, so every run draws the same board.
    let seed = 11;
    const random = () => {
      seed = (seed * 16_807) % 2_147_483_647;
      return seed / 2_147_483_647;
    };
    const totals = { brush: 0, characters: 0, notes: 0, shape: 0 };
    type Note = { box: number[]; id: string; paragraph: string; typed: number };
    let note: Note | null = null;
    let shape: { box: number[]; id: string } | null = null;

    /** A wavy pen stroke of 41 points, about 360 long, as the growth bench
     * draws one. Places are eighths of a pixel, which store in the bytes a
     * mouse's stroke was measured to take (`calibrate`). */
    const stroke = (x: number, y: number) => {
      const eighth = (value: number) => Math.round(value * 8) / 8;
      const points: number[][] = [];
      for (let i = 0; i <= 40; i++)
        points.push([eighth(x + 9.3 * i), eighth(y + Math.sin(i / 4) * 12)]);
      return gfx.surface.addElement({
        color: '#1f2937',
        lineWidth: 4,
        points,
        type: 'brush',
      });
    };
    const textOf = (id: string) =>
      (store.getBlock(id)?.model as TextModel).props.text;
    /** A key: the character, then the note's new size, each its own write. */
    const key = (target: Note, edit: () => void) => {
      edit();
      const model = store.getBlock(target.id)?.model;
      if (!model) throw new Error('no note');
      target.typed += 1;
      const [x, y, w] = target.box;
      store.updateBlock(model, {
        xywh: `[${x},${y},${w},${92 + (target.typed % 9) * 11.5}]`,
      });
    };
    const type = (target: Note, text: string) => {
      for (const character of text)
        key(target, () => {
          const at = textOf(target.paragraph);
          at.insert(character, at.length);
        });
      totals.characters += text.length;
    };
    /** An empty note, as a double click on the canvas leaves one. */
    const newNote = (x: number, y: number): Note => {
      const box = [x, y, 260, 92];
      const id = store.addBlock(
        'affine:note',
        { xywh: `[${box.join(',')}]` },
        store.root.id
      );
      const paragraph = store.addBlock('affine:paragraph', {}, id);
      totals.notes += 1;
      return { box, id, paragraph, typed: 0 };
    };
    /** A shape with its 12-character label typed a key at a time. A label is
     * a Y.Text, whose class is read off a note's text. */
    const newShape = (x: number, y: number, shapeType: string) => {
      if (!note) throw new Error('a shape before the first note');
      const { constructor: Text } = textOf(note.paragraph).yText;
      const box = [x, y, 120, 80];
      const id = gfx.surface.addElement({
        shapeType,
        text: new Text(),
        type: 'shape',
        xywh: `[${box.join(',')}]`,
      });
      totals.shape += 1;
      const label = gfx.getElementById(id)?.text;
      if (!label) throw new Error('a shape without its label');
      for (let i = 0; i < WORD.length; i++)
        store.transact(() => label.insert(i, WORD[i]));
      return { box, id };
    };
    const place = (id: string, box: number[]) => {
      const element = gfx.getElementById(id);
      if (!element) throw new Error('no shape');
      gfx.updateElement(element, { xywh: `[${box.join(',')}]` });
    };

    const minute = (index: number) => {
      // Each minute has a patch of clear canvas, 24 patches to a row.
      const x0 = (index % 24) * 640;
      const y0 = Math.floor(index / 24) * 520;
      if (index % 10 === 0 && index > 0) {
        if (shape) {
          gfx.surface.deleteElement(shape.id);
          totals.shape -= 1;
        }
        const model = note && store.getBlock(note.id)?.model;
        if (model && note) {
          totals.characters -= textOf(note.paragraph).length;
          store.deleteBlock(model);
          totals.notes -= 1;
        }
        shape = null;
        note = null;
      }
      if (index % 2 === 0) {
        note = newNote(x0 + 380, y0 + 300);
        shape = newShape(x0 + 40, y0 + 300, index % 4 ? 'ellipse' : 'rect');
      }
      for (let i = 0; i < 7; i++) {
        stroke(x0 + 20 + random() * 200, y0 + 30 + i * 34);
        totals.brush += 1;
      }
      gfx.surface.deleteElement(stroke(x0 + 20, y0 + 270));
      if (shape) {
        const [x, y, w, h] = shape.box;
        place(shape.id, [x + 30, y, w, h]);
        place(shape.id, [x + 30, y + 20, w, h]);
        shape.box = [x + 30, y + 20, w + 10, h + 10];
        place(shape.id, shape.box);
      }
      if (note) {
        const target = note;
        if (index % 4 === 3 && textOf(target.paragraph).length >= EDIT.length) {
          for (let i = 0; i < EDIT.length; i++)
            key(target, () => {
              const at = textOf(target.paragraph);
              at.delete(at.length - 1, 1);
            });
          type(target, EDIT);
          totals.characters -= EDIT.length;
        }
        type(target, SENTENCE.slice(0, 40));
      }
    };
    window.__capGen = {
      probe(kind, index) {
        const x = 40_000 + (index % 10) * 420;
        const y = Math.floor(index / 10) * 200;
        if (kind === 'stroke') stroke(x, y);
        else if (kind === 'shape') newShape(x, y, 'rect');
        else type(newNote(x, y), SENTENCE);
      },
      run(from, to) {
        for (let index = from; index < to; index++) {
          minute(index);
          // This tab's undo history would otherwise hold all of it as one
          // step that every write merges into, each slower than the last.
          store.resetHistory();
        }
        return { ...totals };
      },
    };
  });
}

const holds = (page: Page) =>
  page.evaluate(() => {
    const { layer } = (document.querySelector('affine-edgeless-root') as Root)
      .gfx;
    return {
      brush: layer.canvasElements.filter((item) => item.type === 'brush')
        .length,
      notes: layer.blocks.filter((item) => item.flavour === 'affine:note')
        .length,
      shape: layer.canvasElements.filter((item) => item.type === 'shape')
        .length,
    };
  });

/** A fresh canvas on the Canvas page, its room's stored state held in memory. */
async function freshCanvas(browser: Browser) {
  const context = await browser.newContext({
    viewport: { height: 800, width: 1280 },
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await holdKept(page, null);
  await page.goto('/canvas');
  await boardReady(page);
  await installWriter(page);
  return { context, errors, page };
}

const run = (page: Page, from: number, to: number) =>
  page.evaluate(([from, to]) => window.__capGen?.run(from, to), [from, to]);

const file = (name: string) => path.join(RESULTS, name);
const keptFile = (target: number) => file(`state-${target}.json`);

async function save(name: string, value: unknown) {
  await mkdir(RESULTS, { recursive: true });
  await writeFile(file(name), JSON.stringify(value, null, 2));
}

test.describe.configure({ mode: 'serial' });

/** What the growth bench measured from real input, in bytes of a room's
 * state (bench/collaboration/reports/2026-11-18-board-live-growth.md). */
const MEASURED = { minuteOfMix: 6583, note: 2229, shape: 773, stroke: 708 };

test('calibrate: what the written mix costs per action', async ({
  browser,
}) => {
  const { context, errors, page } = await freshCanvas(browser);
  let { bytes } = await keptState(page).catch(() => ({ bytes: 237 }));
  const grew = async () => {
    const before = bytes;
    ({ bytes } = await keptState(page));
    return bytes - before;
  };
  // Ten minutes of the mix, then each kind alone.
  await run(page, 0, 10);
  const written = { minuteOfMix: Math.round((await grew()) / 10) } as Record<
    keyof typeof MEASURED,
    number
  >;
  // What the board itself wrote, for `fill` to copy from.
  await mkdir(RESULTS, { recursive: true });
  await writeFile(file('template.json'), (await keptState(page)).stored);
  for (const kind of ['stroke', 'note', 'shape'] as const) {
    await page.evaluate((kind) => {
      for (let i = 0; i < 20; i++) window.__capGen?.probe(kind, i);
    }, kind);
    written[kind] = Math.round((await grew()) / 20);
  }
  const result = { measured: MEASURED, written };
  console.log(JSON.stringify({ calibrate: result }));
  await save('calibrate.json', result);
  expect(errors).toEqual([]);
  await context.close();
});

/* `fill` writes the same mix into a Yjs document in the runner. Written in a
 * page through the board's API, the mix slows as the board grows (150
 * simulated minutes took over five minutes, each fifty longer than the last;
 * the cause was not found), so only `calibrate` runs there. Here each note,
 * shape and stroke is a copy of one the board wrote
 * (`template.json`, kept by `calibrate`), with its own id, order key, seed
 * and place, and each key and move is a transaction of its own in the same
 * order as in the page, so the state holds the same items. The document has
 * no undo history, as a room's has none: what is deleted is collected. */

const FIRST_STATE = path.join(
  HERE,
  '../../../collaboration-rs/crates/server/fixtures/board-first-state.bin'
);

/** A copy of a Yjs value as it would be written anew. */
function copy(value: unknown): unknown {
  if (value instanceof Y.Map) {
    const made = new Y.Map();
    for (const [key, held] of value) made.set(key, copy(held));
    return made;
  }
  if (value instanceof Y.Array) {
    const made = new Y.Array();
    made.push(value.toArray().map(copy));
    return made;
  }
  if (value instanceof Y.Text) return new Y.Text();
  return value === undefined ? value : structuredClone(value);
}

const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
/** The order key after `key`, as BlockSuite's fractional indexing counts
 * whole keys: `a` and one digit, `b` and two, `c` and three. */
function nextIndex(key: string) {
  const digits = [...key.slice(1)];
  for (let i = digits.length - 1; i >= 0; i--) {
    const digit = DIGITS.indexOf(digits[i]);
    if (digit < DIGITS.length - 1) {
      digits[i] = DIGITS[digit + 1];
      return key[0] + digits.join('');
    }
    digits[i] = '0';
  }
  return String.fromCharCode(key.charCodeAt(0) + 1) + '0'.repeat(key.length);
}

/** The mix, a simulated minute at a time, on a document that starts as every
 * canvas's room does. */
function mixWriter(template: Uint8Array, firstState: Uint8Array) {
  const source = new Y.Doc();
  Y.applyUpdate(source, template);
  const written = source.getMap<Y.Map<unknown>>('blocks');
  const elementsOf = (blocks: Y.Map<Y.Map<unknown>>) =>
    (blocks.get('surface')?.get('prop:elements') as Y.Map<unknown>).get(
      'value'
    ) as Y.Map<Y.Map<unknown>>;
  const first = <T extends Y.Map<unknown>>(
    of: Iterable<T>,
    key: string,
    value: string
  ) => {
    for (const entry of of) if (entry.get(key) === value) return entry;
    throw new Error(`the template holds no ${value}`);
  };
  const noteTemplate = first(written.values(), 'sys:flavour', 'affine:note');
  // The first minute's note was on screen while `calibrate` wrote, so the
  // board measured it: the height of every note of two minutes' typing. A
  // note left at another height is one the board writes again as it opens.
  const measured = [...written.values()]
    .map((block) => String(block.get('prop:xywh')))
    .find((xywh) => xywh.startsWith('[380,300,'));
  if (!measured) throw new Error('the template holds no first note');
  const fullHeight = (JSON.parse(measured) as number[])[3];
  const paragraphTemplate = first(
    written.values(),
    'sys:flavour',
    'affine:paragraph'
  );
  const shapeTemplate = first(elementsOf(written).values(), 'type', 'shape');
  const brushTemplate = first(elementsOf(written).values(), 'type', 'brush');

  const doc = new Y.Doc();
  Y.applyUpdate(doc, firstState);
  const blocks = doc.getMap<Y.Map<unknown>>('blocks');
  const elements = elementsOf(blocks);
  const children = blocks.get('page')?.get('sys:children') as Y.Array<string>;

  const SENTENCE =
    'Light reactions in the thylakoid make the ATP and NADPH the Calvin cycle needs. ';
  const WORD = 'Mitochondria';
  const EDIT = 'photosynth';
  /** A note's characters after its two minutes. */
  const FULL_NOTE = 80;
  // Fixed sequences, so every run writes the same board.
  let seed = 11;
  const random = () => {
    seed = (seed * 16_807) % 2_147_483_647;
    return seed / 2_147_483_647;
  };
  const ALPHABET = `${DIGITS}_-`;
  const id = () =>
    Array.from({ length: 10 }, () => ALPHABET[Math.floor(random() * 64)]).join(
      ''
    );
  let index = 'Zz';
  const order = () => {
    index = index === 'Zz' ? 'a0' : nextIndex(index);
    return index;
  };
  const once = (write: () => void) => doc.transact(write);

  const totals = { brush: 0, characters: 0, notes: 0, shape: 0 };
  type Note = { box: number[]; id: string; text: Y.Text; typed: number };
  let note: Note | null = null;
  let shape: { box: number[]; map: Y.Map<unknown> } | null = null;

  const stroke = (x: number, y: number) => {
    const eighth = (value: number) => Math.round(value * 8) / 8;
    const points: number[][] = [];
    for (let i = 0; i <= 40; i++)
      points.push([eighth(x + 9.3 * i), eighth(y + Math.sin(i / 4) * 12)]);
    // A stroke keeps its points from its box's corner, half a line's width in.
    const xs = points.map(([px]) => px);
    const ys = points.map(([, py]) => py);
    const left = Math.min(...xs) - 2;
    const top = Math.min(...ys) - 2;
    const made = copy(brushTemplate) as Y.Map<unknown>;
    const key = id();
    made.set('id', key);
    made.set('index', order());
    made.set('seed', Math.floor(random() * 2 ** 31));
    made.set('points', encodeStrokePoints(points, [left, top]));
    made.set(
      'xywh',
      `[${left},${top},${Math.max(...xs) - left + 2},${Math.max(...ys) - top + 2}]`
    );
    once(() => elements.set(key, made));
    return key;
  };
  const newNote = (x: number, y: number): Note => {
    const box = [x, y, 260, 92];
    const key = id();
    const made = copy(noteTemplate) as Y.Map<unknown>;
    made.set('sys:children', new Y.Array());
    made.set('prop:xywh', `[${box.join(',')}]`);
    made.set('prop:index', order());
    once(() => {
      blocks.set(key, made);
      children.push([key]);
    });
    const paragraph = id();
    const line = copy(paragraphTemplate) as Y.Map<unknown>;
    once(() => {
      blocks.set(paragraph, line);
      (made.get('sys:children') as Y.Array<string>).push([paragraph]);
    });
    totals.notes += 1;
    return { box, id: key, text: line.get('prop:text') as Y.Text, typed: 0 };
  };
  const newShape = (x: number, y: number, shapeType: string) => {
    const box = [x, y, 120, 80];
    const made = copy(shapeTemplate) as Y.Map<unknown>;
    const key = id();
    made.set('id', key);
    made.set('index', order());
    made.set('seed', Math.floor(random() * 2 ** 31));
    made.set('shapeType', shapeType);
    made.set('xywh', `[${box.join(',')}]`);
    once(() => elements.set(key, made));
    const label = made.get('text') as Y.Text;
    for (let i = 0; i < WORD.length; i++) once(() => label.insert(i, WORD[i]));
    totals.shape += 1;
    return { box, map: made };
  };
  /** A key: the character, then the note's new size, each its own write. */
  const key = (target: Note, edit: () => void) => {
    once(edit);
    target.typed += 1;
    const [x, y, w] = target.box;
    once(() =>
      blocks
        .get(target.id)
        ?.set(
          'prop:xywh',
          `[${x},${y},${w},${
            target.text.length === FULL_NOTE
              ? fullHeight
              : 92 + (target.typed % 9) * 11.5
          }]`
        )
    );
  };
  const type = (target: Note, text: string) => {
    for (const character of text)
      key(target, () => target.text.insert(target.text.length, character));
    totals.characters += text.length;
  };
  const place = (target: Y.Map<unknown>, box: number[]) =>
    once(() => target.set('xywh', `[${box.join(',')}]`));

  const minute = (at: number) => {
    // Each minute has a patch of clear canvas, 24 patches to a row.
    const x0 = (at % 24) * 640;
    const y0 = Math.floor(at / 24) * 520;
    if (at % 10 === 0 && at > 0) {
      if (shape) {
        const gone = shape.map.get('id') as string;
        once(() => elements.delete(gone));
        totals.shape -= 1;
      }
      if (note) {
        const gone = note;
        totals.characters -= gone.text.length;
        const line = (
          blocks.get(gone.id)?.get('sys:children') as Y.Array<string>
        ).get(0);
        once(() => {
          children.delete(children.toArray().indexOf(gone.id), 1);
          blocks.delete(line);
          blocks.delete(gone.id);
        });
        totals.notes -= 1;
      }
      shape = null;
      note = null;
    }
    if (at % 2 === 0) {
      note = newNote(x0 + 380, y0 + 300);
      shape = newShape(x0 + 40, y0 + 300, at % 4 ? 'ellipse' : 'rect');
    }
    for (let i = 0; i < 7; i++) {
      stroke(x0 + 20 + random() * 200, y0 + 30 + i * 34);
      totals.brush += 1;
    }
    const undone = stroke(x0 + 20, y0 + 270);
    once(() => elements.delete(undone));
    if (shape) {
      const [x, y, w, h] = shape.box;
      place(shape.map, [x + 30, y, w, h]);
      place(shape.map, [x + 30, y + 20, w, h]);
      shape.box = [x + 30, y + 20, w + 10, h + 10];
      place(shape.map, shape.box);
    }
    if (note) {
      const target = note;
      if (at % 4 === 3 && target.text.length >= EDIT.length) {
        for (let i = 0; i < EDIT.length; i++)
          key(target, () => target.text.delete(target.text.length - 1, 1));
        type(target, EDIT);
        totals.characters -= EDIT.length;
      }
      type(target, SENTENCE.slice(0, 40));
    }
  };
  return {
    bytes: () => Y.encodeStateAsUpdate(doc).byteLength,
    fullHeight,
    minute,
    state: () => Y.encodeStateAsUpdate(doc),
    totals,
  };
}

test('fill: one board in the mixed hour mix, kept near 2 MiB and near the cap', async () => {
  test.skip(
    process.env.PERF_CAP_REUSE === '1',
    'PERF_CAP_REUSE: the kept states of an earlier run are opened'
  );
  const template = JSON.parse(
    await readFile(file('template.json'), 'utf8')
  ) as {
    state: string;
  };
  const calibrated = JSON.parse(
    await readFile(file('calibrate.json'), 'utf8')
  ) as { written: { minuteOfMix: number } };
  const writer = mixWriter(
    Buffer.from(template.state, 'base64'),
    await readFile(FIRST_STATE)
  );
  let minutes = 0;
  let bytes = writer.bytes();
  // A minute of the mix here against one the board wrote in the page.
  for (; minutes < 10; minutes++) writer.minute(minutes);
  const perMinute = Math.round((writer.bytes() - bytes) / 10);
  bytes = writer.bytes();
  const kept: Record<string, object> = {};
  for (const target of TARGETS) {
    // Ten minutes at a time while far off, then two (a note's two minutes,
    // so every note is whole), never past the target.
    while (bytes < target - MARGIN) {
      const room = target - bytes;
      const step = room > perMinute * 25 ? 10 : 2;
      if (room < perMinute * step * 1.2) break;
      for (let i = 0; i < step; i++) writer.minute(minutes++);
      bytes = writer.bytes();
    }
    expect(bytes).toBeLessThan(target);
    const { brush, characters, notes, shape } = writer.totals;
    const made: Kept = {
      bytes,
      characters,
      counts: { brush, notes, shape },
      minutes,
      stored: JSON.stringify({
        state: Buffer.from(writer.state()).toString('base64'),
        version: 2,
      }),
    };
    await writeFile(keptFile(target), JSON.stringify(made));
    kept[`${target}`] = { ...made, stored: undefined };
  }
  const result = {
    kept,
    noteHeight: writer.fullHeight,
    perMinute: {
      inThePage: calibrated.written.minuteOfMix,
      written: perMinute,
    },
  };
  console.log(JSON.stringify({ fill: result }));
  await save('fill.json', result);
});

type Expected = { blocks: number; canvas: number };

/** Watches a page from its first script on: the long frames, and the first
 * task after the first frame in which the board holds every element. */
async function watchOpen(page: Page, expected: Expected) {
  await page.addInitScript((expected) => {
    const open: NonNullable<Window['__capOpen']> = { loafs: [] };
    window.__capOpen = open;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const loaf = entry as PerformanceEntry & {
          blockingDuration?: number;
          scripts?: { duration: number; sourceURL: string }[];
        };
        open.loafs.push({
          blocking: loaf.blockingDuration ?? 0,
          duration: loaf.duration,
          end: loaf.startTime + loaf.duration,
          scripts: (loaf.scripts ?? []).map((script) => ({
            // A chunk's name without its hash.
            file: (script.sourceURL.split('/').pop() ?? '').replace(
              /-[\w-]{8}\.js$/,
              ''
            ),
            ms: script.duration,
          })),
        });
      }
    }).observe({
      buffered: true,
      type: 'long-animation-frame',
    } as PerformanceObserverInit);
    const watch = () => {
      const root = document.querySelector(
        'affine-edgeless-root'
      ) as Root | null;
      const layer = root?.gfx?.layer;
      if (
        layer &&
        layer.canvasElements.length >= expected.canvas &&
        layer.blocks.length >= expected.blocks
      ) {
        requestAnimationFrame(() => {
          const channel = new MessageChannel();
          channel.port1.onmessage = () => {
            open.painted = performance.now();
          };
          channel.port2.postMessage(null);
        });
        return;
      }
      requestAnimationFrame(watch);
    };
    requestAnimationFrame(watch);
  }, expected);
}

/** No long frame for this long after the board is painted: it has settled. */
const QUIET_MS = 3000;
const SETTLE_LIMIT_MS = 180_000;

async function opened(page: Page) {
  await page.waitForFunction(
    () => window.__capOpen?.painted !== undefined,
    null,
    { polling: 250, timeout: 240_000 }
  );
  const settled = await page
    .waitForFunction(
      (quiet) => {
        const open = window.__capOpen;
        if (!open?.painted) return false;
        const last = Math.max(open.painted, ...open.loafs.map((l) => l.end));
        return performance.now() - last >= quiet;
      },
      QUIET_MS,
      { polling: 250, timeout: SETTLE_LIMIT_MS }
    )
    .then(
      () => true,
      () => false
    );
  const timings = await page.evaluate(() => {
    const open = window.__capOpen;
    if (!open?.painted) throw new Error('never painted');
    const painted = open.painted;
    const [mountStart] = performance.getEntriesByName('board:mount-start');
    const [mountEnd] = performance.getEntriesByName('board:mount-end');
    const root = document.querySelector('affine-edgeless-root') as Root;
    const scripts = new Map<string, number>();
    for (const loaf of open.loafs)
      for (const { file, ms } of loaf.scripts)
        scripts.set(file, (scripts.get(file) ?? 0) + ms);
    const kept = window.__capKept ? [...window.__capKept.values()][0] : null;
    return {
      canvasElements: root.gfx.layer.canvasElements.length,
      longestFrameMs: Math.max(0, ...open.loafs.map((loaf) => loaf.duration)),
      mountMs:
        mountEnd && mountStart
          ? mountEnd.startTime - mountStart.startTime
          : null,
      mountStartMs: mountStart?.startTime ?? null,
      paintedMs: painted,
      /** When the mock room read its stored state: the join starts. */
      readMs: open.read ?? null,
      /** The five files whose scripts took longest in the long frames. */
      scripts: [...scripts]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([file, ms]) => ({ file, ms: Math.round(ms) })),
      /** The end of the last long frame before the quiet. */
      settledMs: Math.max(painted, ...open.loafs.map((loaf) => loaf.end)),
      /** What the mock room stored since the page opened: the board wrote. */
      storedChars: kept?.length ?? null,
      totalBlockingMs: open.loafs.reduce((sum, loaf) => sum + loaf.blocking, 0),
      zoom: root.gfx.viewport.zoom,
    };
  });
  const cdp = await cdpSession(page);
  await cdp.send('HeapProfiler.collectGarbage');
  const { usedSize } = await cdp.send('Runtime.getHeapUsage');
  // What the board shows as its own kinds: a stroke, shape or note it could
  // not read would be a placeholder and not counted here.
  return {
    ...timings,
    heapBytes: usedSize,
    holds: await holds(page),
    settled,
  };
}

async function installInputProbe(page: Page, start: string) {
  await page.evaluate((start) => {
    const inputs = { at: [] as number[], presents: [] as number[] };
    window.__capInputs = inputs;
    window.addEventListener(
      start,
      () => {
        inputs.at.push(performance.now());
        const index = inputs.at.length - 1;
        requestAnimationFrame(() => {
          const channel = new MessageChannel();
          channel.port1.onmessage = () => {
            inputs.presents[index] = performance.now();
          };
          channel.port2.postMessage(null);
        });
      },
      { capture: true, passive: true }
    );
  }, start);
}

/** Each input's delay to the first task after its next frame. */
async function inputDelays(page: Page) {
  await page.waitForFunction(
    () => {
      const inputs = window.__capInputs;
      return !!inputs && inputs.presents[inputs.at.length - 1] !== undefined;
    },
    null,
    { polling: 100, timeout: 120_000 }
  );
  const delays = await page.evaluate(() => {
    const inputs = window.__capInputs;
    if (!inputs) throw new Error('no probe');
    return inputs.at.map((at, i) => (inputs.presents[i] ?? Number.NaN) - at);
  });
  const painted = delays.filter((delay) => Number.isFinite(delay));
  return {
    inputs: delays.length,
    maxMs: Math.round(Math.max(...painted)),
    p50Ms: Math.round(percentile(painted, 50)),
    p90Ms: Math.round(percentile(painted, 90)),
  };
}

/** Wheel pans, then a pen stroke, on the board as it opened. */
async function inputs(page: Page) {
  await page.mouse.move(640, 400);
  await installInputProbe(page, 'wheel');
  for (let i = 0; i < WHEELS; i++) {
    await page.mouse.wheel(0, i < WHEELS / 2 ? 120 : -120);
    await page.waitForTimeout(WHEEL_CADENCE_MS);
  }
  const pan = await inputDelays(page);
  const before = (await holds(page)).brush;
  await page.locator('edgeless-pen-tool-button').first().click();
  await page.mouse.move(400, 400);
  await page.mouse.down();
  await installInputProbe(page, 'pointermove');
  for (let i = 1; i <= PEN_MOVES; i++) {
    await page.mouse.move(400 + i * 10, 400 + Math.sin(i / 4) * 80);
    await page.waitForTimeout(PEN_CADENCE_MS);
  }
  const pen = await inputDelays(page);
  await page.mouse.up();
  await expect.poll(async () => (await holds(page)).brush).toBe(before + 1);
  return { pan, pen, write: await writes(page) };
}

const WRITES = 5;
/** The build's chunk that holds the mock room (with the tab's room provider,
 * which hands it each update), or the mock's module on the dev server. */
const MOCK_ROOM = /\/collaboration-[\w-]+\.js|\/mocks\/collaboration\./;

/** One write on the open board, WRITES times: the last stroke moved by a unit
 * through the board's API. The mock room encodes its whole state and stores
 * it as text on every update, on the page's thread, which no service does:
 * a sampling profile splits the 600 ms from each write into what ran under
 * the mock room's chunk, the garbage collector (the stored text is garbage at
 * once) and every other script. `syncMs` is the write's own call. */
async function writes(page: Page) {
  const cdp = await cdpSession(page);
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
  const runs: {
    gcMs: number;
    mockRoomMs: number;
    otherMs: number;
    syncMs: number;
  }[] = [];
  for (let i = 0; i < WRITES; i++) {
    await cdp.send('Profiler.start');
    const syncMs = await page.evaluate(() => {
      const { gfx } = document.querySelector('affine-edgeless-root') as Root;
      const last = gfx.layer.canvasElements.at(-1);
      if (!last) throw new Error('the board holds no stroke');
      const [x, y, w, h] = JSON.parse(last.xywh) as number[];
      const at = performance.now();
      gfx.updateElement(last, { xywh: `[${x + 1},${y},${w},${h}]` });
      return performance.now() - at;
    });
    // The room's side of the write follows it.
    await page.waitForTimeout(600);
    const { profile } = await cdp.send('Profiler.stop');
    const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
    const underMock = new Map<number, boolean>();
    const mark = (id: number, under: boolean) => {
      const node = nodes.get(id);
      if (!node) return;
      const here = under || MOCK_ROOM.test(node.callFrame.url);
      underMock.set(id, here);
      for (const child of node.children ?? []) mark(child, here);
    };
    mark(profile.nodes[0].id, false);
    let gcMs = 0;
    let mockRoomMs = 0;
    let otherMs = 0;
    (profile.samples ?? []).forEach((id, at) => {
      const name = nodes.get(id)?.callFrame.functionName;
      if (name === '(idle)' || name === '(program)' || name === '(root)')
        return;
      const ms = (profile.timeDeltas?.[at] ?? 0) / 1000;
      if (name === '(garbage collector)') gcMs += ms;
      else if (underMock.get(id)) mockRoomMs += ms;
      else otherMs += ms;
    });
    runs.push({ gcMs, mockRoomMs, otherMs, syncMs });
  }
  await cdp.send('Profiler.disable');
  const of = (pick: (run: (typeof runs)[number]) => number) =>
    Math.round(percentile(runs.map(pick), 50) * 10) / 10;
  return {
    gcMs: of((run) => run.gcMs),
    mockRoomMs: of((run) => run.mockRoomMs),
    otherMs: of((run) => run.otherMs),
    syncMs: of((run) => run.syncMs),
    writes: WRITES,
  };
}

type Path = 'room' | 'memory';

/** One cold open in a fresh context: `stored` through the mock room on the
 * Canvas page, or its state as a saved board on the board's own page. */
async function open(
  browser: Browser,
  via: Path,
  stored: string | null,
  expected: Expected,
  rate: number,
  withInputs: boolean,
  shot?: string
) {
  // On a shared machine, wait for its 1-minute load to fall under the knob.
  const maxLoad = Number(process.env.PERF_CAP_MAX_LOAD ?? Number.NaN);
  for (let waited = 0; loadavg()[0] >= maxLoad && waited < 600; waited++)
    await new Promise((resolve) => setTimeout(resolve, 1000));
  const loadBefore = loadavg()[0];
  const context = await browser.newContext({
    viewport: { height: 800, width: 1280 },
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await watchOpen(page, expected);
  if (via === 'room') await holdKept(page, stored);
  else if (stored)
    // The board's own page mounts the saved board it finds here.
    await page.addInitScript(
      (saved) => Object.assign(window, { __benchBoard: saved }),
      (JSON.parse(stored) as { state: string }).state
    );
  if (rate > 1) await throttleCpu(page, rate);
  await page.goto(via === 'room' ? '/canvas' : '/dev/drawing');
  const result = await opened(page);
  const after = withInputs && via === 'room' ? await inputs(page) : null;
  if (shot) await page.screenshot({ path: shot });
  await context.close();
  const load = [loadBefore, loadavg()[0]].map((value) => +value.toFixed(2));
  return { ...result, errors, inputs: after, load };
}

const median = (values: number[]) => Math.round(percentile(values, 50));

function summary(runs: Awaited<ReturnType<typeof open>>[]) {
  const of = (pick: (run: (typeof runs)[number]) => number | null) =>
    runs.map((run) => Math.round(pick(run) ?? Number.NaN));
  const painted = of((run) => run.paintedMs);
  const fromRead = of((run) =>
    run.readMs === null ? null : run.paintedMs - run.readMs
  );
  const fromMount = of((run) =>
    run.mountStartMs === null ? null : run.paintedMs - run.mountStartMs
  );
  return {
    errors: runs.flatMap((run) => run.errors),
    heapMb: of((run) => run.heapBytes / 1e4).map((value) => value / 100),
    holds: runs[0]?.holds,
    scripts: runs[0]?.scripts,
    settled: runs.map((run) => run.settled),
    settledMedianMs: median(of((run) => run.settledMs)),
    settledMs: of((run) => run.settledMs),
    /** What the mock room stored after an open: the board wrote as it opened. */
    storedChars: runs.map((run) => run.storedChars),
    inputs: runs.map((run) => run.inputs).filter((value) => value !== null),
    /** Each open's 1-minute load before and after it. */
    load: runs.map((run) => run.load),
    longestFrameMs: of((run) => run.longestFrameMs),
    mountMs: of((run) => run.mountMs),
    mountToPaintedMs: fromMount,
    paintedMedianMs: median(painted),
    paintedMs: painted,
    readToPaintedMedianMs: median(fromRead.filter(Number.isFinite)),
    readToPaintedMs: fromRead,
    settledAfterPaintedMs: of((run) => run.settledMs - run.paintedMs),
    totalBlockingMs: of((run) => run.totalBlockingMs),
    zoom: runs[0]?.zoom,
  };
}

/** What Yjs takes in Node to apply a state to an empty document and to encode
 * it again: the mock room does the first twice and the second three times on
 * the page's main thread before the tab's own document is given the state. */
function yjsCost(state: Uint8Array) {
  const applies: number[] = [];
  const encodes: number[] = [];
  let structs = 0;
  for (let i = 0; i < 5; i++) {
    const doc = new Y.Doc();
    let at = performance.now();
    Y.applyUpdate(doc, state);
    applies.push(performance.now() - at);
    at = performance.now();
    Y.encodeStateAsUpdate(doc);
    encodes.push(performance.now() - at);
    structs = [...doc.store.clients.values()].reduce(
      (sum, list) => sum + list.length,
      0
    );
    doc.destroy();
  }
  return {
    applyMs: Math.round(percentile(applies, 50) * 10) / 10,
    encodeMs: Math.round(percentile(encodes, 50) * 10) / 10,
    structs,
  };
}

test('open: a blank canvas, one near 2 MiB and one near the cap', async ({
  browser,
}) => {
  const boards: { kept: Kept | null; name: string }[] = [
    { kept: null, name: 'blank' },
  ];
  for (const target of TARGETS)
    boards.push({
      kept: JSON.parse(await readFile(keptFile(target), 'utf8')) as Kept,
      name: `${(target / MIB).toFixed(0)} MiB`,
    });
  const results: Record<string, unknown> = {};
  const began = loadavg();
  for (const { kept, name } of boards) {
    const state = kept
      ? Buffer.from(
          (JSON.parse(kept.stored) as { state: string }).state,
          'base64'
        )
      : null;
    const expected = kept
      ? {
          blocks: kept.counts.notes,
          canvas: kept.counts.brush + kept.counts.shape,
        }
      : { blocks: 0, canvas: 0 };
    const room = [];
    const memory = [];
    for (let i = 0; i < OPENS; i++)
      room.push(
        await open(
          browser,
          'room',
          kept?.stored ?? null,
          expected,
          1,
          i === 0,
          i === 0 ? file(`open-${name.replace(' ', '-')}.png`) : undefined
        )
      );
    // Every stroke, shape and note the state holds is shown as its own kind.
    if (kept) expect(room[0].holds).toEqual(kept.counts);
    // The board's own page adds a plane card when it is given no board.
    let memoryError: string | null = null;
    for (let i = 0; i < OPENS && !memoryError; i++)
      try {
        memory.push(
          await open(
            browser,
            'memory',
            kept?.stored ?? null,
            kept ? expected : { ...expected, canvas: 1 },
            1,
            false
          )
        );
      } catch (error) {
        // Reported, not failed: the room's path is the one this bench is for.
        memoryError = String(error);
      }
    const slowed = [];
    for (let i = 0; i < OPENS; i++)
      slowed.push(
        await open(browser, 'room', kept?.stored ?? null, expected, 4, false)
      );
    results[name] = {
      board: kept && {
        bytes: kept.bytes,
        characters: kept.characters,
        counts: kept.counts,
        gzipBytes: state ? gzipSync(state).byteLength : null,
        minutes: kept.minutes,
        yjs: state ? yjsCost(state) : null,
      },
      memory: memory.length ? summary(memory) : null,
      memoryError,
      room: summary(room),
      roomAt4x: summary(slowed),
    };
    console.log(JSON.stringify({ [name]: results[name] }));
  }
  const record = {
    cap: CAP,
    cpu: cpus()[0]?.model,
    /** The Mac's 1, 5 and 15 minute load as the run began and ended. */
    load: { began, ended: loadavg() },
    opens: OPENS,
    results,
  };
  await save('board-open-at-cap.json', record);
  for (const result of Object.values(results) as {
    room: { errors: string[]; storedChars: (number | null)[] };
  }[]) {
    expect(result.room.errors).toEqual([]);
    // A board that writes as it opens would be timed doing that too.
    expect(result.room.storedChars).toEqual(OPENS_NULL);
  }
});
