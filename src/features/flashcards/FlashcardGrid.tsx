import { type ReactNode, useCallback, useState } from 'react';
import type { FlashcardContent } from '@/features/materials/blocks';
import { m } from '@/i18n';
import { CardGrid, CardTile } from './CardView';

/** A flashcard set read as a grid of fronts; a click flips a tile in place to
 * its back, as study does, and another back to the front.
 * `action` sits right of the title. */
export function FlashcardGrid({
  title,
  cards,
  action,
  openCardId,
}: {
  title: string;
  cards: FlashcardContent[];
  action?: ReactNode;
  /** A card to show turned and scrolled to at once, e.g. from a review
   * summary. */
  openCardId?: string;
}) {
  const [turned, setTurned] = useState(
    () => new Set(openCardId ? [openCardId] : [])
  );
  const scrollTo = useCallback(
    (node: HTMLLIElement | null) => node?.scrollIntoView({ block: 'center' }),
    []
  );
  function flip(id: string) {
    setTurned((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }
  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-4">
        <h1 className="t-large-card-title min-w-0 flex-1">{title}</h1>
        {action}
      </div>
      {cards.length === 0 ? (
        <p className="text-fg-muted">{m.flashcards_empty_flashcards()}</p>
      ) : (
        <CardGrid>
          {cards.map((card, index) => (
            <CardTile
              card={card}
              face={turned.has(card.id) ? 'turned' : 'front'}
              key={card.id}
              n={index + 1}
              onOpen={() => flip(card.id)}
              ref={card.id === openCardId ? scrollTo : undefined}
            />
          ))}
        </CardGrid>
      )}
    </div>
  );
}
