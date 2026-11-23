import { useCallback, useMemo, useRef, useSyncExternalStore } from 'react';
import type * as Y from 'yjs';
import { useMe } from '@/api/hooks';
import {
  type RoomCopy,
  type RoomSeed,
  useRoomSeed,
} from '@/features/collaboration/deviceCopy';
import {
  type ItemRecovery,
  type ItemRoom,
  type ItemRoomSnapshot,
  type ItemRoomStatus,
  useItemRoom,
} from '@/features/collaboration/itemRoom';
import type { InNote } from '@/features/collaboration/noteSeat';
import type { HeldStrip } from '@/features/collaboration/roomProvider';
import { pairedUndo, type UndoTarget } from '@/features/collaboration/undo';
import type { ReadOnlyCode } from '@/features/notes/collaborationEvents';
import type { Question } from '@/features/questions/types';
import { readQuestions } from './liveQuiz';

/** The worse of two room states, as the header's save status reads it. */
function combined(a: ItemRoomStatus, b: ItemRoomStatus): ItemRoomStatus {
  const rank: ItemRoomStatus[] = [
    'unavailable',
    'offline',
    'opening',
    'syncing',
    'saved',
  ];
  return rank[Math.min(rank.indexOf(a), rank.indexOf(b))];
}

export interface QuizRooms {
  access: 'read' | 'write' | null;
  content: ItemRoom | null;
  /** The quiz was deleted (`item_deleted`, Q39): either document's stored
   * edits show as its recovery. */
  deleted: boolean;
  /** Either room dropped a group of pieces as late: the `unsynced` strip's
   * Retry joins both again (Epo 2026-11-23), pending while either's join
   * is, and its Discard drops both rooms' held edits; none while neither
   * did. */
  held: HeldStrip | null;
  /** The keys document, in Edit for editors who can write. */
  keys: ItemRoom | null;
  /** The device's copy of the keys: undefined while it reads, null with none. */
  keysSeed: RoomSeed | null | undefined;
  /** The offline banner (the worse of the two rooms'). */
  offline: ItemRoomSnapshot['offline'];
  /** The content room's other editors, for the header. */
  presence: ItemRoomSnapshot['presence'];
  /** Why the content room is read-only for this writer, when it said. */
  readOnlyCode: ReadOnlyCode | null;
  /** Both documents hold their rooms' state (editable). */
  ready: boolean;
  /** Stored edits that cannot join a room, shown for copying until Discard
   * (either document's; the other one reads live). */
  recovery: {
    content: ItemRecovery | null;
    keys: ItemRecovery | null;
    reload: () => void;
  } | null;
  /** Either room's stored steps are in the draft send (Q319). */
  sending: boolean;
  /** An open waits on the user's open budget (either room's). */
  slowed: boolean;
  status: ItemRoomStatus;
  undo: UndoTarget | null;
}

const OFFLINE: ItemRoomSnapshot['offline'][] = [
  'outdated-unstored',
  'outdated',
  'offline-limit',
  'offline-unstored',
  'offline',
  null,
];

/**
 * A quiz's live rooms (live-items DESIGN.md 1.2, 1.3): the content document
 * while `enabled`, and in Edit (`edit`) the keys document too once the
 * content room says this user can write. Readers never ask for keys. In Edit
 * both keep this account's unsent edits on the device (editDrafts).
 */
