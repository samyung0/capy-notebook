import {
  closeNoteSizes,
  dropNoteSizes,
  measureNoteSize,
  measureNoteSizesAgain,
  NOTE_SIZE_IDLE_MS,
  NOTE_SIZE_MAX_WAIT_MS,
  NOTE_SIZE_VIEWER_MS,
  noteGestureEnds,
  noteGestureStarts,
  openNoteSizes,
  saveNoteSize,
  saveNoteSizes,
  selectNoteSizes,
} from '@blocksuite/affine/blocks/note';
import { NoteStoreExtension } from '@blocksuite/affine/blocks/note/store';
import { ParagraphStoreExtension } from '@blocksuite/affine/blocks/paragraph/store';
import { RootStoreExtension } from '@blocksuite/affine/blocks/root/store';
import type { SurfaceBlockModel } from '@blocksuite/affine/blocks/surface';
import { SurfaceStoreExtension } from '@blocksuite/affine/blocks/surface/store';
import { StoreExtensionManager } from '@blocksuite/affine/ext-loader';
import { ConnectorStoreExtension } from '@blocksuite/affine/gfx/connector/store';
import { ShapeStoreExtension } from '@blocksuite/affine/gfx/shape/store';
import { Bound } from '@blocksuite/affine/global/gfx';
import {
  type ConnectorElementModel,
  INLINE_NOTE_FILL,
  type NoteBlockModel,
  NoteShadow,
  StrokeStyle,
} from '@blocksuite/affine/model';
import { Text } from '@blocksuite/affine/store';
import { MemoryBlobSource } from '@blocksuite/affine/sync';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { boardFirstState } from './boardFirstState';
import { unknownStore } from './boardUnknown';
import { BLOCKS_ROOT, openRoomStore } from './roomStore';

/* A board note's size reaches the room once typing pauses (vendor/blocksuite
 * local change 75), not after every key: each size write took the clock
 * between two typed characters, so no two merged into one run. Only the tab
 * editing the note, or whose person just changed it, holds its size; the
 * others show what they measure at once, as their own, and write it only
 * after 3 s of differing. No tab writes a locked note's, or a read-only
 * board's. */

const page = Object.assign(new EventTarget(), { visibilityState: 'visible' });
vi.stubGlobal('document', page);
// A group's bound reads its notes' through the DOM's DOMRect (unturned here).
vi.stubGlobal(
  'DOMRect',
  class {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
    constructor(x: number, y: number, width: number, height: number) {
      this.x = x;
      this.y = y;
      this.width = width;
      this.height = height;
    }
  }
);

const stores = new StoreExtensionManager([
  RootStoreExtension,
  SurfaceStoreExtension,
  NoteStoreExtension,
  ParagraphStoreExtension,
  ShapeStoreExtension,
  ConnectorStoreExtension,
]);

/** A tab on the room: its document, its store, and how many updates it wrote
 * itself (what it would send). */
function tab(state: Uint8Array = boardFirstState()) {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, state, 'room');
  let sent = 0;
  doc.on('update', (_: Uint8Array, origin: unknown) => {
    if (origin !== 'room') sent++;
  });
  const { dispose, store } = openRoomStore({
    awareness: new Awareness(doc),
    blobs: { main: new MemoryBlobSource() },
    doc,
    id: 'cv_1',
    storeExtensions: [...stores.get('store'), ...unknownStore('workspace')],
  });
  // As the board does when it mounts.
  openNoteSizes(store);
  return { dispose, doc, sent: () => sent, store };
}

type Tab = ReturnType<typeof tab>;

const surfaceOf = (at: Tab) =>
  at.store.getModelsByFlavour('affine:surface')[0] as SurfaceBlockModel;

/** Sends what `from` has that `to` lacks, as the room relays it. */
const relay = (from: Tab, to: Tab) =>
  Y.applyUpdate(
    to.doc,
    Y.encodeStateAsUpdate(from.doc, Y.encodeStateVector(to.doc)),
    'room'
  );

/** A shape 10 square at (`x`, 400). */
const shapeAt = (x: number) => ({
  shapeType: 'rect',
  type: 'shape',
  xywh: `[${x},400,10,10]`,
});

/** What `setNotesInline` writes to make a note inline (local change 52). */
function inlineProps(model: NoteBlockModel) {
  const { edgeless } = model.props;
  return {
    background: INLINE_NOTE_FILL,
    edgeless: {
      ...edgeless,
      style: {
        ...edgeless.style,
        borderStyle: StrokeStyle.None,
        shadowType: NoteShadow.None,
      },
    },
  };
}

/** A note 10 wide, inline or a card, holding one empty paragraph, on `at`. */
function addNote(at: Tab, inline = true) {
  const id = at.store.addBlock(
    'affine:note',
    { xywh: '[100,100,10,30]' },
    at.store.root
  );
  const model = at.store.getModelById(id) as NoteBlockModel;
  if (inline) at.store.updateBlock(model, inlineProps(model));
  at.store.addBlock('affine:paragraph', { text: new Text() }, id);
  return id;
}

/** Note `id` as tab `at` holds it: its model, its text, its stored size and
 * how many times its size was written. */
function noteOn(at: Tab, id: string) {
  const model = at.store.getModelById(id) as NoteBlockModel;
  const text = model.children[0].text!;
  const stored = () =>
    Bound.deserialize(
      (at.doc.getMap(BLOCKS_ROOT).get(id) as Y.Map<string>).get('prop:xywh')!
    );
  let writes = 0;
  model.yBlock.observe((event) => {
    if (event.keysChanged.has('prop:xywh')) writes++;
  });
  return { model, stored, text, writes: () => writes };
}

