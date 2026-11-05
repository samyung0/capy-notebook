import { useEffect, useRef } from 'react';
import { mountDrawingBoard } from '@/features/blocksuite/drawingBoard';

/** The drawing answer's board on its own, for building it and for its spec, with
 * its handle on `window`. Not linked from anywhere. */
export default function DevDrawingBoard() {
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const host = container.current;
    if (!host) return;
    let board = mountDrawingBoard(host);
    const reopen = (saved: string) => {
      board.unmount();
      board = mountDrawingBoard(host, { saved });
      Object.assign(window, { __board: board });
    };
    Object.assign(window, { __board: board, __reopen: reopen });
    return () => board.unmount();
  }, []);
  return <div className="h-dvh w-full [&>div]:h-full" ref={container} />;
}