export function useQuizRooms(
  quizId: string | null,
  {
    copy,
    edit,
    enabled = true,
    inside,
    wake,
  }: {
    /** The page's device copy of the content room; it reads the keys' itself. */
    copy?: RoomCopy;
    edit: boolean;
    enabled?: boolean;
  } & InNote
): QuizRooms {
  const { data: me } = useMe();
  const actorId = edit ? (me?.id ?? null) : null;
  const keysSeed = useRoomSeed(copy ? (quizId ?? '') : '', actorId, 'keys');
  // A page's rooms wait for its copy's read, a few milliseconds.
  const contentEnabled =
    enabled && (!edit || !!actorId) && (!copy || copy.seed !== undefined);
  const content = useItemRoom(quizId, 'quiz', contentEnabled, {
    actorId,
    inside,
    keep: copy?.keep,
    seed: copy?.seed,
    wake,
  });
  // A writer's keys room stays while a fresh content room asks its token
  // (a moved room, a deleted quiz's), until it answers read.
  const wrote = useRef(false);
  if (content.snapshot.access === 'write') wrote.current = true;
  else if (content.snapshot.access === 'read') wrote.current = false;
  // A deleted quiz's keys show their unsent edits beside its content's (Q39).
  const deleted = content.snapshot.deleted;
  const wantKeys =
    contentEnabled &&
    edit &&
    (content.snapshot.access === 'write' ||
      (content.snapshot.access === null && wrote.current) ||
      deleted) &&
    (!copy || keysSeed !== undefined);
  const keys = useItemRoom(quizId, 'quiz', wantKeys, {
    actorId,
    document: 'keys',
    inside,
    keep: copy?.keep,
    seed: copy ? keysSeed : undefined,
    wake,
  });
  // The keys refused this person as read-only (asked as they were demoted,
  // ahead of the content room's read token): the quiz reads, on the content
  // room alone.
  const keysRead = wantKeys && keys.snapshot.access === 'read';
  const withKeys = wantKeys && !keysRead;
  const contentUndo = content.room?.undo;
  const keysUndo = withKeys ? keys.room?.undo : undefined;
  const undo = useMemo(
    () => (contentUndo && keysUndo ? pairedUndo(contentUndo, keysUndo) : null),
    [contentUndo, keysUndo]
  );
  const ready =
    !!content.room &&
    content.snapshot.synced &&
    (!withKeys || (!!keys.room && keys.snapshot.synced));
  const contentRecovery = content.snapshot.recovery;
  const keysRecovery = withKeys ? keys.snapshot.recovery : null;
  const contentRoom = content.room;
  const keysRoom = keys.room;
  const keysDeleted = withKeys && keys.snapshot.deleted;
  const recovery = useMemo(
    () =>
      contentRecovery || keysRecovery
        ? {
            content: contentRecovery,
            keys: keysRecovery,
            reload: () => {
              // A deleted quiz's Discard takes both documents' shown edits
              // at once.
              if (deleted || keysDeleted) {
                void (deleted ? contentRoom : keysRoom)?.reload();
                return;
              }
              if (contentRecovery) void contentRoom?.reload();
              if (keysRecovery) void keysRoom?.reload();
            },
          }
        : null,
    [contentRecovery, keysRecovery, contentRoom, keysRoom, deleted, keysDeleted]
  );
  const offline = OFFLINE.find(
    (state) =>
      state === content.snapshot.offline ||
      (withKeys && state === keys.snapshot.offline)
  );
  const contentHeld = content.snapshot.held;
  const keysHeld = withKeys ? keys.snapshot.held : null;
  const held = useMemo(
    () =>
      contentHeld || keysHeld
        ? {
            discard: () => {
              contentHeld?.discard();
              keysHeld?.discard();
            },
            retry: () => {
              contentHeld?.retry();
              keysHeld?.retry();
            },
            retrying: !!(contentHeld?.retrying || keysHeld?.retrying),
          }
        : null,
    [contentHeld, keysHeld]
  );
  return {
    access: keysRead ? 'read' : content.snapshot.access,
    content: content.room,
    deleted: deleted || keysDeleted,
    held,
    keys: withKeys ? keys.room : null,
    keysSeed,
    offline: offline ?? null,
    presence: content.snapshot.presence,
    readOnlyCode: content.snapshot.readOnlyCode,
    ready,
    recovery,
    sending: content.snapshot.sending || (withKeys && keys.snapshot.sending),
    slowed: content.snapshot.slowed || (withKeys && keys.snapshot.slowed),
    status: withKeys
      ? combined(content.snapshot.status, keys.snapshot.status)
      : content.snapshot.status,
    undo,
  };
}

/** Re-reads `read` whenever one of the documents changes; the value keeps
 * its identity until then. */
function useDocs<T>(
  docs: (Y.Doc | null | undefined)[],
  read: () => T,
  empty: T
): T {
  const cache = useRef<{ key: unknown[]; value: T } | null>(null);
  const subscribe = useCallback(
    (notify: () => void) => {
      const live = docs.filter((doc): doc is Y.Doc => !!doc);
      const changed = () => {
        cache.current = null;
        notify();
      };
      for (const doc of live) doc.on('update', changed);
      return () => {
        for (const doc of live) doc.off('update', changed);
      };
    },
    [...docs]
  );
  const snapshot = () => {
    if (!docs[0]) return empty;
    const stale =
      !cache.current ||
      cache.current.key.length !== docs.length ||
      cache.current.key.some((doc, i) => doc !== docs[i]);
    if (stale) cache.current = { key: [...docs], value: read() };
    return (cache.current as { value: T }).value;
  };
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** Every question with its keys, as editors see it. A question that did not
 * change keeps its object, so a card memoized on it skips the re-render when
 * another question is typed in. */
export function useQuizQuestions(
  content: Y.Doc | null | undefined,
  keys: Y.Doc | null | undefined
): Question[] {
  const held = useRef(new Map<string, { json: string; question: Question }>());
  return useDocs(
    [content, keys],
    () => {
      if (!content) return NO_QUESTIONS;
      const next = new Map<string, { json: string; question: Question }>();
      const questions = readQuestions(content, keys ?? null).map((read) => {
        const json = JSON.stringify(read);
        const before = held.current.get(read.id);
        const question = before?.json === json ? before.question : read;
        next.set(read.id, { json, question });
        return question;
      });
      held.current = next;
      return questions;
    },
    NO_QUESTIONS
  );
}

const NO_QUESTIONS: Question[] = [];
