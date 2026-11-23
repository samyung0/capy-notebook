import { isInlineNote, type NoteBlockModel } from '@blocksuite/affine-model';
import { noteSizeWrites } from '@blocksuite/affine-shared/utils';
import {
  almostEqual,
  Bound,
  type SerializedXYWH,
} from '@blocksuite/global/gfx';
import type { Store } from '@blocksuite/store';

/* Capy (local change 75): a board note's size, as its text measures it (the
 * mask's height, an inline note's width), reaches the room without a write per
 * key. Saved on every key, each size took the clock between two typed
 * characters, so no two merged into one run (an 80-character note held about
 * 173 structs against 80 bytes of text).
 *
 * - The tab whose person changed the note shows what it measures at once, as
 *   its own (`xywh` stashed: the frame, the selection box and connector paths
 *   follow), and saves it 500 ms after the last measure, at most 2 s after the
 *   first unsaved one. That tab is the one editing the note, or the one whose
 *   own change that can resize the note (its text or blocks, an Undo of them,
 *   the Inline toggle, a resize, a gesture's end; not a move or a colour) came
 *   less than 500 ms before the measure.
 * - It saves at once, untracked, when editing ends, the block disconnects, the
 *   page is hidden, the board is saved, a drag, resize or turn starts (the
 *   gesture then has its own stash and its own tracked pop), or any tracked
 *   step of the store starts (align, `updateBlock`): the step's Undo keeps the
 *   size. A plain write of the model (the arrow keys' nudge) stores it with
 *   it, untracked as the write is. A peer's or an Undo's write shows at once,
 *   the measured size over it. Connector labels move at the save, inside its
 *   transaction.
 * - Every other tab holds nothing: it writes what it measures only once that
 *   has differed from the stored size for 3 s (the typist's longest wait and
 *   1 s) with no new size arriving, so a note no one edits still gets its size.
 *   A drag, resize or turn starting writes it first.
 * - A read-only store writes nothing: a waiting size is dropped. Unlocked, the
 *   board measures its notes again; a size the lock dropped is this tab's own.
 * - A locked note (`sizeIsFixed`: BlockSuite's lock, its own or a group's, as
 *   a question's elements on a student's copy) keeps its stored size: no tab
 *   holds, saves or writes one, and a lock arriving while a size waits drops
 *   it. Unlocked, it is measured again as by a tab not editing it (3 s).
 * - Closed, a board saves its waiting sizes, or drops them when the room lost,
 *   refused or replaced it, and writes nothing more.
 * - The width is written only while the note is inline. */

export const NOTE_SIZE_IDLE_MS = 500;
export const NOTE_SIZE_MAX_WAIT_MS = 2000;
export const NOTE_SIZE_VIEWER_MS = NOTE_SIZE_MAX_WAIT_MS + 1000;

/** A measured width and height, before the note's scale. */
type Size = { w?: number; h?: number };

type Held = Size & {
  /** When the first unsaved size was measured. */
  first: number;
  timer?: ReturnType<typeof setTimeout>;
  unwatch: () => void;
};

type Differing = Size & {
  /** The stored width and height the wait started against. */
  stored: string;
  timer: ReturnType<typeof setTimeout>;
  unwatch: () => void;
};

type Transaction = NonNullable<Store['spaceDoc']['_transaction']>;
type SharedType = Transaction['changed'] extends Map<infer T, unknown>
  ? T
  : never;

/** Sizes the tab whose person changed the note holds until a pause. */
const held = new Map<NoteBlockModel, Held>();
/** Sizes a tab not editing the note measured unlike the stored one. */
const differing = new Map<NoteBlockModel, Differing>();
/** Notes a drag, resize or turn holds: its stash takes what is measured. */
const moving = new Set<NoteBlockModel>();
/** What each note's text last measured, read-only or not. */
const latest = new WeakMap<NoteBlockModel, Size>();
/** When this tab's person last changed the note or its text in a way that
 * can change its size. */
const touched = new WeakMap<NoteBlockModel, number>();
/** Notes whose held size the board's lock dropped. */
const dropped = new WeakSet<NoteBlockModel>();
/** Each store's notes measured, or whose size was dropped, while locked: they
 * are measured again once unlocked. */
