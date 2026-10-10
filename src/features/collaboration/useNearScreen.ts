import { type RefObject, useEffect, useState } from 'react';

/** How long an embed's room stays joined after it scrolls away. */
const LINGER_MS = 30_000;

/**
 * Whether an element is within about a viewport of the screen, staying true
 * for 30 s after it leaves: a note opens an embed's room only while it is
 * near view (live-items DESIGN.md 2.3), without rejoining on every scroll.
 */
export function useNearScreen(ref: RefObject<Element | null>) {
  const [near, setNear] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof IntersectionObserver === 'undefined') {
      setNear(true);
      return;
    }
    let linger: ReturnType<typeof setTimeout> | undefined;
    const observer = new IntersectionObserver(
      ([entry]) => {
        clearTimeout(linger);
        if (entry?.isIntersecting) setNear(true);
        else linger = setTimeout(() => setNear(false), LINGER_MS);
      },
      { rootMargin: '100% 0px' }
    );
    observer.observe(element);
    return () => {
      clearTimeout(linger);
      observer.disconnect();
    };
  }, [ref]);
  return near;
}
