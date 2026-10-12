import { type RefObject, useLayoutEffect, useState } from 'react';

/**
 * The stretch of a horizontally scrolling map in view, in whole steps of map
 * units with a margin either side, so scrolling re-renders once per step.
 * Opens with `focus` (map units) a little left of centre.
 *
 * A mouse wheel scrolls the map sideways until it reaches an end, then the
 * page scrolls as usual. Sideways swipes and pinch-zoom pass through.
 */
export function useVisibleRange(
  scrollRef: RefObject<HTMLDivElement | null>,
  {
    focus,
    margin,
    scale,
    step,
  }: { focus: number; margin: number; scale: number; step: number }
) {
  const [range, setRange] = useState<[number, number]>([0, 0]);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const track = () => {
      const lo = Math.floor((el.scrollLeft / scale - margin) / step);
      const hi = Math.ceil(
        ((el.scrollLeft + el.clientWidth) / scale + margin) / step
      );
      setRange((prev) => (prev[0] === lo && prev[1] === hi ? prev : [lo, hi]));
    };
    el.scrollLeft = focus * scale - el.clientWidth * 0.38;
    track();
    let frame = 0;
    const onScroll = () => {
      if (!frame)
        frame = requestAnimationFrame(() => {
          frame = 0;
          track();
        });
    };
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return;
      // Firefox reports mouse wheels in lines.
      const dy =
        e.deltaMode === WheelEvent.DOM_DELTA_LINE ? e.deltaY * 16 : e.deltaY;
      const max = el.scrollWidth - el.clientWidth;
      if (
        (dy < 0 && el.scrollLeft <= 0) ||
        (dy > 0 && el.scrollLeft >= max - 1)
      )
        return;
      e.preventDefault();
      el.scrollLeft += dy;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    el.addEventListener('wheel', onWheel, { passive: false });
    const resize = new ResizeObserver(track);
    resize.observe(el);
    return () => {
      el.removeEventListener('scroll', onScroll);
      el.removeEventListener('wheel', onWheel);
      resize.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [scrollRef, focus, margin, scale, step]);
  return range;
}
