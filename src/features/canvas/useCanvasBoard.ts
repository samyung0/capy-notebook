import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type * as Y from 'yjs';
import { canvasById } from '@/api/canvas';
import { useMe, useWorkspace } from '@/api/hooks';
import {
  recoveryBanner,
  type SaveBannerState,
} from '@/components/banners/SaveBanner';
import { userToast } from '@/components/ui/userToast';
import { assetImages } from '@/features/blocksuite/boardAsset';
import {
  type BoardView,
  type DrawingBoardOptions,
  mountDrawingBoard,
} from '@/features/blocksuite/drawingBoard';
import {
  itemEditingStopped,
  useItemRoom,
} from '@/features/collaboration/itemRoom';
import { m } from '@/i18n';
import { errorCopy, errorKind } from '@/lib/errors';
import type { OpenLink } from '@/lib/openLink';
import type { CanvasPresence } from './BoardPresenceMarks';
import { sendBoardPresence } from './boardPresence';
import { holdsBoard } from './boardRoom';

export type CanvasBoard = ReturnType<typeof mountDrawingBoard>;

/** What a canvas page shows around its board. */
export type CanvasBoardState = {
  /** Why the canvas couldn't open, if it couldn't: said with Retry. */
  failed: string | null;
  /** Nothing shows yet and nothing is wrong: the room is joining. */
  opening: boolean;
  /** The other people on the board, for their marks (`BoardPresenceMarks`);
   * none until the board shows its room. */
  presence: CanvasPresence | null;
  /** The strip over the board while its room cannot take edits as usual
   * (offline, outdated, edits to copy, access lost); `onReload` leaves the
   * copy-only edits for a fresh room. */
  strip: { onReload?: () => void; state: SaveBannerState } | null;
  /** The room refused this person before anything showed: gone, or not
   * theirs. */
  unavailable: boolean;
  /** Nothing has shown yet and the device is offline: the canvas opens by
   * itself once the connection is back. */
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
 * hold, an outdated build, edits open for copying, access lost or being asked
 * again). An editor's board stops and starts taking edits in place
 * (`setLocked`): the view, the history and the board itself stay. Only a
 * board mounted without tools, a viewer's, mounts again if its person may then
 * write, at the view they had. An image is stored at once as the material's
 * own image asset, as a note's is, and lands on the board once it is stored.
 *
 * A canvas that is full (the room refuses an update for its size) drops what
 * this tab had not stored, says so once, and opens the room afresh: the
 * person is back on an editable board holding the room's state, to delete
 * something.
 *
 * Presence is a note's (Epo 2026-11-18): whoever may edit the canvas sends
 * their pointer, selection and text caret and sees the others', also while
 * their own board is read-only for a time (a frozen account, a full one). A
 * workspace viewer sends nothing, as a note's reader does not, and the room
 * tells a viewer nothing of the others. */
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
    onFull: () =>
      userToast({
        id: `canvas-full-${id}`,
        title: m.workspace_canvas_full(),
        variant: 'warning',
      }),
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
    /** The person made the canvas: theirs whatever their workspace role. */
    mine: boolean;
    own: readonly string[];
    workspaceId?: string;
  } | null>(null);
  // Asked for while the device was offline: asked again (`attempt`) once it is
  // back, as the room joins again by itself.
  const [away, setAway] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    setFailed(null);
    canvasById(id).then(
      (canvas) => {
        if (!live) return;
        setAway(false);
        setListed({
          id,
          mine: canvas.own,
          own: canvas.ownImageAssetIds,
          workspaceId: canvas.workspaceId,
        });
      },
      (error: unknown) => {
        if (!live) return;
        if (errorKind(error) === 'offline') setAway(true);
        else setFailed(errorCopy(error, m.workspace_canvas_open_failed()));
      }
    );
    return () => {
      live = false;
    };
  }, [id, attempt]);
  useEffect(() => {
    if (!away) return;
    // Asking shows as opening, not as waiting on a connection that is back.
    const again = () => {
      setAway(false);
      setAttempt((count) => count + 1);
    };
    window.addEventListener('online', again);
    return () => window.removeEventListener('online', again);
  }, [away]);
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
    snapshot.stopped ||
    snapshot.access !== 'write' ||
    itemEditingStopped(snapshot);
  const copyOnly = !!recovery;
  // A board mounts with its tools once its person may write to its document,
  // and keeps them: from then on it only stops and starts taking edits.
  const tooled = useRef<Y.Doc | null>(null);
  if (doc && !copyOnly && snapshot.access === 'write') tooled.current = doc;
  const tools = !!doc && tooled.current === doc;
  const locked = useRef(readOnly);
  locked.current = readOnly;
  // Where the person was looking, for a board that mounts again on this
  // canvas (a fresh room, a viewer who may now write).
  const view = useRef<BoardView | null>(null);
  // The page is going: the board's closing writes are no step back in the URL.
  const leaving = useRef(false);
  const shown = useRef<CanvasBoard | null>(null);
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
        images: tools ? images : { load: images.load },
        locked: locked.current,
        onEditor: (cardId) => {
          const before = editor.current;
          editor.current = cardId;
          const { link } = latest.current;
          // Leaving the page closes it too: that is no step back.
          if (disposed || leaving.current || !link) return;
          if (cardId) link.open(cardId);
          // Done: the URL still names it. Closed by the URL: it no longer does.
          else if (before && link.opened === before) link.close();
        },
        readOnly: !tools,
        room: { doc },
        view: view.current ?? undefined,
        workspace: latest.current.workspace,
      });
    } catch (error) {
      setFailed(errorCopy(error, m.workspace_canvas_open_failed()));
      return;
    }
    const drawing = board;
    shown.current = drawing;
    setMounted(drawing);
    latest.current.onBoard?.(drawing);
    if (import.meta.env.DEV) Object.assign(window, { __board: drawing });
    return () => {
      disposed = true;
      view.current = drawing.view() ?? view.current;
      latest.current.onBoard?.(null);
      drawing.unmount();
      if (import.meta.env.DEV) Object.assign(window, { __board: undefined });
      editor.current = null;
      shown.current = null;
      setMounted(null);
    };
  }, [container, doc, images, tools, copyOnly]);
  // The board stops and starts taking edits where it stands.
  useEffect(() => mounted?.setLocked(readOnly), [mounted, readOnly]);
  // Leaving the page (another canvas, another page): an open plane or chart
  // writes as it closes, and that must reach the room. The room's own effect
  // is cleaned up before the board's, which would write into a document already
  // gone; a layout effect is cleaned up before both.
  useLayoutEffect(() => {
    leaving.current = false;
    return () => {
      leaving.current = true;
      shown.current?.closeEditor();
    };
  }, []);

  // Presence, between the room's awareness and the board showing its document
  // (edits open for copying show a document of their own).
  const awareness = (!copyOnly && room?.awareness) || null;
  const marks = mounted?.presence ?? null;
  const canvas = listed?.id === id ? listed : null;
  const { data: workspace } = useWorkspace(canvas?.workspaceId ?? '');
  // Another member's shared canvas, held as the workspace's viewer.
  const viewer = !canvas?.mine && workspace?.role === 'viewer';
  useEffect(() => {
    if (!(awareness && marks) || viewer) return;
    return sendBoardPresence(marks, awareness);
  }, [awareness, marks, viewer]);
  const connections = snapshot.presence;
  const presence = useMemo(
    () => (awareness && marks ? { awareness, connections, view: marks } : null),
    [awareness, connections, marks]
  );

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
  const unavailable = lost && !snapshot.synced && !options.gone?.();
  const waiting = away || (snapshot.status === 'offline' && !snapshot.synced);
  return {
    failed,
    // Edits to copy that hold no board show their strip alone.
    opening: !(mounted || failed || unavailable || waiting || copyOnly),
    presence,
    strip,
    unavailable,
    waiting,
  };
}
