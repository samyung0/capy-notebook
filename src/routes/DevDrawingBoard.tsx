import { useEffect, useRef } from 'react';
import { drawBoardPreview } from '@/features/blocksuite/boardPreview';
import { mountDrawingBoard } from '@/features/blocksuite/drawingBoard';

/** The drawing answer's board on its own, for building it and for its spec, with
 * its handle on `window`. Not linked from anywhere. `__reopen(doc, true)` opens a saved
 * board as a teacher sees it; `__preview(doc, size)` draws it as lists do. */
export default function DevDrawingBoard() {
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const host = container.current;
    if (!host) return;
    let board = mountDrawingBoard(host, { plane: true });
    const reopen = (
      saved: string,
      readOnly = false,
      fitPadding?: [number, number, number, number]
    ) => {
      board.unmount();
      board = mountDrawingBoard(host, { fitPadding, readOnly, saved });
      Object.assign(window, { __board: board });
    };
    Object.assign(window, {
      __board: board,
      __preview: drawBoardPreview,
      __reopen: reopen,
    });
    return () => board.unmount();
  }, []);
  return <div className="h-dvh w-full [&>div]:h-full" ref={container} />;
}