/** A tab holding a new note, captured so its Undo starts after it, and made
 * long enough ago that a measure no longer follows this tab's change. */
function typist(inline = true) {
  const at = tab();
  const id = addNote(at, inline);
  at.store.captureSync();
  vi.advanceTimersByTime(NOTE_SIZE_IDLE_MS);
  return { ...noteOn(at, id), at, id };
}

type Typist = ReturnType<typeof typist>;

/** The text runs the board stores for `text`. */
function runs(doc: Y.Doc, text: Text) {
  let count = 0;
  for (const structs of doc.store.clients.values())
    for (const struct of structs)
      if (struct instanceof Y.Item && struct.parent === text.yText) count++;
  return count;
}

const words = ['Light ', 'travels ', 'fast.'];

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it.each([
  // An inline note is as wide as its text: every key widens it.
  ['inline', 'w', (typed: number) => 7 * typed],
  // A card is as tall as its text: here each word wraps onto a new line.
  ['card-width', 'h', (_: number, word: number) => 20 * (word + 1)],
] as const)(
  'stores a %s note’s size once per pause in typing, its text in runs',
  (_, dimension, size) => {
    const { at, model, stored, text, writes } = typist();
    let typed = 0;
    for (const [index, word] of words.entries()) {
      for (const char of word) {
        text.insert(char, typed++);
        measureNoteSize(model, dimension, size(typed, index), true);
        // The typist's own frame follows the text at once.
        expect(model[dimension]).toBe(size(typed, index));
        vi.advanceTimersByTime(50);
      }
      vi.advanceTimersByTime(NOTE_SIZE_IDLE_MS);
    }
    expect(writes()).toBe(words.length);
    expect(stored()[dimension]).toBe(size(typed, words.length - 1));
    // One run per word, against one per character when every key wrote it.
    expect(runs(at.doc, text)).toBe(words.length);
    at.dispose();
  }
);

it('stores the size at most every 2 s while typing goes on', () => {
  const { at, model, stored, text, writes } = typist();
  for (let typed = 1; typed <= 40; typed++) {
    text.insert('a', typed - 1);
    measureNoteSize(model, 'w', 7 * typed, true);
    vi.advanceTimersByTime(100);
  }
  // Four seconds of typing: a save 2 s after the first key, the next 2 s
  // after the first key it left.
  expect(writes()).toBe(2);
  expect(stored().w).toBe(280);
  vi.advanceTimersByTime(NOTE_SIZE_MAX_WAIT_MS);
  expect(writes()).toBe(2);
  at.dispose();
});

it('shows a peer’s move made while the size waits, the size over it, and keeps it', () => {
  const a = typist();
  const b = tab(Y.encodeStateAsUpdate(a.at.doc));
  a.text.insert('Light', 0);
  measureNoteSize(a.model, 'w', 35, true);
  noteOn(b, a.id).model.xywh = '[400,300,10,30]';
  relay(b, a.at);
  expect(a.model.xywh).toBe('[400,300,35,30]');
  vi.advanceTimersByTime(NOTE_SIZE_IDLE_MS);
  expect(a.stored().toXYWH()).toEqual([400, 300, 35, 30]);
  b.dispose();
  a.at.dispose();
});

it('stores the size at once when the page is hidden', () => {
  const { at, model, stored, writes } = typist();
  measureNoteSize(model, 'h', 60, true);
  page.visibilityState = 'hidden';
  page.dispatchEvent(new Event('visibilitychange'));
  page.visibilityState = 'visible';
  expect(writes()).toBe(1);
  expect(stored().h).toBe(60);
  at.dispose();
});

it('stores the size before an align made while it waits, untracked, so the align’s Undo keeps it', () => {
  const { at, model, stored, writes } = typist();
  measureNoteSize(model, 'h', 60, true);
  const sent = at.sent();
  // The toolbar's align (`updateBlock`, a step of its own).
  at.store.updateBlock(model, { xywh: '[40,100,10,60]' });
  expect(stored().toXYWH()).toEqual([40, 100, 10, 60]);
  // The size on its own, then the align.
  expect(at.sent() - sent).toBe(2);
  at.store.captureSync();
  at.store.undo();
  expect(stored().toXYWH()).toEqual([100, 100, 10, 60]);
  // Nothing is left to save.
  vi.advanceTimersByTime(NOTE_SIZE_MAX_WAIT_MS);
  expect(writes()).toBe(3);
  at.dispose();
});

it('stores a plain write of the model made while the size waits at once, with the size', () => {
  const { at, model, stored, writes } = typist();
  measureNoteSize(model, 'h', 60, true);
  const sent = at.sent();
  // Outside the store's steps, untracked as the write is.
  model.xywh = '[40,100,10,60]';
  expect(stored().toXYWH()).toEqual([40, 100, 10, 60]);
  expect(at.sent() - sent).toBe(1);
  vi.advanceTimersByTime(NOTE_SIZE_MAX_WAIT_MS);
  expect(writes()).toBe(1);
  at.dispose();
});

it('keeps a viewer’s align made while the typist’s size waits', () => {
  const a = typist();
  const b = tab(Y.encodeStateAsUpdate(a.at.doc));
  const onB = noteOn(b, a.id);
  measureNoteSize(a.model, 'h', 60, true);
  vi.advanceTimersByTime(100);
  // The viewer measures the same text, then aligns the note: stored at once,
  // it reaches the typist before the typist's save.
  measureNoteSize(onB.model, 'h', 60, false);
  b.store.updateBlock(onB.model, { xywh: '[40,100,10,30]' });
  expect(onB.stored().x).toBe(40);
  relay(b, a.at);
  expect(a.model.xywh).toBe('[40,100,10,60]');
  vi.advanceTimersByTime(NOTE_SIZE_IDLE_MS);
  relay(a.at, b);
  vi.advanceTimersByTime(NOTE_SIZE_VIEWER_MS);
  expect(onB.stored().toXYWH()).toEqual([40, 100, 10, 60]);
  expect(a.stored().toXYWH()).toEqual([40, 100, 10, 60]);
  b.dispose();
  a.at.dispose();
});

