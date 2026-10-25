import type { BankSummaryQuestion } from '@/api/types';
import { UnderlineLink } from '@/components/ui/UnderlineLink';
import {
  outcomeOf,
  type QuestionResult,
  ResultNumber,
  ResultScore,
  ResultSquares,
  ResultsByType,
} from '@/features/quizzes/ResultSummary';
import { m } from '@/i18n';
import type { QuestionType } from './types';

/** Questions listed under Worth another look; the rest show as numbers. */
const MISSED_ROWS = 7;

/** The next topic to suggest: unfinished, in the same subject. */
export interface NextTopic {
  id: string;
  label: string;
  started: boolean;
  subjectLabel: string;
  total: number;
}

/**
 * A /qb topic's summary: the score in marks, a square per question, marks by
 * type, up to seven missed questions (in topic order) whose rows open the
 * question, then the next topic.
 */
export function TopicSummary({
  questions,
  next,
  onOpen,
  onNext,
}: {
  questions: BankSummaryQuestion[];
  next: NextTopic | null;
  onOpen: (questionId: string) => void;
  onNext: (topic: NextTopic) => void;
}) {
  const results = questions.map(
    (q, i): QuestionResult => ({
      awarded: q.score === null ? null : q.score * q.marks,
      id: q.id,
      marks: q.marks,
      number: i + 1,
      type: q.answerTypes[0] as QuestionType,
    })
  );
  const missed = results.filter((result) =>
    ['partial', 'wrong'].includes(outcomeOf(result))
  );
  const byId = new Map(questions.map((q) => [q.id, q]));
  return (
    <div className="flex flex-col gap-9">
      <div className="grid gap-3">
        <ResultScore
          awarded={results.reduce((sum, r) => sum + (r.awarded ?? 0), 0)}
          max={results.reduce((sum, r) => sum + r.marks, 0)}
          percent
        />
        <ResultSquares onOpen={onOpen} results={results} />
      </div>
      <ResultsByType results={results} />
      {missed.length > 0 && (
        <section>
          <h3 className="mb-1.5 font-bold text-fg-muted text-sm">
            {m.question_ui_worth_another_look()}
          </h3>
          {missed.slice(0, MISSED_ROWS).map((result) => (
            <button
              className="grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3.5 border-divider border-t px-2 py-3 text-left outline-none hover:bg-surface-hover-bg focus-visible:ring-2 focus-visible:ring-tint-accent-1-fg"
              key={result.id}
              onClick={() => onOpen(result.id)}
              type="button"
            >
              <ResultNumber result={result} />
              <span className="line-clamp-2 min-w-0 font-semibold sm:truncate">
                {byId.get(result.id)?.preview}
              </span>
              <span className="text-fg-secondary text-sm">
                {m.result_points({
                  awarded: result.awarded ?? 0,
                  max: result.marks,
                })}
              </span>
            </button>
          ))}
          {missed.length > MISSED_ROWS && (
            <div className="flex flex-wrap items-center gap-1.5 border-divider border-t py-3">
              <span className="me-1.5 text-fg-muted text-xs">
                {m.question_ui_more_missed({
                  count: missed.length - MISSED_ROWS,
                })}
              </span>
              {missed.slice(MISSED_ROWS).map((result) => (
                <ResultNumber
                  key={result.id}
                  onClick={() => onOpen(result.id)}
                  result={result}
                  small
                />
              ))}
            </div>
          )}
        </section>
      )}
      {next && (
        <section>
          <h3 className="mb-1.5 font-bold text-fg-muted text-sm">
            {m.question_ui_next_in({ subject: next.subjectLabel })}
          </h3>
          <div className="flex items-center justify-between gap-4 border-divider border-y py-3">
            <div className="min-w-0">
              <div className="truncate font-semibold">{next.label}</div>
              <div className="text-fg-muted text-xs">
                {next.total === 1
                  ? m.question_ui_one_question()
                  : m.question_ui_question_count({ count: next.total })}
                {!next.started && ` · ${m.question_ui_not_started()}`}
              </div>
            </div>
            <UnderlineLink onClick={() => onNext(next)}>
              {next.started ? m.question_ui_continue() : m.common_start()}
            </UnderlineLink>
          </div>
        </section>
      )}
    </div>
  );
}
