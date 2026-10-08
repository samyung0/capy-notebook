import { zodResolver } from '@hookform/resolvers/zod';
import { useRef, useState } from 'react';
import { Controller, useForm, useWatch } from 'react-hook-form';
import {
  UpdateFlashcardContentBody,
  updateFlashcardContentBodyCardsItemBackMax,
  updateFlashcardContentBodyCardsItemFrontMax,
} from '@/api/gen/validators';
import { Button } from '@/components/ui/Button';
import { SimpleDialog } from '@/components/ui/Dialog';
import { Input, InputError, InputTitle } from '@/components/ui/Input';
import { Textarea } from '@/components/ui/TextArea';
import type { FlashcardContent } from '@/features/materials/blocks';
import { IMAGE_ACCEPT } from '@/features/quizzes/quizImage';
import { m } from '@/i18n';
import { errorCopy } from '@/lib/errors';
import { textLength } from '@/lib/textLength';
import { CardImage, CardSides } from './CardView';

/** The faces the whole-set save accepts, reused for one card's form. */
const cardSchema = UpdateFlashcardContentBody.shape.cards
  .unwrap()
  .element.pick({ back: true, front: true });

export interface CardFaces {
  back: string;
  front: string;
  image?: FlashcardContent['image'];
}

/** Edits one card of a set being edited. Save and Remove change only the set
 * on screen; the page's Save stores it. */
export function CardDialog({
  card,
  position,
  total,
  setTitle,
  onSave,
  onRemove,
  onClose,
  pickImage,
}: {
  /** Null adds a new card. */
  card: CardFaces | null;
  position: number;
  total: number;
  setTitle: string;
  onSave: (faces: CardFaces) => void;
  onRemove?: () => void;
  onClose: () => void;
  /** Shrinks a picked image and keeps it in the browser until the set is
   * saved; returns the id the card refers to it by. */
  pickImage: (file: File) => Promise<string>;
}) {
  const {
    control,
    handleSubmit,
    formState: { errors, isValid },
  } = useForm<Pick<CardFaces, 'front' | 'back'>>({
    defaultValues: { back: card?.back ?? '', front: card?.front ?? '' },
    mode: 'onChange',
    resolver: zodResolver(cardSchema),
  });
  const [front, back] = useWatch({ control, name: ['front', 'back'] });
  const [image, setImage] = useState(card?.image);
  const [picking, setPicking] = useState(false);
  const [imageError, setImageError] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);

  async function pick(file: File) {
    setPicking(true);
    setImageError('');
    try {
      setImage({ assetId: await pickImage(file) });
    } catch (error) {
      setImageError(errorCopy(error, m.question_ui_upload_failed()));
    } finally {
      setPicking(false);
    }
  }

  return (
    <SimpleDialog
      footer={
        <>
          <Button
            onClick={onClose}
            size="lg"
            type="button"
            variant="ghost-hover"
          >
            {m.action_cancel()}
          </Button>
          {onRemove && (
            <Button
              onClick={onRemove}
              size="lg"
              type="button"
              variant="danger-light"
            >
              {m.editor_remove_card()}
            </Button>
          )}
          <Button
            disabled={!isValid || picking}
            size="lg"
            type="submit"
            variant="accent"
          >
            {card ? m.action_save() : m.flashcards_add_card()}
          </Button>
        </>
      }
      onClose={onClose}
      onSubmit={handleSubmit((faces) => onSave({ ...faces, image }))}
      open
      title={
        card ? (
          <span className="flex items-baseline gap-2.5">
            {m.flashcards_edit_card()}
            <span className="font-medium text-fg-muted">
              {position}/{total}
            </span>
          </span>
        ) : (
          m.flashcards_new_card()
        )
      }
      width={920}
    >
      {/* Note-embedded sets pass no title: their name is never shown. */}
      {setTitle && (
        <p className="t-meta -mt-3 mb-4 text-fg-muted">{setTitle}</p>
      )}
      <div className="grid gap-7 md:grid-cols-2">
        <div className="flex flex-col gap-4">
          <label className="flex flex-col gap-1.5" htmlFor="card-front">
            <InputTitle
              count={{
                max: updateFlashcardContentBodyCardsItemFrontMax,
                value: textLength(front),
              }}
              required
            >
              {m.editor_card_front()}
            </InputTitle>
            <Controller
              control={control}
              name="front"
              render={({ field }) => (
                <Input
                  aria-invalid={!!errors.front}
                  autoFocus
                  id="card-front"
                  {...field}
                />
              )}
            />
            <InputError errors={[errors.front]} />
          </label>
          <div className="flex flex-col gap-1.5">
            <InputTitle>{m.editor_image()}</InputTitle>
            {image ? (
              <>
                <div className="grid h-38 place-items-center rounded-card border border-line p-3">
                  <CardImage assetId={image.assetId} className="max-h-31" />
                </div>
                <div className="flex justify-end gap-1">
                  <Button
                    disabled={picking}
                    iconLeft="upload"
                    onClick={() => fileInput.current?.click()}
                    rounded="large"
                    size="sm"
                    type="button"
                    variant="ghost-hover"
                  >
                    {m.question_ui_replace()}
                  </Button>
                  <Button
                    disabled={picking}
                    iconLeft="trash"
                    onClick={() => setImage(undefined)}
                    rounded="large"
                    size="sm"
                    type="button"
                    variant="danger-light"
                  >
                    {m.action_remove()}
                  </Button>
                </div>
              </>
            ) : (
              <div className="grid h-28 place-items-center rounded-card border border-line">
                <Button
                  disabled={picking}
                  iconLeft="image"
                  onClick={() => fileInput.current?.click()}
                  rounded="large"
                  size="sm"
                  type="button"
                  variant="ghost-hover"
                >
                  {m.flashcards_add_image()}
                </Button>
              </div>
            )}
            <input
              accept={IMAGE_ACCEPT}
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (file) void pick(file);
              }}
              ref={fileInput}
              type="file"
            />
            <InputError>{imageError}</InputError>
          </div>
          <label className="flex flex-col gap-1.5" htmlFor="card-back">
            <InputTitle
              count={{
                max: updateFlashcardContentBodyCardsItemBackMax,
                value: textLength(back),
              }}
              required
            >
              {m.editor_card_back()}
            </InputTitle>
            <Controller
              control={control}
              name="back"
              render={({ field }) => (
                <Textarea
                  aria-invalid={!!errors.back}
                  className="max-h-none min-h-42"
                  id="card-back"
                  {...field}
                />
              )}
            />
            <InputError errors={[errors.back]} />
          </label>
        </div>
        <div className="hidden md:block">
          <CardSides card={{ back, front, id: '', image }} />
        </div>
      </div>
    </SimpleDialog>
  );
}