const fixed = new WeakMap<Store, Set<NoteBlockModel>>();
/** Stores watched for their person's changes, and how to stop. */
const opened = new WeakMap<Store, () => void>();
/** Stores whose board closed: nothing is measured or written there again. */
const closed = new WeakSet<Store>();
/** A write of this module's own is under way: no person's change. */
let writing = false;

const storedOf = (note: NoteBlockModel) =>
  note.yBlock.get('prop:xywh') as SerializedXYWH;

const scaleOf = (note: NoteBlockModel) => note.props.edgeless.scale ?? 1;

const empty = (size: Size) => size.w === undefined && size.h === undefined;

const detached = (note: NoteBlockModel) =>
  note.store.getBlock(note.id)?.model !== note;

/** Whether the note keeps its stored size whatever its text measures:
 * BlockSuite's lock, the note's own or a group's. */
const sizeIsFixed = (note: NoteBlockModel) => note.isLocked();

const storedSize = (xywh: SerializedXYWH) => {
  const [, , w, h] = Bound.deserialize(xywh).toXYWH();
  return `${w},${h}`;
};

/** This tab's person changed the note or its text, in a way that can resize
 * it, less than 500 ms ago. */
const ownChange = (note: NoteBlockModel) => {
  const at = touched.get(note);
  return at !== undefined && Date.now() - at < NOTE_SIZE_IDLE_MS;
};

/** `xywh` with the measured size over it, its width only while inline. */
function sized(note: NoteBlockModel, xywh: SerializedXYWH, size: Size) {
  const bound = Bound.deserialize(xywh);
  const scale = scaleOf(note);
  if (size.w !== undefined && isInlineNote(note.props))
    bound.w = size.w * scale;
  if (size.h !== undefined) bound.h = size.h * scale;
  return bound.serialize();
}

/** Shows `xywh` as the note's in this tab, as a size only it shows. */
function show(note: NoteBlockModel, xywh: SerializedXYWH) {
  if (note.xywh === xywh) return;
  noteSizeWrites.local(note, () => {
    note.xywh = xywh;
  });
}

/** This module's own write: untracked, in a transaction of its own unless one
 * is open. */
function write(store: Store, fn: () => void) {
  const before = writing;
  writing = true;
  try {
    store.transact(fn, false);
  } finally {
    writing = before;
  }
}

/** Where `type` sits: the block holding it, by its key in the blocks map, and
 * the key of that block's value holding it (none for the block's own map). */
function placeOf(blocks: object, type: SharedType) {
  let key: string | null = null;
  for (let current = type; ; ) {
    const item = current._item;
    if (!item) return null;
    if (item.parent === blocks)
      return item.parentSub ? { id: item.parentSub, key } : null;
    key = item.parentSub;
    if (!item.parent || !('_item' in item.parent)) return null;
    current = item.parent;
  }
}

function noteOf(store: Store, id: string) {
  let model = store.getModelById(id);
  while (model && model.flavour !== 'affine:note')
    model = store.getParent(model);
  return model as NoteBlockModel | null;
}

/** Whether a change of the note's own values can change its size: its blocks,
 * its scale and style (inline or a card), its width or height, a fill making
 * it inline or a card. Where it stands, its turn or its colour cannot. */
function resizes(
  transaction: Transaction,
  note: NoteBlockModel,
  type: SharedType,
  key: string | null,
  keys: Set<string | null>
) {
  // Inside one of its values (its style, its list of blocks).
  if (key) return key === 'prop:edgeless' || key === 'sys:children';
  const before = (changed: string): unknown =>
    transaction.changedParentTypes
      .get(type)
      ?.find(event => event.target === type)
      ?.keys.get(changed)?.oldValue;
  for (const changed of keys) {
    if (changed === 'sys:children' || changed === 'prop:edgeless') return true;
    if (changed === 'prop:xywh') {
      const xywh = before(changed);
      if (
        typeof xywh !== 'string' ||
        storedSize(xywh as SerializedXYWH) !== storedSize(storedOf(note))
      )
        return true;
    }
    if (
      changed === 'prop:background' &&
      isInlineNote({
        background: before(changed),
        edgeless: note.props.edgeless,
      }) !== isInlineNote(note.props)
    )
      return true;
  }
  return false;
}

/** Keys whose change can lock or unlock a note: a block's lock, a frame's
 * children, a surface element's lock or children (a group's). */
