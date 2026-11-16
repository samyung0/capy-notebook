import { useEffect, useRef, useState } from 'react';
import { BOARD_CATALOG } from '@/api/board.generated';
import type { SaveCanvasBody, WorkspaceCanvas } from '@/api/canvas';
import { isCanvasConflict } from '@/api/canvas';
import { isApiError } from '@/api/client';
import { userToast } from '@/components/ui/userToast';
import {
  assetImages,
  boardFile,
  boardFromAsset,
  gzipBoard,
} from '@/features/blocksuite/boardAsset';
import {
  type DrawingBoardOptions,
  mountDrawingBoard,
} from '@/features/blocksuite/drawingBoard';
import { m } from '@/i18n';
import { errorCopy } from '@/lib/errors';
import {
  deleteLocalDrawingDraft,
  type LocalDrawingDraft,
  localDrawingDraft,
  saveLocalDrawingDraft,
} from '@/lib/localDb';

/** Idle before a save goes up (Epo 2026-11-09), and before the device copy
 * is written. */
const SAVE_AFTER_MS = 2000;
const KEEP_AFTER_MS = 400;
const CANVAS_BOARD_MAX = BOARD_CATALOG.limits.CANVAS_BOARD_MAX;
/** How long a save waits for images still going up before it goes as it stands:
 * a stalled upload must not hold every save. */
const IMAGE_WAIT_MS = 20_000;

export type CanvasBoard = ReturnType<typeof mountDrawingBoard>;

/** Saves still going, by canvas key. A board opening a canvas whose last board
 * is still saving (switched back to, or remounted) reads it once that save
 * lands; read before, it holds the old revision and its own next save is
 * refused as another tab's. */
const inFlight = new Map<string, Promise<void>>();

/** Where a canvas is read from and saved to: a workspace's Canvas tab or one of
 * the person's own (Epo 2026-11-10: saved the same way, with no workspace). */
export type CanvasSource = {
  /** Names the canvas shown: another key mounts another board. */
  key: string;
  open: () => Promise<WorkspaceCanvas>;
  save: (body: SaveCanvasBody) => Promise<WorkspaceCanvas>;
};

/** The drawing board over a canvas material, mounted in `container` (Epo
 * 2026-11-09, todo-workspace-canvas-storage.md). The board opens from the
 * material's board asset, or from this device's unsaved copy when the last save
 * didn't go up and the copy was taken at the material's current revision.
 * Saves: the cleaned-up document, gzipped, uploaded as a new board asset, then
 * recorded on the material at the revision read with the canvas's images; the
 * device copy (the live snapshot, so the drawer's tool and open card are left
 * alone) follows each change in between. Another tab's save (409) stops saving
 * until a reload; any other failure waits for the next change or open, the copy
 * holding the work. An image uploads at once as the material's own image asset,
 * as a note's does, and a save waits for the ones still going up, on leaving
 * too. Nothing here opens a room: a canvas is personal. Answers why the canvas
 * couldn't open, if it couldn't. */
