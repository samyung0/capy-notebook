import { useEffect, useRef } from 'react';
import { drawBoardPreview } from '@/features/blocksuite/boardPreview';
import {
  type DrawingBoardOptions,
  mountDrawingBoard,
} from '@/features/blocksuite/drawingBoard';

/** The drawing answer's board on its own, for building it, for its spec and for
 * bench:canvas, with its handle on `window`. Not linked from anywhere. `__reopen(doc,
 * true)` opens a saved board as a teacher sees it; `__mount(options)` opens one with
 * any options; `__preview(doc, size)` draws it as lists do. `?unmounted` mounts
 * nothing until `__mount`. */
export default function DevDrawingBoard() {
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const host = container.current;
    if (!host) return;
    // The bench sets a saved board before the page loads, and times the mount.
    // `?unmounted` loads the module and mounts nothing, as a drawing question
    // does before Draw.
    const { __benchBoard } = window as Window & { __benchBoard?: string };
    let board: ReturnType<typeof mountDrawingBoard> | undefined;
    if (!new URLSearchParams(location.search).has('unmounted')) {
      performance.mark('board:mount-start');
      board = mountDrawingBoard(host, {
        board: 'question',
        plane: true,
        saved: __benchBoard,
      });
      performance.mark('board:mount-end');
    }
    // The drawing answer's board, as every test on this page opens it.
    const mount = (options: Omit<DrawingBoardOptions, 'board'>) => {
      board?.unmount();
      board = mountDrawingBoard(host, { ...options, board: 'question' });
      Object.assign(window, { __board: board });
    };
    const reopen = (
      saved: string,
      readOnly = false,
      fitPadding?: [number, number, number, number]
    ) => mount({ fitPadding, readOnly, saved });
    Object.assign(window, {
      __board: board,
      __mount: mount,
      __preview: (saved: string, size: { height: number; width: number }) =>
        drawBoardPreview(saved, size, 'question'),
      __reopen: reopen,
    });
    return () => board?.unmount();
  }, []);
  return <div className="h-dvh w-full [&>div]:h-full" ref={container} />;
}
