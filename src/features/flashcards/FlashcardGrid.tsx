import { type ReactNode, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { SimpleDialog } from '@/components/ui/Dialog';
import type { FlashcardContent } from '@/features/materials/blocks';
import { m } from '@/i18n';
import { CardGrid, CardSides, CardTile } from './CardView';

/** A flashcard set read as a grid of fronts; a tile opens its preview.
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
  /** A card to open in the preview at once, e.g. from a review summary. */
  openCardId?: string;
}) {
  const [open, setOpen] = useState<number | null>(() => {
    const at = cards.findIndex((card) => card.id === openCardId);
    return at < 0 ? null : at;
  });
  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-baseline gap-4">
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
              key={card.id}
              label={card.front}
              onOpen={() => setOpen(index)}
            />
          ))}
        </CardGrid>
      )}
      <CardPreviewDialog
        cards={cards}
        index={open}
        onClose={() => setOpen(null)}
        onIndexChange={setOpen}
      />
    </div>
  );
}

/** One card at a time, Previous and Next stepping through the set. */
export function CardPreviewDialog({
  cards,
  index,
  onIndexChange,
  onClose,
}: {
  cards: FlashcardContent[];
  index: number | null;
  onIndexChange: (index: number) => void;
  onClose: () => void;
}) {
  const card = index === null ? undefined : cards[index];
  return (
    <SimpleDialog
      footer={
        index !== null && (
          <div className="flex w-full justify-between">
            <Button
              disabled={index === 0}
              iconLeft="navigationBack"
              onClick={() => onIndexChange(index - 1)}
              size="lg"
              variant="ghost-hover"
            >
              {m.action_previous()}
            </Button>
            <Button
              disabled={index === cards.length - 1}
              iconRight="navigationForward"
              onClick={() => onIndexChange(index + 1)}
              size="lg"
              variant="ghost-hover"
            >
              {m.action_next()}
            </Button>
          </div>
        )
      }
      onClose={onClose}
      open={!!card}
      title={
        index === null
          ? undefined
          : m.flashcards_card_position({
              position: index + 1,
              total: cards.length,
            })
      }
      width={560}
    >
      {card && <CardSides card={card} />}
    </SimpleDialog>
  );
}
