import { useQueryClient } from '@tanstack/react-query';
import {
  lazy,
  Suspense,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { createPortal } from 'react-dom';
import { qk } from '@/api/client';
import { useMaterial } from '@/api/hooks';
import type { MaterialListItem, MaterialPreview } from '@/api/types';
import { ThumbnailPanel } from '@/components/app/ThumbnailPanel';
import { UndoSink } from '@/features/collaboration/undo';
import { useNearScreen } from '@/features/collaboration/useNearScreen';
import { FilmEmbed } from '@/features/films/FilmEmbed';
import { EmbedLoading } from '@/features/materials/embeds/EmbedView';
import { materialIconName } from '@/lib/fileIcons';
import { type OpenLink, OpenLinkContext, scopedOpenLink } from '@/lib/openLink';
import {
  cardEditing,
  type EditingCard,
  lendCardUndo,
  type MaterialCardHost,
  onCardState,
  onMaterialHosts,
  type StudyCardKind,
  setCardEditable,
  setCardEditing,
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
type Listed = Pick<MaterialListItem, 'id' | 'preview'>;

/** The quiz and flashcard cards placed on the workspace canvas (Epo 2026-11-09):
 * each one is the real runner, answered and checked on the canvas. The board lends
 * one host element per card and this renders the runner into it through a portal, so
 * the page's providers (the account's reads, i18n, error boundaries) are the
 * runner's own. A card out of view draws the material's stored preview instead.
 *
 * A card's Edit (Epo 2026-11-12) turns it into the editor a note's embed has,
 * for one card at a time: the canvas has no room of its own for the cards' rooms
 * to join inside, so each edited card takes its own place among the user's 22
 * joined documents, and the others stay snapshots. Edit and Done are on the
 * board's toolbar (Epo 2026-11-13), for a card whose material the person may edit:
 * this tells the board which those are (`setCardEditable`), and draws the editor
 * for the card it names (`setCardEditing`). */
export function CanvasMaterialCards({
  link,
  materials,
}: {
  /** The page's URL for what fills the screen: a card's drawing answer is
   * named there under the card's id. */
  link?: OpenLink;
  /** The quizzes and sets the board's links list (`useCanvasLinks`),
   * `undefined` until the list has loaded; the card's own header says when a
   * placed one is gone. */
  materials: Listed[] | undefined;
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
  if (!cards.length) return null;
  return (
    <PlacedCards cards={cards} link={link ?? null} materials={materials} />
  );
}

function PlacedCards({
  cards,
  link,
  materials,
}: {
  cards: Placed[];
  link: OpenLink | null;
  materials: Listed[] | undefined;
}) {
  // The list carries each one's stored preview (a card whose preview isn't
  // stored falls back to the kind's icon).
  const listed = useMemo(
    () => materials && new Map(materials.map((item) => [item.id, item])),
    [materials]
  );
  // The one card being edited, by its block: the same material placed twice
  // edits in one of them.
  const editing = useSyncExternalStore(onCardState, cardEditing);
  const qc = useQueryClient();
  // The edits went through the live rooms, not the snapshot every card draws:
  // read again whenever a card stops editing (Done, another card's Edit, or the
  // card leaving the board).
  const last = useRef<EditingCard | null>(null);
  useEffect(() => {
    const before = last.current;
    last.current = editing;
    if (!before || before.id === editing?.id) return;
    void qc.invalidateQueries({ queryKey: qk.quiz(before.materialId) });
    void qc.invalidateQueries({ queryKey: qk.material(before.materialId) });
  }, [editing, qc]);
  useEffect(() => () => setCardEditing(null), []);
  const gone =
    editing &&
    !cards.some(
      ({ id, materialId }) =>
        id === editing.id &&
        materialId === editing.materialId &&
        listed?.has(materialId) !== false
    );
  useEffect(() => {
    if (gone) setCardEditing(null);
  }, [gone]);
  return (
    <>
      {cards.map(({ host, id, kind, materialId }) =>
        createPortal(
          <OpenLinkContext.Provider value={scopedOpenLink(link, id)}>
            {kind === 'film' ? (
              // The film itself, view-only (Epo 2026-11-27); a gone one's
              // card says so in its own chrome.
              listed?.has(materialId) !== false && (
                <FilmEmbed contain fileId={materialId} />
              )
            ) : (
              <CanvasMaterial
                blockId={id}
                editing={editing?.id === id}
                kind={kind}
                listed={listed?.has(materialId)}
                materialId={materialId}
                preview={listed?.get(materialId)?.preview}
              />
            )}
          </OpenLinkContext.Provider>,
          host,
          id
        )
      )}
    </>
  );
}

function CanvasMaterial({
  blockId,
  editing,
  kind,
  listed,
  materialId,
  preview,
}: {
  blockId: string;
  editing: boolean;
  kind: StudyCardKind;
  /** `undefined` while the workspace's list loads. */
  listed: boolean | undefined;
  materialId: string;
  preview?: MaterialPreview;
}) {
  const box = useRef<HTMLDivElement>(null);
  const { near } = useNearScreen(box);
  // Who may edit its content, read once the card is near (a set's runner reads
  // it anyway); an owner at their storage limit can't.
  const { data: material } = useMaterial(near ? materialId : null, {
    errorBoundary: false,
  });
  const editable = !!material?.capabilities.canEditContent && !!listed;
  // The URL names this card's drawing answer, but the workspace no longer lists
  // its quiz.
  const link = useContext(OpenLinkContext);
  const named = link?.opened != null;
  useEffect(() => {
    if (named && listed === false) link?.gone();
  }, [named, listed]);
  useEffect(() => {
    setCardEditable(blockId, editable);
    return () => setCardEditable(blockId, false);
  }, [blockId, editable]);
  // The workspace no longer lists it: the card's own chrome says so.
  if (listed === false) return null;
  return (
    <div className="flex h-full min-h-0 flex-col p-3" ref={box}>
      <div className="min-h-0 flex-1">
        {listed === undefined ? (
          <EmbedLoading />
        ) : editing ? (
          <Suspense fallback={<EmbedLoading />}>
            {/* Its live rooms while near the screen, as a note's embed in Edit.
                With no onEmpty it behaves as the item's own page: a quiz may
                lose its last question, a set keeps its last card. */}
            {/* Its Undo and Redo are the board's while it's edited. */}
            <UndoSink.Provider value={lendCardUndo}>
              <AppEmbedEdit materialId={materialId} refKind={kind} />
            </UndoSink.Provider>
          </Suspense>
        ) : near ? (
          <Suspense fallback={<EmbedLoading />}>
            {/* The workspace's own quiz or set, not a note's copy: there is no
                owner to wait for, so no ownerId. */}
            <AppEmbed
              fill
              live={false}
              materialId={materialId}
              refKind={kind}
            />
          </Suspense>
        ) : (
          <ThumbnailPanel icon={materialIconName(kind)} preview={preview} />
        )}
      </div>
    </div>
  );
}
