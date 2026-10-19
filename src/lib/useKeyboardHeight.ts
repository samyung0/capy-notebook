import { useEffect } from 'react';

/**
 * Keeps `--keyboard-inset` at the height the on-screen keyboard covers. The
 * keyboard overlays the page (the viewport meta leaves Chrome's default
 * `resizes-visual`; iOS Safari always overlays), so nothing resizes: only what
 * must stay visible, the chat dock's field and dialog bottom padding, adds it.
 * A pinch zoom also shrinks the visual viewport, so only an unzoomed one counts.
 */
export function useKeyboardHeight() {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const root = document.documentElement;
    const sync = () => {
      const zoomed = Math.abs(viewport.scale - 1) > 0.01;
      const covered = zoomed
        ? 0
        : root.clientHeight - viewport.height - viewport.offsetTop;
      root.style.setProperty('--keyboard-inset', `${Math.max(0, covered)}px`);
      // Safari scrolled the page to bring the focused field into view; the
      // field is lifted above the keyboard instead, so the header stays.
      if (!zoomed && window.scrollY) window.scrollTo(0, 0);
    };
    sync();
    viewport.addEventListener('resize', sync);
    return () => {
      viewport.removeEventListener('resize', sync);
      root.style.removeProperty('--keyboard-inset');
    };
  }, []);
}
