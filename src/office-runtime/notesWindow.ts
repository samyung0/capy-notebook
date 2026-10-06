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
 * (`presenterWindowUrl`); the window then hands itself over here. `ask`
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
    notes.set(presenter);
    return true;
  };
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
 * frame that expects the token, found among the opener's frames; a window
 * nobody expects (reloaded, or the show ended first) closes.
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
      if (owner?.capyAttachPresenter?.(token, self)) return true;
    } catch {
      // Another origin: Capy itself and its other frames.
    }
  }
  self.close();
  return false;
}
