import { MatchingGrid } from '@/features/questions/MatchingGrid';
import {
  optionLetter,
  QuestionView,
  TextView,
} from '@/features/questions/QuestionView';
import {
  type LearnerPart,
  type LearnerQuestion,
  multipleAnswers,
  type Question,
  type QuestionPart,
  shownOptions,
} from '@/features/questions/types';
import { m } from '@/i18n';
import { SectionLabel } from './todoParts';

/** An upload's questions as a printed paper (Epo 2026-11-25, mock A): the
 * shared paper view at its body size, marks at the right, choices as lettered
 * text with nothing to pick, and a written part its text alone, since every
 * answer goes on the paper. */
export function PaperSheet({
  questions,
}: {
  questions: (LearnerQuestion | Question)[];
}) {
  return (
    <section aria-label={m.quiz_questions()}>
      <SectionLabel className="pb-1">
        {m.quiz_editor_questions({ count: questions.length })}
      </SectionLabel>
      <ol>
        {questions.map((question, i) => (
          <li
            className="border-divider border-b py-5 last:border-b-0"
            data-paper-question={question.id}
            key={question.id}
          >
            <QuestionView
              question={question}
              questionNumber={i + 1}
              renderAnswer={paperAnswer}
            />
          </li>
        ))}
      </ol>
    </section>
  );
}

/** What a part offers to answer, read only: lettered choices in a row, a
 * matching grid or the items to order; nothing for a written part. */
function paperAnswer(part: QuestionPart | LearnerPart) {
  const answer = part.answer;
  if (answer.type === 'mcq')
    return (
      <div className="col-[2/-1] min-w-0">
        {multipleAnswers(answer) && (
          <p className="mb-1 text-fg-muted text-sm">
            {m.question_ui_multiple_answers()}
          </p>
        )}
        <ol className="flex flex-wrap gap-x-6 gap-y-1">
          {shownOptions(answer).map(({ index, text }, i) => (
            <li className="flex min-w-0 gap-2" key={index}>
              <span className="font-bold">{optionLetter(i)}</span>
              <TextView className="min-w-0" text={text} />
            </li>
          ))}
        </ol>
      </div>
    );
  if (answer.type === 'matching')
    return (
      <MatchingGrid
        className="col-[2/-1] min-w-0"
        columns={answer.options}
        label={m.question_ui_matching()}
        rows={
          'left' in answer ? answer.left : answer.pairs.map((pair) => pair.left)
        }
      />
    );
  if (answer.type === 'ordering')
    return (
      <ol className="col-[2/-1] min-w-0 space-y-1">
        {answer.items.map((text, i) => (
          <li className="flex gap-2" key={i}>
            <span className="w-4.5 shrink-0">{i + 1}.</span>
            <TextView className="min-w-0 flex-1" text={text} />
          </li>
        ))}
      </ol>
    );
  return null;
}