it('starts a drag from the saved size, so its Undo keeps the typed height', () => {
  const { at, model, stored } = typist();
  measureNoteSize(model, 'h', 60, true);
  // What the note's view does as a drag starts, moves and ends.
  noteGestureStarts(model);
  expect(stored().h).toBe(60);
  at.store.captureSync();
  model.stash('xywh');
  model.xywh = '[150,100,10,60]';
  // What is measured during the drag goes with it.
  measureNoteSize(model, 'h', 80, true);
  at.store.transact(() => model.pop('xywh'));
  noteGestureEnds(model);
  expect(stored().toXYWH()).toEqual([150, 100, 10, 80]);
  vi.advanceTimersByTime(NOTE_SIZE_MAX_WAIT_MS);
  at.store.undo();
  expect(stored().toXYWH()).toEqual([100, 100, 10, 60]);
  at.dispose();
});

it('stores the size a tab not editing shows before a drag starts, untracked, so the drag starts from it and its Undo keeps it', () => {
  const { at, model, stored, writes } = typist();
  measureNoteSize(model, 'h', 60, false);
  vi.advanceTimersByTime(1000);
  const before = writes();
  noteGestureStarts(model);
  expect(stored().h).toBe(60);
  expect(writes()).toBe(before + 1);
  at.store.captureSync();
  // What the drag does: its stash, a move from the bound shown, its tracked
  // pop.
  model.stash('xywh');
  expect(model.xywh).toBe('[100,100,10,60]');
  const bound = Bound.deserialize(model.xywh);
  bound.x += 50;
  model.xywh = bound.serialize();
  at.store.transact(() => model.pop('xywh'));
  noteGestureEnds(model);
  expect(stored().toXYWH()).toEqual([150, 100, 10, 60]);
  // The 3 s wait ended with the start: nothing more is written.
  vi.advanceTimersByTime(NOTE_SIZE_VIEWER_MS);
  expect(writes()).toBe(before + 2);
  at.store.undo();
  expect(stored().toXYWH()).toEqual([100, 100, 10, 60]);
  at.dispose();
});

it('stores the size a tab whose fonts lost to a peer’s shows before a drag starts', () => {
  const a = typist(false);
  const b = tab(Y.encodeStateAsUpdate(a.at.doc));
  const onB = noteOn(b, a.id);
  measureNoteSize(onB.model, 'h', 62, false);
  vi.advanceTimersByTime(NOTE_SIZE_VIEWER_MS);
  // B wrote 62; A's fonts measure 60 and write that over it.
  relay(b, a.at);
  measureNoteSize(a.model, 'h', 60, false);
  vi.advanceTimersByTime(NOTE_SIZE_VIEWER_MS);
  relay(a.at, b);
  expect(onB.stored().h).toBe(60);
  expect(onB.model.h).toBe(62);
  noteGestureStarts(onB.model);
  expect(onB.stored().h).toBe(62);
  b.store.captureSync();
  onB.model.stash('xywh');
  const bound = Bound.deserialize(onB.model.xywh);
  bound.x += 50;
  onB.model.xywh = bound.serialize();
  b.store.transact(() => onB.model.pop('xywh'));
  noteGestureEnds(onB.model);
  expect(onB.stored().toXYWH()).toEqual([150, 100, 10, 62]);
  b.store.undo();
  expect(onB.stored().toXYWH()).toEqual([100, 100, 10, 62]);
  b.dispose();
  a.at.dispose();
});

it('holds a measured size a gesture’s own write left out once it ends, as this tab’s', () => {
  const { at, model, stored } = typist();
  measureNoteSize(model, 'h', 60, false);
  noteGestureStarts(model);
  // A resize setting the old height (`model.props.xywh`, its stash).
  model.stash('xywh');
  model.xywh = '[150,100,10,30]';
  at.store.transact(() => model.pop('xywh'));
  noteGestureEnds(model);
  expect(model.h).toBe(60);
  vi.advanceTimersByTime(NOTE_SIZE_IDLE_MS);
  expect(stored().toXYWH()).toEqual([150, 100, 10, 60]);
  at.dispose();
});

it('holds what is measured right after this tab adds a note', () => {
  const at = tab();
  let id = '';
  // The note and its paragraph in one step, as a tool adds them.
  at.store.transact(() => {
    id = at.store.addBlock(
      'affine:note',
      { xywh: '[100,100,10,30]' },
      at.store.root
    );
    at.store.addBlock('affine:paragraph', { text: new Text() }, id);
  });
  const { model, stored } = noteOn(at, id);
  measureNoteSize(model, 'h', 24, false);
  expect(model.h).toBe(24);
  vi.advanceTimersByTime(NOTE_SIZE_IDLE_MS);
  expect(stored().h).toBe(24);
  at.dispose();
});

/** What a note's text measures after a change: its width or height. */
type Measured = ['w' | 'h', number];

