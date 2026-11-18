import type { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import type {
  BoardBox,
  BoardPresenceView,
  BoardTextPoint,
} from '@/features/blocksuite/drawingBoard';
import { PEER_COLORS } from '@/features/collaboration/PresenceMarks';
import type { PresenceConnection } from '@/features/collaboration/presence';
import { CURSOR_SEND_MS } from '@/features/notes/cursorThrottle';
import {
  decodePosition,
  MAX_PRESENCE_BYTES,
  throttled,
} from '@/features/notes/notePresence';
import { m } from '@/i18n';
import { bytesToBase64 } from '@/lib/base64';

/**
 * A canvas's presence (Epo 2026-11-18, "just the same presence events like
 * others"): what a tab's awareness carries in a canvas's room, the fields a
 * note's has with a board's values. The collaboration server keeps and relays
 * a state only when every field is one listed here, within its bounds
 * (`Fields::Board`, collaboration-rs/crates/server/src/presence.rs); a
 * receiver drops any other state the same way (`readBoardPresence`). It holds
 * no colour and no name: receivers colour and label a peer from the room's
 * presence. BlockSuite's own awareness (its `selectionV2`) never reaches the
 * room (`roomBoardStore`, drawingBoard.ts).
 */
export interface BoardPresence {
  /** The selected elements' and blocks' ids. */
  b?: string[];
  /** The text selection's focus, as `s`; absent when it is collapsed. */
  f?: string;
  /** The pointer, or null once it left the board. */
  p?: BoardPointer | null;
  /** The text caret's anchor: base64 of `Y.encodeRelativePosition` on its
   * block's text. */
  s?: string;
}

/** Whole board units: BlockSuite's viewport gives fractions, and a rounded
 * one is at most 3 px off at the largest zoom (600%). */
export type BoardPointer = [x: number, y: number];

export const MAX_BOARD_COORDINATE = 1_000_000_000;
const MAX_ID = 64;
const MAX_IDS = 16;
const MAX_POSITION = 64;
const POSITION = /^[A-Za-z0-9+/=]*$/;

const isPosition = (value: unknown) =>
  typeof value === 'string' &&
  value.length <= MAX_POSITION &&
  POSITION.test(value);

const isCoordinate = (value: unknown) =>
  Number.isInteger(value) && Math.abs(value as number) <= MAX_BOARD_COORDINATE;

const isPointer = (value: unknown) =>
  Array.isArray(value) && value.length === 2 && value.every(isCoordinate);

const isIds = (value: unknown) =>
  Array.isArray(value) &&
  value.length <= MAX_IDS &&
  value.every((id) => typeof id === 'string' && id.length <= MAX_ID);

function admits(state: object) {
  for (const [key, value] of Object.entries(state)) {
    // This tab's own state may leave a field undefined; JSON drops it.
    if (value === undefined) continue;
    if (key === 's' || key === 'f') {
      if (!isPosition(value)) return false;
    } else if (key === 'p') {
      if (!(value === null || isPointer(value))) return false;
    } else if (!(key === 'b' && isIds(value))) return false;
  }
  return true;
}

const read = new WeakMap<object, BoardPresence | null>();

/** A board state the room's field list admits, or null: a state the server
 * would drop is not read at all. Each state is checked once (y-protocols
 * replaces a client's state object on every change). */
export function readBoardPresence(state: unknown): BoardPresence | null {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return null;
  let presence = read.get(state);
  if (presence === undefined) {
    presence = admits(state) ? (state as BoardPresence) : null;
    read.set(state, presence);
  }
  return presence;
}

const same = (left: unknown, right: unknown) =>
  left === right ||
  (Array.isArray(left) &&
    Array.isArray(right) &&
    JSON.stringify(left) === JSON.stringify(right));

/** Sets fields of this tab's board presence and sends it, only when a field
 * changed. A field set to undefined goes from the state. */
export function setBoardPresence(awareness: Awareness, fields: BoardPresence) {
  const local = awareness.getLocalState();
  if (local === null) return;
  const next = Object.fromEntries(
    Object.entries({ ...local, ...fields }).filter(
      ([, value]) => value !== undefined
    )
  );
  const keys = new Set([...Object.keys(local), ...Object.keys(next)]);
  if ([...keys].some((key) => !same(local[key], next[key])))
    awareness.setLocalState(next);
}

/** A point of the board as a pointer: null for one the room would refuse. */
export function boardPointer(x: number, y: number): BoardPointer | null {
  const pointer = [Math.round(x), Math.round(y)];
  return isPointer(pointer) ? (pointer as BoardPointer) : null;
}

const utf8 = new TextEncoder();
/** What a state's caret and pointer take of the room's 4 KiB at most. */
const BESIDE_IDS = 256;

/** The selected ids as presence sends them: none for a selection of more
 * than 16 (as a note's runs, Epo 2026-10-28), for an id the room would
 * refuse, or for ids that would take the state past the room's cap. */
export function selectedIds(ids: readonly string[]): string[] | undefined {
  if (ids.length === 0 || !isIds(ids)) return;
  const bytes = utf8.encode(JSON.stringify(ids)).length;
  return bytes > MAX_PRESENCE_BYTES - BESIDE_IDS ? undefined : [...ids];
}

/** A place in a block's text as a caret sends it; none when its encoding is
 * longer than the room takes. */
export function encodeCaret({ index, text }: BoardTextPoint) {
  const position = bytesToBase64(
    Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, index))
  );
  return position.length <= MAX_POSITION ? position : undefined;
}

