import { useEffect } from 'react';

/** Chrome's VirtualKeyboard API, missing from TypeScript's DOM types. */
type VirtualKeyboard = EventTarget & {
  boundingRect: DOMRect;
  overlaysContent: boolean;
};
const virtualKeyboard = () =>
  (navigator as Navigator & { virtualKeyboard?: VirtualKeyboard })
    .virtualKeyboard;

/**
 * Keeps `--keyboard-inset` at the height the on-screen keyboard covers. The
 * keyboard overlays the page (the viewport meta leaves Chrome's default
 * `resizes-visual`; iOS Safari always overlays), so nothing resizes: only what
 * must stay visible, the chat dock's field and dialog bottom padding, adds it.
 * Chrome may pan the shrunken visual viewport down to a focused field, which
 * uncovers part of the page, so pans count too. A pinch zoom also shrinks the
 * visual viewport, so only an unzoomed one counts.
 *
 * Fields inside `[data-keyboard-overlay]` (the chat dock and chat page) lift
 * themselves above the keyboard: while one has focus, Chrome lays the
 * keyboard over the page instead of panning the page up to it, so the header
 * stays put, and the keyboard reports its own height. Anywhere else (a note
 * being edited) Chrome keeps scrolling the caret into view itself.
 */
export function useKeyboardHeight() {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const keyboard = virtualKeyboard();
    const root = document.documentElement;
    const sync = () => {
      const zoomed = Math.abs(viewport.scale - 1) > 0.01;
      const covered = zoomed
        ? 0
        : Math.max(
            root.clientHeight - viewport.height - viewport.offsetTop,
            keyboard?.overlaysContent ? keyboard.boundingRect.height : 0
          );
      root.style.setProperty('--keyboard-inset', `${Math.max(0, covered)}px`);
      // Safari scrolled the page to bring the focused field into view; the
      // field is lifted above the keyboard instead, so the header stays.
      if (!zoomed && window.scrollY) window.scrollTo(0, 0);
    };
    // Decided as focus lands, before the keyboard opens for it.
    const onFocusIn = (event: FocusEvent) => {
      if (!keyboard) return;
      keyboard.overlaysContent =
        event.target instanceof Element &&
        !!event.target.closest('[data-keyboard-overlay]');
    };
    sync();
    document.addEventListener('focusin', onFocusIn);
    viewport.addEventListener('resize', sync);
    viewport.addEventListener('scroll', sync);
    keyboard?.addEventListener('geometrychange', sync);
    return () => {
      document.removeEventListener('focusin', onFocusIn);
      viewport.removeEventListener('resize', sync);
      viewport.removeEventListener('scroll', sync);
      keyboard?.removeEventListener('geometrychange', sync);
      root.style.removeProperty('--keyboard-inset');
    };
  }, []);
}
