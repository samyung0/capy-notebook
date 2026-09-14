import { useLayoutEffect, useRef } from 'react';

/** Reveal visible rows once when the initial skeleton resolves. */
export function useLoadingReveal(loading: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  const sawLoading = useRef(false);
  const settled = useRef(false);

  useLayoutEffect(() => {
    if (settled.current) return;
    if (loading) {
      sawLoading.current = true;
      return;
    }
    const node = ref.current;
    if (!node) return;
    settled.current = true;
    if (!sawLoading.current) return;
    const visible = Array.from(node.children).filter((child) => {
      const box = child.getBoundingClientRect();
      return (
        box.bottom > 0 &&
        box.top < window.innerHeight &&
        box.right > 0 &&
        box.left < window.innerWidth
      );
    });
    for (const child of visible) {
      child.classList.add('motion-content-reveal');
      Promise.allSettled(
        child.getAnimations().map((animation) => animation.finished)
      ).then(() => {
        child.classList.remove('motion-content-reveal');
      });
    }
    return () => {
      for (const child of visible)
        child.classList.remove('motion-content-reveal');
    };
  }, [loading]);

  return ref;
}
