import { useQueryClient } from '@tanstack/react-query';
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { qk } from '@/api/client';
import { useMaterial, useOwnedMaterials } from '@/api/hooks';
import type { MaterialPreview } from '@/api/types';
import { ThumbnailPanel } from '@/components/app/ThumbnailPanel';
import { Button } from '@/components/ui/Button';
import { useNearScreen } from '@/features/collaboration/useNearScreen';
import { EmbedLoading } from '@/features/materials/embeds/EmbedView';
import { m } from '@/i18n';
import { materialIconName } from '@/lib/fileIcons';
import {
  type CardMaterialKind,
  type MaterialCardHost,
  onMaterialHosts,
} from './materialCardHosts';

/** The runner and the editor a note's embed uses, loaded when a card first
 * comes near the screen or is edited. */
const AppEmbed = lazy(() =>
  import('@/features/materials/embeds/AppEmbed').then((mod) => ({
    default: mod.AppEmbedView,
  }))
);
const AppEmbedEdit = lazy(() =>
  import('@/features/materials/embeds/AppEmbed').then((mod) => ({
    default: mod.AppEmbedEdit,
  }))
);

type Placed = MaterialCardHost & { id: string };

/** The quiz and flashcard cards placed on the workspace canvas (Epo 2026-11-09):
 * each one is the real runner, answered and checked on the canvas. The board lends
 * one host element per card and this renders the runner into it through a portal, so
 * the page's providers (the account's reads, i18n, error boundaries) are the
 * runner's own. A card out of view draws the material's stored preview instead.
 *
 * A card's Edit (Epo 2026-11-12) turns it into the editor a note's embed has,
 * for one card at a time: the canvas has no room of its own for the cards' rooms
 * to join inside, so each edited card takes its own place among the user's 22
 * joined documents, and the others stay snapshots. */
export function CanvasMaterialCards({
  listed,
  workspaceId,
}: {
  /** The materials the workspace still lists, `undefined` until the list has
   * loaded; the card's own header says when a placed one is gone. */
  listed: ReadonlySet<string> | undefined;
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
  listed: ReadonlySet<string> | undefined;
  workspaceId: string;
}) {
  // The workspace's own materials read carries no preview, so the stored previews
  // come from the paged list, every page of which WorkspaceCanvas reads (a card
  // whose preview isn't stored falls back to the kind's icon).
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
  // The one card being edited, by its block: the same material placed twice
  // edits in one of them.
  const [editing, setEditing] = useState<string | null>(null);
  const qc = useQueryClient();
  const stopEditing = (materialId: string) => {
    setEditing(null);
    // The edits went through the live rooms, not the snapshot every card draws.
    void qc.invalidateQueries({ queryKey: qk.quiz(materialId) });
    void qc.invalidateQueries({ queryKey: qk.material(materialId) });
  };
  return (
    <>
      {cards.map(({ host, id, kind, materialId }) =>
        createPortal(
          <CanvasMaterial
            editing={editing === id}
            kind={kind}
            listed={listed?.has(materialId)}
            materialId={materialId}
            onEdit={(on) => (on ? setEditing(id) : stopEditing(materialId))}
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
  editing,
  kind,
  listed,
  materialId,
  onEdit,
  preview,
}: {
  editing: boolean;
  kind: CardMaterialKind;
  /** `undefined` while the workspace's list loads. */
  listed: boolean | undefined;
  materialId: string;
  onEdit: (on: boolean) => void;
  preview?: MaterialPreview;
}) {
  const box = useRef<HTMLDivElement>(null);
  const { near } = useNearScreen(box);
  // Who may edit it, read once the card is near (a set's runner reads it anyway).
  const { data: material } = useMaterial(near ? materialId : null, {
    errorBoundary: false,
  });
  const canEdit = !!material?.capabilities.canEdit;
  // The workspace no longer lists it: the card's own chrome says so.
  if (listed === false) return null;
  return (
    <div className="flex h-full min-h-0 flex-col gap-2 p-3" ref={box}>
      {canEdit && listed && (
        <div className="flex justify-end">
          <Button
            onClick={() => onEdit(!editing)}
            size="sm"
            variant={editing ? 'accent' : 'outline'}
          >
            {editing ? m.drawing_board_done() : m.action_edit()}
          </Button>
        </div>
      )}
      <div className="min-h-0 flex-1">
        {listed === undefined ? (
          <EmbedLoading />
        ) : editing ? (
          <Suspense fallback={<EmbedLoading />}>
            {/* Its live rooms while near the screen, as a note's embed in Edit;
                the last question or card stays, since the card isn't the item. */}
            <AppEmbedEdit materialId={materialId} refKind={kind} />
          </Suspense>
        ) : near ? (
          <Suspense fallback={<EmbedLoading />}>
            {/* The workspace's own quiz or set, not a note's copy: there is no
                owner to wait for, so no ownerId. */}
            <AppEmbed live={false} materialId={materialId} refKind={kind} />
          </Suspense>
        ) : (
          <ThumbnailPanel icon={materialIconName(kind)} preview={preview} />
        )}
      </div>
    </div>
  );
}
