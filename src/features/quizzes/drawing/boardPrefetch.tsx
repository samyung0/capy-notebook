import { useEffect, useState } from 'react';

/** BlockSuite loads only for a drawing part. */
export const loadBoard = () => import('./DrawingBoardScreen');

/** The one board mounted ahead on the page: a drawing question showing holds it
 * until it leaves; others open theirs on Draw. */
let holder: object | null = null;

/**
 * Once a drawing part or a sample answer field shows, fetches and evaluates the
 * board's module (about 650 KB gzipped) in idle time but within a second. With
 * `ahead`, it then returns true when this part may mount its board hidden, so Draw
 * shows a board that takes a stroke at once (Epo 2026-11-07, fix 4: "the moment
 * they click they should be able to draw already"). A first mount took 240-430 ms
 * at 4x CPU on a Mac, a visible wait, and showing one mounted ahead about 12 ms; a
 * mounted board holds about 3-9 MB of heap.
 */
export function useBoardAhead(ahead: boolean) {
  const [me] = useState(() => ({}));
  const [held, setHeld] = useState(false);
  useEffect(() => {
    let live = true;
    const run = () =>
      void loadBoard()
        .then(() => {
          if (!(live && ahead && holder === null)) return;
          holder = me;
          setHeld(true);
        })
        .catch(() => undefined);
    const idle = window.requestIdleCallback
      ? window.requestIdleCallback(run, { timeout: 1000 })
      : setTimeout(run, 200);
    return () => {
      live = false;
      if (window.cancelIdleCallback) window.cancelIdleCallback(idle as number);
      else clearTimeout(idle);
      if (holder === me) holder = null;
      setHeld(false);
    };
  }, [ahead, me]);
  return held;
}
