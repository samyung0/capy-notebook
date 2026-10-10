import type {
  ReviewAnswer,
  ReviewItem,
  ReviewMode,
  ReviewSuggestion,
} from '@/api/types';
import { UnderlineLink } from '@/components/ui/UnderlineLink';
import { answerLabels } from '@/features/questions/editorFields';
import { TextView } from '@/features/questions/TextView';
import type { QuestionBlock, TextBlock } from '@/features/questions/types';
import { formatPoints } from '@/features/quizzes/grade';
import {
  OUTCOME_FILL,
  type Outcome,
  outcomeOf,
  type QuestionResult,
  ResultNumber,
  ResultSquares,
} from '@/features/quizzes/ResultSummary';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { SRS_RATINGS } from '@/lib/srs';
import { RATING_LABEL } from './ratings';
import { groupName, itemCount, REVIEW_MODE } from './reviewText';

/** What a session recorded for an item: a card's rating (1 Again to 4 Easy),
 * or a question's marks. None means it was skipped. */
export interface ReviewRecord {
  correct?: number;
  rating?: number;
  total?: number;
}

/** A session item, a question in either its answer-free or graded form. */
type SessionItem = ReviewItem | ReviewAnswer;

export interface SummaryItem {
  item: SessionItem;
  record?: ReviewRecord;
}

const LEGEND: Record<Outcome, (count: number) => string> = {
  full: (count) => m.review_legend_full({ count }),
  none: (count) => m.review_legend_skipped({ count }),
  partial: (count) => m.review_legend_partial({ count }),
  wrong: (count) => m.review_legend_wrong({ count }),
};

// Card ratings on the result scale: Good and Easy right, Hard partial,
// Again wrong.
const CARD_AWARD = [0, 0.5, 1, 1];

const blockText = (blocks: QuestionBlock[] = []) =>
  blocks.find((b): b is TextBlock => b.type === 'text' && b.text.trim() !== '')
    ?.text;

/** A question's first line of text, from its stem or else its first part. */
function questionText(item: SessionItem) {
  const q = item.question;
  if (!q) return '';
  return (
    blockText(q.stem) ??
    q.parts.map((p) => blockText(p.blocks)).find(Boolean) ??
    ''
  );
}

const marksOf = (item: SessionItem) =>
  item.question?.parts.reduce((sum, p) => sum + p.marks, 0) ?? 0;

function resultOf({ item, record }: SummaryItem, index: number) {
  const key = `${item.materialId}/${item.itemId}`;
  if (item.kind === 'card')
    return {
      awarded: record?.rating ? CARD_AWARD[record.rating - 1] : null,
      id: key,
      marks: 1,
      number: index + 1,
    } satisfies QuestionResult;
  return {
    awarded: record?.correct ?? null,
    id: key,
    marks: record?.total ?? marksOf(item),
    number: index + 1,
    type: item.question?.parts[0]?.answer.type,
  } satisfies QuestionResult;
}

/** The end of a review session, in the topic summary's style: one square per
 * item, questions by marks and cards by rating, the misses to look at again
 * and what to review next. Skipped items count toward nothing. */
