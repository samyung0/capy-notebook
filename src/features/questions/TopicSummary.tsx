import { useState } from 'react';
import { copyBankQuestionsBodyQuestionIdsMax as COPY_MAX } from '@/api/gen/validators';
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
import { CopyToQuizDialog } from './CopyToQuizDialog';
import { answerLabels } from './editorFields';
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
 * type, up to seven missed questions to retry (in topic order) with Copy to
 * quiz, then the next topic.
 */
export function TopicSummary({
  questions,
  topicLabel,
  next,
  onOpen,
  onNext,
}: {
  questions: BankSummaryQuestion[];
  topicLabel: string;
  next: NextTopic | null;
  onOpen: (questionId: string) => void;
  onNext: (topic: NextTopic) => void;
}) {
  const [copying, setCopying] = useState(false);
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
        />
        <ResultSquares onOpen={onOpen} results={results} />
      </div>
      <ResultsByType results={results} />
      {missed.length > 0 && (
        <section>
          <div className="mb-1.5 flex flex-wrap items-baseline justify-between gap-x-4">
            <h3 className="font-bold text-fg-muted text-sm">
              {m.question_ui_worth_another_look()}
            </h3>
            <UnderlineLink onClick={() => setCopying(true)}>
              {m.question_ui_copy_to_quiz()}
            </UnderlineLink>
          </div>
          {missed.slice(0, MISSED_ROWS).map((result) => {
            const question = byId.get(result.id);
            return (
              <div
                className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-3.5 border-divider border-t py-3 sm:grid-cols-[auto_minmax(0,1fr)_auto_auto] sm:items-center"
                key={result.id}
              >
                <ResultNumber result={result} />
                <div className="min-w-0">
                  <div className="line-clamp-2 font-semibold sm:truncate">
                    {question?.preview}
                  </div>
                  <div className="text-fg-muted text-xs">
                    {result.type && answerLabels[result.type]()} ·{' '}
                    {result.marks === 1
                      ? m.question_ui_one_mark()
                      : m.question_ui_marks({ count: result.marks })}
                  </div>
                </div>
                <span className="hidden text-fg-secondary text-sm sm:block">
                  {m.result_points({
                    awarded: result.awarded ?? 0,
                    max: result.marks,
                  })}
                </span>
                <UnderlineLink onClick={() => onOpen(result.id)}>
                  {m.question_ui_retry()}
                </UnderlineLink>
              </div>
            );
          })}
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
      {copying && (
        <CopyToQuizDialog
          onClose={() => setCopying(false)}
          onCopied={() => setCopying(false)}
          questionIds={missed.slice(0, COPY_MAX).map((result) => result.id)}
          topicLabel={topicLabel}
        />
      )}
    </div>
  );
}
