import { useEffect, useRef } from 'react';
import { mountDrawingBoard } from '@/features/blocksuite/drawingBoard';

/** The drawing answer's board on its own, for building it, for its spec and for
 * bench:canvas, with its handle on `window`. Not linked from anywhere. `__reopen(doc,
 * true)` opens a saved board as a teacher sees it. */
export default function DevDrawingBoard() {
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const host = container.current;
    if (!host) return;
    // The bench sets a saved board before the page loads, and times the mount.
    const { __benchBoard } = window as Window & { __benchBoard?: string };
    performance.mark('board:mount-start');
    let board = mountDrawingBoard(host, { plane: true, saved: __benchBoard });
    performance.mark('board:mount-end');
    const reopen = (
      saved: string,
      readOnly = false,
      fitPadding?: [number, number, number, number]
    ) => {
      board.unmount();
      board = mountDrawingBoard(host, { fitPadding, readOnly, saved });
      Object.assign(window, { __board: board });
    };
    Object.assign(window, { __board: board, __reopen: reopen });
    return () => board.unmount();
  }, []);
  return <div className="h-dvh w-full [&>div]:h-full" ref={container} />;
}
