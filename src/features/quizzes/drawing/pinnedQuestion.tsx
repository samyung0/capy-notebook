import type { Question, QuestionPart } from '@/api/types';
import { fullPartLabel } from '@/features/questions/groups';
import { QuestionBlockView } from '@/features/questions/QuestionView';
import type { LearnerPart, LearnerQuestion } from '@/features/questions/types';
import { m } from '@/i18n';
import type { PinnedQuestion } from './DrawingBoardScreen';

/** A drawing part's question as its board pins it: the stem, its group's text
 * and figures, then the part. */
export function pinnedQuestion(
  question: Question | LearnerQuestion,
  part: QuestionPart | LearnerPart,
  questionNumber: number | undefined
): PinnedQuestion {
  const label =
    question.parts.length > 1 ? fullPartLabel(question, part.id) : '';
  const number =
    questionNumber === undefined
      ? m.drawing_answer_question()
      : m.quiz_editor_question({ number: questionNumber });
  const blocks = [
    ...question.stem,
    ...(question.groups?.find((group) => group.id === part.group)?.blocks ??
      []),
    ...part.blocks,
  ];
  const first = part.blocks.find((block) => block.type === 'text');
  return {
    body: (
      <div className="flex flex-col gap-2 text-fg-secondary">
        {blocks.map((block, i) => (
          <QuestionBlockView block={block} key={i} />
        ))}
      </div>
    ),
    marks:
      part.marks === 1
        ? m.question_ui_one_mark()
        : m.question_ui_marks({ count: part.marks }),
    short: [questionNumber, label].filter(Boolean).join(' '),
    summary: first?.type === 'text' ? first.text : '',
    title: label ? `${number} ${label}` : number,
  };
}
