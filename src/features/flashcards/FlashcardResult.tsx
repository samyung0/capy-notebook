import { type ReactNode, useState } from 'react';
import type { AttemptCard, PreviousAttempt } from '@/api/types';
import { SortMenu, type SortOption } from '@/components/app/ListToolbar';
import { Icon } from '@/components/ui/Icon';
import { RATING_LABEL } from '@/features/study/ratings';
import { getLocale, m } from '@/i18n';
import { cn } from '@/lib/cn';
import { SRS_RATINGS, type SrsRating } from '@/lib/srs';
import { CardBackFace } from './CardView';

/** A rating's result colour (bars) and tint (each card's rating chips). */
const TONE: Record<SrsRating, { bar: string; chip: string }> = {
  again: { bar: 'bg-solid-error', chip: 'bg-tint-error text-tint-error-fg' },
  easy: {
    bar: 'bg-solid-success',
    chip: 'bg-tint-success text-tint-success-fg',
  },
  good: { bar: 'bg-solid-info', chip: 'bg-tint-info text-tint-info-fg' },
  hard: {
    bar: 'bg-solid-warning',
    chip: 'bg-tint-warning text-tint-warning-fg',
  },
};

const ratingOf = (n: number) => SRS_RATINGS[n - 1];

type CardOrder = 'order' | 'hardest' | 'easiest';

/** Harder first: the first rating, then the last one. */
const hardness = (a: AttemptCard, b: AttemptCard) =>
  a.ratings[0] - b.ratings[0] ||
  (a.ratings.at(-1) ?? 0) - (b.ratings.at(-1) ?? 0);

/** A study run's result: the score with its change since the set's previous
 * attempt when it gained, time and card count beside a bar per rating, then every card's
 * back in a grid with its ratings, numbered in the order first rated. */
export function FlashcardResult({
  cards,
  minutes,
  previous,
}: {
  cards: AttemptCard[];
  /** "9 min"; absent where the start is unknown. */
  minutes?: string;
  previous?: PreviousAttempt;
}) {
  const [order, setOrder] = useState<CardOrder>('order');
  const counts = Object.fromEntries(
    SRS_RATINGS.map((rating) => [
      rating,
      cards.filter((card) => ratingOf(card.ratings[0]) === rating).length,
    ])
  ) as Record<SrsRating, number>;
  const good = counts.good + counts.easy;
  const numbered = cards.map((card, i) => ({ card, n: i + 1 }));
  if (order !== 'order')
    numbered.sort(
      (a, b) => (order === 'hardest' ? 1 : -1) * hardness(a.card, b.card)
    );
  const sorts: SortOption<CardOrder>[] = [
    { icon: 'listOrdered', label: m.flashcards_sort_order(), value: 'order' },
    { icon: 'flame', label: m.flashcards_sort_hardest(), value: 'hardest' },
    { icon: 'feather', label: m.flashcards_sort_easiest(), value: 'easiest' },
  ];
  return (
    <div>
      <div className="grid gap-7 border-divider border-b pb-7 sm:grid-cols-[minmax(0,1fr)_minmax(0,420px)] sm:items-end">
        <div>
          <p className="flex flex-wrap items-baseline gap-x-2.5">
            <span className="font-extrabold text-4xl text-fg leading-none">
              {good} / {cards.length}
            </span>
            <span className="font-semibold text-fg-secondary">
              {m.flashcards_result_good()}
            </span>
          </p>
          {previous && good > previous.correct && (
            <Gain count={good - previous.correct} since={previous.takenAt} />
          )}
          <p className="mt-4.5 flex flex-wrap gap-x-4.5 gap-y-1.5 text-fg-secondary text-sm">
            {minutes && (
              <span className="inline-flex items-center gap-1.5">
                <Icon name="clock" strokeWidth={2.2} />
                {minutes}
              </span>
            )}
            <span className="inline-flex items-center gap-1.5">
              <Icon name="flashcards" strokeWidth={2.2} />
              {cards.length === 1
                ? m.flashcards_result_cards_one()
                : m.flashcards_result_cards({ count: cards.length })}
            </span>
          </p>
        </div>
        <RatingChart counts={counts} />
      </div>
      <div className="mt-7 mb-3.5 flex min-h-9 items-center justify-between gap-3">
        <h3 className="font-extrabold text-[15px]">
          {m.flashcards_result_heading()}
        </h3>
        <SortMenu
          ascending={false}
          onSortChange={setOrder}
          sort={order}
          sorts={sorts}
        />
      </div>
      <ResultCardGrid>
        {numbered.map(({ card, n }) => (
          <ResultCardTile
            card={card}
            key={card.id}
            n={n}
            ratings={card.ratings}
          />
        ))}
      </ResultCardGrid>
    </div>
  );
}

