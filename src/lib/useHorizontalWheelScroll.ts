import { type RefObject, useEffect } from 'react';

export function useHorizontalWheelScroll(
  target: HTMLElement | RefObject<HTMLElement | null> | null
) {
  useEffect(() => {
    const row = target && 'current' in target ? target.current : target;
    if (!row) return;

    const onWheel = (event: WheelEvent) => {
      if (
        event.defaultPrevented ||
        !event.cancelable ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        event.deltaX !== 0
      )
        return;

      const mode = event.deltaMode;
      let delta = event.deltaY;
      if (!delta) return;

      const width = row.clientWidth;
      const maxScroll = row.scrollWidth - width;
      if (maxScroll <= 0) return;

      if (mode === WheelEvent.DOM_DELTA_LINE) {
        delta *= Number.parseFloat(getComputedStyle(row).lineHeight);
      } else if (mode === WheelEvent.DOM_DELTA_PAGE) {
        delta *= width;
      }

      const left = row.scrollLeft;
      const next = Math.max(0, Math.min(maxScroll, left + delta));
      if (next === left) return;

      event.preventDefault();
      row.scrollLeft = next;
    };

    // React's onWheel is passive; cancel only wheel input consumed by this row.
    row.addEventListener('wheel', onWheel, { passive: false });
    return () => row.removeEventListener('wheel', onWheel);
  }, [target]);
}