it.each([
  // `setNotesInline` makes a card inline: its width is now its text's.
  [
    'the Inline toggle',
    false,
    (a: Typist): Measured => {
      a.at.store.updateBlock(a.model, inlineProps(a.model));
      return ['w', 35];
    },
  ],
  // Typing undone on the board once the note is no longer edited.
  [
    'an Undo of typing',
    true,
    (a: Typist): Measured => {
      a.text.insert('Light', 0);
      measureNoteSize(a.model, 'w', 35, true);
      vi.advanceTimersByTime(NOTE_SIZE_IDLE_MS);
      a.at.store.captureSync();
      a.at.store.undo();
      return ['w', 7];
    },
  ],
  // A card's side widened: its text rewraps, its height follows.
  [
    'a resize',
    false,
    (a: Typist): Measured => {
      a.at.store.updateBlock(a.model, { xywh: '[100,100,60,30]' });
      return ['h', 20];
    },
  ],
] as const)(
  'holds what is measured after %s in the tab that made it, the only one to write it',
  (_, inline, change) => {
    const a = typist(inline);
    const b = tab(Y.encodeStateAsUpdate(a.at.doc));
    const onB = noteOn(b, a.id);
    const [dimension, size] = change(a);
    relay(a.at, b);
    const sent = b.sent();
    const writes = a.writes();
    // Neither tab is editing the note.
    measureNoteSize(a.model, dimension, size, false);
    measureNoteSize(onB.model, dimension, size, false);
    expect(a.model[dimension]).toBe(size);
    vi.advanceTimersByTime(NOTE_SIZE_IDLE_MS);
    expect(a.stored()[dimension]).toBe(size);
    expect(a.writes() - writes).toBe(1);
    relay(a.at, b);
    vi.advanceTimersByTime(NOTE_SIZE_VIEWER_MS);
    expect(b.sent() - sent).toBe(0);
    expect(onB.stored()[dimension]).toBe(size);
    b.dispose();
    a.at.dispose();
  }
);

it.each([
  [
    'a move',
    true,
    (b: Tab, model: NoteBlockModel) =>
      b.store.updateBlock(model, { xywh: '[150,100,10,30]' }),
  ],
  // A card's colour: still a card.
  [
    'a colour',
    false,
    (b: Tab, model: NoteBlockModel) =>
      b.store.updateBlock(model, { background: 'red' }),
  ],
] as const)(
  'keeps a tab whose person just made %s of the note a viewer when a peer’s text arrives',
  (_, inline, change) => {
    const a = typist(inline);
    const b = tab(Y.encodeStateAsUpdate(a.at.doc));
    const onB = noteOn(b, a.id);
    change(b, onB.model);
    relay(b, a.at);
    const sent = b.sent();
    a.text.insert('abc', 0);
    measureNoteSize(a.model, 'h', 60, true);
    relay(a.at, b);
    // Its own font measures the text a little taller: it shows that at once,
    // holding none.
    measureNoteSize(onB.model, 'h', 62, false);
    expect(onB.model.h).toBe(62);
    vi.advanceTimersByTime(NOTE_SIZE_IDLE_MS);
    expect(b.sent() - sent).toBe(0);
    expect(onB.stored().h).toBe(30);
    b.dispose();
    a.at.dispose();
  }
);

it('writes a waiting width only while the note is inline', () => {
  const a = typist();
  const b = tab(Y.encodeStateAsUpdate(a.at.doc));
  measureNoteSize(a.model, 'w', 35, true);
  // A peer makes it a card, widened by a card's padding (`setNotesInline`).
  b.store.updateBlock(noteOn(b, a.id).model, {
    background: 'white',
    xywh: '[100,100,30,30]',
  });
  relay(b, a.at);
  vi.advanceTimersByTime(NOTE_SIZE_IDLE_MS);
  expect(a.stored().w).toBe(30);
  expect(a.model.w).toBe(30);
  // The card's own width, measured, is not a waiting width.
  measureNoteSize(a.model, 'w', 50, true);
  vi.advanceTimersByTime(NOTE_SIZE_MAX_WAIT_MS);
  expect(a.stored().w).toBe(30);
  b.dispose();
  a.at.dispose();
});

it('writes nothing into a board that turned read-only while the size waits', () => {
  const { at, model, stored, writes } = typist();
  measureNoteSize(model, 'h', 60, true);
  at.store.readonly = true;
  vi.advanceTimersByTime(NOTE_SIZE_IDLE_MS);
  expect(writes()).toBe(0);
  // What it measures still shows, in this tab alone.
  expect(model.h).toBe(60);
  expect(stored().h).toBe(30);
  at.dispose();
});

it('drops the waiting sizes of a board that locks, before editing ends', () => {
  const { at, model, writes } = typist();
  measureNoteSize(model, 'h', 60, true);
  // `setLocked`: the sizes go, then the selection's end saves the note's.
  dropNoteSizes(at.store);
  saveNoteSize(model);
  vi.advanceTimersByTime(NOTE_SIZE_MAX_WAIT_MS);
  expect(writes()).toBe(0);
  expect(model.h).toBe(60);
  at.dispose();
});

it('measures a locked board’s notes again as it unlocks, a size the lock dropped as this tab’s', () => {
  const { at, model, stored } = typist();
  measureNoteSize(model, 'h', 60, true);
  // `setLocked(true)`, then the selection's end.
  dropNoteSizes(at.store);
  at.store.readonly = true;
  saveNoteSize(model);
  // Measured while locked: a peer's text arrived.
  measureNoteSize(model, 'h', 80, false);
  // `setLocked(false)`.
  at.store.readonly = false;
  measureNoteSizesAgain(at.store);
  expect(model.h).toBe(80);
  vi.advanceTimersByTime(NOTE_SIZE_IDLE_MS);
  expect(stored().h).toBe(80);
  at.dispose();
});

