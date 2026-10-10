import { answerLabels } from '@/features/questions/editorFields';
import { QUESTION_TYPES, type QuestionType } from '@/features/questions/types';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { formatPoints } from './grade';

/** One question's result for the score, squares and type rows; `awarded` is
 * null while the question has no answer for its current content. */
export interface QuestionResult {
  awarded: number | null;
  id: string;
  marks: number;
  number: number;
  /** The question's first part's answer type, which groups it by type. */
  type: QuestionType;
}

type Outcome = 'full' | 'partial' | 'wrong' | 'none';

export function outcomeOf({ awarded, marks }: QuestionResult): Outcome {
  if (awarded === null) return 'none';
  if (marks > 0 && awarded >= marks) return 'full';
  return awarded > 0 ? 'partial' : 'wrong';
}

const FILL: Record<Outcome, string> = {
  full: 'bg-solid-success',
  none: 'bg-surface-hover-bg',
  partial: 'bg-solid-warning',
  wrong: 'bg-solid-error',
};

const squareLabel = (outcome: Outcome, number: number) =>
  ({
    full: m.quiz_question_right,
    none: m.quiz_question_unanswered,
    partial: m.quiz_question_partial,
    wrong: m.quiz_question_wrong,
  })[outcome]({ number });

/** "34 / 47" large, then "marks" and the percentage small. */
export function ResultScore({
  awarded,
  max,
}: {
  awarded: number;
  max: number;
}) {
  return (
    <p className="flex flex-wrap items-baseline gap-x-2.5">
      <span className="font-extrabold text-4xl text-fg leading-none">
        {formatPoints(awarded)} / {formatPoints(max)}
      </span>
      <span className="font-semibold text-fg-secondary">
        {m.result_marks()}
      </span>
      <span className="ml-1 font-semibold text-fg-secondary">
        {max > 0 ? Math.round((awarded / max) * 100) : 0}%
      </span>
    </p>
  );
}

/**
 * One numbered square per question, green for full marks, amber for partial,
 * red for none (blank answers are wrong) and grey without an answer; with
 * `onOpen` each square opens its question. A legend counts each colour.
 */
export function ResultSquares({
  results,
  onOpen,
}: {
  results: QuestionResult[];
  onOpen?: (id: string) => void;
}) {
  const counts = { full: 0, none: 0, partial: 0, wrong: 0 };
  for (const result of results) counts[outcomeOf(result)]++;
  const legend = [
    ['full', m.result_full({ count: counts.full })],
    ['partial', m.result_partial({ count: counts.partial })],
    ['wrong', m.result_wrong({ count: counts.wrong })],
    ['none', m.result_unanswered({ count: counts.none })],
  ] as const;
  return (
    <div>
      <ol
        aria-label={m.quiz_question_results()}
        className="flex flex-wrap gap-1.5"
      >
        {results.map((result) => {
          const outcome = outcomeOf(result);
          const label = squareLabel(outcome, result.number);
          const className = cn(
            'grid size-6.5 place-items-center rounded-md font-bold text-[#1d2330] text-[0.72rem]',
            FILL[outcome],
            outcome === 'none' && 'text-fg-secondary'
          );
          return (
            <li key={result.id}>
              {onOpen ? (
                <button
                  aria-label={label}
                  className={cn(className, 'cursor-pointer hover:opacity-80')}
                  onClick={() => onOpen(result.id)}
                  title={label}
                  type="button"
                >
                  {result.number}
                </button>
              ) : (
                <span aria-label={label} className={className} title={label}>
                  {result.number}
                </span>
              )}
            </li>
          );
        })}
      </ol>
      <div className="mt-2.5 flex flex-wrap gap-x-3.5 gap-y-1 text-fg-secondary text-sm">
        {legend.map(
          ([outcome, text]) =>
            counts[outcome] > 0 && (
              <span className="inline-flex items-center gap-1.5" key={outcome}>
                <span
                  aria-hidden
                  className={cn('size-2.5 rounded-[3px]', FILL[outcome])}
                />
                {text}
              </span>
            )
        )}
      </div>
    </div>
  );
}

/** Marks by answer type: a row per type present, with small plain squares. */
export function ResultsByType({ results }: { results: QuestionResult[] }) {
  const types = QUESTION_TYPES.filter((type) =>
    results.some((result) => result.type === type)
  );
  return (
    <section>
      <h3 className="mb-1.5 font-bold text-fg-muted text-sm">
        {m.result_by_type()}
      </h3>
      {types.map((type) => {
        const rows = results.filter((result) => result.type === type);
        return (
          <div
            className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1.5 border-divider border-t py-2.5 sm:grid-cols-[9rem_minmax(0,1fr)_auto]"
            key={type}
          >
            <span className="font-semibold">{answerLabels[type]()}</span>
            <ol className="col-span-2 row-start-2 flex flex-wrap gap-1 sm:col-span-1 sm:row-start-auto">
              {rows.map((result) => (
                <li
                  aria-label={squareLabel(outcomeOf(result), result.number)}
                  className={cn(
                    'size-3.5 rounded-[4px]',
                    FILL[outcomeOf(result)]
                  )}
                  key={result.id}
                />
              ))}
            </ol>
            <span className="col-start-2 row-start-1 text-right text-fg-secondary text-sm sm:col-start-auto sm:row-start-auto">
              {m.result_type_marks({
                awarded: formatPoints(
                  rows.reduce((sum, result) => sum + (result.awarded ?? 0), 0)
                ),
                max: formatPoints(
                  rows.reduce((sum, result) => sum + result.marks, 0)
                ),
              })}
            </span>
          </div>
        );
      })}
    </section>
  );
}
