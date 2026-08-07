import { useEffect, useState } from 'react';
import { useCreateCard, useUpdateCard } from '@/api/hooks';
import type { Flashcard } from '@/api/types';
import { Button } from '@/components/ui/Button';
import { SimpleDialog } from '@/components/ui/Dialog';
import { Input } from '@/components/ui/Input';

/**
 * Create or edit a single flashcard. When `card` is provided the modal edits it,
 * otherwise it creates a new card in `deckId`.
 */
export function CardEditModal({
  deckId,
  card,
  open,
  onClose,
}: {
  deckId: string;
  card?: Flashcard | null;
  open: boolean;
  onClose: () => void;
}) {
  const [front, setFront] = useState('');
  const [back, setBack] = useState('');
  const { isPending: createCardIsPending, mutate: createCard } =
    useCreateCard(deckId);
  const { isPending: updateCardIsPending, mutate: updateCard } =
    useUpdateCard(deckId);

  useEffect(() => {
    if (open) {
      setFront(card?.front ?? '');
      setBack(card?.back ?? '');
    }
  }, [open, card]);

  const canSave = front.trim().length > 0 && back.trim().length > 0;
  const pending = createCardIsPending || updateCardIsPending;

  function save() {
    if (!canSave) return;
    const done = { onSuccess: () => onClose() };
    if (card) updateCard({ back, front, id: card.id }, done);
    else createCard({ back, front }, done);
  }

  return (
    <SimpleDialog
      footer={
        <>
          <Button onClick={onClose} variant="ghost">
            Cancel
          </Button>
          <Button disabled={!canSave || pending} onClick={save}>
            {card ? 'Save' : 'Add card'}
          </Button>
        </>
      }
      onClose={onClose}
      open={open}
      title={card ? 'Edit card' : 'New card'}
      width={480}
    >
      <div className="flex flex-col gap-4">
        <label className="flex flex-col gap-1.5">
          <p className="t-label text-fg-muted">Front (term / question)</p>
          <Input
            autoFocus
            onChange={(e) => setFront(e.target.value)}
            value={front}
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <p className="t-label text-fg-muted">Back (definition / answer)</p>
          <Input onChange={(e) => setBack(e.target.value)} value={back} />
        </label>
      </div>
    </SimpleDialog>
  );
}