it.each([
  ['not editing it', false],
  ['whose person is changing it', true],
] as const)(
  'never holds or writes the size of a locked note, measured by a tab %s',
  (_, editing) => {
    const { at, model, stored, text, writes } = typist();
    // A question's note on a student's copy of the board.
    model.lock();
    if (editing) text.insert('Light', 0);
    // This tab's fonts measure the text unlike the stored size: shown here.
    measureNoteSize(model, 'h', 60, editing);
    expect(model.h).toBe(60);
    vi.advanceTimersByTime(NOTE_SIZE_VIEWER_MS);
    // Editing ends, a drag starts and ends, the board is saved.
    saveNoteSize(model);
    noteGestureStarts(model);
    noteGestureEnds(model);
    saveNoteSizes(at.store);
    vi.advanceTimersByTime(NOTE_SIZE_VIEWER_MS);
    expect(writes()).toBe(0);
    expect(stored().h).toBe(30);
    at.dispose();
  }
);

it.each([
  [
    'the note',
    (on: Tab, ids: string[]) => {
      for (const id of ids) noteOn(on, id).model.lock();
    },
  ],
  [
    'a group holding it',
    (on: Tab, ids: string[]) =>
      surfaceOf(on).addElement({
        children: Object.fromEntries(ids.map((id) => [id, true])),
        lockedBySelf: true,
        type: 'group',
      }),
  ],
] as const)(
  'drops a waiting size when a peer locks %s, writing nothing',
  (_, lock) => {
    const a = typist();
    const other = noteOn(a.at, addNote(a.at));
    vi.advanceTimersByTime(NOTE_SIZE_IDLE_MS);
    const b = tab(Y.encodeStateAsUpdate(a.at.doc));
    // A size held by the tab editing one note, a 3 s wait on another.
    measureNoteSize(a.model, 'h', 60, true);
    measureNoteSize(other.model, 'h', 60, false);
    lock(b, [a.id, other.model.id]);
    relay(b, a.at);
    // The size goes on showing, as this tab's alone.
    expect(a.model.h).toBe(60);
    expect(a.stored().h).toBe(30);
    // Editing ends; the waits pass.
    saveNoteSize(a.model);
    vi.advanceTimersByTime(NOTE_SIZE_VIEWER_MS);
    expect(a.writes() + other.writes()).toBe(0);
    expect(a.stored().h).toBe(30);
    b.dispose();
    a.at.dispose();
  }
);

it('measures a note again once a peer unlocks it, writing its size after 3 s', () => {
  const a = typist();
  const b = tab(Y.encodeStateAsUpdate(a.at.doc));
  const onB = noteOn(b, a.id);
  measureNoteSize(a.model, 'h', 60, true);
  onB.model.lock();
  relay(b, a.at);
  // Measured while locked: a peer's text arrived.
  measureNoteSize(a.model, 'h', 80, false);
  vi.advanceTimersByTime(NOTE_SIZE_VIEWER_MS);
  expect(a.writes()).toBe(0);
  onB.model.unlock();
  relay(b, a.at);
  // As by a tab not editing it: shown at once, nothing written before 3 s.
  expect(a.model.h).toBe(80);
  vi.advanceTimersByTime(NOTE_SIZE_VIEWER_MS - 100);
  expect(a.writes()).toBe(0);
  vi.advanceTimersByTime(100);
  expect(a.stored().h).toBe(80);
  b.dispose();
  a.at.dispose();
});

it('checks no locked note’s lock while a key is typed into another', () => {
  const { at, model, stored, text } = typist();
  // Question notes a group locks, as the toolbar's Lock of several elements.
  const locked = [addNote(at), addNote(at)].map((id) => noteOn(at, id).model);
  surfaceOf(at).addElement({
    children: Object.fromEntries(locked.map((note) => [note.id, true])),
    lockedBySelf: true,
    type: 'group',
  });
  for (const note of locked) measureNoteSize(note, 'h', 60, false);
  const checks = locked.map((note) => vi.spyOn(note, 'isLocked'));
  for (let typed = 1; typed <= 5; typed++) {
    text.insert('a', typed - 1);
    measureNoteSize(model, 'w', 7 * typed, true);
  }
  vi.advanceTimersByTime(NOTE_SIZE_IDLE_MS);
  expect(stored().w).toBe(35);
  for (const check of checks) expect(check).not.toHaveBeenCalled();
  at.dispose();
});

it.each([
  ['saves', 'save', 60],
  // The room lost, refused or replaced the board.
  ['drops', 'drop', 30],
] as const)(
  '%s the waiting size of a board that closes, and writes nothing after',
  (_, sizes, height) => {
    const { at, model, stored } = typist();
    const other = noteOn(at, addNote(at));
    vi.advanceTimersByTime(NOTE_SIZE_IDLE_MS);
    measureNoteSize(model, 'h', 60, true);
    // A size this tab measures and no one stores: its 3 s wait stops too.
    measureNoteSize(other.model, 'h', 60, false);
    // `unmount`, then its store's close; the room's document lives on.
    closeNoteSizes(at.store, sizes);
    at.dispose();
    expect(stored().h).toBe(height);
    const sent = at.sent();
    // A measure arriving late, from the board's last frame.
    measureNoteSize(other.model, 'h', 90, true);
    vi.advanceTimersByTime(NOTE_SIZE_VIEWER_MS);
    expect(at.sent() - sent).toBe(0);
    expect(other.stored().h).toBe(30);
  }
);

it('saves the waiting sizes of one board when it is saved or closed', () => {
  const one = typist();
  const other = typist();
  measureNoteSize(one.model, 'h', 60, true);
  measureNoteSize(other.model, 'h', 60, true);
  saveNoteSizes(one.at.store);
  expect(one.stored().h).toBe(60);
  expect(other.stored().h).toBe(30);
  one.at.dispose();
  other.at.dispose();
});

