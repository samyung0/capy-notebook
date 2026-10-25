import { useEffect, useRef, useState } from 'react';
import type * as Y from 'yjs';
import { editorImageMaxBytes, uploadEditorAsset } from '@/api/editorAssets';
import { Button } from '@/components/ui/Button';
import { SimpleDialog, useIsPhone } from '@/components/ui/Dialog';
import { Input, InputError, InputTitle } from '@/components/ui/Input';
import { Textarea } from '@/components/ui/TextArea';
import type { ItemRoomStatus } from '@/features/collaboration/itemRoom';
import {
  LiveStatus,
  UndoButtons,
} from '@/features/collaboration/LiveItemControls';
import type { UndoTarget } from '@/features/collaboration/undo';
import { useBoundText } from '@/features/collaboration/yText';
import { m } from '@/i18n';
import { errorCopy } from '@/lib/errors';
import { fitImage, IMAGE_ACCEPT } from '@/lib/fitImage';
import { textLength } from '@/lib/textLength';
import { CardPreview } from './CardStack';
import { CardImage } from './CardView';
import {
  cardFace,
  MAX_BACK,
  MAX_FRONT,
  readCards,
  setCardImage,
  useCards,
} from './liveSet';

/** Edits one card of a live set: every field writes to the set as you type
 * and the picked image uploads at once (Epo 2026-10-10). No Save or Cancel:
 * the dialog closes with its X or Esc; Undo and Redo undo this user's own
 * edits to the set. */
export function CardDialog({
  doc,
  cardId,
  setId,
  setTitle,
  status,
  undo,
  onRemove,
  onClose,
}: {
  doc: Y.Doc;
  cardId: string;
  /** Uploads go through the set's editor-asset route. */
  setId: string;
  setTitle: string;
  status: ItemRoomStatus;
  undo: UndoTarget;
  onRemove?: () => void;
  onClose: () => void;
}) {
  const cards = useCards(doc);
  const index = cards.findIndex((card) => card.id === cardId);
  const card = cards[index];
  const front = useBoundText<HTMLInputElement>(cardFace(doc, cardId, 'front'));
  const back = useBoundText<HTMLTextAreaElement>(cardFace(doc, cardId, 'back'));
  const [picking, setPicking] = useState(false);
  const [imageError, setImageError] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  // Closing the dialog cancels an image still waiting in the upload line.
  const pickAbort = useRef<AbortController | null>(null);
  useEffect(() => () => pickAbort.current?.abort(), []);

  async function pick(file: File) {
    setPicking(true);
    setImageError('');
    pickAbort.current?.abort();
    const controller = new AbortController();
    pickAbort.current = controller;
    try {
      const fitted = await fitImage(file, await editorImageMaxBytes(setId));
      const { assetId } = await uploadEditorAsset(setId, fitted, 'image', {
        signal: controller.signal,
      });
      // Someone may have removed the card while the image uploaded.
      if (readCards(doc).some((c) => c.id === cardId))
        setCardImage(doc, cardId, { assetId });
    } catch (error) {
      if (!controller.signal.aborted)
        setImageError(errorCopy(error, m.question_ui_upload_failed()));
    } finally {
      setPicking(false);
    }
  }

  const phone = useIsPhone();
  // Removed by someone else (or Undo of its insert): nothing left to edit.
  useEffect(() => {
    if (!card) onClose();
  }, [card, onClose]);
  if (!card) return null;
  return (
    <SimpleDialog
      // Live-saved: phones show the status by the title and Undo where Save
      // would be.
      action={
        phone && (
          // Back up the 2px the header drops its action, level with the title
          // and the cloud.
          <span className="-translate-y-0.5">
            <UndoButtons manager={undo} />
          </span>
        )
      }
      footer={
        <>
          {!phone && (
            <div className="mr-auto flex items-center gap-2">
              <UndoButtons footer manager={undo} />
              <LiveStatus status={status} />
            </div>
          )}
          {onRemove && (
            // Wrapped so phones keep it at the end (the footer starts a
            // borderless first button at the content's edge); its label
            // lines up with the content's right edge.
            <div className="-mr-6.5 ml-auto">
              <Button
                onClick={onRemove}
                size="lg"
                type="button"
                variant="danger-light"
              >
                {m.editor_remove_card()}
              </Button>
            </div>
          )}
        </>
      }
      onClose={onClose}
      open
      status={<LiveStatus compact status={status} />}
      title={
        <span className="flex items-baseline gap-2.5">
          {m.flashcards_edit_card()}
          <span className="font-medium text-fg-muted">
            {index + 1}/{cards.length}
          </span>
        </span>
      }
      width={920}
    >
      {/* Note-embedded sets pass no title: their name is never shown. */}
      {setTitle && (
        <p className="t-meta mb-3 text-fg-muted sm:-mt-3">{setTitle}</p>
      )}
      <div className="grid gap-7 md:grid-cols-2">
        <div className="flex flex-col gap-4">
          <label className="flex flex-col gap-1.5" htmlFor="card-front">
            <InputTitle
              count={{ max: MAX_FRONT, value: textLength(front.value) }}
              required
            >
              {m.editor_card_front()}
            </InputTitle>
            <Input
              autoFocus
              id="card-front"
              maxLength={MAX_FRONT}
              onChange={front.onChange}
              ref={front.ref}
              value={front.value}
            />
          </label>
          <div className="flex flex-col gap-1.5">
            <InputTitle>{m.editor_image()}</InputTitle>
            {card.image ? (
              <>
                <div className="grid h-38 place-items-center rounded-card border border-line p-3">
                  <CardImage
                    assetId={card.image.assetId}
                    className="max-h-31"
                  />
                </div>
                {/* Borderless: the labels line up with the box's right edge. */}
                <div className="-mr-4 flex justify-end gap-1">
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
                    onClick={() => setCardImage(doc, cardId, undefined)}
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
                  variant="outline"
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
              count={{ max: MAX_BACK, value: textLength(back.value) }}
              required
            >
              {m.editor_card_back()}
            </InputTitle>
            {/* Ruled lines, as a quiz's written answer. */}
            <Textarea
              className="ruled-lines max-h-[calc(var(--ruled-line)*10)] min-h-[calc(var(--ruled-line)*4)] rounded-none border-0 bg-transparent px-0.5 py-0 focus:border-0"
              id="card-back"
              maxLength={MAX_BACK}
              onChange={back.onChange}
              ref={back.ref}
              value={back.value}
            />
          </label>
        </div>
        <div className="hidden md:block">
          <CardPreview card={card} />
        </div>
      </div>
    </SimpleDialog>
  );
}
