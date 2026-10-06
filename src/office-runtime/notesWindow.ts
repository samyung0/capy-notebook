import { NotesWindow } from '@betteroffice/pptx-react/presentation';

declare global {
  interface Window {
    /** Set in the runtime frame: a presenter window hands itself over. */
    capyAttachPresenter?: (token: string, presenter: Window) => boolean;
  }
}

/** The PPTX command whose window Capy opens (`popup: 'presenter'`). */
export const PRESENTER_VIEW = 'view.presenterView';
const CLOSE = 'capy-presenter-close';

export interface RuntimeNotesWindow {
  /** The token Capy sent with `view.presenterView`; '' when the browser blocked the window. */
  expect: (token: string) => void;
  notes: NotesWindow;
}

/**
 * The runtime's side of Presenter view's speaker notes window. Capy opens
 * it, as the sandboxed frame gets no user activation from Capy's header
 * (`openPresenterWindow`); the window then hands itself over here. `ask`
 * requests one from a click in the show.
 */
export function runtimeNotesWindow(ask: () => void): RuntimeNotesWindow {
  let expected: string | null = null;
  const notes = new NotesWindow({
    // Capy opened it, so only the window itself can close it.
    close: (presenter) => presenter.postMessage(CLOSE, window.location.origin),
    open: ask,
  });
  window.capyAttachPresenter = (token, presenter) => {
    if (token !== expected || notes.get() !== 'opening') return false;
    expected = null;
    // Capy's style gives the window its font (--font-sans); it stays dark.
    const root = presenter.document.documentElement;
    const { lang, dataset } = window.document.documentElement;
    if (dataset.style) root.dataset.style = dataset.style;
    root.lang = lang;
    notes.set(presenter);
    return true;
  };
  // The frame going away (Back, another file, a reload, the tab closing)
  // takes the notes window with it instead of leaving it stale.
  window.addEventListener('pagehide', () => notes.close());
  return {
    expect: (token) => {
      expected = token || null;
      notes.set(token ? 'opening' : 'blocked');
    },
    notes,
  };
}

/**
 * In the presenter window (`#presenter=<token>`): hands it to the runtime
 * frame that expects the token, found among the opener's frames, then drops
 * its opener (Capy) so nothing it shows can reach Capy's page. A window
 * nobody expects (reloaded, or the show ended first) closes, and so does
 * one whose runtime frame is gone without a word.
 */
export function handOverPresenterWindow(token: string, self: Window = window) {
  self.addEventListener('message', (event) => {
    if (event.origin === self.location.origin && event.data === CLOSE)
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