it('lets a tab not editing the note write nothing while the typist’s sizes arrive', () => {
  const a = typist();
  const b = tab(Y.encodeStateAsUpdate(a.at.doc));
  const onB = noteOn(b, a.id);
  const sent = b.sent();
  for (let typed = 1; typed <= 40; typed++) {
    a.text.insert('a', typed - 1);
    measureNoteSize(a.model, 'w', 7 * typed, true);
    relay(a.at, b);
    // The viewer's own frame measures the same text, unedited there.
    measureNoteSize(onB.model, 'w', 7 * typed, false);
    vi.advanceTimersByTime(100);
  }
  vi.advanceTimersByTime(NOTE_SIZE_IDLE_MS);
  relay(a.at, b);
  vi.advanceTimersByTime(NOTE_SIZE_VIEWER_MS);
  expect(b.sent() - sent).toBe(0);
  expect(onB.stored().w).toBe(280);
  b.dispose();
  a.at.dispose();
});

it('lets a tab not editing the note write a size it measures and no one stores, after 3 s', () => {
  const { at, model, stored, writes } = typist();
  // Its text changed with no one editing it here (a peer's agent, a font).
  measureNoteSize(model, 'h', 60, false);
  vi.advanceTimersByTime(NOTE_SIZE_VIEWER_MS - 100);
  expect(writes()).toBe(0);
  vi.advanceTimersByTime(100);
  expect(stored().h).toBe(60);
  // Its own write is no change its person made: what it measures next waits,
  // shown here.
  measureNoteSize(model, 'h', 70, false);
  expect(model.h).toBe(70);
  expect(stored().h).toBe(60);
  at.dispose();
});

it('ends a tab’s 3 s wait when someone else writes a size, the tab showing its own and writing nothing', () => {
  const { at, model, stored } = typist();
  measureNoteSize(model, 'h', 60, false);
  vi.advanceTimersByTime(NOTE_SIZE_VIEWER_MS - 100);
  // A peer's size arrives, still not what this tab measures.
  const peer = tab(Y.encodeStateAsUpdate(at.doc));
  peer.store.updateBlock(noteOn(peer, model.id).model, {
    xywh: '[100,100,10,40]',
  });
  relay(peer, at);
  vi.advanceTimersByTime(3 * NOTE_SIZE_VIEWER_MS);
  expect(stored().h).toBe(40);
  expect(model.h).toBe(60);
  peer.dispose();
  at.dispose();
});

it('shows what a read-only tab measures at once, and never writes it', () => {
  const a = typist(false);
  const viewer = tab(Y.encodeStateAsUpdate(a.at.doc));
  viewer.store.readonly = true;
  const onViewer = noteOn(viewer, a.id);
  const sent = viewer.sent();
  // Its fonts wrap the text taller than the stored 30: its frame, hit area and
  // connectors follow the text at once.
  measureNoteSize(onViewer.model, 'h', 62, false);
  expect(onViewer.model.h).toBe(62);
  // A peer's move and size land, what this tab measures shown over them.
  a.at.store.updateBlock(a.model, { xywh: '[150,100,10,40]' });
  relay(a.at, viewer);
  expect(onViewer.stored().toXYWH()).toEqual([150, 100, 10, 40]);
  expect(onViewer.model.xywh).toBe('[150,100,10,62]');
  // The waits, a save, a gesture and the board's close write nothing.
  vi.advanceTimersByTime(3 * NOTE_SIZE_VIEWER_MS);
  saveNoteSize(onViewer.model);
  noteGestureStarts(onViewer.model);
  noteGestureEnds(onViewer.model);
  vi.advanceTimersByTime(3 * NOTE_SIZE_VIEWER_MS);
  closeNoteSizes(viewer.store, 'save');
  expect(viewer.sent() - sent).toBe(0);
  expect(onViewer.stored().h).toBe(40);
  viewer.dispose();
  a.at.dispose();
});

it('lets two tabs that measure a note unlike each other show their own sizes, each writing once at most', () => {
  const a = typist(false);
  const b = tab(Y.encodeStateAsUpdate(a.at.doc));
  const onB = noteOn(b, a.id);
  const sent = a.at.sent() + b.sent();
  // A note no one edits, its text wrapped by each tab's own fonts.
  measureNoteSize(a.model, 'h', 60, false);
  measureNoteSize(onB.model, 'h', 62, false);
  for (let round = 0; round < 10; round++) {
    vi.advanceTimersByTime(NOTE_SIZE_VIEWER_MS);
    relay(a.at, b);
    relay(b, a.at);
  }
  expect(a.at.sent() + b.sent() - sent).toBeLessThanOrEqual(2);
  expect(a.model.h).toBe(60);
  expect(onB.model.h).toBe(62);
  b.dispose();
  a.at.dispose();
});

it('writes a step’s move of a note showing a size it does not act on with the stored size, so the step’s Undo moves the note back alone', () => {
  const { at, model, stored } = typist(false);
  measureNoteSize(model, 'h', 60, false);
  // A step from the bound the board shows, the note not selected.
  const bound = Bound.deserialize(model.xywh);
  bound.x = 40;
  at.store.updateBlock(model, { xywh: bound.serialize() });
  expect(stored().toXYWH()).toEqual([40, 100, 10, 30]);
  expect(model.xywh).toBe('[40,100,10,60]');
  at.store.captureSync();
  at.store.undo();
  expect(stored().toXYWH()).toEqual([100, 100, 10, 30]);
  expect(model.xywh).toBe('[100,100,10,60]');
  at.dispose();
});

