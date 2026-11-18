import { captureException } from '@sentry/react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import * as Y from 'yjs';
import { BOARD_CATALOG } from '@/api/board.generated';
import { canvasById, trashedCanvasBoard } from '@/api/canvas';
import { useMe } from '@/api/hooks';
import type { CanvasBody, StorageFullBy, Trashed } from '@/api/types';
import {
  recoveryBanner,
  type SaveBannerState,
} from '@/components/banners/SaveBanner';
import { assetImages } from '@/features/blocksuite/boardAsset';
import {
  type BoardView,
  type DrawingBoardOptions,
  mountDrawingBoard,
} from '@/features/blocksuite/drawingBoard';
import {
  type CopyLabel,
  keepsCopyOf,
  useRoomSeed,
} from '@/features/collaboration/deviceCopy';
import {
  type ItemRoomStatus,
  itemEditingStopped,
  useItemRoom,
} from '@/features/collaboration/itemRoom';
import { m } from '@/i18n';
import { base64ToBytes } from '@/lib/base64';
import { errorCopy, errorKind, unexpectedErrorId } from '@/lib/errors';
import { useOnlineStatus } from '@/lib/online';
import type { OpenLink } from '@/lib/openLink';
import type { CanvasPresence } from './BoardPresenceMarks';
import { sendBoardPresence } from './boardPresence';
import { holdsBoard } from './boardRoom';
import { editsCanvas, sendsPresence } from './canvasRights';

export type CanvasBoard = ReturnType<typeof mountDrawingBoard>;

/** A canvas room's cap on its board's state (Epo 2026-11-18). */
const BOARD = { max: BOARD_CATALOG.limits.CANVAS_BOARD_MAX };

/** The editor's own first state, for a trashed canvas never opened (its
 * stored board is empty). Loaded only then: the board's modules stay out of
 * this one's. */
const firstStateModule = import.meta.glob<{
  boardFirstState: () => Uint8Array;
}>('/src/features/blocksuite/boardFirstState.ts');
async function boardFirstState() {
  const [load] = Object.values(firstStateModule);
  return (await load()).boardFirstState();
}

/** The one strip over a canvas's board, by priority: the room's save strips,
 * then why the board is read-only, then a delayed save. */
export type CanvasStrip =
  | {
      kind: 'save';
      /** Recovery's Reload (after asking), which leaves the copy-only edits
       * for a fresh room. */
      onReload?: () => void;
      /** `unreachable`'s Retry. */
      onRetry?: () => void;
      state: SaveBannerState;
    }
  /** The account is frozen, or this person was narrowed while it was open
   * (Epo 2026-09-29): "This file is read-only now." */
  | { kind: 'read-only' }
  /** Its payer (its maker) is at the storage limit, or this person is. */
  | { by: StorageFullBy; kind: 'storage' }
  /** Opened from its maker's Trash: read-only until Restore. */
  | { id: string; kind: 'trash'; trash: Trashed; workspaceId: string };

/** What a canvas page shows around its board. */
export type CanvasBoardState = {
  /** Why the canvas couldn't open, if it couldn't and nothing shows: said
   * with Retry and, for an unexpected failure, its error id (Q612). */
  failed: { errorId: string | null; message: string } | null;
  /** Nothing shows yet and nothing is wrong: the room is joining. */
  opening: boolean;
  /** The other people on the board, for their marks (`BoardPresenceMarks`);
   * none until the board shows its room. */
  presence: CanvasPresence | null;
  /** The room's open waits on the user's open budget (Epo 2026-10-20). */
  slowed: boolean;
  /** The save status just left of the board's ☰ (Epo 2026-11-18, 1B):
   * where it goes, and what it says. None while the board shows no room
   * (the Trash, edits to copy, access lost). A viewer, who saves nothing,
   * gets what a note's viewer gets: the offline icon alone (`reads`). */
  status: { reads: boolean; slot: HTMLElement; state: ItemRoomStatus } | null;
  /** The strip over the board, under the picker's row. */
  strip: CanvasStrip | null;
  /** The room refused this person before anything showed: gone, or not
   * theirs. */
  unavailable: boolean;
  /** Nothing has shown yet and the device is offline: the canvas opens by
   * itself once the connection is back. */
  waiting: boolean;
};

