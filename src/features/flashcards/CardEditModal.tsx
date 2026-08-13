import { zodResolver } from '@hookform/resolvers/zod';
import { useCallback } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { CreateCardBody } from '@/api/gen/validators';
import { useCreateCard, useUpdateCard } from '@/api/hooks';
import type { CreateCardReq, Flashcard } from '@/api/types';
import { Button } from '@/components/ui/Button';
import { SimpleDialog } from '@/components/ui/Dialog';
import { Spinner } from '@/components/ui/feedback';
import { Input, InputError, InputTitle } from '@/components/ui/Input';

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
  const { mutateAsync: createCard } = useCreateCard(deckId);
  const { mutateAsync: updateCard } = useUpdateCard(deckId);

  const {
    formState: { isDirty, isValid, isSubmitting },
    handleSubmit: formSubmit,
    control,
  } = useForm<CreateCardReq>({
    defaultValues: { back: card?.back ?? '', front: card?.front ?? '' },
    mode: 'onChange',
    resolver: zodResolver(CreateCardBody),
  });

  const submitDisabled = !isDirty || !isValid || isSubmitting;

  const handleSubmit = useCallback(
    async (v: CreateCardReq) => {
      try {
        if (card) {
          await updateCard({ back: v.back, front: v.front, id: card.id });
        } else {
          await createCard(v);
        }
        onClose();
      } catch {
        // Keep the dialog open so the user can retry without losing input.
        // The global mutation handler shows the normalized failure.
      }
    },
    [card, createCard, onClose, updateCard]
  );

  return (
    <SimpleDialog
      footer={
        <>
          <Button onClick={onClose} type="button" variant="ghost">
            Cancel
          </Button>
          <Button disabled={submitDisabled} type="submit">
            {!isSubmitting && <span>{card ? 'Save' : 'Add card'}</span>}
            {isSubmitting && (
              <span>
                <Spinner />
              </span>
            )}
          </Button>
        </>
      }
      onClose={onClose}
      onSubmit={formSubmit(handleSubmit)}
      open={open}
      title={card ? 'Edit card' : 'New card'}
      width={480}
    >
      <div className="flex flex-col gap-4">
        <Controller
          control={control}
          name="front"
          render={({ field, fieldState }) => (
            <label className="flex flex-col gap-1.5">
              <InputTitle required>Front (term / question)</InputTitle>
              <Input {...field} aria-invalid={fieldState.invalid} autoFocus />
              {fieldState.invalid && <InputError errors={[fieldState.error]} />}
            </label>
          )}
        />
        <Controller
          control={control}
          name="back"
          render={({ field, fieldState }) => (
            <label className="flex flex-col gap-1.5">
              <InputTitle required>Back (definition / answer)</InputTitle>
              <Input {...field} aria-invalid={fieldState.invalid} />
              {fieldState.invalid && <InputError errors={[fieldState.error]} />}
            </label>
          )}
        />
      </div>
    </SimpleDialog>
  );
}
