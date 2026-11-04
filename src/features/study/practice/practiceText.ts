import type { ReviewReason, SessionScore } from '@/api/types';
import type {
  LearnerQuestion,
  Question,
  QuestionBlock,
  TextBlock,
} from '@/features/questions/types';
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

const blockText = (blocks: QuestionBlock[] = []) =>
  blocks.find((b): b is TextBlock => b.type === 'text' && b.text.trim() !== '')
    ?.text;

/** A question's first line: its stem's, else its first part's. */
export function questionLine(
  q?: Pick<Question | LearnerQuestion, 'stem' | 'parts'>
) {
  if (!q) return '';
  return (
    blockText(q.stem) ??
    q.parts.map((p) => blockText(p.blocks)).find(Boolean) ??
    ''
  );
}
