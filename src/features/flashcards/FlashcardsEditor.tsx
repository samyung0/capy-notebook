import { useMutation } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { uploadEditorAsset } from '@/api/editorAssets';
import { useUpdateFlashcardContent } from '@/api/hooks';
import type { Flashcard } from '@/api/types';
import { BlockToolbar } from '@/components/ui/BlockToolbar';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ConfirmDialog } from '@/components/ui/Dialog';
import { Icon } from '@/components/ui/Icon';
import { ToolbarButton } from '@/components/ui/ToolbarButton';
import type { FlashcardContent } from '@/features/materials/blocks';
import { AssetUrlContext } from '@/features/materials/MediaAssetView';
import { fitQuizImage } from '@/features/quizzes/quizImage';
import { m } from '@/i18n';
import { uid } from '@/lib/id';
import { CardDialog, type CardFaces } from './CardDialog';
import { CardGrid, CardTile } from './CardView';

/** A card on screen; `id` is absent until the set is saved. */
export interface DraftCard extends CardFaces {
  id?: string;
  key: string;
}

const toDraft = (card: FlashcardContent | Flashcard): DraftCard => ({
  back: card.back,
  front: card.front,
  id: card.id,
  key: card.id,
  ...(card.image ? { image: { assetId: card.image.assetId } } : {}),
});

// A new set starts with one blank card; blank cards are not stored.
const written = (card: DraftCard) => !!(card.front.trim() || card.back.trim());

/** The whole-set save body: written cards in order, an existing card keeping
 * its id (and so its review state), a new one without. */
export function cardsForSave(cards: DraftCard[]) {
  return cards.filter(written).map(({ id, front, back, image }) => ({
    back,
    front,
    ...(id ? { id } : {}),
    ...(image ? { image } : {}),
  }));
}

/** Edits a flashcard set as a grid, the way the quiz edit page edits a quiz:
 * changes stay on screen until Save writes the whole set (with the revision
 * the editing started from), and Reset drops them. A picked image stays in
 * the browser until Save uploads it, so an abandoned pick never reaches
 * storage. */
