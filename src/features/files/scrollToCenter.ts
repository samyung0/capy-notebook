/** How long a citation's scroll runs (Q490). */
export const CITATION_SCROLL_MS = 300;

const SCROLL_KEYS = new Set([
  ' ',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'End',
  'Home',
  'PageDown',
  'PageUp',
]);

/** Scrolls `scroller` until `target`'s centre sits at its centre, over
 * CITATION_SCROLL_MS of ease-out frames, then calls `onEnd`. Each frame aims
 * at where the target is now, so a page above it that paints mid-scroll still
 * ends centred. A trip over two viewports first jumps to one viewport short,
 * so the frames don't render every lazy page in between. It moves sideways
 * only when the target starts out of view (a zoomed page). Reduced motion
 * lands at once. Wheel, a pointer on the scroller (a touch, its scrollbar) or
 * a scroll key stops it without `onEnd`. Returns that stop. */
export function scrollToCenter(
  scroller: HTMLElement,
  target: Element,
  onEnd: () => void
) {
  // The target centre's distance from the scroller's, in one layout read.
  const measure = () => {
    const box = target.getBoundingClientRect();
    const pane = scroller.getBoundingClientRect();
    const { clientHeight, clientWidth } = scroller;
    const x = box.left + box.width / 2 - (pane.left + clientWidth / 2);
    return {
      clientHeight,
      hiddenX: Math.abs(x) > (clientWidth - box.width) / 2,
      x,
      y: box.top + box.height / 2 - (pane.top + clientHeight / 2),
    };
  };
  const scrollBy = (x: number, y: number) =>
    scroller.scrollBy({ behavior: 'instant', left: x, top: y });

  const { clientHeight, hiddenX, x, y } = measure();
  if (
    matchMedia('(prefers-reduced-motion: reduce)').matches ||
    (!hiddenX && Math.abs(y) < 1)
  ) {
    scrollBy(hiddenX ? x : 0, y);
    onEnd();
    return () => undefined;
  }
  if (Math.abs(y) > 2 * clientHeight)
    scrollBy(0, y - Math.sign(y) * clientHeight);

  const controller = new AbortController();
  let frame = 0;
  const stop = () => {
    cancelAnimationFrame(frame);
    controller.abort();
  };
  const listen = { passive: true, signal: controller.signal };
  scroller.addEventListener('wheel', stop, listen);
  scroller.addEventListener('pointerdown', stop, listen);
  scroller.ownerDocument.addEventListener(
    'keydown',
    (event) => SCROLL_KEYS.has(event.key) && stop(),
    listen
  );

  const start = performance.now();
  // The share of the way still to go, which ease-out cubic shrinks as (1-t)³.
  let left = 1;
  const step = () => {
    if (!target.isConnected) {
      stop();
      return;
    }
    const t = Math.min(1, (performance.now() - start) / CITATION_SCROLL_MS);
    const next = (1 - t) ** 3;
    const { x, y } = measure();
    const share = 1 - next / left;
    left = next;
    scrollBy(hiddenX ? x * share : 0, y * share);
    if (t < 1) frame = requestAnimationFrame(step);
    else {
      stop();
      onEnd();
    }
  };
  frame = requestAnimationFrame(step);
  return stop;
}
