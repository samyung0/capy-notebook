import { useEffect, useState } from 'react';
import type { LearnerQuestion } from '@/features/questions/types';

/**
 * A quiz's questions as a learner sees them, following its live content
 * document (Epo 2026-10-10, D9): the stored questions paint first, then the
 * room's once synced, then every edit as it lands. Readers join the content
 * document only, so no answer key reaches them. The room code (yjs, the
 * provider) loads after first paint, so readers pay nothing until then.
 */
export function useLiveQuizQuestions(
  quizId: string,
  stored: LearnerQuestion[],
  enabled = true
): LearnerQuestion[] {
  const [live, setLive] = useState<LearnerQuestion[] | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let close: (() => void) | undefined;
    void Promise.all([
      import('@/features/collaboration/itemRoom'),
      import('./liveQuiz'),
    ]).then(([{ ItemRoom }, { readLearnerQuestions }]) => {
      if (cancelled) return;
      const room = new ItemRoom(quizId);
      const update = () => {
        if (room.getSnapshot().synced) setLive(readLearnerQuestions(room.doc));
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
  }, [quizId, enabled]);
  return live ?? stored;
}
