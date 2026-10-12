import { useEffect, useState } from 'react';
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
  enabled = true
): LearnerQuestion[] {
  const [live, setLive] = useState<LearnerQuestion[] | null>(null);
  // A room that ended here (it moved to a new lineage) is joined afresh.
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    // Left while the tab is hidden (REVIEW5 N5).
    return whileVisible(() =>
      readLive(quizId, setLive, () => setGeneration((value) => value + 1))
    );
  }, [quizId, enabled, generation]);
  return live ?? stored;
}

/** Joins the quiz's content room on a read channel (never its keys; REVIEW5
 * N2) and hands every state of its questions to `onQuestions`; returns the
 * leave. */
export function readLive(
  quizId: string,
  onQuestions: (questions: LearnerQuestion[]) => void,
  onReplace: () => void
) {
  let cancelled = false;
  let close: (() => void) | undefined;
  void Promise.all([
    import('@/features/collaboration/itemRoom'),
    import('./liveQuiz'),
  ]).then(([{ ItemRoom }, { readLearnerQuestions }]) => {
    if (cancelled) return;
    const room = new ItemRoom(quizId, { onReplace, read: true });
    const update = () => {
      if (room.getSnapshot().synced)
        onQuestions(readLearnerQuestions(room.doc, room.lists));
    };
    room.subscribe(update);
    room.doc.on('update', update);
    void room.start();
    close = () => room.destroy();
  });
  return () => {
    cancelled = true;
    close?.();
  };
}
