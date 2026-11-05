import { useEffect, useRef } from 'react';
import { mountDrawingBoard } from '@/features/blocksuite/drawingBoard';

/** Spike page (todo-queue.md, drawing answers): BlockSuite's edgeless editor on
 * an in-memory board. Not linked from anywhere. */
export default function DevDrawingBoard() {
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!container.current) return;
    const board = mountDrawingBoard(container.current);
    Object.assign(window, { __board: board });
    return board.unmount;
  }, []);
  return <div className="h-dvh w-full [&>div]:h-full" ref={container} />;
}
