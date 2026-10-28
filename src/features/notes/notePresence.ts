import { slateRangeToRelativeRange, type YjsEditor } from '@slate-yjs/core';
import {
  ElementApi,
  type Path,
  PathApi,
  type SlateEditor,
  type TRange,
} from 'platejs';
import type { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { base64ToBytes, bytesToBase64 } from '@/lib/base64';
import { CURSOR_SEND_MS } from './cursorThrottle';

/**
 * A note's presence (Epo 2026-10-28, todo-presence.md "Wire shapes"): what a
 * tab's awareness carries in a note room. The collaboration server keeps and
 * relays a state only when every field is one listed here, within its
 * bounds, and the state is at most 4 KiB
 * (collaboration-rs/crates/server/src/presence.rs); a receiver drops any
 * other state the same way (`readNotePresence`). It holds no colour and no
 * name: receivers colour and label a peer from the room's presence
 * (RemoteCursors.tsx).
 */
export interface NotePresence {
  /** The block selection's runs of adjacent blocks, in document order. */
  b?: BlockRun[];
  /** The selection's focus, as `s`; absent when it is collapsed. */
  f?: string;
  /** The pointer over a block, or null once it left the note. */
  p?: NotePointer | null;
  /** The caret's anchor: base64 of `Y.encodeRelativePosition`. */
  s?: string;
  /** The placeholder blocks this tab is uploading into (uploadPresence.ts). */
  uploads?: string[];
}

/** A block's stable id (`data-block-id`), then x and y as 0–1000 of its box. */
export type NotePointer = [blockId: string, x: number, y: number];
/** The first and last block of a run of adjacent selected blocks. */
export type BlockRun = [firstId: string, lastId: string];

/** The room's cap on one awareness state (`MAX_AWARENESS_ENTRY`). */
export const MAX_PRESENCE_BYTES = 4 * 1024;
const MAX_POSITION = 64;
const MAX_ID = 64;
const MAX_RUNS = 16;
export const MAX_UPLOADS = 100;
export const MAX_UPLOAD_ID = 32;
const POSITION = /^[A-Za-z0-9+/=]*$/;

const isId = (value: unknown, max = MAX_ID): value is string =>
  typeof value === 'string' && value.length <= max;

const isPosition = (value: unknown) =>
  typeof value === 'string' &&
  value.length <= MAX_POSITION &&
  POSITION.test(value);

const isCoordinate = (value: unknown) =>
  Number.isInteger(value) &&
  (value as number) >= 0 &&
  (value as number) <= 1000;

const isPointer = (value: unknown) =>
  Array.isArray(value) &&
  value.length === 3 &&
  isId(value[0]) &&
  isCoordinate(value[1]) &&
  isCoordinate(value[2]);

const isRuns = (value: unknown) =>
  Array.isArray(value) &&
  value.length <= MAX_RUNS &&
  value.every(
    (run) =>
      Array.isArray(run) && run.length === 2 && run.every((id) => isId(id))
  );

const isUploads = (value: unknown) =>
  Array.isArray(value) &&
  value.length <= MAX_UPLOADS &&
  value.every((id) => isId(id, MAX_UPLOAD_ID));

function admits(state: object) {
  for (const [key, value] of Object.entries(state)) {
    // This tab's own state may leave a field undefined; JSON drops it.
    if (value === undefined) continue;
    if (key === 's' || key === 'f') {
      if (!isPosition(value)) return false;
    } else if (key === 'p') {
      if (!(value === null || isPointer(value))) return false;
    } else if (key === 'b') {
      if (!isRuns(value)) return false;
    } else if (!(key === 'uploads' && isUploads(value))) return false;
  }
  return true;
}

const read = new WeakMap<object, NotePresence | null>();

/** A note state the room's field list admits, or null: a state the server
 * would drop is not read at all. Each state is checked once (y-protocols
 * replaces a client's state object on every change). */
export function readNotePresence(state: unknown): NotePresence | null {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return null;
  let presence = read.get(state);
  if (presence === undefined) {
    presence = admits(state) ? (state as NotePresence) : null;
    read.set(state, presence);
  }
  return presence;
}

const same = (left: unknown, right: unknown) =>
  left === right ||
  (Array.isArray(left) &&
    Array.isArray(right) &&
    JSON.stringify(left) === JSON.stringify(right));

/** The runs each tab wants to send, kept while its state is too large for
 * them (Q524). */
const wantedRuns = new WeakMap<Awareness, BlockRun[] | undefined>();
const utf8 = new TextEncoder();

/**
 * Sets fields of this tab's note presence and sends it, only when a field
 * changed. A state past the room's 4 KiB cap leaves out its block selection
 * runs and sends the rest (Epo 2026-10-28, Q524); they go again once it fits.
 */
export function setNotePresence(awareness: Awareness, fields: NotePresence) {
  const local = awareness.getLocalState();
  if (local === null) return;
  if ('b' in fields) wantedRuns.set(awareness, fields.b);
  const merged: Record<string, unknown> = {
    ...local,
    ...fields,
    b: wantedRuns.get(awareness),
  };
  if (
    merged.b &&
    utf8.encode(JSON.stringify(merged)).length > MAX_PRESENCE_BYTES
  )
    merged.b = undefined;
  // A field set to undefined goes from the state (JSON would drop it).
  const next = Object.fromEntries(
    Object.entries(merged).filter(([, value]) => value !== undefined)
  );
  const keys = new Set([...Object.keys(local), ...Object.keys(next)]);
  if ([...keys].some((key) => !same(local[key], next[key])))
    awareness.setLocalState(next);
}

const encodePosition = (position: Y.RelativePosition) =>
  bytesToBase64(Y.encodeRelativePosition(position));

/** A position a peer's `s` or `f` names; null when it names none. */
export function decodePosition(value: string): Y.RelativePosition | null {
  try {
    return Y.decodeRelativePosition(base64ToBytes(value));
  } catch {
    return null;
  }
}

/**
 * The editor's caret in the compact shape, in place of slate-yjs's
 * `sendCursorPosition` (which sent its relative positions as JSON beside a
 * colour): its anchor `s`, its focus `f` only when the selection is not
 * collapsed, neither without a selection.
 */
export function sendCaret(
  editor: YjsEditor,
  awareness: Awareness,
  range: TRange | null
) {
  if (!range) {
    setNotePresence(awareness, { f: undefined, s: undefined });
    return;
  }
  const { anchor, focus } = slateRangeToRelativeRange(
    editor.sharedRoot,
    editor,
    range
  );
  const s = encodePosition(anchor);
  const f = encodePosition(focus);
  setNotePresence(awareness, { f: f === s ? undefined : f, s });
}

/** Calls `send` at most every `ms`, and once after the last `schedule`;
 * `send` reads what to send when it runs. */
export function throttled(send: () => void, ms = CURSOR_SEND_MS) {
  let last = Number.NEGATIVE_INFINITY;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = () => {
    timer = undefined;
    last = Date.now();
    send();
  };
  return {
    cancel() {
      clearTimeout(timer);
      timer = undefined;
    },
    schedule() {
      if (timer) return;
      const wait = last + ms - Date.now();
      if (wait <= 0) run();
      else timer = setTimeout(run, wait);
    },
  };
}

const share = (at: number, start: number, size: number) =>
  Math.min(1000, Math.max(0, Math.round(((at - start) / size) * 1000)));

/** The pointer at (`x`, `y`) on `target`: the innermost block of `root`
 * holding it, by its stable id; null off every block or for an id the room
 * would refuse. */
export function pointerOn(
  root: Node,
  target: EventTarget | null,
  x: number,
  y: number
): NotePointer | null {
  const block = (target as Element | null)?.closest?.<HTMLElement>(
    '[data-block-id]'
  );
  const id = block?.dataset.blockId;
  if (!(block && id && isId(id) && root.contains(block))) return null;
  const box = block.getBoundingClientRect();
  if (!(box.width && box.height)) return null;
  return [id, share(x, box.left, box.width), share(y, box.top, box.height)];
}

/**
 * Sends this tab's pointer over the note (Epo 2026-10-28): the innermost
 * block under it, x and y as 0–1000 of that block's box, at most every
 * 50 ms; null once it leaves. A mouse or pen only: a touch is no pointer
 * (co-editors' mouse pointers, Epo 2026-10-20). Returns the undo.
 */
export function sendPointer(
  root: HTMLElement,
  awareness: Awareness,
  ms = CURSOR_SEND_MS
) {
  let latest: PointerEvent | null = null;
  const pointer = throttled(() => {
    const event = latest;
    if (event)
      setNotePresence(awareness, {
        p: pointerOn(root, event.target, event.clientX, event.clientY),
      });
  }, ms);
  const move = (event: PointerEvent) => {
    if (event.pointerType === 'touch') return;
    latest = event;
    pointer.schedule();
  };
  const leave = () => {
    latest = null;
    pointer.cancel();
    setNotePresence(awareness, { p: null });
  };
  root.addEventListener('pointermove', move, { passive: true });
  root.addEventListener('pointerleave', leave);
  return () => {
    pointer.cancel();
    root.removeEventListener('pointermove', move);
    root.removeEventListener('pointerleave', leave);
  };
}

/** The selected blocks as runs of adjacent siblings in document order;
 * none past 16 runs (Epo 2026-10-28) or for an id the room would refuse. */
export function blockRuns(
  editor: SlateEditor,
  ids: ReadonlySet<string>
): BlockRun[] | undefined {
  if (ids.size === 0) return;
  const runs: BlockRun[] = [];
  let previous: Path | null = null;
  for (const [node, path] of editor.api.nodes({
    at: [],
    match: (node) =>
      ElementApi.isElement(node) &&
      typeof node.id === 'string' &&
      ids.has(node.id),
  })) {
    const id = node.id as string;
    if (!isId(id)) return;
    const run = runs.at(-1);
    if (run && previous && PathApi.equals(PathApi.next(previous), path))
      run[1] = id;
    else if (runs.push([id, id]) > MAX_RUNS) return;
    previous = path;
  }
  return runs.length ? runs : undefined;
}