const LOCK_KEYS = [
  'prop:lockedBySelf',
  'prop:childElementIds',
  'lockedBySelf',
  'children',
];

/** Whether the transaction can have locked or unlocked a note: one of those
 * keys changed, a block (a frame) was added or went, a frame's or a group's
 * children changed, or a surface element (a group) was added or went. A typed
 * key, a shape's text or a move changes none, so it checks no lock. */
function changesLocks(store: Store, blocks: object, transaction: Transaction) {
  for (const [type, keys] of transaction.changed) {
    if (type === blocks || LOCK_KEYS.some(key => keys.has(key))) return true;
    const sub = type._item?.parentSub;
    if (sub === 'prop:childElementIds') return true;
    // A group's children, or the surface's elements (Boxed, under `value`).
    if (sub !== 'children' && sub !== 'value') continue;
    const place = placeOf(blocks, type);
    if (place && store.getBlock(place.id)?.flavour === 'affine:surface')
      return true;
  }
  return false;
}

/** Watches `store` for its person's own changes to notes and their text that
 * can change their size, and for locks made or lifted by anyone, and saves its
 * waiting sizes before each tracked step. Opened by its board as it mounts (a
 * first note's creation counts), else by the first measure. */
export function openNoteSizes(store: Store) {
  if (opened.has(store) || closed.has(store)) return;
  const doc = store.spaceDoc;
  const blocks: object = store.doc.yBlocks;
  const touch = (transaction: Transaction) => {
    if (changesLocks(store, blocks, transaction)) checkLocks(store);
    // A peer's update, applied, is not local.
    if (!transaction.local || writing) return;
    const now = Date.now();
    const mark = (id: string | null) => {
      const note = id ? noteOf(store, id) : null;
      if (note) touched.set(note, now);
    };
    for (const [type, keys] of transaction.changed) {
      // A block added: a note, or a block of a note's text.
      if (type === blocks) {
        keys.forEach(mark);
        continue;
      }
      const place = placeOf(blocks, type);
      const note = place && noteOf(store, place.id);
      if (!(place && note)) continue;
      // A block of its text, or the note itself.
      if (
        note.id !== place.id ||
        resizes(transaction, note, type, place.key, keys)
      )
        touched.set(note, now);
    }
  };
  doc.on('afterTransaction', touch);
  const { transact } = store;
  store.transact = (fn, shouldTransact) => {
    // Stored before the step, on its own: undoing the step keeps the size.
    if (shouldTransact !== false && !doc._transaction) saveNoteSizes(store);
    transact.call(store, fn, shouldTransact);
  };
  opened.set(store, () => {
    doc.off('afterTransaction', touch);
    Reflect.deleteProperty(store, 'transact');
  });
}

let hideListened = false;

/** A page leaving hides first (`visibilitychange` before `pagehide`). */
function saveAllOnHide() {
  if (hideListened) return;
  hideListened = true;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden')
      [...held.keys()].forEach(saveNoteSize);
  });
}

function watch(note: NoteBlockModel) {
  const changes = note.propsUpdated.subscribe(({ key }) => {
    if (noteSizeWrites.isLocal(note.store, note.id)) return;
    if (key === 'xywh' || key === 'background' || key === 'edgeless')
      changed(note, key);
  });
  const deleted = note.deleted.subscribe(() => forget(note));
  return () => {
    changes.unsubscribe();
    deleted.unsubscribe();
  };
}

function release(note: NoteBlockModel) {
  const entry = held.get(note);
  if (!entry) return;
  clearTimeout(entry.timer);
  entry.unwatch();
  held.delete(note);
}

function stopDiffering(note: NoteBlockModel) {
  const entry = differing.get(note);
  if (!entry) return;
  clearTimeout(entry.timer);
  entry.unwatch();
  differing.delete(note);
}

function forget(note: NoteBlockModel) {
  release(note);
  stopDiffering(note);
  moving.delete(note);
}

/** Drops the note's waiting size: it shows the stored one again, and nothing
 * is written. */
function drop(note: NoteBlockModel) {
  stopDiffering(note);
  if (!held.has(note)) return;
  release(note);
  if (detached(note)) return;
  show(note, storedOf(note));
  // Equal to the stored value: the pop writes nothing.
  note.pop('xywh');
}

/** The note is locked: a waiting size is dropped, and it is measured again
 * once unlocked. */
