declare global {
  interface Window {
    /** Set in the runtime frame: a presenter window hands itself over. */
    capyAttachPresenter?: (token: string, presenter: Window) => boolean;
  }
}

/**
 * The PPTX command whose window Capy opens (`popup: 'presenter'`). This
 * module loads with every runtime, so it imports nothing of pptx-react.
 */
export const PRESENTER_VIEW = 'view.presenterView';
/** The runtime's message that closes a presenter window it did not open. */
export const PRESENTER_CLOSE = 'capy-presenter-close';

/**
 * In the presenter window (`#presenter=<token>`): hands it to the runtime
 * frame that expects the token, found among the opener's frames, then drops
 * its opener (Capy) so nothing it shows can reach Capy's page. A window
 * nobody expects (reloaded, or the show ended first) closes, and so does
 * one whose runtime frame is gone without a word.
 */
export function handOverPresenterWindow(token: string, self: Window = window) {
  self.addEventListener('message', (event) => {
    if (event.origin === self.location.origin && event.data === PRESENTER_CLOSE)
      self.close();
  });
  const opener = self.opener as Window | null;
  const owners = opener
    ? [
        opener,
        ...Array.from({ length: opener.frames.length }, (_, i) => opener[i]),
      ]
    : [];
  for (const owner of owners) {
    try {
      if (owner?.capyAttachPresenter?.(token, self)) {
        self.opener = null;
        const watch = self.setInterval(() => {
          if (!owner.closed) return;
          self.clearInterval(watch);
          self.close();
        }, 1000);
        return true;
      }
    } catch {
      // Another origin: Capy itself and its other frames.
    }
  }
  self.close();
  return false;
}
