import { type ReactNode, useState } from 'react';
import type { PastReview, ReviewAnswer, ReviewResult } from '@/api/types';
import { SortMenu, type SortOption } from '@/components/app/ListToolbar';
import { Icon } from '@/components/ui/Icon';
import { UnderlineLink } from '@/components/ui/UnderlineLink';
import {
  ResultCardGrid,
  ResultCardTile,
} from '@/features/flashcards/FlashcardResult';
import { TextView } from '@/features/questions/TextView';
import type { QuestionBlock, TextBlock } from '@/features/questions/types';
import { formatPoints } from '@/features/quizzes/grade';
import { QuestionRunner } from '@/features/quizzes/QuestionRunner';
import { getLocale, m } from '@/i18n';
import { cn } from '@/lib/cn';
import { SRS_RATINGS, type SrsRating } from '@/lib/srs';
import { RATING_LABEL } from './ratings';

/* A review session's result (human/study-progress.md, 2026-10-19): questions
   and flashcards side by side, each with one bar from best to worst, then
   every answered item, opening to its graded question or the card's back. */

type Outcome = 'full' | 'partial' | 'wrong';
type Tone = 'success' | 'info' | 'warning' | 'error';

const OUTCOMES: Outcome[] = ['full', 'partial', 'wrong'];
const OUTCOME_TONE: Record<Outcome, Tone> = {
  full: 'success',
  partial: 'warning',
  wrong: 'error',
};
const OUTCOME_LABEL: Record<Outcome, () => string> = {
  full: m.review_result_right,
  partial: m.review_result_partial,
  wrong: m.review_result_wrong,
};
const LEGEND_LABEL: Record<Outcome, () => string> = {
  full: m.review_result_legend_right,
  partial: m.review_result_legend_partial,
  wrong: m.review_result_legend_wrong,
};
/** Flashcards run best to worst, as questions do. */
const CARD_RATINGS = [...SRS_RATINGS].reverse();
const RATING_TONE: Record<SrsRating, Tone> = {
  again: 'error',
  easy: 'success',
  good: 'info',
  hard: 'warning',
};
const FILL: Record<Tone, string> = {
  error: 'bg-solid-error',
  info: 'bg-solid-info',
  success: 'bg-solid-success',
  warning: 'bg-solid-warning',
};
const TEXT: Record<Tone, string> = {
  error: 'text-tint-error-fg',
  info: 'text-tint-info-fg',
  success: 'text-tint-success-fg',
  warning: 'text-tint-warning-fg',
};

const outcomeOf = (a: ReviewAnswer): Outcome => {
  const correct = a.correct ?? 0;
  if (correct >= (a.total ?? 0)) return 'full';
  return correct > 0 ? 'partial' : 'wrong';
};
const ratingOf = (a: ReviewAnswer) => SRS_RATINGS[a.rating - 1];
/** How well it went, 0 to 1, for the hardest and easiest orders. */
const scoreOf = (a: ReviewAnswer) =>
  a.kind === 'card' ? (a.rating - 1) / 3 : (a.correct ?? 0) / (a.total || 1);

const blockText = (blocks: QuestionBlock[] = []) =>
  blocks.find((b): b is TextBlock => b.type === 'text' && b.text.trim() !== '')
    ?.text;

/** A question's first line of text, from its stem or else its first part. */
function questionText(a: ReviewAnswer) {
  const q = a.question;
  if (!q) return '';
  return (
    blockText(q.stem) ??
    q.parts.map((p) => blockText(p.blocks)).find(Boolean) ??
    ''
  );
}

