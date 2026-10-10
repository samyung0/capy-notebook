import { type RefObject, useLayoutEffect, useState } from 'react';

/**
 * The stretch of a horizontally scrolling map in view, in whole steps of map
 * units with a margin either side, so scrolling re-renders once per step.
 * Opens with `focus` (map units) a little left of centre.
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
    el.addEventListener('scroll', onScroll, { passive: true });
    const resize = new ResizeObserver(track);
    resize.observe(el);
    return () => {
      el.removeEventListener('scroll', onScroll);
      resize.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [scrollRef, focus, margin, scale, step]);
  return range;
}
