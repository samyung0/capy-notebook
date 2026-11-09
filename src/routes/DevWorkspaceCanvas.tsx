import { useEffect, useRef } from 'react';
import { useMaterials } from '@/api/hooks';
import { mountDrawingBoard } from '@/features/blocksuite/drawingBoard';
import { isString, readPref, writePref } from '@/lib/localPrefs';

const SAVE_AFTER_MS = 500;

/** The drawing board to play with in a workspace, kept in this browser only. Like
 * the dev route, a build without MSW has an empty module here (`MSW_ENTRIES`). */
export default function DevWorkspaceCanvas({
  onOpenMaterial,
  workspaceId,
}: {
  onOpenMaterial: (materialId: string) => void;
  workspaceId: string;
}) {
  const container = useRef<HTMLDivElement>(null);
  // The canvas mounts once and reads the latest of both when it needs them.
  const { data: materials } = useMaterials(workspaceId, {
    errorBoundary: false,
  });
  const latest = useRef({ materials, onOpenMaterial });
  latest.current = { materials, onOpenMaterial };
  useEffect(() => {
    const host = container.current;
    if (!host) return;
    const key = `capy.workspace.canvas.${workspaceId}`;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let changed = false;
    const saved = readPref(key, '', isString);
    const board = mountDrawingBoard(host, {
      board: 'workspace',
      onChange: () => {
        changed = true;
        clearTimeout(timer);
        timer = setTimeout(() => {
          writePref(key, board.snapshot());
          changed = false;
        }, SAVE_AFTER_MS);
      },
      plane: true,
      saved: saved || undefined,
      // Its quiz and flashcard cards (Epo 2026-11-09).
      workspace: {
        materials: () =>
          (latest.current.materials ?? []).flatMap(({ id, title, type }) =>
            type === 'quiz' || type === 'flashcards'
              ? [{ id, kind: type, title }]
              : []
          ),
        open: (materialId) => latest.current.onOpenMaterial(materialId),
      },
    });
    Object.assign(window, { __board: board });
    return () => {
      clearTimeout(timer);
      // Unchanged, what's stored stands: a board mounted and unmounted at once has
      // nothing on it yet.
      if (changed) writePref(key, board.save().doc);
      board.unmount();
    };
  }, [workspaceId]);
  return (
    <div
      className="h-full w-full overflow-hidden rounded-card-xl [&>div]:h-full"
      ref={container}
    />
  );
}
