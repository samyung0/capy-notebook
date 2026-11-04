import type { ReviewReason, SessionScore } from '@/api/types';
import { formatPoints } from '@/features/quizzes/grade';
import { m } from '@/i18n';

/** Why a topic session served a question (boards F1, F1b, F4). */
export const REASON: Record<
  ReviewReason,
  { label: () => string; className: string }
> = {
  fading: {
    className: 'bg-page-hover text-fg-secondary',
    label: m.practice_reason_fading,
  },
  missed: {
    className: 'bg-tint-warning text-tint-warning-fg',
    label: m.practice_reason_missed,
  },
  new: {
    className: 'bg-tint-info text-tint-info-fg',
    label: m.practice_reason_new,
  },
};

export const questionsLabel = (count: number) =>
  count === 1 ? m.practice_questions_one() : m.practice_questions({ count });

/** A session's time estimate (no time limit, Epo 2026-11-03): about 1.2
 * minutes a question, so 10 questions read "about 12 minutes" (board F1). */
export function minutesLabel(questions: number) {
  const count = Math.max(1, Math.round(questions * 1.2));
  return count === 1 ? m.practice_minutes_one() : m.practice_minutes({ count });
}

/** "7 / 10": marks, half marks kept. */
export const scoreText = (s: SessionScore) =>
  `${formatPoints(s.correct)} / ${formatPoints(s.total)}`;

/** A topic session's name: its topic, Other files, or the whole workspace. */
export function groupLabel(
  group: 'topic' | 'others' | 'workspace',
  topicName?: string
) {
  if (group === 'others') return m.topic_other_files();
  if (group === 'workspace') return m.practice_whole_workspace();
  return topicName ?? '';
}

/** The start dialog's sizes (Epo 2026-11-04): those under what the group holds,
 * then All. */
export function countChoices(total: number) {
  return [...[10, 20, 30, 50].filter((n) => n < total), total];
}

/** A dialog starts at 10, or everything when the group holds fewer. */
export const defaultCount = (total: number) => Math.min(10, total);

export const TIMER_MINUTES = [10, 20, 30, 60] as const;

/** "12:05": what a session's timer has left. */
export function timeLeft(ms: number) {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
