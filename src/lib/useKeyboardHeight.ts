import { useEffect } from 'react';

/**
 * Keeps `--app-height` at the visible height, so the app shell ends at the top
 * of the on-screen keyboard and a field at the page's bottom sits on it.
 * Chrome on Android resizes the page itself (`interactive-widget` in
 * index.html); iOS Safari ignores that and pans the page under the keyboard
 * instead. A pinch zoom also shrinks the visual viewport, so only an unzoomed
 * one counts.
 */
export function useKeyboardHeight() {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const root = document.documentElement;
    const sync = () => {
      const zoomed = Math.abs(viewport.scale - 1) > 0.01;
      root.style.setProperty(
        '--app-height',
        `${zoomed ? window.innerHeight : viewport.height}px`
      );
      // Safari scrolled the page to bring the focused field into view; the
      // shell now fits above the keyboard, so its header stays on screen.
      if (!zoomed && window.scrollY) window.scrollTo(0, 0);
    };
    sync();
    viewport.addEventListener('resize', sync);
    return () => {
      viewport.removeEventListener('resize', sync);
      root.style.removeProperty('--app-height');
    };
  }, []);
}
