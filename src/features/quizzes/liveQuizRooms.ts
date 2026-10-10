import { useCallback, useMemo, useRef, useSyncExternalStore } from 'react';
import type * as Y from 'yjs';
import {
  type ItemRoom,
  type ItemRoomStatus,
  useItemRoom,
} from '@/features/collaboration/itemRoom';
import { pairedUndo, type UndoTarget } from '@/features/collaboration/undo';
import type { LearnerQuestion, Question } from '@/features/questions/types';
import { readLearnerQuestions, readQuestions } from './liveQuiz';

/** The worse of two room states, as the header's save status reads it. */
function combined(a: ItemRoomStatus, b: ItemRoomStatus): ItemRoomStatus {
  const rank: ItemRoomStatus[] = [
    'unavailable',
    'offline',
    'connecting',
    'syncing',
    'synced',
  ];
  return rank[Math.min(rank.indexOf(a), rank.indexOf(b))];
}

export interface QuizRooms {
  access: 'read' | 'write' | null;
  content: ItemRoom | null;
  /** The keys document, in Edit for editors who can write. */
  keys: ItemRoom | null;
  /** Both documents hold their rooms' state (editable). */
  ready: boolean;
  status: ItemRoomStatus;
  undo: UndoTarget | null;
}

/**
 * A quiz's live rooms (live-items DESIGN.md 1.2, 1.3): the content document
 * while `enabled`, and in Edit (`edit`) the keys document too once the
 * content room says this user can write. Readers never ask for keys.
 */
export function useQuizRooms(
  quizId: string | null,
  { edit, enabled = true }: { edit: boolean; enabled?: boolean }
): QuizRooms {
  const content = useItemRoom(quizId, enabled);
  const wantKeys = enabled && edit && content.snapshot.access === 'write';
  const keys = useItemRoom(quizId, wantKeys, 'keys');
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
  return {
    access: content.snapshot.access,
    content: content.room,
    keys: wantKeys ? keys.room : null,
    ready,
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
  return useSyncExternalStore(subscribe, () => {
    if (!docs[0]) return empty;
    const stale =
      !cache.current ||
      cache.current.key.length !== docs.length ||
      cache.current.key.some((doc, i) => doc !== docs[i]);
    if (stale) cache.current = { key: [...docs], value: read() };
    return (cache.current as { value: T }).value;
  });
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

/** Every question as a learner sees it, from the content document. */
export function useLearnerQuestions(
  content: Y.Doc | null | undefined
): LearnerQuestion[] {
  return useDocs(
    [content],
    () => (content ? readLearnerQuestions(content) : NO_LEARNER),
    NO_LEARNER
  );
}

const NO_QUESTIONS: Question[] = [];
const NO_LEARNER: LearnerQuestion[] = [];
