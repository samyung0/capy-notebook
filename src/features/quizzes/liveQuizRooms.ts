import { useCallback, useMemo, useRef, useSyncExternalStore } from 'react';
import type * as Y from 'yjs';
import { useMe } from '@/api/hooks';
import {
  type ItemRecovery,
  type ItemRoom,
  type ItemRoomSnapshot,
  type ItemRoomStatus,
  useItemRoom,
} from '@/features/collaboration/itemRoom';
import { pairedUndo, type UndoTarget } from '@/features/collaboration/undo';
import type { ReadOnlyCode } from '@/features/notes/collaborationEvents';
import type { Question } from '@/features/questions/types';
import { readQuestions } from './liveQuiz';

/** The worse of two room states, as the header's save status reads it:
 * one room's stored edits beside another with nothing to store is saved. */
function combined(a: ItemRoomStatus, b: ItemRoomStatus): ItemRoomStatus {
  const rank: ItemRoomStatus[] = [
    'unavailable',
    'offline',
    'connecting',
    'syncing',
    'saved',
    'synced',
  ];
  return rank[Math.min(rank.indexOf(a), rank.indexOf(b))];
}

export interface QuizRooms {
  access: 'read' | 'write' | null;
  content: ItemRoom | null;
  /** The keys document, in Edit for editors who can write. */
  keys: ItemRoom | null;
  /** The offline banner (the worse of the two rooms'). */
  offline: ItemRoomSnapshot['offline'];
  /** Why the content room is read-only for this writer, when it said. */
  readOnlyCode: ReadOnlyCode | null;
  /** Both documents hold their rooms' state (editable). */
  ready: boolean;
  /** Stored edits that cannot join a room, shown for copying until Reload
   * (either document's; the other one reads live). */
  recovery: {
    content: ItemRecovery | null;
    keys: ItemRecovery | null;
    reload: () => void;
  } | null;
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
  { edit, enabled = true }: { edit: boolean; enabled?: boolean }
): QuizRooms {
  const { data: me } = useMe();
  const actorId = edit ? (me?.id ?? null) : null;
  const contentEnabled = enabled && (!edit || !!actorId);
  const content = useItemRoom(quizId, contentEnabled, { actorId });
  const wantKeys =
    contentEnabled && edit && content.snapshot.access === 'write';
  const keys = useItemRoom(quizId, wantKeys, { actorId, document: 'keys' });
  const contentUndo = content.room?.undo;
  const keysUndo = keys.room?.undo;
  const undo = useMemo(
    () => (contentUndo && keysUndo ? pairedUndo(contentUndo, keysUndo) : null),
    [contentUndo, keysUndo]
  );
  const ready =
    !!content.room &&
    content.snapshot.synced &&
    (!wantKeys || (!!keys.room && keys.snapshot.synced));
  const contentRecovery = content.snapshot.recovery;
  const keysRecovery = wantKeys ? keys.snapshot.recovery : null;
  const contentRoom = content.room;
  const keysRoom = keys.room;
  const recovery = useMemo(
    () =>
      contentRecovery || keysRecovery
        ? {
            content: contentRecovery,
            keys: keysRecovery,
            reload: () => {
              if (contentRecovery) void contentRoom?.reload();
              if (keysRecovery) void keysRoom?.reload();
            },
          }
        : null,
    [contentRecovery, keysRecovery, contentRoom, keysRoom]
  );
  const offline = OFFLINE.find(
    (state) =>
      state === content.snapshot.offline ||
      (wantKeys && state === keys.snapshot.offline)
  );
  return {
    access: content.snapshot.access,
    content: content.room,
    keys: wantKeys ? keys.room : null,
    offline: offline ?? null,
    readOnlyCode: content.snapshot.readOnlyCode,
    ready,
    recovery,
    status: wantKeys
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

/** Every question with its keys, as editors see it. */
export function useQuizQuestions(
  content: Y.Doc | null | undefined,
  keys: Y.Doc | null | undefined
): Question[] {
  return useDocs(
    [content, keys],
    () => (content ? readQuestions(content, keys ?? null) : NO_QUESTIONS),
    NO_QUESTIONS
  );
}

const NO_QUESTIONS: Question[] = [];