function fix(note: NoteBlockModel) {
  drop(note);
  let notes = fixed.get(note.store);
  if (!notes) fixed.set(note.store, (notes = new Set()));
  notes.add(note);
}

/** After a change of `store` that can lock or unlock notes, this tab's or a
 * peer's: a note it locked (the note's own lock or a group's) drops its
 * waiting size; one it unlocked is measured again, as by a tab not editing it,
 * so the 3 s rule applies. */
function checkLocks(store: Store) {
  for (const note of [...held.keys(), ...differing.keys()])
    if (note.store === store && sizeIsFixed(note)) fix(note);
  const notes = fixed.get(store);
  if (!notes) return;
  for (const note of [...notes]) {
    if (detached(note)) notes.delete(note);
    else if (!sizeIsFixed(note)) {
      notes.delete(note);
      measureAgain(note, false);
    }
  }
}

function changed(note: NoteBlockModel, key: string) {
  const entry = held.get(note);
  if (entry) {
    if (key === 'xywh' && note.xywh !== storedOf(note)) {
      // A plain write of the model, outside the store's steps (each saved the
      // size before it began): it stores the size with it.
      release(note);
      note.pop('xywh');
      return;
    }
    if (entry.w !== undefined && !isInlineNote(note.props)) delete entry.w;
    if (empty(entry)) return drop(note);
    // A peer's or an Undo's write, the measured size shown over it.
    show(note, sized(note, storedOf(note), entry));
    return;
  }
  const other = differing.get(note);
  if (!other) return;
  const stored = Bound.deserialize(storedOf(note));
  const scale = scaleOf(note);
  if (
    other.w !== undefined &&
    (!isInlineNote(note.props) || almostEqual(stored.w, other.w * scale))
  )
    delete other.w;
  if (other.h !== undefined && almostEqual(stored.h, other.h * scale))
    delete other.h;
  if (empty(other)) return stopDiffering(note);
  const size = storedSize(storedOf(note));
  if (size === other.stored) return;
  // A new size arrived: the wait starts again.
  other.stored = size;
  clearTimeout(other.timer);
  other.timer = setTimeout(() => writeDiffering(note), NOTE_SIZE_VIEWER_MS);
}

function forgetWidth(note: NoteBlockModel) {
  const entry = held.get(note);
  if (entry?.w !== undefined) {
    delete entry.w;
    if (empty(entry)) drop(note);
    else show(note, sized(note, storedOf(note), entry));
  }
  const other = differing.get(note);
  if (other?.w !== undefined) {
    delete other.w;
    if (empty(other)) stopDiffering(note);
  }
}

function hold(
  note: NoteBlockModel,
  dimension: 'w' | 'h',
  size: number,
  bound: Bound
) {
  const now = Date.now();
  let entry = held.get(note);
  if (!entry) {
    stopDiffering(note);
    saveAllOnHide();
    entry = { first: now, unwatch: watch(note) };
    held.set(note, entry);
    noteSizeWrites.local(note, () => note.stash('xywh'));
  }
  entry[dimension] = size;
  clearTimeout(entry.timer);
  bound[dimension] = size * scaleOf(note);
  show(note, bound.serialize());
  const wait = Math.min(
    NOTE_SIZE_IDLE_MS,
    entry.first + NOTE_SIZE_MAX_WAIT_MS - now
  );
  entry.timer = setTimeout(() => saveNoteSize(note), Math.max(0, wait));
}

function differ(note: NoteBlockModel, dimension: 'w' | 'h', size: number) {
  const stored = storedOf(note);
  let entry = differing.get(note);
  if (almostEqual(Bound.deserialize(stored)[dimension], size * scaleOf(note))) {
    if (!entry) return;
    delete entry[dimension];
    if (empty(entry)) stopDiffering(note);
    return;
  }
  if (!entry) {
    entry = {
      stored: storedSize(stored),
      timer: setTimeout(() => writeDiffering(note), NOTE_SIZE_VIEWER_MS),
      unwatch: watch(note),
    };
    differing.set(note, entry);
  }
  entry[dimension] = size;
}

