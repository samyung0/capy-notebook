import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useEffect, useRef } from 'react';
import type { BankProgress } from '@/api/types';
import { userToast } from '@/components/ui/userToast';
import { bankProgressQuery } from '@/features/questions/bank';
import { m } from '@/i18n';

/** Topics finished in `next` that were not in `prev` (unanswered, started, or
 * reopened by new questions). */
export const newlyFinishedTopics = (prev: BankProgress, next: BankProgress) => {
  const before = new Set(
    prev.topics.filter((t) => !t.nextQuestionId).map((t) => t.topicId)
  );
  return next.topics.filter((t) => !t.nextQuestionId && !before.has(t.topicId));
};

/**
 * The finish toast: when the bank's progress list refetches (it does after
 * every answer) with a topic newly finished, a success toast whose Go check
 * opens /qb, where the map leads with it and plays the finish once. Mounted
 * in the app shell, so the list stays observed on every signed-in page.
 */
export function useFinishToasts() {
  const navigate = useNavigate();
  const { data: bank } = useQuery({
    ...bankProgressQuery(),
    meta: { errorBoundary: false },
  });
  const prev = useRef(bank);
  useEffect(() => {
    const before = prev.current;
    prev.current = bank;
    if (!(before && bank) || before === bank) return;
    for (const topic of newlyFinishedTopics(before, bank))
      userToast({
        button: {
          label: m.common_go_check(),
          onClick: () =>
            void navigate({ search: { finished: topic.topicId }, to: '/qb' }),
        },
        description: m.question_ui_topic_finished_toast({
          topic: topic.topicLabel,
        }),
        id: `finish:topic:${topic.topicId}`,
        title: m.question_ui_topic_finished(),
        variant: 'success',
      });
  }, [bank, navigate]);
}
