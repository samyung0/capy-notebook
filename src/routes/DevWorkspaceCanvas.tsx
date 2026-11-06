import { useEffect, useRef } from 'react';
import { mountDrawingBoard } from '@/features/blocksuite/drawingBoard';
import { isString, readPref, writePref } from '@/lib/localPrefs';

const SAVE_AFTER_MS = 500;

/** The drawing board to play with in a workspace, kept in this browser only. Like
 * the dev route, a build without MSW has an empty module here (`MSW_ENTRIES`). */
export default function DevWorkspaceCanvas({
  workspaceId,
}: {
  workspaceId: string;
}) {
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const host = container.current;
    if (!host) return;
    const key = `capy.workspace.canvas.${workspaceId}`;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let changed = false;
    const saved = readPref(key, '', isString);
    const board = mountDrawingBoard(host, {
      onChange: () => {
        changed = true;
        clearTimeout(timer);
        timer = setTimeout(() => {
          writePref(key, board.snapshot());
          changed = false;
        }, SAVE_AFTER_MS);
      },
      saved: saved || undefined,
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