export function FlashcardsEditor({
  setId,
  title,
  cards,
  onEmpty,
  revision,
  saveEachChange,
  showTitle = true,
}: {
  setId: string;
  title: string;
  cards: FlashcardContent[];
  revision: number;
  /** Removing the last card calls this instead of saving, since a set keeps
   * at least one card; inside a note it removes the embed block. */
  onEmpty?: () => void;
  /** Inside a note: every change saves at once (no Reset or Save). */
  saveEachChange?: boolean;
  /** Off where the page header already names the set. */
  showTitle?: boolean;
}) {
  const [base, setBase] = useState(() => ({
    cards: cards.map(toDraft),
    revision,
  }));
  const [draft, setDraft] = useState(base.cards);
  const revisionRef = useRef(revision);
  const saving = useRef(Promise.resolve());
  const [editing, setEditing] = useState<number | 'new' | null>(null);
  const [confirm, setConfirm] = useState<'reset' | 'save' | null>(null);
  const { isPending: savePending, mutateAsync: saveCards } =
    useUpdateFlashcardContent(setId);
  // Picked images by local id, and the object URLs that preview them.
  const picked = useRef(new Map<string, File>());
  const previews = useRef(new Map<string, string>());
  useEffect(() => {
    const urls = previews.current;
    return () => {
      for (const url of urls.values()) URL.revokeObjectURL(url);
    };
  }, []);
  const { isPending: uploadPending, mutateAsync: uploadPicked } = useMutation({
    mutationFn: async (cards: DraftCard[]) => {
      const uploaded = new Map<string, string>();
      const used = new Set(cards.flatMap((card) => card.image?.assetId ?? []));
      const results = await Promise.allSettled(
        [...picked.current].flatMap(([localId, file]) =>
          used.has(localId)
            ? [
                uploadEditorAsset(setId, file, 'image').then(({ assetId }) => {
                  uploaded.set(localId, assetId);
                  picked.current.delete(localId);
                  const url = previews.current.get(localId);
                  if (url) previews.current.set(assetId, url);
                }),
              ]
            : []
        )
      );
      // Keep what did upload so retrying the save sends only the rest.
      const next = cards.map((card) => {
        const assetId = card.image && uploaded.get(card.image.assetId);
        return assetId ? { ...card, image: { assetId } } : card;
      });
      setDraft(next);
      const failed = results.find((result) => result.status === 'rejected');
      if (failed) throw failed.reason;
      return next;
    },
  });
  const isPending = savePending || uploadPending;

  const dirty = JSON.stringify(draft) !== JSON.stringify(base.cards);
  const kept = draft.filter(written);

  async function pickImage(file: File) {
    const fitted = await fitQuizImage(file);
    const localId = crypto.randomUUID();
    picked.current.set(localId, fitted);
    previews.current.set(localId, URL.createObjectURL(fitted));
    return localId;
  }

  async function save(cards = draft) {
    try {
      const saved = await saveCards({
        cards: cardsForSave(await uploadPicked(cards)),
        expectedRevision: revisionRef.current,
      });
      const next = saved.map(toDraft);
      revisionRef.current = saved[0]?.revision ?? 0;
      setBase({ cards: next, revision: revisionRef.current });
      setDraft(next);
      setConfirm(null);
    } catch {
      // The global mutation handler shows the normalized failure.
    }
  }

  // Staged, a change waits for Save; saved each change, it goes out at once.
  function change(next: DraftCard[]) {
    if (saveEachChange && onEmpty && !next.some(written)) return onEmpty();
    setDraft(next);
    // One save at a time, each with the revision the previous one returned.
    if (saveEachChange) saving.current = saving.current.then(() => save(next));
  }
  const editedCard = typeof editing === 'number' ? draft[editing] : null;

  return (
    <AssetUrlContext.Provider value={(id) => previews.current.get(id)}>
      <div className="flex flex-col gap-6">
        {showTitle && <h1 className="t-large-card-title">{title}</h1>}
        <CardGrid>
          {draft.map((card, index) => (
            <CardTile
              card={{ ...card, id: card.key }}
              key={card.key}
              label={m.flashcards_edit_card()}
              onOpen={() => setEditing(index)}
            >
              <BlockToolbar className="absolute top-2 right-2 z-10 rounded-md p-0.5 opacity-0 pointer-coarse:opacity-100 transition-opacity group-hover/tile:opacity-100 has-focus-visible:opacity-100 [&_button]:size-7">
                <ToolbarButton
                  label={m.action_edit()}
                  onClick={() => setEditing(index)}
                  tooltipSide="top"
                >
                  <Icon name="pencil" />
                </ToolbarButton>
                <ToolbarButton
                  disabled={isPending}
                  label={m.editor_remove_card()}
                  onClick={() => change(draft.filter((_, i) => i !== index))}
                  tooltipSide="top"
                  variant="danger-light"
                >
                  <Icon name="trash" />
                </ToolbarButton>
              </BlockToolbar>
            </CardTile>
          ))}
          <Card
            border="dashed"
            className="aspect-[4/3] cursor-pointer items-center justify-center focus-visible:border-0 focus-visible:ring-2 focus-visible:ring-action focus-visible:transition-none"
            interactive
            onClick={() => setEditing('new')}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') setEditing('new');
            }}
            radius="card-lg"
            role="button"
            tabIndex={0}
          >
            <span className="flex flex-col items-center gap-2 text-fg-muted">
              <Icon name="plus" size={24} />
              <span className="t-meta text-fg-muted">
                {m.flashcards_add_card()}
              </span>
            </span>
          </Card>
        </CardGrid>
        {!saveEachChange && (
          <div className="mt-2 flex justify-end gap-2">
            <Button
              disabled={!dirty || isPending}
              onClick={() => setConfirm('reset')}
              size="lg"
              variant="danger-light"
            >
              {m.action_reset()}
            </Button>
            <Button
              disabled={!dirty || kept.length === 0 || isPending}
              onClick={() => setConfirm('save')}
              size="lg"
              variant="accent"
            >
              {m.action_save()}
            </Button>
          </div>
        )}

        {editing !== null && (
          <CardDialog
            card={editedCard}
            onClose={() => setEditing(null)}
            onRemove={
              typeof editing === 'number'
                ? () => {
                    change(draft.filter((_, i) => i !== editing));
                    setEditing(null);
                  }
                : undefined
            }
            onSave={(faces) => {
              change(
                typeof editing === 'number'
                  ? draft.map((card, i) =>
                      i === editing ? { ...card, ...faces } : card
                    )
                  : [...draft, { ...faces, key: uid('card') }]
              );
              setEditing(null);
            }}
            pickImage={pickImage}
            position={
              typeof editing === 'number' ? editing + 1 : draft.length + 1
            }
            setTitle={title}
            total={
              typeof editing === 'number' ? draft.length : draft.length + 1
            }
          />
        )}
        <ConfirmDialog
          body={m.edit_reset_confirm_body()}
          confirmLabel={m.action_reset()}
          onClose={() => setConfirm(null)}
          onConfirm={() => setDraft(base.cards)}
          open={confirm === 'reset'}
          title={m.edit_reset_confirm_title()}
        />
        <ConfirmDialog
          body={m.edit_save_confirm_body()}
          closeOnConfirm={false}
          confirmLabel={m.action_save()}
          danger={false}
          isSubmitting={isPending}
          onClose={() => setConfirm(null)}
          onConfirm={() => void save()}
          open={confirm === 'save'}
          title={m.edit_save_confirm_title()}
        />
      </div>
    </AssetUrlContext.Provider>
  );
}
