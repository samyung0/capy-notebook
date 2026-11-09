import { useEffect, useRef, useState } from 'react';
import { BOARD_CATALOG } from '@/api/board.generated';
import {
  isCanvasConflict,
  saveWorkspaceCanvas,
  workspaceCanvas,
} from '@/api/canvas';
import { useMaterials } from '@/api/hooks';
import { userToast } from '@/components/ui/userToast';
import {
  boardFile,
  boardFromAsset,
  gzipBoard,
} from '@/features/blocksuite/boardAsset';
import { mountDrawingBoard } from '@/features/blocksuite/drawingBoard';
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

/** A member's own canvas in the workspace (Epo 2026-11-09,
 * todo-workspace-canvas-storage.md): the drawing board over their canvas material.
 * The board opens from the material's board asset, or from this device's unsaved
 * copy when the last save didn't go up and the copy was taken at the material's
 * current revision. Saves: the cleaned-up document, gzipped, uploaded as a new
 * board asset, then recorded on the material at the revision read; the device
 * copy (the live snapshot, so the drawer's tool and open card are left alone)
 * follows each change in between. Another tab's save (409) stops saving until a
 * reload; any other failure waits for the next change or open, the copy holding
 * the work. Nothing here opens a room: the canvas is personal. */
export default function WorkspaceCanvas({
  onOpenMaterial,
  workspaceId,
}: {
  onOpenMaterial: (materialId: string) => void;
  workspaceId: string;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState<string | null>(null);
  // The canvas mounts once and reads the latest of both when it needs them.
  const { data: materials } = useMaterials(workspaceId, {
    errorBoundary: false,
  });
  const latest = useRef({ materials, onOpenMaterial });
  const mounted = useRef<{ refreshCards: () => void } | null>(null);
  // Cards redraw only when the list changes, not on each render of the page.
  useEffect(() => {
    latest.current.materials = materials;
    mounted.current?.refreshCards();
  }, [materials]);
  useEffect(() => {
    latest.current.onOpenMaterial = onOpenMaterial;
  }, [onOpenMaterial]);
  useEffect(() => {
    const host = container.current;
    if (!host) return;
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
    const draftKey = () => `canvas:${materialId}`;

    /** The device copy: the live snapshot at the revision it was taken on, written
     * after each change and on leaving, so a reload mid-draw keeps the strokes. */
    const keep = () => {
      if (!board || stopped) return Promise.resolve();
      return saveLocalDrawingDraft({
        doc: board.snapshot(),
        key: draftKey(),
        revision,
        savedAt: new Date().toISOString(),
      }).catch(() => undefined);
    };
    const forget = () => deleteLocalDrawingDraft(draftKey()).catch(() => 0);
    const flush = async () => {
      if (!(board && dirty) || stopped || saving) return;
      dirty = false;
      const { bytes, doc } = board.save({ finish: false });
      if (bytes > CANVAS_BOARD_MAX) {
        // The last good save stands; said once until it fits again.
        if (!tooBig)
          userToast({ title: m.workspace_canvas_too_big(), variant: 'error' });
        tooBig = true;
        return;
      }
      tooBig = false;
      saving = (async () => {
        const { uploadEditorAsset } = await import('@/api/editorAssets');
        const asset = await uploadEditorAsset(
          materialId,
          boardFile(await gzipBoard(doc), 'canvas.ydoc.gz'),
          'board',
          { maxBytes: CANVAS_BOARD_MAX }
        );
        const next = await saveWorkspaceCanvas(workspaceId, {
          boardAssetId: asset.assetId,
          imageAssetIds: [],
          revision,
        });
        revision = next.revision;
        // Nothing drawn since: the copy has gone up. Drawn since: the copy is
        // rewritten at the new revision.
        if (dirty) await keep();
        else await forget();
      })()
        .catch((error: unknown) => {
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
          userToast({
            description: errorCopy(error, m.workspace_canvas_save_failed()),
            title: m.workspace_canvas_save_failed(),
            variant: 'error',
          });
        })
        .finally(() => {
          saving = null;
        });
      await saving;
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
      const canvas = await workspaceCanvas(workspaceId);
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
      board = mountDrawingBoard(host, {
        board: 'workspace',
        onChange: schedule,
        saved,
        // Its quiz and flashcard cards (Epo 2026-11-09).
        workspace: {
          materials: () =>
            (latest.current.materials ?? []).flatMap(({ id, title, type }) =>
              type === 'quiz' || type === 'flashcards'
                ? [{ id, kind: type, title }]
                : []
            ),
          open: (id) => latest.current.onOpenMaterial(id),
        },
      });
      mounted.current = board;
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
      // Leaving mid-draw within the app: the copy, then the save, which outlives
      // this page.
      if (dirty) {
        void keep();
        if (!saving) void flush();
      }
      mounted.current = null;
      board?.unmount();
      board = null;
    };
  }, [workspaceId]);
  return (
    <div
      className="h-full w-full overflow-hidden rounded-card-xl [&>div]:h-full"
      ref={container}
    >
      {failed && (
        <p className="t-body m-6 text-fg-muted" role="alert">
          {failed}
        </p>
      )}
    </div>
  );
}