it('stores the sizes the notes an align acts on show, untracked, and no other note’s', () => {
  const { at, model, stored } = typist(false);
  const other = noteOn(at, addNote(at, false));
  const grouped = noteOn(at, addNote(at, false));
  const group = surfaceOf(at).addElement({
    children: { [grouped.model.id]: true },
    type: 'group',
  });
  vi.advanceTimersByTime(NOTE_SIZE_IDLE_MS);
  // Selected: the note, and a group holding another.
  selectNoteSizes(at.store, () => [
    model,
    surfaceOf(at).getElementById(group)!,
  ]);
  measureNoteSize(model, 'h', 60, false);
  measureNoteSize(other.model, 'h', 50, false);
  measureNoteSize(grouped.model, 'h', 40, false);
  const others = other.writes();
  at.store.captureSync();
  // The toolbar's align, from the bounds the board shows.
  for (const note of [model, grouped.model]) {
    const bound = Bound.deserialize(note.xywh);
    bound.x = 40;
    at.store.updateBlock(note, { xywh: bound.serialize() });
  }
  expect(stored().toXYWH()).toEqual([40, 100, 10, 60]);
  expect(grouped.stored().toXYWH()).toEqual([40, 100, 10, 40]);
  expect(other.stored().toXYWH()).toEqual([100, 100, 10, 30]);
  expect(other.writes()).toBe(others);
  at.store.captureSync();
  at.store.undo();
  expect(stored().toXYWH()).toEqual([100, 100, 10, 60]);
  expect(grouped.stored().toXYWH()).toEqual([100, 100, 10, 40]);
  at.dispose();
});

it('lets a tab take its move of a note back after another tab that measures it unlike it steps elsewhere', () => {
  const a = typist(false);
  const b = tab(Y.encodeStateAsUpdate(a.at.doc));
  const onB = noteOn(b, a.id);
  // Two editors whose fonts wrap the text unlike each other.
  measureNoteSize(a.model, 'h', 60, false);
  measureNoteSize(onB.model, 'h', 62, false);
  // A drags the note.
  noteGestureStarts(a.model);
  a.at.store.captureSync();
  a.model.stash('xywh');
  const bound = Bound.deserialize(a.model.xywh);
  bound.x += 50;
  a.model.xywh = bound.serialize();
  a.at.store.transact(() => a.model.pop('xywh'));
  noteGestureEnds(a.model);
  relay(a.at, b);
  // B draws a shape elsewhere, its 3 s pass, and A takes its move back.
  surfaceOf(b).addElement(shapeAt(400));
  vi.advanceTimersByTime(NOTE_SIZE_VIEWER_MS);
  relay(b, a.at);
  // Undone is the move, not the step before it (the note's creation).
  a.at.store.undo();
  expect(a.at.store.hasBlock(a.id)).toBe(true);
  expect(a.stored().toXYWH()).toEqual([100, 100, 10, 60]);
  b.dispose();
  a.at.dispose();
});

it('stores a plain write of a note showing a size with that size', () => {
  const { model, stored, writes, at } = typist(false);
  measureNoteSize(model, 'h', 60, false);
  const before = writes();
  // The arrow keys' nudge, from the bound shown.
  const bound = Bound.deserialize(model.xywh);
  bound.y += 10;
  model.xywh = bound.serialize();
  expect(stored().toXYWH()).toEqual([100, 110, 10, 60]);
  vi.advanceTimersByTime(NOTE_SIZE_VIEWER_MS);
  expect(writes()).toBe(before + 1);
  at.dispose();
});

it('keeps a local write of a note showing a size in a read-only tab out of the store', () => {
  const a = typist(false);
  const viewer = tab(Y.encodeStateAsUpdate(a.at.doc));
  viewer.store.readonly = true;
  const onViewer = noteOn(viewer, a.id);
  const sent = viewer.sent();
  measureNoteSize(onViewer.model, 'h', 62, false);
  onViewer.model.xywh = '[140,100,10,62]';
  expect(viewer.sent() - sent).toBe(0);
  expect(onViewer.stored().toXYWH()).toEqual([100, 100, 10, 30]);
  expect(onViewer.model.xywh).toBe('[100,100,10,62]');
  viewer.dispose();
  a.at.dispose();
});

it('moves a connector’s label at the save, in its transaction, not per key', async () => {
  const { at, id, model, text } = typist();
  const surface = surfaceOf(at);
  const shape = surface.addElement({
    shapeType: 'rect',
    type: 'shape',
    xywh: '[100,400,100,100]',
  });
  const connector = surface.getElementById(
    surface.addElement({
      labelDisplay: true,
      labelOffset: { distance: 0.5 },
      labelXYWH: [0, 0, 60, 24],
      mode: 0,
      source: { id },
      target: { id: shape },
      text: new Y.Text('feeds'),
      type: 'connector',
    })
  ) as ConnectorElementModel;
  await vi.advanceTimersByTimeAsync(0);
  let placed = 0;
  connector.yMap.observe((event) => {
    if (event.keysChanged.has('labelXYWH')) placed++;
  });
  for (let typed = 1; typed <= 6; typed++) {
    text.insert('a', typed - 1);
    measureNoteSize(model, 'h', 30 + 20 * typed, true);
    await vi.advanceTimersByTimeAsync(50);
  }
  expect(placed).toBe(0);
  const sent = at.sent();
  await vi.advanceTimersByTimeAsync(NOTE_SIZE_IDLE_MS);
  expect(placed).toBe(1);
  expect(at.sent() - sent).toBe(1);
  at.dispose();
});

