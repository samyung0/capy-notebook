import { useEffect, useRef } from 'react';
import { mountDrawingBoard } from '@/features/blocksuite/drawingBoard';
import { isString, readPref, removePref, writePref } from '@/lib/localPrefs';

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
    const saved = readPref(key, '', isString);
    const board = mountDrawingBoard(host, {
      onChange: () => {
        clearTimeout(timer);
        timer = setTimeout(
          () => writePref(key, board.snapshot()),
          SAVE_AFTER_MS
        );
      },
      saved: saved || undefined,
    });
    Object.assign(window, { __board: board });
    return () => {
      clearTimeout(timer);
      // An empty board has no blocks to keep.
      if (board.stats().canvas.length || board.stats().blocks.length)
        writePref(key, board.save());
      else removePref(key);
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
