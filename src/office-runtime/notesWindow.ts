import { NotesWindow } from '@betteroffice/pptx-react/presentation';
import { PRESENTER_CLOSE } from './presenterWindow';

export interface RuntimeNotesWindow {
  /** The viewer or editor unmounts: its window closes and nothing is expected. */
  dispose: () => void;
  /** The token Capy sent with `view.presenterView`; '' when the browser blocked the window. */
  expect: (token: string) => void;
  notes: NotesWindow;
}

/**
 * The runtime's side of Presenter view's speaker notes window, one per PPTX
 * viewer or editor. Capy opens the window, as the sandboxed frame gets no
 * user activation from Capy's header (`openPresenterWindow`); the window then
 * hands itself over here (`handOverPresenterWindow`). `ask` requests one from
 * a click in the show.
 */
export function runtimeNotesWindow(ask: () => void): RuntimeNotesWindow {
  let expected: string | null = null;
  const notes = new NotesWindow({
    // Capy opened it, so only the window itself can close it.
    close: (presenter) =>
      presenter.postMessage(PRESENTER_CLOSE, window.location.origin),
    open: ask,
  });
  const attach = (token: string, presenter: Window) => {
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
  window.capyAttachPresenter = attach;
  // The frame going away (Back, another file, a reload, the tab closing)
  // takes the notes window with it instead of leaving it stale.
  const hide = () => notes.close();
  window.addEventListener('pagehide', hide);
  return {
    dispose: () => {
      window.removeEventListener('pagehide', hide);
      if (window.capyAttachPresenter === attach)
        window.capyAttachPresenter = undefined;
      expected = null;
      notes.close();
    },
    expect: (token) => {
      expected = token || null;
      notes.set(token ? 'opening' : 'blocked');
    },
    notes,
  };
}