/** "Oct 18, 2026, 4:12 PM · Biology 101 · 11 min". */
export function reviewResultMeta(s: PastReview) {
  const minutes = Math.max(
    1,
    Math.round((Date.parse(s.lastAnswerAt) - Date.parse(s.startedAt)) / 60_000)
  );
  return [
    new Intl.DateTimeFormat(getLocale(), {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(s.startedAt)),
    s.workspaceName,
    m.past_minutes({ count: minutes }),
  ].join(' · ');
}

type Order = 'order' | 'hardest' | 'easiest';

export function ReviewResultBody({
  result,
  onAgain,
  againLabel = m.review_again(),
  footer,
}: {
  result: ReviewResult;
  onAgain: () => void;
  againLabel?: string;
  /** Under the items: the next suggestion at the end of a session. */
  footer?: ReactNode;
}) {
  // Numbered in review order, so each section's numbers skip the other's.
  const numbered = result.items.map((item, n) => ({ item, n: n + 1 }));
  const questions = result.items.filter((a) => a.kind === 'question');
  const cards = result.items.filter((a) => a.kind === 'card');
  // "Questions 5 / 10": each kind's share of the session's items.
  const share = (label: string, count: number) =>
    `${label} ${m.result_points({ awarded: count, max: result.items.length })}`;
  const questionsLabel = share(m.review_result_questions(), questions.length);
  const cardsLabel = share(m.review_result_cards(), cards.length);
  const sum = (list: ReviewAnswer[], key: 'correct' | 'total') =>
    list.reduce((total, a) => total + (a[key] ?? 0), 0);
  return (
    <div>
      <div className="mb-6.5 flex items-center justify-between gap-3">
        {result.better > 0 ? (
          <span className="inline-flex items-center gap-1 font-bold text-[13px] text-tint-success-fg">
            <Icon name="arrowUp" size={14} />
            {m.review_result_better({ count: result.better })}
          </span>
        ) : (
          <span />
        )}
        <UnderlineLink accent onClick={onAgain}>
          {againLabel}
        </UnderlineLink>
      </div>
      <div
        className={cn(
          'grid border-divider border-b pb-5.5',
          questions.length > 0 && cards.length > 0 && 'sm:grid-cols-2'
        )}
      >
        {questions.length > 0 && (
          <ScoreHalf
            bar={OUTCOMES.map((o) => ({
              count: questions.filter((a) => outcomeOf(a) === o).length,
              label: LEGEND_LABEL[o](),
              tone: OUTCOME_TONE[o],
            }))}
            className={cn(cards.length > 0 && 'pb-4.5 sm:pr-7 sm:pb-0')}
            label={questionsLabel}
            score={`${formatPoints(sum(questions, 'correct'))} / ${formatPoints(sum(questions, 'total'))}`}
            unit={m.result_marks()}
          />
        )}
        {cards.length > 0 && (
          <ScoreHalf
            bar={CARD_RATINGS.map((r) => ({
              count: cards.filter((a) => ratingOf(a) === r).length,
              label: RATING_LABEL[r](),
              tone: RATING_TONE[r],
            }))}
            className={cn(
              questions.length > 0 &&
                'border-divider border-t pt-4 sm:border-t-0 sm:border-l sm:pt-0 sm:pl-7'
            )}
            label={cardsLabel}
            score={`${cards.filter((a) => a.rating >= 3).length} / ${cards.length}`}
            unit={m.flashcards_result_good()}
          />
        )}
      </div>
      {questions.length > 0 && (
        <SortedSection
          items={numbered.filter(({ item }) => item.kind === 'question')}
          title={questionsLabel}
        >
          {(shown) => (
            <ol>
              {shown.map(({ item, n }) => (
                <QuestionRow
                  item={item}
                  key={`${item.materialId}/${item.itemId}`}
                  n={n}
                />
              ))}
            </ol>
          )}
        </SortedSection>
      )}
      {cards.length > 0 && (
        <SortedSection
          items={numbered.filter(({ item }) => item.kind === 'card')}
          title={cardsLabel}
        >
          {(shown) => (
            <ResultCardGrid>
              {shown.map(({ item, n }) => (
                <ResultCardTile
                  card={{ back: item.back ?? '', front: item.front ?? '' }}
                  key={`${item.materialId}/${item.itemId}`}
                  n={n}
                  ratings={[item.rating]}
                />
              ))}
            </ResultCardGrid>
          )}
        </SortedSection>
      )}
      {footer}
    </div>
  );
}

type Numbered = { item: ReviewAnswer; n: number };

/** One kind's items under its heading, in review order or by how
 * well they went. */
function SortedSection({
  title,
  items,
  children,
}: {
  title: string;
  items: Numbered[];
  children: (shown: Numbered[]) => ReactNode;
}) {
  const [order, setOrder] = useState<Order>('order');
  const shown =
    order === 'order'
      ? items
      : [...items].sort(
          (a, b) =>
            (order === 'hardest' ? 1 : -1) * (scoreOf(a.item) - scoreOf(b.item))
        );
  const sorts: SortOption<Order>[] = [
    { icon: 'listOrdered', label: m.review_result_order(), value: 'order' },
    { icon: 'flame', label: m.flashcards_sort_hardest(), value: 'hardest' },
    { icon: 'feather', label: m.flashcards_sort_easiest(), value: 'easiest' },
  ];
  return (
    <section className="mt-6">
      <div className="mb-2 flex min-h-9 items-center justify-between gap-3">
        <h3 className="font-extrabold text-[15px]">{title}</h3>
        <SortMenu
          ascending={false}
          onSortChange={setOrder}
          sort={order}
          sorts={sorts}
        />
      </div>
      {children(shown)}
    </section>
  );
}

function ScoreHalf({
  label,
  score,
  unit,
  bar,
  className,
}: {
  label: string;
  score: string;
  unit: string;
  bar: { count: number; label: string; tone: Tone }[];
  className?: string;
}) {
  const parts = bar.filter((p) => p.count > 0);
  return (
    <div className={cn('min-w-0', className)}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-2">
        <p className="font-bold text-[13px] text-fg-muted">{label}</p>
        <p className="flex items-baseline gap-1.5">
          <span className="font-extrabold text-2xl text-fg leading-tight sm:text-[28px]">
            {score}
          </span>
          <span className="font-semibold text-[13px] text-fg-secondary sm:text-sm">
            {unit}
          </span>
        </p>
      </div>
      <div className="mt-3 flex h-2.5 gap-0.75">
        {parts.map((p) => (
          <span
            className={cn('min-w-1 rounded-[3px]', FILL[p.tone])}
            key={p.label}
            style={{ flex: p.count }}
          />
        ))}
      </div>
      <p className="mt-2 flex flex-wrap gap-x-3 gap-y-0.75 text-[12.5px] text-fg-secondary">
        {parts.map((p) => (
          <span className="inline-flex items-center gap-1.25" key={p.label}>
            <span className={cn('size-2.25 rounded-[3px]', FILL[p.tone])} />
            <b className="font-bold text-fg">{p.count}</b>
            {p.label}
          </span>
        ))}
      </p>
    </div>
  );
}

/** A question's part results as small squares, "n. text", its quiz and
 * marks, the result in words; it opens to the graded question. */
function QuestionRow({ item, n }: { item: ReviewAnswer; n: number }) {
  const [open, setOpen] = useState(false);
  const tone = OUTCOME_TONE[outcomeOf(item)];
  const parts = item.question?.parts.map((p) =>
    outcomeOf({ ...item, correct: p.awarded ?? 0, total: p.marks })
  ) ?? [outcomeOf(item)];
  return (
    <li className="border-divider border-t last:border-b">
      <button
        aria-expanded={open}
        className="grid w-full cursor-pointer grid-cols-[1.75rem_minmax(0,1fr)_auto_auto] items-start gap-x-3.5 py-3 text-left sm:items-center"
        onClick={() => setOpen(!open)}
        type="button"
      >
        <span className="flex flex-wrap gap-0.5 pt-1 sm:pt-0">
          {parts.map((o, i) => (
            <span
              className={cn('size-3 rounded-[3px]', FILL[OUTCOME_TONE[o]])}
              key={i}
            />
          ))}
        </span>
        <span className="min-w-0">
          <span className="line-clamp-2 font-semibold sm:line-clamp-1">
            {n}. <TextView text={questionText(item)} />
          </span>
          <span className="block text-fg-muted text-xs">
            {item.materialTitle}
            {' · '}
            <span className={cn('font-semibold', TEXT[tone])}>
              {item.total === 1
                ? m.review_result_mark({
                    awarded: formatPoints(item.correct ?? 0),
                  })
                : m.review_result_marks({
                    awarded: formatPoints(item.correct ?? 0),
                    max: formatPoints(item.total ?? 0),
                  })}
            </span>
          </span>
        </span>
        <span className={cn('font-semibold text-sm', TEXT[tone])}>
          {OUTCOME_LABEL[outcomeOf(item)]()}
        </span>
        <Icon
          className="text-fg-muted"
          name={open ? 'chevronUp' : 'chevronDown'}
          size={16}
        />
      </button>
      {open && item.question && (
        <div className="pb-4 sm:pl-10.5">
          <QuestionRunner
            answers={item.answers ?? {}}
            disabled
            headerMarks={false}
            question={item.question}
            review
          />
        </div>
      )}
    </li>
  );
}
