import { afterEach, describe, expect, it, vi } from 'vitest';
import { handOverPresenterWindow, runtimeNotesWindow } from './notesWindow';

const RUNTIME = 'https://office.example.com';

/** Just what the notes window code touches of a window. */
function fakeWindow(origin = RUNTIME) {
  const listeners = new Map<string, ((event: unknown) => void)[]>();
  const self = {
    addEventListener: (type: string, listener: (event: unknown) => void) =>
      listeners.set(type, [...(listeners.get(type) ?? []), listener]),
    capyAttachPresenter: undefined as Window['capyAttachPresenter'],
    close: vi.fn(),
    dispatch: (type: string, event: unknown = {}) => {
      for (const listener of listeners.get(type) ?? []) listener(event);
    },
    location: { origin },
    opener: null as unknown,
    postMessage: vi.fn(),
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
});

describe('PPTX presenter window, runtime side', () => {
  it('takes the window Capy opened only for the token it expects, while it expects one', () => {
    const frame = fakeWindow();
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

    self.dispatch('message', {
      data: 'capy-presenter-close',
      origin: 'https://evil.example',
    });
    expect(self.close).not.toHaveBeenCalled();
    self.dispatch('message', { data: 'capy-presenter-close', origin: RUNTIME });
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
