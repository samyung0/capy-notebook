import { isInlineNote, type NoteBlockModel } from '@blocksuite/affine-model';
import { noteSizeWrites } from '@blocksuite/affine-shared/utils';
import {
  almostEqual,
  Bound,
  type SerializedXYWH,
} from '@blocksuite/global/gfx';
import { type GfxModel, isGfxGroupCompatibleModel } from '@blocksuite/std/gfx';
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
 * - Every other tab shows what it measures at once too, as a size only it shows
 *   (`xywh` stashed: hit tests, the selection box and connector paths follow
 *   the text it shows, and a connector's label its path, unwritten), and
 *   writes what it measures
 *   only once that has differed from the stored size for 3 s (the typist's
 *   longest wait and 1 s), so a note no one edits still gets its size. A size
 *   someone else writes meanwhile ends the wait: the tab goes on showing its
 *   own and writes nothing. Before a drag, resize or turn, and before a tracked
 *   step of the store for the notes the step can act on (the selection, a
 *   selected group's or frame's: an align), it stores the size it shows,
 *   untracked, so the step starts from the bound shown, the note is stored as
 *   it shows, and the step's Undo keeps the size. No other note: a step
 *   elsewhere writing a note would stop another tab's Undo of it (Yjs never
 *   undoes over a later write). A step that writes a note it did not store
 *   writes the stored size where it kept the one shown; a plain write (the
 *   arrow keys' nudge) is stored as written, the size shown with it. A peer's
 *   or an Undo's write shows at once, what this tab measures over it.
 * - A read-only store writes nothing: a waiting size is dropped, what this tab
 *   measures still shown, and a local write of a note showing a size stays out
 *   of the store. Unlocked, the board measures its notes again; a size
 *   the lock dropped is this tab's own.
 * - A locked note (`sizeIsFixed`: BlockSuite's lock, its own or a group's, as
 *   a question's elements on a student's copy) keeps its stored size: no tab
 *   holds, saves or writes one (each shows what it measures), and a lock
 *   arriving while a size waits drops it. Unlocked, it is measured again as by
 *   a tab not editing it (3 s).
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
/** Each store's selection, as its board reads it. */
const selections = new WeakMap<Store, () => readonly GfxModel[]>();
/** Stores whose board closed: nothing is measured or written there again. */
const closed = new WeakSet<Store>();
/** Notes this tab shows at what it measures without holding the size (a tab
 * not editing the note, read-only, or the note locked), and the `xywh` shown:
 * never written from here. */
const shown = new Map<NoteBlockModel, SerializedXYWH>();
/** Notes this tab measured, and how to stop watching their stored values. */
const observed = new Map<NoteBlockModel, () => void>();
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

/** Stores the size each note of `store` showing one shows, if a step can act
 * on it: it is selected, or in a selected group or frame. Each shown note is
 * checked against the selection, so a step with none (most of them) costs a
 * look at the selection. */
function storeActedOn(store: Store) {
  const selected = selections.get(store)?.();
  if (!selected?.length) return;
  const ids = new Set(selected.map(model => model.id));
  const groups = selected.some(isGfxGroupCompatibleModel);
  for (const note of [...shown.keys()])
    if (
      note.store === store &&
      (ids.has(note.id) ||
        (groups && note.groups.some(group => ids.has(group.id))))
    )
      storeShown(note);
}

/** `store`'s board reads its selection with `selected`: before a step, the
 * notes it can act on store the sizes they show. */
export function selectNoteSizes(
  store: Store,
  selected: () => readonly GfxModel[]
) {
  selections.set(store, selected);
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
    // A note the step can act on (an align's) is stored at the size it shows;
    // no other, never after the step (either would stop an Undo: Yjs never
    // undoes over a later write).
    if (shouldTransact !== false && !doc._transaction) {
      saveNoteSizes(store);
      storeActedOn(store);
    }
    transact.call(store, fn, shouldTransact);
  };
  opened.set(store, () => {
    doc.off('afterTransaction', touch);
    Reflect.deleteProperty(store, 'transact');
    selections.delete(store);
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
  shown.delete(note);
  observed.get(note)?.();
  observed.delete(note);
}

/** Drops the note's waiting size, writing nothing: what this tab measures
 * shows as a size only it shows. */
function drop(note: NoteBlockModel) {
  stopDiffering(note);
  if (held.has(note)) {
    release(note);
    if (detached(note)) return;
    show(note, storedOf(note));
    // Equal to the stored value: the pop writes nothing.
    note.pop('xywh');
  }
  display(note);
}

/** The dimensions of `size` the note's stored size differs from (the width
 * only while inline). */
function differences(note: NoteBlockModel, size: Size | undefined) {
  const stored = Bound.deserialize(storedOf(note));
  const scale = scaleOf(note);
  const differs: Size = {};
  if (
    size?.w !== undefined &&
    isInlineNote(note.props) &&
    !almostEqual(stored.w, size.w * scale)
  )
    differs.w = size.w;
  if (size?.h !== undefined && !almostEqual(stored.h, size.h * scale))
    differs.h = size.h;
  return differs;
}

/** Shows what the note's text last measured over its stored values, as a size
 * only this tab shows and never writes (`xywh` stashed), unless this tab holds
 * the size, a gesture moves the note or it measures as stored. */
function display(note: NoteBlockModel) {
  if (
    held.has(note) ||
    moving.has(note) ||
    closed.has(note.store) ||
    detached(note)
  )
    return;
  const size = differences(note, latest.get(note));
  if (empty(size)) return hide(note);
  if (!shown.has(note)) noteSizeWrites.local(note, () => note.stash('xywh'));
  const xywh = sized(note, storedOf(note), size);
  shown.set(note, xywh);
  show(note, xywh);
}

/** Stops showing what the note measures: the stored size shows again, and
 * nothing is written. */
function hide(note: NoteBlockModel) {
  if (!shown.delete(note) || detached(note)) return;
  show(note, storedOf(note));
  // Equal to the stored value: the pop writes nothing.
  note.pop('xywh');
}

/** Stores the size this tab shows, untracked, before a gesture or a step that
 * acts on the note writes it, so the note is stored as it shows (a preview, a
 * tab that has not drawn it) and undoing the step keeps the size; its
 * connectors' labels are placed in the same write. Never in a read-only store
 * or for a locked note. */
function storeShown(note: NoteBlockModel) {
  if (
    !shown.has(note) ||
    note.store.readonly ||
    sizeIsFixed(note) ||
    detached(note)
  )
    return;
  stopDiffering(note);
  const xywh = sized(note, storedOf(note), differences(note, latest.get(note)));
  hide(note);
  write(note.store, () => {
    note.xywh = xywh;
    noteSizeWrites.saved(note);
  });
}

/** A write of the model while the note shows what this tab measures, which
 * the stash keeps here. Read-only, it stays out of the store, and the size
 * shows again. A plain write (the arrow keys' nudge, untracked itself) is
 * stored as written, the size shown with it. Inside a step that began
 * without storing the size (one that does not act on the note), it is written
 * in that step with the stored size where it kept the one shown, so the
 * step's Undo moves the note back alone. */
function passOn(note: NoteBlockModel, before: SerializedXYWH) {
  if (note.store.readonly) return display(note);
  const written = Bound.deserialize(note.xywh);
  if (note.store.spaceDoc._transaction) {
    const was = Bound.deserialize(before);
    const stored = Bound.deserialize(storedOf(note));
    if (almostEqual(written.w, was.w)) written.w = stored.w;
    if (almostEqual(written.h, was.h)) written.h = stored.h;
  }
  shown.delete(note);
  show(note, written.serialize());
  note.pop('xywh');
  display(note);
}

/** Watches the stored values of a note this tab measures: a peer's or an
 * Undo's write shows at once, what this tab measures over it; a write of the
 * model while a size shows goes on to the store. */
function observe(note: NoteBlockModel) {
  if (observed.has(note)) return;
  const changes = note.propsUpdated.subscribe(({ key }) => {
    if (key !== 'xywh' && key !== 'background' && key !== 'edgeless') return;
    if (noteSizeWrites.isLocal(note.store, note.id)) return;
    const before = shown.get(note);
    if (key === 'xywh' && before && note.xywh !== storedOf(note))
      return passOn(note, before);
    display(note);
  });
  const deleted = note.deleted.subscribe(() => forget(note));
  observed.set(note, () => {
    changes.unsubscribe();
    deleted.unsubscribe();
  });
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
  // A size someone else wrote (a peer's, an Undo's) ends the wait: this tab
  // shows what it measures over it and writes nothing, so no later write of
  // its own takes that writer's step out of their Undo (Yjs never undoes over
  // a later write).
  if (storedSize(storedOf(note)) !== other.stored) stopDiffering(note);
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
    // A size shown here hands its stash over.
    shown.delete(note);
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
  if (xywh !== stored) {
    // The size shown here steps aside, so the write reaches the store; its
    // connectors' labels are placed in the same write.
    hide(note);
    write(note.store, () => {
      note.xywh = xywh;
      noteSizeWrites.saved(note);
    });
  }
  display(note);
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
  observe(note);
  let last = latest.get(note);
  if (!last) latest.set(note, (last = {}));
  last[dimension] = size;
  settle(note, dimension, size, editing);
  // What it measures shows at once in every tab, held or not.
  display(note);
}

function settle(
  note: NoteBlockModel,
  dimension: 'w' | 'h',
  size: number,
  editing: boolean
) {
  if (sizeIsFixed(note)) return fix(note);
  if (note.store.readonly) return drop(note);
  if (dimension === 'w' && !isInlineNote(note.props)) return forgetWidth(note);
  // Against the size this tab holds or a gesture moves, else the stored one:
  // a size only shown here waits as any other.
  const holding = held.has(note) || moving.has(note);
  const bound = Bound.deserialize(holding ? note.xywh : storedOf(note));
  const same = almostEqual(bound[dimension], size * scaleOf(note));
  if (moving.has(note)) {
    // The gesture's stash takes it, and its end stores it with the gesture.
    bound[dimension] = size * scaleOf(note);
    if (!same) show(note, bound.serialize());
    return;
  }
  if (editing || held.has(note) || ownChange(note)) {
    if (!same) hold(note, dimension, size, Bound.deserialize(note.xywh));
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
  // A width it did not hold, measured unlike the stored one.
  display(note);
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
  closed.add(store);
  for (const note of [...held.keys(), ...differing.keys(), ...moving]) {
    if (note.store !== store) continue;
    drop(note);
    moving.delete(note);
  }
  for (const note of [...shown.keys()]) if (note.store === store) hide(note);
  for (const [note, stop] of [...observed])
    if (note.store === store) {
      stop();
      observed.delete(note);
    }
  opened.get(store)?.();
  opened.delete(store);
  fixed.delete(store);
}

/** A drag, resize or turn of the note starts. The size this tab's person
 * waits on, or the one it shows, is stored first, untracked: the gesture
 * starts from the bound shown, its step holds only what it changes, and its
 * Undo keeps the size. What is measured until it ends goes with the gesture. */
export function noteGestureStarts(note: NoteBlockModel) {
  saveNoteSize(note);
  storeShown(note);
  moving.add(note);
}

/** The gesture ends, its pop written: a measured size its write did not take
 * waits as this tab's own. */
export function noteGestureEnds(note: NoteBlockModel) {
  moving.delete(note);
  measureAgain(note, true);
  display(note);
}