export function useCanvasBoard(
  container: React.RefObject<HTMLDivElement | null>,
  source: CanvasSource,
  options: {
    /** The canvas was deleted: nothing more is saved or kept for it. */
    gone?: () => boolean;
    /** The board as it mounts, and null as it goes. */
    onBoard?: (board: CanvasBoard | null) => void;
    /** A workspace canvas's quizzes and sets for its cards. */
    workspace?: DrawingBoardOptions['workspace'];
  } = {}
) {
  const [failed, setFailed] = useState<string | null>(null);
  // The board mounts once per canvas and reads the latest of these when it
  // needs them.
  const latest = useRef({ ...source, ...options });
  latest.current = { ...source, ...options };
  const { key } = source;
  useEffect(() => {
    setFailed(null);
    const host = container.current;
    if (!host) return;
    // This canvas's own: a save still going after the page shows another
    // canvas goes to the canvas it was drawn on.
    const { open, save } = latest.current;
    const gone = () => latest.current.gone?.() === true;
    let disposed = false;
    let board: ReturnType<typeof mountDrawingBoard> | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let keepTimer: ReturnType<typeof setTimeout> | undefined;
    let dirty = false;
    let stopped = false;
    let saving: Promise<void> | null = null;
    let tooBig = false;
    let revision = 0;
    let materialId = '';
    /** The board as it was left, once unmounted: what a save still in flight
     * writes the copy from, at the revision it lands on. */
    let leftDoc: string | null = null;
    /** The canvas's image assets: which ids a save names, and the server's
     * list of them again after it refused one. */
    let assets: ReturnType<typeof assetImages> | null = null;
    const draftKey = () => `canvas:${materialId}`;

    /** The device copy: the live snapshot at the revision it was taken on, written
     * after each change and on leaving, so a reload mid-draw keeps the strokes. */
    const keep = () => {
      const doc = board ? board.snapshot() : leftDoc;
      if (!doc || stopped || gone()) return Promise.resolve();
      return saveLocalDrawingDraft({
        doc,
        key: draftKey(),
        revision,
        savedAt: new Date().toISOString(),
      }).catch(() => undefined);
    };
    const forget = () => deleteLocalDrawingDraft(draftKey()).catch(() => 0);
    /** A board uploaded for a save that didn't land stops being charged. */
    const dropAsset = async (assetId: string) => {
      try {
        const { deleteEditorAsset } = await import('@/api/editorAssets');
        await deleteEditorAsset(assetId);
      } catch {
        // Charged until the next successful save's prune.
      }
    };
    /** The server's list of the canvas's images again. */
    const relist = async () => {
      try {
        const canvas = await open();
        assets?.relist(canvas.ownImageAssetIds);
      } catch {
        // The next refused save asks again.
      }
    };
    const flush = async () => {
      if (!(board && dirty) || stopped || saving || gone()) return;
      // Read after the page has left too: the board's document outlives its
      // unmount, and an upload finishing then still moves its block.
      const drawing = board;
      let uploaded: string | null = null;
      const run = (async () => {
        // An image still going up is in the save once it has its asset id.
        await Promise.race([
          drawing.imagesSettled(),
          new Promise((resolve) => setTimeout(resolve, IMAGE_WAIT_MS)),
        ]);
        dirty = false;
        const { bytes, doc } = drawing.save({ finish: false });
        if (bytes > CANVAS_BOARD_MAX) {
          // The last good save stands; said once until it fits again.
          if (!tooBig)
            userToast({
              title: m.workspace_canvas_too_big(),
              variant: 'error',
            });
          tooBig = true;
          return;
        }
        tooBig = false;
        const imageAssetIds =
          assets?.named(drawing.images().map(({ id }) => id)) ?? [];
        const { uploadEditorAsset } = await import('@/api/editorAssets');
        const asset = await uploadEditorAsset(
          materialId,
          boardFile(await gzipBoard(doc), 'canvas.ydoc.gz'),
          'board',
          { maxBytes: CANVAS_BOARD_MAX }
        );
        uploaded = asset.assetId;
        const next = await save({
          boardAssetId: asset.assetId,
          imageAssetIds,
          revision,
        });
        uploaded = null;
        revision = next.revision;
        // Nothing drawn since: the copy has gone up. Drawn since: the copy is
        // rewritten at the new revision.
        if (dirty) await keep();
        else await forget();
        // An image trashed after its delete was undone is back with this save.
        if (assets?.restored()) drawing.reloadImages();
      })()
        .catch((error: unknown) => {
          // A board uploaded for a save that didn't land stops being charged.
          if (uploaded) void dropAsset(uploaded);
          if (isCanvasConflict(error)) {
            // The other tab's save stands; this tab's copy must not come back.
            stopped = true;
            void forget();
            userToast({
              title: m.workspace_canvas_saved_elsewhere(),
              variant: 'error',
            });
            return;
          }
          // The copy holds it; the next change or open tries again (no retry loop).
          dirty = true;
          // Refused for what it named (an image deleted for good elsewhere): the
          // next save names from the server's list as it is now.
          if (isApiError(error) && error.status === 400) void relist();
          userToast({
            description: errorCopy(error, m.workspace_canvas_save_failed()),
            title: m.workspace_canvas_save_failed(),
            variant: 'error',
          });
        })
        .finally(() => {
          saving = null;
          if (inFlight.get(key) === run) inFlight.delete(key);
        });
      saving = run;
      inFlight.set(key, run);
      await run;
    };
    const schedule = () => {
      dirty = true;
      clearTimeout(keepTimer);
      keepTimer = setTimeout(() => void keep(), KEEP_AFTER_MS);
      clearTimeout(timer);
      timer = setTimeout(() => void flush(), SAVE_AFTER_MS);
    };
    // The page going (a tab closed, the app left): the copy, at least. The
    // upload can't run as a keepalive request, so the save waits for the next
    // open of this canvas on this device.
    const hidden = () => {
      if (dirty) void keep();
    };
    window.addEventListener('pagehide', hidden);

    (async () => {
      await inFlight.get(key);
      const canvas = await open();
      materialId = canvas.id;
      revision = canvas.revision;
      // An unsaved copy taken at this revision is newer than the stored board and
      // goes up first; one from before another tab's or device's save is left.
      let draft: LocalDrawingDraft | undefined;
      try {
        draft = await localDrawingDraft(draftKey());
      } catch {
        // No IndexedDB (a private window): the stored board alone.
      }
      if (draft && draft.revision !== canvas.revision) {
        draft = undefined;
        void forget();
      }
      const saved =
        draft?.doc ??
        (canvas.boardAssetId
          ? await boardFromAsset(canvas.boardAssetId)
          : undefined);
      if (disposed) return;
      assets = assetImages(canvas.id, canvas.ownImageAssetIds, (error) =>
        userToast({
          description: errorCopy(error, m.workspace_canvas_image_refused()),
          title: m.workspace_canvas_image_refused(),
          variant: 'error',
        })
      );
      board = mountDrawingBoard(host, {
        board: 'workspace',
        images: assets.images,
        onChange: schedule,
        saved,
        workspace: latest.current.workspace,
      });
      latest.current.onBoard?.(board);
      if (import.meta.env.DEV) Object.assign(window, { __board: board });
      if (draft) schedule();
    })().catch((error: unknown) => {
      if (!disposed)
        setFailed(errorCopy(error, m.workspace_canvas_open_failed()));
    });

    return () => {
      disposed = true;
      clearTimeout(timer);
      clearTimeout(keepTimer);
      window.removeEventListener('pagehide', hidden);
      // Leaving mid-draw within the app: an open card's view is finished into the
      // document, the copy written, then the save, which outlives this page; one
      // already in flight rewrites the copy from `leftDoc` at the revision it
      // lands on.
      if (gone()) void forget();
      else if (board && dirty) {
        leftDoc = board.save().doc;
        void keep();
        if (!saving) void flush();
      }
      latest.current.onBoard?.(null);
      board?.unmount();
      board = null;
    };
  }, [key, container]);
  return failed;
}
