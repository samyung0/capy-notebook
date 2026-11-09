import type {
  LearnerPart,
  LearnerQuestion,
  Question,
  QuestionPart,
} from '@/features/questions/types';
import type { Answer } from './grade';

type AnyPart = LearnerPart | QuestionPart;
type PartsById = ReadonlyMap<string, AnyPart>;

/** Whether an answer still means what the learner chose after an editor
 * changed the part live (D9, Epo 2026-10-10): a chosen option, ordering item
 * or matching option that is gone, or a changed number of gaps, drops it. */
function stillAnswers(before: AnyPart, after: AnyPart, value: Answer): boolean {
  const a = before.answer;
  const b = after.answer;
  if (a.type !== b.type) return false;
  if (a.type === 'mcq' && 'options' in b)
    return (
      Array.isArray(value) &&
      value.every(
        (i) =>
          typeof i === 'number' &&
          'options' in a &&
          a.options[i] === b.options[i]
      )
    );
  if (a.type === 'ordering' && 'items' in a && 'items' in b)
    return (
      [...a.items].sort().join('\u0000') === [...b.items].sort().join('\u0000')
    );
  if (
    b.type === 'matching' &&
    'options' in b &&
    value &&
    typeof value === 'object'
  )
    return Object.values(value).every((option) =>
      b.options.includes(option as string)
    );
  if (a.type === 'gaps' && b.type === 'gaps')
    return JSON.stringify(a) === JSON.stringify(b);
  return true;
}

export const partsById = (
  questions: readonly (LearnerQuestion | Question)[]
): PartsById =>
  new Map<string, AnyPart>(
    questions.flatMap((question) =>
      question.parts.map((part) => [part.id, part] as const)
    )
  );

/** The answers that still mean what the learner chose; `current` itself when
 * they all do. */
export function keptAnswers(
  before: PartsById,
  after: PartsById,
  current: Record<string, Answer>
) {
  const kept = Object.fromEntries(
    Object.entries(current).filter(([id, value]) => {
      const was = before.get(id);
      const now = after.get(id);
      return !!(was && now && stillAnswers(was, now, value));
    })
  );
  return Object.keys(kept).length === Object.keys(current).length
    ? current
    : kept;
}