/** The drawing board over a canvas's collaboration room, mounted in
 * `container` (Epo 2026-11-18; a room for every canvas, shared or not). The
 * board edits the room's document in place: the server seeded its page and
 * canvas, every change goes to the room as it is made, and what another tab or
 * person draws arrives the same way. Nothing is saved from here. Unsent edits
 * are kept on this device as any live item's are (`itemRoom.ts`), and sent on
 * the next open. A member's device keeps a copy of what the room confirmed
 * (`deviceCopy.ts`): the next open shows it at once, offline too, read-only
 * until the room has synced.
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
 * An edit the room refuses for good, one taking the board past its cap
 * included, is kept on this device and opens read-only for copying, as any
 * item's (Developer 2026-09-30); Reload asks before it drops them. Turned
 * read-only while open (a demotion, a freeze, a full payer), the board shows
 * what was saved before, under the strip saying so (Epo 2026-09-29). A canvas
 * in its maker's Trash opens read-only from its stored board, with Restore.
 *
 * Presence is a note's (Epo 2026-11-18): whoever may edit the canvas by their
 * role sends their pointer, selection and text caret and sees the others',
 * also while their own board is read-only for a time (a frozen account, a full
 * one). A workspace viewer sends nothing, as a note's reader does not, and the
 * room tells a viewer nothing of the others (`sendsPresence`). */
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
  const online = useOnlineStatus();
  const shown = useRef<CanvasBoard | null>(null);
  // The board's document is going (the page left, a fresh room): its closing
  // writes are no step back in the URL.
  const leaving = useRef(false);

  // The canvas as the server reads it: who the person is on it, why it may
  // be read-only, whether it is in the Trash, its image assets.
  const [canvas, setCanvas] = useState<CanvasBody | null>(null);
  const [failed, setFailed] = useState<CanvasBoardState['failed']>(null);
  // Asked for while the device was offline: asked again (`attempt`) once it is
  // back, as the room joins again by itself. Read again too when the room
  // turned read-only, for why.
  const [away, setAway] = useState(false);
  const [attempt, setAttempt] = useState(0);
  // The canvas's image assets as the server lists them, a trashed one
  // included: an image already the canvas's own is never stored again.
  const own = useRef(new Set<string>());
  useEffect(() => {
    let live = true;
    setFailed(null);
    canvasById(id).then(
      (body) => {
        if (!live) return;
        setAway(false);
        for (const asset of body.ownImageAssetIds) own.current.add(asset);
        setCanvas(body);
      },
      (error: unknown) => {
        if (!live) return;
        if (errorKind(error) === 'offline') {
          setAway(true);
          return;
        }
        // An API failure is the server's to log (beforeSend drops it); any
        // other throw is this page's.
        captureException(error, { tags: { component: 'canvas-open' } });
        setFailed({
          errorId: unexpectedErrorId(error),
          message: errorCopy(error, m.workspace_canvas_open_failed()),
        });
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
  const trash = canvas?.trash;

  // The device's copy, read once before the room starts from it.
  const seed = useRoomSeed(id, actorId);
  const { room, snapshot } = useItemRoom(
    id,
    !!actorId && seed !== undefined && !trash,
    {
      actorId,
      awareness: true,
      board: BOARD,
      keep: seed
        ? {
            canEditContent: seed.row.canEditContent,
            kind: seed.row.kind,
            owner: seed.row.owner,
            standalone: seed.row.standalone,
            title: seed.row.title,
          }
        : undefined,
      // A room replaced under an open plane or chart (moved, refused): what
      // the editor writes as it closes goes into the document while it still
      // stands. The fresh room's board opens the editor again from the URL.
      onLeave: () => {
        leaving.current = true;
        shown.current?.closeEditor();
      },
      seed,
    }
  );
  // A member keeps a copy of what the room confirmed, under the canvas's
  // name (C1, Epo 2026-11-04).
  const keep = useMemo((): CopyLabel | undefined => {
    if (!(canvas && actorId && !canvas.trash)) return;
    if (!keepsCopyOf({ id, isOwner: canvas.own, role: canvas.role })) return;
    return {
      canEditContent: canvas.capabilities.canEditContent,
      kind: 'canvas',
      owner: actorId,
      standalone: !canvas.workspaceId,
      title: canvas.title,
    };
  }, [actorId, canvas, id]);
  useEffect(() => {
    if (room && keep) room.keepAs(keep);
  }, [room, keep]);

  // A canvas in the Trash shows its stored board, with no room.
  const [trashDoc, setTrashDoc] = useState<Y.Doc | null>(null);
  const trashed = !!trash;
  useEffect(() => {
    if (!trashed) return;
    const doc = new Y.Doc();
    let live = true;
    trashedCanvasBoard(id)
      .then(async ({ updates }) => {
        if (!live) return;
        if (updates.length)
          for (const update of updates)
            Y.applyUpdate(doc, base64ToBytes(update));
        else Y.applyUpdate(doc, await boardFirstState());
        if (live) setTrashDoc(doc);
      })
      .catch((error: unknown) => {
        if (!live) return;
        captureException(error, { tags: { component: 'canvas-open' } });
        setFailed({
          errorId: unexpectedErrorId(error),
          message: errorCopy(error, m.workspace_canvas_open_failed()),
        });
      });
    return () => {
      live = false;
      setTrashDoc(null);
      doc.destroy();
    };
  }, [id, trashed]);

  const [mounted, setMounted] = useState<CanvasBoard | null>(null);
  // The card whose plane or chart editor is open.
  const editor = useRef<string | null>(null);
  // The board reads the latest of these when it needs them.
  const latest = useRef(options);
  latest.current = options;
  // Its name now, for Download as image's file: the read's, or the copy's.
  const title = useRef('');
  title.current = canvas?.title ?? seed?.row.title ?? '';

  const images = useMemo(() => {
    // A refused upload says why in the board's own upload box (boardUploads.ts).
    const stored = assetImages(id, [], () => {});
    return {
      ...stored,
      stored: (asset: string) =>
        own.current.has(asset) || !!stored.stored?.(asset),
    };
  }, [id]);

  const { recovery } = snapshot;
  const lost = snapshot.status === 'unavailable';
  // The board as the device kept it, until the room's state arrives.
  const seeded = !!seed && room?.doc === seed.doc;
  // The room refused this person before anything showed: nothing to show.
  const refusedFirst = lost && !snapshot.synced;
  // Edits that cannot join the room show alone, for copying; a trashed
  // canvas shows its stored board; else the room's document once it holds
  // the room's state, or the device's copy of it.
  const doc =
    trashDoc ??
    recovery?.doc ??
    (room && !refusedFirst && (snapshot.synced || seeded) ? room.doc : null);
  const readOnly =
    !!trashDoc ||
    !!recovery ||
    lost ||
    !snapshot.synced ||
    snapshot.stopped ||
    snapshot.access !== 'write' ||
    itemEditingStopped(snapshot);
  const copyOnly = !!recovery || !!trashDoc;
  // A board mounts with its tools once its person may write to its document
  // (or, painting from the copy before the token answers, could when it was
  // kept), and keeps them: from then on it only stops and starts taking edits.
  const tooled = useRef<Y.Doc | null>(null);
  if (
    doc &&
    !copyOnly &&
    (snapshot.access === 'write' ||
      (seeded && snapshot.access === null && !!seed?.row.canEditContent))
  )
    tooled.current = doc;
  const tools = !!doc && tooled.current === doc;
  // The canvas is read or painted from the copy: what the board needs.
  const ready = !!canvas || seeded;
  const locked = useRef(readOnly);
  locked.current = readOnly;
  // Where the person was looking, for a board that mounts again on this
  // canvas (a fresh room, a viewer who may now write).
  const view = useRef<BoardView | null>(null);
  useEffect(() => {
    const host = container.current;
    if (!(host && doc && ready)) return;
    if (!holdsBoard(doc)) {
      // Edits to copy that hold no board show their strip alone.
      if (!copyOnly)
        setFailed({
          errorId: null,
          message: m.workspace_canvas_open_failed(),
        });
      return;
    }
    let disposed = false;
    leaving.current = false;
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
          // Its document going closes it too: that is no step back.
          if (disposed || leaving.current || !link) return;
          if (cardId) link.open(cardId);
          // Done: the URL still names it. Closed by the URL: it no longer does.
          else if (before && link.opened === before) link.close();
        },
        readOnly: !tools,
        room: { doc },
        title: () => title.current,
        view: view.current ?? undefined,
        workspace: latest.current.workspace,
      });
    } catch (error) {
      // The board's own failure: reported, as an editor's crash is.
      captureException(error, { tags: { component: 'canvas-board' } });
      setFailed({
        errorId: null,
        message: errorCopy(error, m.workspace_canvas_open_failed()),
      });
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
  }, [container, doc, images, tools, copyOnly, ready]);
  // The board stops and starts taking edits where it stands.
  useEffect(() => mounted?.setLocked(readOnly), [mounted, readOnly]);
  // The picker's row, a sibling of the board on its page, stops short of the
  // board's status and ☰ whatever the status says (mock StatusPhone): their
  // width as --capy-board-chrome on the page around the board.
  useEffect(() => {
    const chrome = mounted?.statusSlot.parentElement;
    const page = container.current?.parentElement;
    if (!(chrome && page)) return;
    const observer = new ResizeObserver(() =>
      page.style.setProperty('--capy-board-chrome', `${chrome.offsetWidth}px`)
    );
    observer.observe(chrome);
    return () => {
      observer.disconnect();
      page.style.removeProperty('--capy-board-chrome');
    };
  }, [container, mounted]);
  // A viewer saves nothing: no size and no save status, as a note's viewer.
  const reads = !!canvas && !editsCanvas(canvas.role);
  // The board's size in its menu from 75% (Epo 2026-11-18, 2B), as the room
  // measures it; none for a viewer, edits to copy or a trashed board.
  const sized = !(copyOnly || reads) && room;
  useEffect(() => {
    if (!mounted) return;
    if (!sized) {
      mounted.setRoomSize(null);
      return;
    }
    const show = () => mounted.setRoomSize(sized.size());
    show();
    return sized.subscribeSize(show);
  }, [mounted, sized]);
  // Leaving the page (another canvas, another page): an open plane or chart
  // writes as it closes, and that must reach the room. The room's own effect
  // is cleaned up before the board's, which would write into a document already
  // gone; a layout effect is cleaned up before both, the board still on the
  // page.
  useLayoutEffect(
    () => () => {
      leaving.current = true;
      shown.current?.closeEditor();
    },
    []
  );

  // Turned read-only while open (Epo 2026-09-29): the strip says so from
  // then on, and the canvas is read again for why (a full payer).
  const wrote = useRef(false);
  const [narrowed, setNarrowed] = useState(false);
  const { access } = snapshot;
  useEffect(() => {
    if (access === 'write') {
      wrote.current = true;
      setNarrowed(false);
    } else if (access === 'read' && wrote.current) {
      wrote.current = false;
      setNarrowed(true);
      setAttempt((count) => count + 1);
    }
  }, [access]);

  // Presence, between the room's awareness and the board showing its document
  // (edits open for copying show a document of their own).
  const awareness = (!copyOnly && room?.awareness) || null;
  const marks = mounted?.presence ?? null;
  // Whoever edits the canvas by their role, as the room relays it. Anyone
  // else sets no state and listens for no pointer.
  const sends = sendsPresence(canvas?.role);
  useEffect(() => {
    if (!(awareness && marks && sends)) return;
    return sendBoardPresence(marks, awareness);
  }, [awareness, marks, sends]);
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

  // Read-only for its account or its payer, said the way a note says it: a
  // full storage names whose, else the read-only strip (no cue for a viewer).
  const storageFull = !trash && canvas?.storageFull;
  const readOnlyStrip =
    narrowed ||
    (!!canvas &&
      !trash &&
      editsCanvas(canvas.role) &&
      !canvas.capabilities.canEditContent);
  const strip: CanvasStrip | null = trash
    ? {
        id,
        kind: 'trash',
        trash,
        workspaceId: canvas?.workspaceId ?? '',
      }
    : recovery
      ? {
          kind: 'save',
          onReload: () => void room?.reload(),
          state: recoveryBanner(recovery),
        }
      : lost && (snapshot.synced || !!mounted)
        ? { kind: 'save', state: 'access-lost' }
        : snapshot.offline
          ? { kind: 'save', state: snapshot.offline }
          : snapshot.unreachable && online
            ? {
                kind: 'save',
                onRetry: () => room?.retry(),
                state: 'unreachable',
              }
            : storageFull
              ? { by: storageFull, kind: 'storage' }
              : readOnlyStrip
                ? { kind: 'read-only' }
                : snapshot.delayed
                  ? { kind: 'save', state: 'delayed' }
                  : null;
  const unavailable =
    refusedFirst &&
    !trash &&
    !mounted &&
    (!!canvas || !!failed) &&
    !options.gone?.();
  // Offline with nothing shown keeps waiting; the server down with the
  // browser online loads, and says so at 30 s with Retry.
  const waiting =
    !online &&
    !mounted &&
    !trash &&
    (away || (snapshot.status === 'offline' && !snapshot.synced));
  const failedShown = mounted ? null : failed;
  return {
    failed: failedShown,
    // Edits to copy that hold no board show their strip alone.
    opening: !(mounted || failedShown || unavailable || waiting || recovery),
    presence,
    slowed: snapshot.slowed,
    status:
      mounted && !(copyOnly || lost)
        ? { reads, slot: mounted.statusSlot, state: snapshot.status }
        : null,
    strip,
    unavailable,
    waiting,
  };
}
