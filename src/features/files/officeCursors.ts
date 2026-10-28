import type { Awareness } from 'y-protocols/awareness';
import {
  type PresenceConnection,
  presenceNames,
} from '@/features/collaboration/presence';
import { useNoteEditorPrefs } from '@/features/notes/noteEditorPrefs';
import { base64ToBytes, bytesToBase64 } from '@/lib/base64';
import {
  MAX_CURSOR_BYTES,
  MAX_CURSOR_TEXT,
  MAX_PEERS,
  type OfficeCell,
  type OfficeCursor,
  type OfficePeer,
} from './officeProtocol';

/** A DOCX position in awareness: base64 of at most 1,024 bytes. */
const MAX_POSITION = Math.ceil(MAX_CURSOR_BYTES / 3) * 4;
const POSITION = /^[A-Za-z0-9+/=]*$/;

/** An Office cursor as a source room's awareness carries it (Epo
 * 2026-10-28): the frame's, except that DOCX positions go as base64. */
type AwarenessCursor =
  | { story: string; anchor: string; head: string }
  | { sheet: string; anchor: OfficeCell; head: OfficeCell }
  | { slideId: string; shapeId?: string };

const isText = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= MAX_CURSOR_TEXT;

const isPosition = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length <= MAX_POSITION &&
  POSITION.test(value);

const isCount = (value: unknown) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** Exactly `keys`, and `optional` when present. */
const holds = (value: object, keys: string[], optional: string[] = []) =>
  Object.keys(value).every(
    (key) => keys.includes(key) || optional.includes(key)
  ) && keys.every((key) => key in value);

const isCell = (value: unknown): value is OfficeCell =>
  !!value &&
  typeof value === 'object' &&
  holds(value, ['row', 'col']) &&
  isCount((value as OfficeCell).row) &&
  isCount((value as OfficeCell).col);

/** The source room's field list for a cursor, as the collaboration server
 * checks it (collaboration-rs/crates/server/src/presence.rs). */
function isAwarenessCursor(value: unknown): value is AwarenessCursor {
  if (!value || typeof value !== 'object') return false;
  const cursor = value as Record<string, unknown>;
  if ('story' in cursor)
    return (
      holds(cursor, ['story', 'anchor', 'head']) &&
      isText(cursor.story) &&
      isPosition(cursor.anchor) &&
      isPosition(cursor.head)
    );
  if ('sheet' in cursor)
    return (
      holds(cursor, ['sheet', 'anchor', 'head']) &&
      isText(cursor.sheet) &&
      isCell(cursor.anchor) &&
      isCell(cursor.head)
    );
  return (
    holds(cursor, ['slideId'], ['shapeId']) &&
    isText(cursor.slideId) &&
    (cursor.shapeId === undefined || isText(cursor.shapeId))
  );
}

/** A source state's cursor, when the state holds nothing but one. */
function stateCursor(state: unknown): AwarenessCursor | null {
  if (!state || typeof state !== 'object') return null;
  const { cursor, ...rest } = state as { cursor?: unknown };
  return Object.keys(rest).length === 0 && isAwarenessCursor(cursor)
    ? cursor
    : null;
}

/** The frame's cursor as awareness carries it: each field named, so nothing
 * else the frame's object holds goes to the room. */
function toAwareness(cursor: OfficeCursor): AwarenessCursor {
  if ('story' in cursor)
    return {
      anchor: bytesToBase64(Uint8Array.from(cursor.anchor)),
      head: bytesToBase64(Uint8Array.from(cursor.head)),
      story: cursor.story,
    };
  if ('sheet' in cursor)
    return {
      anchor: { col: cursor.anchor.col, row: cursor.anchor.row },
      head: { col: cursor.head.col, row: cursor.head.row },
      sheet: cursor.sheet,
    };
  return cursor.shapeId === undefined
    ? { slideId: cursor.slideId }
    : { shapeId: cursor.shapeId, slideId: cursor.slideId };
}

/** An awareness cursor for the frame: DOCX positions as byte arrays again. */
function toFrame(cursor: AwarenessCursor): OfficeCursor | null {
  if (!('story' in cursor)) return cursor;
  try {
    return {
      anchor: [...base64ToBytes(cursor.anchor)],
      head: [...base64ToBytes(cursor.head)],
      story: cursor.story,
    };
  } catch {
    return null;
  }
}

/**
 * The co-editors' cursors of an Office file (Epo 2026-10-20): each client id
 * the room's awareness gives a cursor, drawn only under the verified name the
 * room's presence gives that id. A name in a peer's awareness is never read,
 * an id the presence does not list (a reader, or a peer not listed yet) is
 * not drawn, and neither is a state the room's field list would drop.
 */
export function officePeers(
  states: ReadonlyMap<number, unknown>,
  self: number,
  names: ReadonlyMap<number, string>
): OfficePeer[] {
  const peers: OfficePeer[] = [];
  for (const [clientId, state] of states) {
    const name = names.get(clientId);
    const shared = clientId !== self && name ? stateCursor(state) : null;
    const cursor = shared && toFrame(shared);
    if (!(name && cursor)) continue;
    peers.push({ clientId, cursor, name });
    if (peers.length === MAX_PEERS) break;
  }
  return peers;
}

/** A session's cursors: its room's awareness (`attach`) and presence
 * (`names`) in, the frame's cursor out (`set`), the peers to draw to
 * `subscribe`'s listeners: none while this device's show-others switch is
 * off (Epo 2026-10-28). */
export function createOfficeCursors() {
  let awareness: Awareness | null = null;
  let names = new Map<number, string>();
  let peers: OfficePeer[] = [];
  let unsubscribePrefs: (() => void) | undefined;
  const listeners = new Set<(peers: OfficePeer[]) => void>();
  const update = () => {
    peers =
      awareness && useNoteEditorPrefs.getState().showOthers
        ? officePeers(awareness.getStates(), awareness.clientID, names)
        : [];
    for (const listener of listeners) listener(peers);
  };
  return {
    attach(next: Awareness | null) {
      awareness?.off('change', update);
      unsubscribePrefs?.();
      awareness = next;
      awareness?.on('change', update);
      unsubscribePrefs = awareness
        ? useNoteEditorPrefs.subscribe((state, previous) => {
            if (state.showOthers !== previous.showOthers) update();
          })
        : undefined;
      update();
    },
    names(connections: readonly PresenceConnection[] | null) {
      names = presenceNames(connections ?? []);
      update();
    },
    set(cursor: OfficeCursor | null) {
      awareness?.setLocalStateField('cursor', cursor && toAwareness(cursor));
    },
    subscribe(listener: (peers: OfficePeer[]) => void) {
      listeners.add(listener);
      listener(peers);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export type OfficeCursors = ReturnType<typeof createOfficeCursors>;
