import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useOwnedMaterials } from '@/api/hooks';
import type { MaterialPreview } from '@/api/types';
import { ThumbnailPanel } from '@/components/app/ThumbnailPanel';
import { useNearScreen } from '@/features/collaboration/useNearScreen';
import { EmbedLoading } from '@/features/materials/embeds/EmbedView';
import { materialIconName } from '@/lib/fileIcons';
import {
  type CardMaterialKind,
  type MaterialCardHost,
  onMaterialHosts,
} from './materialCardHosts';

/** The runner the note embed uses, loaded when a card first comes near the screen. */
const AppEmbed = lazy(() =>
  import('@/features/materials/embeds/AppEmbed').then((mod) => ({
    default: mod.AppEmbedView,
  }))
);

type Placed = MaterialCardHost & { id: string };

/** The quiz and flashcard cards placed on the workspace canvas (Epo 2026-11-09):
 * each one is the real runner, answered and checked on the canvas. The board lends
 * one host element per card and this renders the runner into it through a portal, so
 * the page's providers (the account's reads, i18n, error boundaries) are the
 * runner's own. A card out of view draws the material's stored preview instead. */
export function CanvasMaterialCards({
  listed,
  workspaceId,
}: {
  /** The materials the workspace still lists; the card's own header says when a
   * placed one is gone. */
  listed: ReadonlySet<string>;
  workspaceId: string;
}) {
  const [cards, setCards] = useState<Placed[]>([]);
  useEffect(
    () =>
      onMaterialHosts((placed) =>
        setCards(
          [...placed].map(([id, card]) => ({
            ...card,
            id,
          }))
        )
      ),
    []
  );
  // Nothing placed: no list is read for previews either.
  if (!cards.length) return null;
  return (
    <PlacedCards cards={cards} listed={listed} workspaceId={workspaceId} />
  );
}

function PlacedCards({
  cards,
  listed,
  workspaceId,
}: {
  cards: Placed[];
  listed: ReadonlySet<string>;
  workspaceId: string;
}) {
  // The workspace's own materials read carries no preview, so the stored previews
  // come from the paged list (its first page; a card whose preview isn't there
  // falls back to the kind's icon).
  const { data } = useOwnedMaterials({
    kinds: ['quiz', 'flashcards'],
    scope: 'member',
    workspaceIds: [workspaceId],
  });
  const previews = useMemo(
    () =>
      new Map(
        (data?.pages ?? [])
          .flatMap((page) => page.items)
          .map((item) => [item.id, item.preview])
      ),
    [data]
  );
  return (
    <>
      {cards.map(({ host, id, kind, materialId }) =>
        createPortal(
          <CanvasMaterial
            kind={kind}
            listed={listed.has(materialId)}
            materialId={materialId}
            preview={previews.get(materialId)}
          />,
          host,
          id
        )
      )}
    </>
  );
}

function CanvasMaterial({
  kind,
  listed,
  materialId,
  preview,
}: {
  kind: CardMaterialKind;
  listed: boolean;
  materialId: string;
  preview?: MaterialPreview;
}) {
  const box = useRef<HTMLDivElement>(null);
  const { near } = useNearScreen(box);
  // The workspace no longer lists it: the card's own chrome says so.
  if (!listed) return null;
  return (
    <div className="h-full min-h-0 p-3" ref={box}>
      {near ? (
        <Suspense fallback={<EmbedLoading />}>
          {/* The workspace's own quiz or set, not a note's copy: there is no owner
              to wait for, so no ownerId. */}
          <AppEmbed live={false} materialId={materialId} refKind={kind} />
        </Suspense>
      ) : (
        <ThumbnailPanel icon={materialIconName(kind)} preview={preview} />
      )}
    </div>
  );
}
