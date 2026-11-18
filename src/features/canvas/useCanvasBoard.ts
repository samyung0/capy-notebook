import { useEffect, useMemo, useRef, useState } from 'react';
import { canvasById } from '@/api/canvas';
import { useMe } from '@/api/hooks';
import {
  recoveryBanner,
  type SaveBannerState,
} from '@/components/banners/SaveBanner';
import { userToast } from '@/components/ui/userToast';
import { assetImages } from '@/features/blocksuite/boardAsset';
import {
  type DrawingBoardOptions,
  mountDrawingBoard,
} from '@/features/blocksuite/drawingBoard';
import {
  itemEditingStopped,
  useItemRoom,
} from '@/features/collaboration/itemRoom';
import { m } from '@/i18n';
import { errorCopy } from '@/lib/errors';
import type { OpenLink } from '@/lib/openLink';
import { holdsBoard } from './boardRoom';

export type CanvasBoard = ReturnType<typeof mountDrawingBoard>;

/** What a canvas page shows around its board. */
export type CanvasBoardState = {
  /** Why the canvas couldn't open, if it couldn't: said with Retry. */
  failed: string | null;
  /** The strip over the board while its room cannot take edits as usual
   * (offline, outdated, edits to copy, access lost); `onReload` leaves the
   * copy-only edits for a fresh room. */
  strip: { onReload?: () => void; state: SaveBannerState } | null;
  /** The room refused this person before anything showed: gone, or not
   * theirs. */
  unavailable: boolean;
  /** Nothing has shown yet and the room cannot be reached: it joins once the
   * connection is back. */
  waiting: boolean;
};

/** The drawing board over a canvas's collaboration room, mounted in
 * `container` (Epo 2026-11-18; a room for every canvas, shared or not). The
 * board edits the room's document in place once the room has synced: the
 * server seeded its page and canvas, every change goes to the room as it is
 * made, and what another tab or person draws arrives the same way. Nothing is
 * saved from here. Unsent edits are kept on this device as any live item's are
 * (`itemRoom.ts`), and sent on the next open.
 *
 * The board is read-only for whoever the room gives a read channel (a
 * workspace viewer on a shared canvas, a frozen account, a payer at its
 * limit) and while the room takes no edits (offline past what this device may
 * hold, an outdated build, edits open for copying, access lost). An image
 * uploads at once as the material's own image asset, as a note's does. */
export function useCanvasBoard(
  container: React.RefObject<HTMLDivElement | null>,
  id: string,
  options: {
    /** The canvas is being deleted: its room's refusal is no news. */
    gone?: () => boolean;
    /** The board as it mounts, and null as it goes. */
    onBoard?: (board: CanvasBoard | null) => void;
    /** A workspace canvas's quizzes and sets for its cards. */
    workspace?: DrawingBoardOptions['workspace'];
    /** The page's URL for what fills the screen (Epo 2026-11-13): a plane's or
     * chart's editor by its card's id, a card's drawing answer as
     * `<card>~<part>`. */
    link?: OpenLink;
  } = {}
): CanvasBoardState {
  const { data: me } = useMe();
  const actorId = me?.id ?? null;
  const { room, snapshot } = useItemRoom(id, !!actorId, {
    actorId,
    awareness: true,
  });
  const [failed, setFailed] = useState<string | null>(null);
  const [mounted, setMounted] = useState<CanvasBoard | null>(null);
  // The card whose plane or chart editor is open.
  const editor = useRef<string | null>(null);
  // The board reads the latest of these when it needs them.
  const latest = useRef(options);
  latest.current = options;

  // The canvas's image assets as the server lists them: an image already the
  // canvas's own is never stored again.
  const [listed, setListed] = useState<{
    id: string;
    own: readonly string[];
  } | null>(null);
  useEffect(() => {
    let live = true;
    setFailed(null);
    canvasById(id).then(
      (canvas) => live && setListed({ id, own: canvas.ownImageAssetIds }),
      (error: unknown) =>
        live && setFailed(errorCopy(error, m.workspace_canvas_open_failed()))
    );
    return () => {
      live = false;
    };
  }, [id]);
  const images = useMemo(
    () =>
      listed?.id === id
        ? assetImages(id, listed.own, (error) =>
            userToast({
              description: errorCopy(error, m.workspace_canvas_image_refused()),
              title: m.workspace_canvas_image_refused(),
              variant: 'error',
            })
          )
        : null,
    [id, listed]
  );

  const { recovery } = snapshot;
  const lost = snapshot.status === 'unavailable';
  // Edits that cannot join the room show alone, for copying; else the room's
  // document once it holds the room's state.
  const doc = recovery?.doc ?? (room && snapshot.synced ? room.doc : null);
  const readOnly =
    !!recovery ||
    lost ||
    snapshot.access !== 'write' ||
    itemEditingStopped(snapshot);
  const copyOnly = !!recovery;
  useEffect(() => {
    const host = container.current;
    if (!(host && doc && images)) return;
    if (!holdsBoard(doc)) {
      // Edits to copy that hold no board show their strip alone.
      if (!copyOnly) setFailed(m.workspace_canvas_open_failed());
      return;
    }
    let disposed = false;
    let board: CanvasBoard;
    try {
      board = mountDrawingBoard(host, {
        board: 'workspace',
        // A reader stores nothing: another canvas's image stays as it is.
        images: readOnly ? { load: images.load } : images,
        onEditor: (cardId) => {
          const before = editor.current;
          editor.current = cardId;
          const { link } = latest.current;
          // Leaving the page closes it too: that is no step back.
          if (disposed || !link) return;
          if (cardId) link.open(cardId);
          // Done: the URL still names it. Closed by the URL: it no longer does.
          else if (before && link.opened === before) link.close();
        },
        readOnly,
        room: { doc },
        workspace: latest.current.workspace,
      });
    } catch (error) {
      setFailed(errorCopy(error, m.workspace_canvas_open_failed()));
      return;
    }
    const drawing = board;
    setMounted(drawing);
    latest.current.onBoard?.(drawing);
    if (import.meta.env.DEV) Object.assign(window, { __board: drawing });
    return () => {
      disposed = true;
      latest.current.onBoard?.(null);
      drawing.unmount();
      if (import.meta.env.DEV) Object.assign(window, { __board: undefined });
      editor.current = null;
      setMounted(null);
    };
  }, [container, doc, images, readOnly, copyOnly]);

  // The URL drives what fills the screen: Back closes it, Forward or the page's
  // link opens it, and one no longer on the canvas says so.
  const opened = options.link?.opened ?? null;
  useEffect(() => {
    const { link } = latest.current;
    if (!(mounted && link)) return;
    const cardId = opened?.includes('~') ? opened.split('~')[0] : null;
    if (editor.current && editor.current !== opened) mounted.closeEditor();
    if (cardId) {
      if (mounted.has(cardId)) mounted.reveal(cardId);
      else link.gone();
    } else if (
      opened &&
      editor.current !== opened &&
      !mounted.openEditor(opened)
    )
      link.gone();
  }, [mounted, opened]);

  const strip: CanvasBoardState['strip'] = recovery
    ? {
        onReload: () => void room?.reload(),
        state: recoveryBanner(recovery),
      }
    : lost && snapshot.synced
      ? { state: 'access-lost' }
      : snapshot.offline
        ? { state: snapshot.offline }
        : null;
  return {
    failed,
    strip,
    unavailable: lost && !snapshot.synced && !options.gone?.(),
    waiting: snapshot.status === 'offline' && !snapshot.synced,
  };
}
