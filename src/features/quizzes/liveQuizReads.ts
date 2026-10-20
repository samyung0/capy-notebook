import { useEffect, useRef, useState } from 'react';
import type { InNote, NoteSeat } from '@/features/collaboration/noteSeat';
import { whileVisible } from '@/features/collaboration/whileVisible';
import type { LearnerQuestion } from '@/features/questions/types';

/**
 * A quiz's questions as a learner sees them, following its live content
 * document (Epo 2026-10-10, D9): the stored questions paint first, then the
 * room's once synced, then every edit as it lands. Readers join the content
 * document only, so no answer key reaches them; matching options and
 * ordering items come as the room's shuffled lists, outside Yjs (D3). The
 * room code (yjs, the provider) loads after first paint, so readers pay
 * nothing until then.
 */
export function useLiveQuizQuestions(
  quizId: string,
  stored: LearnerQuestion[],
  enabled = true,
  { inside, wake }: InNote = {}
): LearnerQuestion[] {
  const [live, setLive] = useState<LearnerQuestion[] | null>(null);
  // A room that ended here (it moved to a new lineage) is joined afresh.
  const [generation, setGeneration] = useState(0);
  const joined = useRef<{ wake: () => void } | null>(null);
  useEffect(() => {
    if (wake) joined.current?.wake();
  }, [wake]);
  useEffect(() => {
    if (!enabled) return;
    // Left while the tab is hidden (REVIEW5 N5).
    return whileVisible(() =>
      readLive(quizId, setLive, () => setGeneration((value) => value + 1), {
        inside,
        joined,
      })
    );
  }, [quizId, enabled, inside, generation]);
  return live ?? stored;
}

/** Joins the quiz's content room on a read channel (never its keys; REVIEW5
 * N2), inside its note's seat when embedded, and hands every state of its
 * questions to `onQuestions`; returns the leave. `joined` holds the room
 * while it is open. */
export function readLive(
  quizId: string,
  onQuestions: (questions: LearnerQuestion[]) => void,
  onReplace: () => void,
  {
    inside,
    joined,
  }: {
    inside?: NoteSeat | null;
    joined?: { current: { wake: () => void } | null };
  } = {}
) {
  let cancelled = false;
  let close: (() => void) | undefined;
  void Promise.all([
    import('@/features/collaboration/itemRoom'),
    import('./liveQuiz'),
  ]).then(([{ openItemRoom }, { readLearnerQuestions }]) => {
    if (cancelled) return;
    // Shared with another copy of the quiz in the note (r6 S-2).
    const { close: leave, room } = openItemRoom(quizId, {
      inside,
      onReplace,
      read: true,
    });
    if (joined) joined.current = room;
    const update = () => {
      if (room.getSnapshot().synced)
        onQuestions(readLearnerQuestions(room.doc, room.lists));
    };
    const unsubscribe = room.subscribe(update);
    room.doc.on('update', update);
    update();
    close = () => {
      if (joined?.current === room) joined.current = null;
      unsubscribe();
      room.doc.off('update', update);
      leave();
    };
  });
  return () => {
    cancelled = true;
    close?.();
  };
}