export function ReviewSummary({
  items,
  mode,
  next,
  onMore,
  onNext,
  onOpen,
  title,
  when,
}: {
  items: SummaryItem[];
  mode?: ReviewMode;
  next?: ReviewSuggestion;
  onMore: () => void;
  onNext: (suggestion: ReviewSuggestion) => void;
  onOpen: (item: SessionItem) => void;
  title: string;
  when: string;
}) {
  const results = items.map(resultOf);
  const byKey = new Map(
    items.map((entry, i) => [results[i].id, { ...entry, result: results[i] }])
  );
  const open = (id: string) => {
    const entry = byKey.get(id);
    if (entry) onOpen(entry.item);
  };
  const reviewed = results.filter((r) => r.awarded !== null).length;
  const skipped = results.length - reviewed;
  const missed = [...byKey.values()].filter(({ result }) =>
    ['partial', 'wrong'].includes(outcomeOf(result))
  );
  const skippedItems = results.filter((r) => r.awarded === null);
  const questions = [...byKey.values()].filter(
    (e) => e.item.kind === 'question'
  );
  const cards = [...byKey.values()].filter((e) => e.item.kind === 'card');
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-9">
      <div className="grid gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
          <h2 className="t-page-title min-w-0">{title}</h2>
          <UnderlineLink accent onClick={onMore}>
            {m.review_more()}
          </UnderlineLink>
        </div>
        <p className="t-meta text-fg-muted">
          {m.review_summary_meta({ items: itemCount(items.length), when })}
          {mode && ` · ${REVIEW_MODE[mode].label()}`}
        </p>
        <p className="mt-2 flex flex-wrap items-baseline gap-x-2.5">
          <span className="font-extrabold text-4xl text-fg leading-none">
            {reviewed}
          </span>
          <span className="font-semibold text-fg-secondary">
            {m.review_summary_reviewed()}
          </span>
          {skipped > 0 && (
            <span className="ml-1 font-semibold text-fg-secondary">
              {m.review_summary_skipped({ count: skipped })}
            </span>
          )}
        </p>
        <ResultSquares legend={LEGEND} onOpen={open} results={results} />
      </div>

      <section>
        <h3 className="mb-1.5 font-bold text-fg-muted text-sm">
          {m.review_summary_by_kind()}
        </h3>
        {questions.length > 0 && (
          <KindRow
            label={m.review_summary_questions()}
            results={questions.map((e) => e.result)}
            value={m.result_type_marks({
              awarded: formatPoints(
                questions.reduce((sum, e) => sum + (e.result.awarded ?? 0), 0)
              ),
              max: formatPoints(
                questions.reduce((sum, e) => sum + e.result.marks, 0)
              ),
            })}
          />
        )}
        {cards.length > 0 && (
          <KindRow
            label={m.review_summary_cards()}
            results={cards.map((e) => e.result)}
            value={ratingCounts(cards.map((e) => e.record?.rating))}
          />
        )}
      </section>

      {missed.length > 0 && (
        <section>
          <h3 className="mb-1.5 font-bold text-fg-muted text-sm">
            {m.question_ui_worth_another_look()}
          </h3>
          {missed.map(({ item, record, result }) => (
            <div
              className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-3.5 border-divider border-t py-3 sm:grid-cols-[auto_minmax(0,1fr)_auto_auto] sm:items-center"
              key={result.id}
            >
              <ResultNumber result={result} />
              <div className="min-w-0">
                <div className="line-clamp-2 font-semibold sm:truncate">
                  {item.kind === 'card' ? (
                    item.front
                  ) : (
                    <TextView text={questionText(item)} />
                  )}
                </div>
                <div className="text-fg-muted text-xs">
                  {item.kind === 'card'
                    ? m.review_summary_card()
                    : [
                        result.type && answerLabels[result.type](),
                        result.marks === 1
                          ? m.question_ui_one_mark()
                          : m.question_ui_marks({ count: result.marks }),
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                  {` · ${item.materialTitle}`}
                </div>
              </div>
              <span className="hidden text-fg-secondary text-sm sm:block">
                {item.kind === 'card' && record?.rating
                  ? RATING_LABEL[SRS_RATINGS[record.rating - 1]]()
                  : m.result_points({
                      awarded: result.awarded ?? 0,
                      max: result.marks,
                    })}
              </span>
              <UnderlineLink noArrow onClick={() => onOpen(item)}>
                {m.review_summary_open()}
              </UnderlineLink>
            </div>
          ))}
        </section>
      )}

      {skippedItems.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 border-divider border-t py-3">
          <span className="me-1.5 text-fg-muted text-xs">
            {m.review_summary_skipped_list()}
          </span>
          {skippedItems.map((result) => (
            <ResultNumber
              key={result.id}
              onClick={() => open(result.id)}
              result={result}
              small
            />
          ))}
        </div>
      )}

      {next && (
        <section>
          <h3 className="mb-1.5 font-bold text-fg-muted text-sm">
            {m.review_summary_next()}
          </h3>
          <div className="flex items-center justify-between gap-4 border-divider border-y py-3">
            <div className="min-w-0">
              <div className="truncate font-semibold">
                {[next.workspaceName, groupName(next.group, next.chapterName)]
                  .filter(Boolean)
                  .join(' · ')}
              </div>
              <div className="text-fg-muted text-xs">
                <span className={REVIEW_MODE[next.mode].className}>
                  {REVIEW_MODE[next.mode].label()}
                </span>
                {` · ${itemCount(next.items)}`}
              </div>
            </div>
            <UnderlineLink onClick={() => onNext(next)}>
              {m.review_start()}
            </UnderlineLink>
          </div>
        </section>
      )}
    </div>
  );
}

/** "4 Good · 1 Hard": the session's card ratings, best first. */
function ratingCounts(ratings: (number | undefined)[]) {
  return [...SRS_RATINGS]
    .reverse()
    .map((rating) => {
      const count = ratings.filter(
        (r) => r === SRS_RATINGS.indexOf(rating) + 1
      ).length;
      return count
        ? m.review_summary_rating_count({
            count,
            rating: RATING_LABEL[rating](),
          })
        : '';
    })
    .filter(Boolean)
    .join(' · ');
}

/** One kind's row: label, a small square per item and its total. */
function KindRow({
  label,
  results,
  value,
}: {
  label: string;
  results: QuestionResult[];
  value: string;
}) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1.5 border-divider border-t py-2.5 sm:grid-cols-[9rem_minmax(0,1fr)_auto]">
      <span className="font-semibold">{label}</span>
      <ol className="col-span-2 row-start-2 flex flex-wrap gap-1 sm:col-span-1 sm:row-start-auto">
        {results.map((result) => {
          const outcome = outcomeOf(result);
          return (
            <li
              className={cn('size-3.5 rounded-[4px]', OUTCOME_FILL[outcome])}
              key={result.id}
            />
          );
        })}
      </ol>
      <span className="col-start-2 row-start-1 text-right text-fg-secondary text-sm sm:col-start-auto sm:row-start-auto">
        {value}
      </span>
    </div>
  );
}