/** The place in `doc` a peer's `s` or `f` names: null when it names none, a
 * root type (`decodePosition`) or anything but a text. */
export function resolveCaret(doc: Y.Doc, value: string): BoardTextPoint | null {
  const position = decodePosition(value);
  if (!position) return null;
  try {
    const at = Y.createAbsolutePositionFromRelativePosition(position, doc);
    return at?.type instanceof Y.Text
      ? { index: at.index, text: at.type }
      : null;
  } catch {
    // A position naming nothing the document holds.
    return null;
  }
}

/** The selection as presence sends it: the selected elements, and the text
 * caret with its focus when a range is selected. Text in a shape or on a
 * connector has no caret here (BlockSuite gives it no text selection); its
 * element is in `b`, selected for editing. */
function selectionFields(
  view: BoardPresenceView
): Pick<BoardPresence, 'b' | 'f' | 's'> {
  const caret = view.caret();
  const anchor = caret ? encodeCaret(caret.anchor) : undefined;
  const focus = caret ? encodeCaret(caret.focus) : undefined;
  const b = selectedIds(view.selected());
  if (!(anchor && focus)) return { b, f: undefined, s: undefined };
  return { b, f: focus === anchor ? undefined : focus, s: anchor };
}

/**
 * Sends this tab's presence on a canvas: the pointer in board units (a mouse
 * or pen only, as a note's), the selected elements, and the text caret as
 * soon as it is placed, moved or a range is selected, not only while typing
 * (Epo 2026-11-18). At most one state every 50 ms, only when a field changed.
 * The pointer goes null once it leaves the board, a card's editor fills it,
 * or the tab or window loses focus.
 *
 * A pointer move costs two stored numbers and at most one timer: the send
 * converts them with the viewport's own arithmetic (no layout is read) and
 * writes one awareness state. Returns the undo, which takes the state back.
 */
export function sendBoardPresence(
  view: BoardPresenceView,
  awareness: Awareness,
  ms = CURSOR_SEND_MS
) {
  const { host } = view;
  // Says this tab is here: the room's presence names its client id from it.
  awareness.setLocalState({});
  /** Whether the pointer is over the board, and where on the page. */
  let over = false;
  let pageX = 0;
  let pageY = 0;
  let selectionChanged = true;
  const sender = throttled(() => {
    // A plane's or chart's editor over the board has no board under it.
    const shown = over && !host.hasAttribute('data-editor-open');
    const fields: BoardPresence = {
      p: shown ? boardPointer(...view.toBoard(pageX, pageY)) : null,
    };
    if (selectionChanged) Object.assign(fields, selectionFields(view));
    selectionChanged = false;
    setBoardPresence(awareness, fields);
  }, ms);
  const move = (event: PointerEvent) => {
    if (event.pointerType === 'touch') return;
    over = true;
    pageX = event.clientX;
    pageY = event.clientY;
    sender.schedule();
  };
  const leave = () => {
    if (!over) return;
    over = false;
    sender.schedule();
  };
  const page = host.ownerDocument;
  const tab = page.defaultView;
  const hidden = () => {
    if (page.hidden) leave();
  };
  host.addEventListener('pointermove', move, { passive: true });
  host.addEventListener('pointerleave', leave);
  page.addEventListener('visibilitychange', hidden);
  tab?.addEventListener('blur', leave);
  const offSelection = view.onSelection(() => {
    selectionChanged = true;
    sender.schedule();
  });
  // The board moved under a still pointer.
  const offView = view.onView(() => {
    if (over) sender.schedule();
  });
  sender.schedule();
  return () => {
    sender.cancel();
    host.removeEventListener('pointermove', move);
    host.removeEventListener('pointerleave', leave);
    page.removeEventListener('visibilitychange', hidden);
    tab?.removeEventListener('blur', leave);
    offSelection();
    offView();
    awareness.setLocalState(null);
  };
}