function writeDiffering(note: NoteBlockModel) {
  const entry = differing.get(note);
  if (!entry) return;
  stopDiffering(note);
  if (detached(note)) return;
  if (sizeIsFixed(note)) return fix(note);
  // A gesture under way stores what it shows when it ends.
  if (note.store.readonly || moving.has(note)) return;
  const stored = storedOf(note);
  const xywh = sized(note, stored, entry);
  if (xywh !== stored)
    write(note.store, () => {
      note.xywh = xywh;
    });
}

/** The note's last measure, again; `own`: as this tab's person's change. */
function measureAgain(note: NoteBlockModel, own: boolean) {
  const size = latest.get(note);
  if (size?.w !== undefined) measureNoteSize(note, 'w', size.w, own);
  if (size?.h !== undefined) measureNoteSize(note, 'h', size.h, own);
}

/** The note's text measures `size` (before its scale) as its width or
 * height. `editing`: this tab's user is editing the note. */
export function measureNoteSize(
  note: NoteBlockModel,
  dimension: 'w' | 'h',
  size: number,
  editing: boolean
) {
  if (closed.has(note.store)) return;
  openNoteSizes(note.store);
  let last = latest.get(note);
  if (!last) latest.set(note, (last = {}));
  last[dimension] = size;
  if (sizeIsFixed(note)) return fix(note);
  if (note.store.readonly) return drop(note);
  if (dimension === 'w' && !isInlineNote(note.props)) return forgetWidth(note);
  const bound = Bound.deserialize(note.xywh);
  const same = almostEqual(bound[dimension], size * scaleOf(note));
  if (moving.has(note)) {
    // The gesture's stash takes it, and its end stores it with the gesture.
    bound[dimension] = size * scaleOf(note);
    if (!same) show(note, bound.serialize());
    return;
  }
  if (editing || held.has(note) || ownChange(note)) {
    if (!same) hold(note, dimension, size, bound);
    return;
  }
  differ(note, dimension, size);
}

/** Saves the note's waiting size now, if one waits. */
export function saveNoteSize(note: NoteBlockModel) {
  const entry = held.get(note);
  if (!entry) return;
  if (detached(note)) return forget(note);
  if (sizeIsFixed(note)) return fix(note);
  if (note.store.readonly) return drop(note);
  release(note);
  const xywh = sized(note, storedOf(note), entry);
  write(note.store, () => {
    show(note, xywh);
    note.pop('xywh');
    noteSizeWrites.saved(note);
  });
}

/** Saves every size waiting in `store` (a drawing answer saved or closed). */
export function saveNoteSizes(store: Store) {
  for (const note of [...held.keys()])
    if (note.store === store) saveNoteSize(note);
}

/** Drops every size waiting in `store`, writing nothing (a board locked). */
export function dropNoteSizes(store: Store) {
  for (const note of [...held.keys(), ...differing.keys()]) {
    if (note.store !== store) continue;
    if (held.has(note)) dropped.add(note);
    drop(note);
  }
}

/** `store` takes edits again (a board unlocked): every note's last measure
 * goes through again, nothing having measured it since the lock dropped its
 * size; a size the lock dropped is this tab's own. */
export function measureNoteSizesAgain(store: Store) {
  for (const model of store.getModelsByFlavour('affine:note')) {
    const note = model as NoteBlockModel;
    measureAgain(note, dropped.delete(note));
  }
}

/** The board of `store` closes: its waiting sizes are saved, or dropped when
 * the room lost, refused or replaced it; every wait stops, a viewer's too, and
 * nothing is measured or written there again. */
export function closeNoteSizes(store: Store, sizes: 'save' | 'drop') {
  if (sizes === 'save') saveNoteSizes(store);
  for (const note of [...held.keys(), ...differing.keys(), ...moving]) {
    if (note.store !== store) continue;
    drop(note);
    moving.delete(note);
  }
  opened.get(store)?.();
  opened.delete(store);
  fixed.delete(store);
  closed.add(store);
}

/** A drag, resize or turn of the note starts: a waiting size is written first,
 * the held one or a viewer's, so the gesture's stash and its tracked pop start
 * from it; what is measured until it ends goes with the gesture. */
export function noteGestureStarts(note: NoteBlockModel) {
  saveNoteSize(note);
  writeDiffering(note);
  moving.add(note);
}

/** The gesture ends, its pop written: a measured size its write did not take
 * waits as this tab's own. */
export function noteGestureEnds(note: NoteBlockModel) {
  moving.delete(note);
  measureAgain(note, true);
}