// Review of local change 83: a note showing a size this tab measured keeps
// its `xywh` stashed (local change 75), which the connector watcher took for
// a gesture: a label hanging on it stayed this tab's for as long as the size
// showed, and an Undo took a move back without it. Fails if this tab's move
// of the connector's other end leaves its label unstored.
it('stores the label of a connector hanging on a note that shows a measured size as this tab moves its other end, taken back with the move', async () => {
  const { at, id, model } = typist(false);
  const surface = surfaceOf(at);
  const shape = surface.addElement(shapeAt(400));
  const connector = surface.getElementById(
    surface.addElement({
      labelDisplay: true,
      labelOffset: { distance: 0.5 },
      labelXYWH: [0, 0, 60, 24],
      mode: 0,
      source: { id },
      target: { id: shape },
      text: new Y.Text('feeds'),
      type: 'connector',
    })
  ) as ConnectorElementModel;
  await vi.advanceTimersByTimeAsync(0);
  // This tab's fonts wrap the text taller than the stored 30: it shows that.
  measureNoteSize(model, 'h', 62, false);
  await vi.advanceTimersByTimeAsync(0);
  expect(model.h).toBe(62);
  const before = connector.yMap.get('labelXYWH');
  at.store.captureSync();
  surface.updateElement(shape, { xywh: '[400,600,10,10]' });
  await vi.advanceTimersByTimeAsync(0);
  expect(connector.labelXYWH).not.toEqual(before);
  expect(connector.yMap.get('labelXYWH')).toEqual(connector.labelXYWH);
  // One Undo takes the move and the label back.
  at.store.undo();
  expect(connector.yMap.get('labelXYWH')).toEqual(before);
  at.dispose();
});

it.each([
  [
    'its 3 s wait ends',
    (model: NoteBlockModel) => {
      measureNoteSize(model, 'h', 60, false);
      vi.advanceTimersByTime(NOTE_SIZE_VIEWER_MS);
    },
  ],
  [
    'a drag starts',
    (model: NoteBlockModel) => {
      measureNoteSize(model, 'h', 60, false);
      noteGestureStarts(model);
    },
  ],
] as const)(
  'places a connector’s label in the untracked write of the size a tab shows when %s, adding nothing to Undo',
  async (_, stores) => {
    const { at, id } = typist(false);
    const surface = surfaceOf(at);
    const shape = surface.addElement(shapeAt(400));
    const joined = surface.addElement({
      labelDisplay: true,
      labelOffset: { distance: 0.5 },
      labelXYWH: [0, 0, 60, 24],
      mode: 0,
      source: { id, position: [0.5, 1] },
      target: { id: shape, position: [0.5, 0] },
      text: new Y.Text('feeds'),
      type: 'connector',
    });
    await vi.advanceTimersByTimeAsync(0);
    // A tab with nothing to undo yet.
    const other = tab(Y.encodeStateAsUpdate(at.doc));
    const connector = surfaceOf(other).getElementById(
      joined
    ) as ConnectorElementModel;
    await vi.advanceTimersByTimeAsync(0);
    const placed = connector.labelXYWH;
    stores(noteOn(other, id).model);
    await vi.advanceTimersByTimeAsync(0);
    expect(noteOn(other, id).stored().h).toBe(60);
    expect(connector.labelXYWH).not.toEqual(placed);
    expect(other.store.canUndo).toBe(false);
    other.dispose();
    at.dispose();
  }
);

it.each([
  ['straight', 0],
  ['elbowed', 1],
  ['curved', 2],
] as const)(
  'shows a connector’s label on the path a tab shows for a note’s measured size, and writes nothing (%s)',
  async (_, mode) => {
    const { at, id } = typist(false);
    const surface = surfaceOf(at);
    const shape = surface.addElement({
      shapeType: 'rect',
      type: 'shape',
      xywh: '[55,400,100,100]',
    });
    // From the note's bottom to the shape's top, its label placed by its maker.
    const joined = surface.addElement({
      labelDisplay: true,
      labelOffset: { distance: 0.5 },
      labelXYWH: [0, 0, 60, 24],
      mode,
      source: { id, position: [0.5, 1] },
      target: { id: shape, position: [0.5, 0] },
      text: new Y.Text('feeds'),
      type: 'connector',
    });
    await vi.advanceTimersByTimeAsync(0);
    const viewer = tab(Y.encodeStateAsUpdate(at.doc));
    viewer.store.readonly = true;
    const onViewer = noteOn(viewer, id);
    const connector = surfaceOf(viewer).getElementById(
      joined
    ) as ConnectorElementModel;
    await vi.advanceTimersByTimeAsync(0);
    const stored = connector.labelXYWH;
    const sent = viewer.sent();
    measureNoteSize(onViewer.model, 'h', 230, false);
    await vi.advanceTimersByTimeAsync(NOTE_SIZE_VIEWER_MS);
    // The path starts at the bottom the tab shows, 200 below the stored one.
    expect(connector.absolutePath[0][1]).toBe(330);
    // The point its offset puts on that path.
    const middle = connector.getPointByOffsetDistance(0.5);
    const [x, y] = connector.getNearestPoint(middle);
    expect(Math.hypot(x - middle[0], y - middle[1])).toBeLessThan(0.5);
    expect(Bound.fromXYWH(stored!).isPointInBound(middle)).toBe(false);
    // Its label is drawn and hit there, and stays stored where it was.
    expect(connector.labelIncludesPoint(middle)).toBe(true);
    expect(connector.elementBound.isPointInBound(middle)).toBe(true);
    expect(connector.labelXYWH).toEqual(stored);
    expect(viewer.sent() - sent).toBe(0);
    viewer.dispose();
    at.dispose();
  }
);