/** Result tiles in columns of 350px or more that share the width. */
export function ResultCardGrid({ children }: { children: ReactNode }) {
  return (
    <ol className="grid grid-cols-1 gap-2.5 sm:grid-cols-[repeat(auto-fill,minmax(350px,1fr))] sm:gap-3.5">
      {children}
    </ol>
  );
}

/** A card's back as a result tile: its number in the order first rated and
 * its ratings, as Learning's review result also lists cards. */
export function ResultCardTile({
  card,
  n,
  ratings,
}: {
  card: Pick<AttemptCard, 'back' | 'front'>;
  n: number;
  ratings: number[];
}) {
  return (
    <li className="flex flex-col overflow-hidden rounded-card-lg border border-line bg-surface">
      <CardBackFace card={card} className="flex-1" size="tile" />
      <div className="flex items-center justify-between gap-2 px-3.5 pb-3">
        <span className="font-bold text-[13px] text-fg-muted">{n}</span>
        <span className="flex items-center gap-1 whitespace-nowrap">
          {ratings.map((r, j) => (
            <span className="contents" key={j}>
              {j > 0 && (
                <Icon className="text-fg-muted" name="arrowRight" size={12} />
              )}
              <span
                className={cn(
                  'rounded-input px-2 py-0.5 font-bold text-xs',
                  TONE[ratingOf(r)].chip
                )}
              >
                {RATING_LABEL[ratingOf(r)]()}
              </span>
            </span>
          ))}
        </span>
      </div>
    </li>
  );
}

/** More cards rated good than in the set's previous attempt; a run that did
 * no better shows nothing (Epo 2026-10-19). */
function Gain({ count, since }: { count: number; since: string }) {
  const date = new Date(since).toLocaleDateString(getLocale(), {
    day: 'numeric',
    month: 'short',
  });
  return (
    <p className="mt-2.5 inline-flex items-center gap-1 rounded-full bg-tint-success py-0.75 pr-2.5 pl-2 font-bold text-[13px] text-tint-success-fg">
      <Icon name="arrowUp" size={14} />
      {m.flashcards_result_change({ count, date })}
    </p>
  );
}

/** One bar per rating with its count, labelled by the axis. */
function RatingChart({ counts }: { counts: Record<SrsRating, number> }) {
  const top = Math.max(1, ...Object.values(counts));
  return (
    <section aria-label={m.flashcards_result_by_rating()} className="w-full">
      <div className="grid h-40 grid-cols-4 items-end gap-1.5 border-line border-b">
        {SRS_RATINGS.map((rating) => (
          <div
            className="flex h-full flex-col items-center justify-end gap-1"
            key={rating}
            title={
              counts[rating] === 1
                ? m.flashcards_result_bar_one({
                    rating: RATING_LABEL[rating](),
                  })
                : m.flashcards_result_bar({
                    count: counts[rating],
                    rating: RATING_LABEL[rating](),
                  })
            }
          >
            <span className="font-bold text-fg text-sm">{counts[rating]}</span>
            <span
              className={cn(
                'min-h-0.5 w-[min(52px,72%)] rounded-t-[5px]',
                TONE[rating].bar
              )}
              style={{ height: `${(counts[rating] / top) * 100}%` }}
            />
          </div>
        ))}
      </div>
      <div className="grid grid-cols-4 gap-1.5 pt-1.5 text-center text-fg-secondary text-sm">
        {SRS_RATINGS.map((rating) => (
          <span key={rating}>{RATING_LABEL[rating]()}</span>
        ))}
      </div>
    </section>
  );
}
