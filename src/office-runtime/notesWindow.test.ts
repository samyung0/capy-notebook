import { afterEach, describe, expect, it, vi } from 'vitest';
import { runtimeNotesWindow } from './notesWindow';
import { handOverPresenterWindow } from './presenterWindow';

const RUNTIME = 'https://office.example.com';

/** Just what the notes window code touches of a window. */
function fakeWindow(origin = RUNTIME) {
  const listeners = new Map<string, ((event: unknown) => void)[]>();
  const self = {
    addEventListener: (type: string, listener: (event: unknown) => void) =>
      listeners.set(type, [...(listeners.get(type) ?? []), listener]),
    capyAttachPresenter: undefined as Window['capyAttachPresenter'],
    clearInterval: (id: number) => clearInterval(id),
    close: vi.fn(),
    closed: false,
    dispatch: (type: string, event: unknown = {}) => {
      for (const listener of listeners.get(type) ?? []) listener(event);
    },
    document: { documentElement: { dataset: {} as DOMStringMap, lang: '' } },
    location: { origin },
    opener: null as unknown,
    postMessage: vi.fn(),
    setInterval: (handler: () => void, ms: number) => setInterval(handler, ms),
  };
  return self;
}

const INDEX = /^\d+$/;

/** Another origin: reading anything but its frames throws. */
function crossOrigin(frames: unknown[]) {
  return new Proxy(
    Object.assign([...frames], { frames: { length: frames.length } }),
    {
      get(target, key) {
        if (key === 'frames' || INDEX.test(String(key)))
          return Reflect.get(target, key);
        throw new DOMException('Blocked a frame', 'SecurityError');
      },
    }
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('PPTX presenter window, runtime side', () => {
  it('takes the window Capy opened only for the token it expects, while it expects one', () => {
    const frame = fakeWindow();
    frame.document.documentElement.dataset.style = 'classroom';
    frame.document.documentElement.lang = 'zh';
    vi.stubGlobal('window', frame);
    const ask = vi.fn();
    const presenter = runtimeNotesWindow(ask);
    const attach = frame.capyAttachPresenter!;
    const popup = fakeWindow() as unknown as Window;

    expect(attach('t1', popup)).toBe(false);
    presenter.expect('t1');
    expect(presenter.notes.get()).toBe('opening');
    expect(attach('t2', popup)).toBe(false);
    expect(attach('t1', popup)).toBe(true);
    expect(presenter.notes.get()).toBe(popup);
    // Capy's style (its font) and language reach the window.
    expect(popup.document.documentElement.dataset.style).toBe('classroom');
    expect(popup.document.documentElement.lang).toBe('zh');
    // A reload of the same window is not taken again.
    expect(attach('t1', popup)).toBe(false);

    // Capy opened it: the window closes itself when told.
    presenter.notes.close();
    expect(popup.postMessage).toHaveBeenCalledWith(
      'capy-presenter-close',
      RUNTIME
    );
    expect(presenter.notes.get()).toBeNull();

    presenter.expect('');
    expect(presenter.notes.get()).toBe('blocked');
    presenter.notes.open();
    expect(ask).toHaveBeenCalledOnce();

    // The show ended before the window loaded: it is refused.
    presenter.expect('t3');
    presenter.notes.close();
    expect(attach('t3', popup)).toBe(false);
  });

  it('closes the notes window when the frame goes away (Back, another file, a reload)', () => {
    const frame = fakeWindow();
    vi.stubGlobal('window', frame);
    const presenter = runtimeNotesWindow(() => {});
    const popup = fakeWindow() as unknown as Window;
    presenter.expect('t1');
    expect(frame.capyAttachPresenter!('t1', popup)).toBe(true);
    frame.dispatch('pagehide');
    expect(popup.postMessage).toHaveBeenCalledWith(
      'capy-presenter-close',
      RUNTIME
    );
    expect(presenter.notes.get()).toBeNull();
    // Nothing open: a later pagehide sends nothing.
    frame.dispatch('pagehide');
    expect(popup.postMessage).toHaveBeenCalledOnce();
  });

  it('lets go when its viewer or editor unmounts: the window closes and is no longer taken', () => {
    const frame = fakeWindow();
    const removed: string[] = [];
    Object.assign(frame, {
      removeEventListener: (type: string) => removed.push(type),
    });
    vi.stubGlobal('window', frame);
    const presenter = runtimeNotesWindow(() => {});
    const attach = frame.capyAttachPresenter!;
    const popup = fakeWindow() as unknown as Window;
    presenter.expect('t1');
    expect(attach('t1', popup)).toBe(true);
    presenter.dispose();
    expect(popup.postMessage).toHaveBeenCalledWith(
      'capy-presenter-close',
      RUNTIME
    );
    expect(removed).toEqual(['pagehide']);
    expect(frame.capyAttachPresenter).toBeUndefined();
    // A newer viewer's hook stays when an older one lets go.
    const next = runtimeNotesWindow(() => {});
    const newer = frame.capyAttachPresenter;
    presenter.dispose();
    expect(frame.capyAttachPresenter).toBe(newer);
    next.dispose();
  });
});

describe('PPTX presenter window, its own side', () => {
  it("hands itself to the runtime frame among Capy's frames, and closes when told", () => {
    const self = fakeWindow();
    const runtime = fakeWindow();
    const taken: unknown[] = [];
    runtime.capyAttachPresenter = (token, presenter) => {
      taken.push([token, presenter]);
      return token === 't1';
    };
    self.opener = crossOrigin([crossOrigin([]), runtime]);
    expect(handOverPresenterWindow('t1', self as unknown as Window)).toBe(true);
    expect(taken).toEqual([['t1', self]]);
    expect(self.close).not.toHaveBeenCalled();
    // Capy is out of its reach from now on.
    expect(self.opener).toBeNull();

    self.dispatch('message', {
      data: 'capy-presenter-close',
      origin: 'https://evil.example',
    });
    expect(self.close).not.toHaveBeenCalled();
    self.dispatch('message', { data: 'capy-presenter-close', origin: RUNTIME });
    expect(self.close).toHaveBeenCalledOnce();
  });

  it('closes once its runtime frame is gone without a word', () => {
    vi.useFakeTimers();
    const self = fakeWindow();
    const runtime = fakeWindow();
    runtime.capyAttachPresenter = () => true;
    self.opener = crossOrigin([runtime]);
    expect(handOverPresenterWindow('t1', self as unknown as Window)).toBe(true);
    vi.advanceTimersByTime(3000);
    expect(self.close).not.toHaveBeenCalled();
    runtime.closed = true;
    vi.advanceTimersByTime(1000);
    expect(self.close).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(3000);
    expect(self.close).toHaveBeenCalledOnce();
  });

  it('closes when no runtime expects it', () => {
    const self = fakeWindow();
    self.opener = crossOrigin([fakeWindow()]);
    expect(handOverPresenterWindow('stale', self as unknown as Window)).toBe(
      false
    );
    expect(self.close).toHaveBeenCalledOnce();
    const orphan = fakeWindow();
    expect(handOverPresenterWindow('t1', orphan as unknown as Window)).toBe(
      false
    );
    expect(orphan.close).toHaveBeenCalledOnce();
  });
});
