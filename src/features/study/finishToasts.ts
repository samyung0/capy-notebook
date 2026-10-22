import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useEffect, useRef } from 'react';
import { useLearningProgress } from '@/api/hooks';
import type { BankProgress, LearningProgress } from '@/api/types';
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

/** Workspaces finished in `next` that were not in `prev`. */
export const newlyFinishedWorkspaces = (
  prev: LearningProgress,
  next: LearningProgress
) => {
  const before = new Set(prev.finished.map((ws) => ws.workspaceId));
  return next.finished.filter((ws) => !before.has(ws.workspaceId));
};

/** Calls `onChange` with each refetched value and the one before it. */
function useChange<T>(
  value: T | undefined,
  onChange: (prev: T, next: T) => void
) {
  const prev = useRef(value);
  const handler = useRef(onChange);
  handler.current = onChange;
  useEffect(() => {
    const before = prev.current;
    prev.current = value;
    if (before && value && before !== value) handler.current(before, value);
  }, [value]);
}

/**
 * The finish toast: when the bank's or Learning's progress list refetches
 * (both do after every answer and study write) with a topic or workspace newly
 * finished, a success toast whose Go check opens its landing, where the map
 * leads with it and plays the finish once. Mounted in the app shell, so the
 * lists stay observed on every signed-in page.
 */
export function useFinishToasts() {
  const navigate = useNavigate();
  const { data: bank } = useQuery({
    ...bankProgressQuery(),
    meta: { errorBoundary: false },
  });
  const { data: learning } = useLearningProgress(undefined, false, {
    errorBoundary: false,
  });
  useChange(bank, (prev, next) => {
    for (const topic of newlyFinishedTopics(prev, next))
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
  });
  useChange(learning, (prev, next) => {
    for (const ws of newlyFinishedWorkspaces(prev, next))
      userToast({
        button: {
          label: m.common_go_check(),
          onClick: () =>
            void navigate({
              search: { finished: ws.workspaceId, tab: 'progress' },
              to: '/learning',
            }),
        },
        description: m.learning_workspace_finished_toast({
          workspace: ws.name,
        }),
        id: `finish:workspace:${ws.workspaceId}`,
        title: m.learning_workspace_finished(),
        variant: 'success',
      });
  });
}
