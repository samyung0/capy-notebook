import { type RefObject, useEffect, useState } from 'react';

/** Whether the element is within the root (default the viewport) grown by
 * `margin`; an ancestor scroller still clips it. The observer reports a frame
 * late, so a new `key` (content moved the element) reads false until then. */
export function useNear(
  ref: RefObject<Element | null>,
  margin: string,
  root?: RefObject<Element | null>,
  key?: unknown
) {
  const [seen, setSeen] = useState({ key, near: false });
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new IntersectionObserver(
      ([entry]) => setSeen({ key, near: entry.isIntersecting }),
      { root: root?.current, rootMargin: margin }
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, margin, root, key]);
  return seen.key === key && seen.near;
}
