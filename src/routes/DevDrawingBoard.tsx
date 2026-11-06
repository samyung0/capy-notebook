import { useEffect, useRef } from 'react';
import {
  type BoardBackground,
  mountDrawingBoard,
} from '@/features/blocksuite/drawingBoard';

/** `?background=` as a question would set it: blank, grid, axes:-5,5,-3,3 (x then y
 * ranges) or figure:<url>. */
function backgroundOf(search: URLSearchParams): BoardBackground | undefined {
  const value = search.get('background');
  if (value === 'blank' || value === 'grid') return { kind: value };
  if (value?.startsWith('figure:'))
    return { kind: 'figure', src: value.slice(7) };
  if (value?.startsWith('axes:')) {
    const [x0, x1, y0, y1] = value.slice(5).split(',').map(Number);
    return { kind: 'axes', x: [x0, x1], y: [y0, y1] };
  }
}

/** The drawing answer's board on its own, for building it and for its spec, with
 * its handle on `window`. Not linked from anywhere. `?readonly` opens what's reopened
 * as a teacher sees it. */
export default function DevDrawingBoard() {
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const host = container.current;
    if (!host) return;
    const search = new URLSearchParams(location.search);
    const background = backgroundOf(search);
    let board = mountDrawingBoard(host, { background });
    const reopen = (saved: string, readOnly = search.has('readonly')) => {
      board.unmount();
      board = mountDrawingBoard(host, { background, readOnly, saved });
      Object.assign(window, { __board: board });
    };
    Object.assign(window, { __board: board, __reopen: reopen });
    return () => board.unmount();
  }, []);
  return <div className="h-dvh w-full [&>div]:h-full" ref={container} />;
}
