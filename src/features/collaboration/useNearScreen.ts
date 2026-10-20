import { type RefObject, useEffect, useState } from 'react';

/** How long an embed's room stays joined after it scrolls away. */
const LINGER_MS = 30_000;

/**
 * Whether an element is within about a viewport of the screen, staying true
 * for 30 s after it leaves: a note opens an embed's room only while it is
 * near view (live-items DESIGN.md 2.3), without rejoining on every scroll.
 * `entered` counts its comings near: an embed's room closed as its note's
 * oldest joins again on the next one (Epo 2026-10-20).
 */
export function useNearScreen(ref: RefObject<Element | null>) {
  const [near, setNear] = useState(false);
  const [entered, setEntered] = useState(0);
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
        if (entry?.isIntersecting) {
          setNear(true);
          setEntered((count) => count + 1);
        } else linger = setTimeout(() => setNear(false), LINGER_MS);
      },
      { rootMargin: '100% 0px' }
    );
    observer.observe(element);
    return () => {
      clearTimeout(linger);
      observer.disconnect();
    };
  }, [ref]);
  return { entered, near };
}
