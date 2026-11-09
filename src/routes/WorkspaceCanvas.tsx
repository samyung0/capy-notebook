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
 * copy when the last save didn't go up. Saves: the cleaned-up document, gzipped,
 * uploaded as a new board asset, then recorded on the material at the revision
 * read; the device copy holds it in between. Another tab's save (409) stops saving
 * until a reload. Nothing here opens a room: the canvas is personal. */
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
    let dirty = false;
    let stopped = false;
    let saving: Promise<void> | null = null;
    let tooBig = false;
    let revision = 0;
    let version = 0;
    let materialId = '';
    const draftKey = () => `canvas:${materialId}`;

    /** The device copy, written before anything goes up and on leaving. */
    const keep = () => {
      if (!board) return Promise.resolve();
      return saveLocalDrawingDraft({
        doc: board.save().doc,
        key: draftKey(),
        savedAt: new Date().toISOString(),
      }).catch(() => undefined);
    };
    const flush = async () => {
      if (!(board && dirty) || stopped || saving) return;
      dirty = false;
      const { bytes, doc } = board.save();
      if (bytes > CANVAS_BOARD_MAX) {
        // The last good save stands; said once until it fits again.
        if (!tooBig)
          userToast({ title: m.workspace_canvas_too_big(), variant: 'error' });
        tooBig = true;
        await keep();
        return;
      }
      tooBig = false;
      await keep();
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
          version: version + 1,
        });
        revision = next.revision;
        version = next.version;
        // Nothing drawn since: the copy has gone up.
        if (!dirty)
          try {
            await deleteLocalDrawingDraft(draftKey());
          } catch {
            // A copy left behind only repeats a save that already went up.
          }
      })()
        .catch((error: unknown) => {
          if (isCanvasConflict(error)) {
            stopped = true;
            userToast({
              title: m.workspace_canvas_saved_elsewhere(),
              variant: 'error',
            });
            return;
          }
          // The copy holds it; the next change or open tries again.
          dirty = true;
          userToast({
            description: errorCopy(error, m.workspace_canvas_save_failed()),
            title: m.workspace_canvas_save_failed(),
            variant: 'error',
          });
        })
        .finally(() => {
          saving = null;
          if (dirty && !stopped && !disposed) schedule();
        });
      await saving;
    };
    // The device copy follows each change closely, so a reload mid-draw keeps
    // the strokes (a write on pagehide alone may not finish); the save waits
    // for the idle.
    let keepTimer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      dirty = true;
      clearTimeout(keepTimer);
      keepTimer = setTimeout(() => void keep(), KEEP_AFTER_MS);
      clearTimeout(timer);
      timer = setTimeout(() => void flush(), SAVE_AFTER_MS);
    };
    // The page going (a tab closed, the app left): the copy, at least.
    const hidden = () => {
      if (dirty) void keep();
    };
    window.addEventListener('pagehide', hidden);

    (async () => {
      const canvas = await workspaceCanvas(workspaceId);
      materialId = canvas.id;
      revision = canvas.revision;
      version = canvas.version;
      // An unsaved copy is newer than any stored board: it goes up first.
      let draft: Awaited<ReturnType<typeof localDrawingDraft>>;
      try {
        draft = await localDrawingDraft(draftKey());
      } catch {
        // No IndexedDB (a private window): the stored board alone.
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
      // Leaving mid-draw: the copy, then the save, which outlives the page.
      if (dirty && !saving) void flush();
      else if (dirty) void keep();
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
