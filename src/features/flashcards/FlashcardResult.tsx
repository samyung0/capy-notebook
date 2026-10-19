import type { AttemptCard } from '@/api/types';
import { RATING_LABEL } from '@/features/study/ratings';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { SRS_RATINGS, type SrsRating } from '@/lib/srs';
import { CardImage } from './CardView';

/** A rating's result colour (bars) and text tone (each card's rating). */
const TONE: Record<SrsRating, { bar: string; text: string }> = {
  again: { bar: 'bg-solid-error', text: 'text-tint-error-fg' },
  easy: { bar: 'bg-solid-success', text: 'text-tint-success-fg' },
  good: { bar: 'bg-solid-info', text: 'text-tint-info-fg' },
  hard: { bar: 'bg-solid-warning', text: 'text-tint-warning-fg' },
};

const ratingOf = (n: number) => SRS_RATINGS[n - 1];

/** A study run's result, laid out as a quiz result: the score (cards whose
 * first rating is Good or Easy), a bar per rating, then every card in the
 * order first rated with its faces and ratings. */
export function FlashcardResult({ cards }: { cards: AttemptCard[] }) {
  const counts = Object.fromEntries(
    SRS_RATINGS.map((rating) => [
      rating,
      cards.filter((card) => ratingOf(card.ratings[0]) === rating).length,
    ])
  ) as Record<SrsRating, number>;
  const good = counts.good + counts.easy;
  const top = Math.max(1, ...Object.values(counts));
  return (
    <div>
      <div className="grid gap-8">
        <p className="flex flex-wrap items-baseline gap-x-2.5">
          <span className="font-extrabold text-4xl text-fg leading-none">
            {good} / {cards.length}
          </span>
          <span className="font-semibold text-fg-secondary">
            {m.flashcards_result_good()}
          </span>
        </p>
        <section>
          <h3 className="mb-3 font-bold text-fg-muted text-sm">
            {m.flashcards_result_by_rating()}
          </h3>
          <div className="max-w-105">
            <div className="grid h-36 grid-cols-4 items-end gap-0.5 border-line border-b">
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
                  <span className="font-semibold text-fg text-sm">
                    {counts[rating]}
                  </span>
                  <span
                    className={cn(
                      'min-h-0.5 w-[min(48px,70%)] rounded-t-[4px]',
                      TONE[rating].bar
                    )}
                    style={{ height: `${(counts[rating] / top) * 100}%` }}
                  />
                </div>
              ))}
            </div>
            <div className="grid grid-cols-4 gap-0.5 pt-1.5 text-center text-fg-secondary text-sm">
              {SRS_RATINGS.map((rating) => (
                <span key={rating}>{RATING_LABEL[rating]()}</span>
              ))}
            </div>
          </div>
        </section>
      </div>
      <ol className="mt-12 grid gap-10">
        {cards.map((card, i) => (
          <li
            className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-baseline text-[15px] leading-relaxed"
            key={card.id}
          >
            <span className="pr-1.5 font-bold md:pr-2">{i + 1}.</span>
            <div className="min-w-0 space-y-2">
              <p className="whitespace-pre-line break-words font-semibold">
                {card.front}
              </p>
              {card.image && (
                <CardImage assetId={card.image.assetId} className="h-30" />
              )}
              <p className="whitespace-pre-line break-words text-fg-secondary">
                {card.back}
              </p>
            </div>
            <span className="whitespace-nowrap pl-1.5 font-bold text-xs md:pl-2">
              {card.ratings.map((n, j) => (
                <span className={TONE[ratingOf(n)].text} key={j}>
                  {j > 0 && <span className="text-fg-muted">, </span>}
                  {RATING_LABEL[ratingOf(n)]()}
                </span>
              ))}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