/** A peer on the canvas: its presence, from a state the board's field list
 * admits, for a client the room's presence lists (one it does not list yet
 * is not drawn). Labelled with the verified name the room gives its client
 * id and coloured by its person's number there, as in a note. */
export type BoardPeer = {
  /** The palette's index. */
  color: number;
  name: string;
  presence: BoardPresence;
};

export function readBoardPeer(
  awareness: Awareness,
  clients: ReadonlyMap<number, PresenceConnection>,
  client: number
): BoardPeer | undefined {
  const connection = clients.get(client);
  if (client === awareness.clientID || !connection) return;
  const presence = readBoardPresence(awareness.getStates().get(client));
  if (!presence) return;
  return {
    color: connection.person % PEER_COLORS,
    name: connection.name ?? m.editor_collaborator(),
    presence,
  };
}

/** What the canvas draws for a peer, in board units. */
export type BoardMark = { color: number; key: string; name: string } & (
  | { kind: 'pointer'; x: number; y: number }
  | ({ kind: 'outline' | 'caret' | 'range' } & BoardBox)
);

/** The outline around what a peer selected; none when the board holds none
 * of it. */
export function placeOutline(
  view: Pick<BoardPresenceView, 'boxOf'>,
  client: number,
  { color, name, presence: { b } }: BoardPeer
): BoardMark | undefined {
  const box = b?.length ? view.boxOf(b) : null;
  return box
    ? { ...box, color, key: `${client}:b`, kind: 'outline', name }
    : undefined;
}

const UNITS_APART = 1;

/** Two boxes of one line, or of a block and a line in it: they share more
 * than half the shorter one's height, and meet or overlap sideways. Lines
 * that only brush each other (a tight line height) stay apart. */
function joins(one: BoardBox, other: BoardBox) {
  const shared =
    Math.min(one.y + one.h, other.y + other.h) - Math.max(one.y, other.y);
  return (
    shared > Math.min(one.h, other.h) / 2 &&
    one.x <= other.x + other.w + UNITS_APART &&
    other.x <= one.x + one.w + UNITS_APART
  );
}

/** A range's boxes as the tint draws them. The page gives one per piece of
 * text and one per element wholly inside the range (a line's, a paragraph's),
 * over each other: those that join become the box around them, so a line, or
 * a block selected whole, is tinted once. */
export function mergeBoxes(boxes: readonly BoardBox[]): BoardBox[] {
  const merged: BoardBox[] = [];
  for (const next of boxes) {
    let box = next;
    // The grown box may reach ones it did not before.
    for (;;) {
      const grown = box;
      const at = merged.findIndex((other) => joins(other, grown));
      if (at < 0) break;
      const [other] = merged.splice(at, 1);
      const x = Math.min(box.x, other.x);
      const y = Math.min(box.y, other.y);
      box = {
        h: Math.max(box.y + box.h, other.y + other.h) - y,
        w: Math.max(box.x + box.w, other.x + other.w) - x,
        x,
        y,
      };
    }
    merged.push(box);
  }
  return merged;
}

/** A peer's text caret, at its focus, and the lines of its selection, in a
 * note's or a text block's text; none for a place the board draws no text
 * at. Positions are relative, so they are resolved against the document as
 * it is now. Reads the page's layout (`textBoxes`). */
export function placeText(
  view: Pick<BoardPresenceView, 'textBoxes'>,
  doc: Y.Doc,
  client: number,
  { color, name, presence: { f, s } }: BoardPeer
): BoardMark[] {
  if (!s) return [];
  const anchor = resolveCaret(doc, s);
  const focus = f ? resolveCaret(doc, f) : anchor;
  if (!focus) return [];
  const boxes = view.textBoxes(focus, f ? anchor : null);
  if (!boxes) return [];
  return [
    ...mergeBoxes(boxes.range).map(
      (box, line): BoardMark => ({
        ...box,
        color,
        key: `${client}:r${line}`,
        kind: 'range',
        name,
      })
    ),
    { ...boxes.caret, color, key: `${client}:c`, kind: 'caret', name },
  ];
}
