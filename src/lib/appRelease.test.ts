import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const R1 = '1'.repeat(40);
const R2 = '2'.repeat(40);
const R3 = '3'.repeat(40);

/** The module as a page running `release` has it (null: a build without
 * one). */
async function page(release: string | null = R1) {
  vi.resetModules();
  vi.stubEnv('VITE_RELEASE_SHA', release ?? undefined);
  return import('./appRelease');
}

/** The site serving `body` as its release file (or `status`). */
const serve = (body: string, status = 200) =>
  vi.fn(async () => new Response(body, { status }));

/** Lets a check's fetch and read settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve));

let session: Map<string, string>;
let location: { reload: ReturnType<typeof vi.fn> };
let listeners: Map<string, () => void>;
let visibilityState: string;
let browser: { onLine: boolean };
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  session = new Map();
  vi.stubGlobal('sessionStorage', {
    getItem: (key: string) => session.get(key) ?? null,
    setItem: (key: string, value: string) => session.set(key, value),
  });
  location = { reload: vi.fn() };
  listeners = new Map();
  const addEventListener = (type: string, listener: () => void) =>
    listeners.set(type, listener);
  visibilityState = 'visible';
  browser = { onLine: true };
  vi.stubGlobal('navigator', browser);
  vi.stubGlobal('window', { addEventListener, location });
  vi.stubGlobal('document', {
    addEventListener,
    get visibilityState() {
      return visibilityState;
    },
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('the release nudge', () => {
  it('reads the release file when the tab regains focus, and loads the page at the next path change, once per release', async () => {
    const { checkReleaseOnFocus, loadUpdateOnPathChange } = await page();
    let navigate!: (event: { pathChanged: boolean }) => void;
    loadUpdateOnPathChange({
      subscribe: (_event, listener) => {
        navigate = listener;
        return () => undefined;
      },
    });
    checkReleaseOnFocus();
    const fetch = serve(`${R2}\n`);
    vi.stubGlobal('fetch', fetch);

    // A hidden tab reads nothing.
    visibilityState = 'hidden';
    listeners.get('visibilitychange')?.();
    await settle();
    expect(fetch).not.toHaveBeenCalled();

    visibilityState = 'visible';
    listeners.get('focus')?.();
    await settle();
    expect(fetch).toHaveBeenCalledWith('/release.txt', { cache: 'no-store' });
    // A search change (`?file=`) stays in the page.
    navigate({ pathChanged: false });
    expect(location.reload).not.toHaveBeenCalled();
    // Offline the page stays (a load would land on the browser's offline
    // page); the first path change back online loads.
    browser.onLine = false;
    navigate({ pathChanged: true });
    expect(location.reload).not.toHaveBeenCalled();
    browser.onLine = true;
    navigate({ pathChanged: true });
    expect(location.reload).toHaveBeenCalledOnce();

    // A stale edge served r1 again: this tab does not load for r2 twice.
    const again = await page();
    vi.stubGlobal('fetch', serve(R2));
    await again.checkServedRelease();
    expect(again.takeUpdateLoad()).toBe(false);
    // A later release loads again.
    vi.setSystemTime(Date.now() + 60_000);
    vi.stubGlobal('fetch', serve(R3));
    await again.checkServedRelease();
    expect(again.takeUpdateLoad()).toBe(true);
  });

  it('reads at most once a minute', async () => {
    const { checkServedRelease, takeUpdateLoad } = await page();
    const fetch = serve(R1);
    vi.stubGlobal('fetch', fetch);
    await checkServedRelease();
    vi.setSystemTime(Date.now() + 59_000);
    vi.stubGlobal('fetch', serve(R2));
    await checkServedRelease();
    expect(fetch).toHaveBeenCalledOnce();
    expect(takeUpdateLoad()).toBe(false);
    vi.setSystemTime(Date.now() + 1000);
    await checkServedRelease();
    expect(takeUpdateLoad()).toBe(true);
  });

  it('does nothing for the same release, a failed read, a file that is not a release, or a build without one', async () => {
    const answers = [
      serve(R1),
      serve(R2, 404),
      // The SPA fallback where no release file is served (local dev, MSW).
      serve('<!doctype html><html></html>'),
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    ];
    for (const fetch of answers) {
      const { checkServedRelease, takeUpdateLoad } = await page();
      vi.stubGlobal('fetch', fetch);
      await checkServedRelease();
      expect(fetch).toHaveBeenCalledOnce();
      expect(takeUpdateLoad()).toBe(false);
    }

    const { checkServedRelease, takeUpdateLoad } = await page(null);
    const fetch = serve(R2);
    vi.stubGlobal('fetch', fetch);
    await checkServedRelease();
    expect(fetch).not.toHaveBeenCalled();
    expect(takeUpdateLoad()).toBe(false);
  });

  it('takes a refused client protocol as an update, without a load loop', async () => {
    const { markUpdateAvailable, takeUpdateLoad } = await page();
    expect(takeUpdateLoad()).toBe(false);
    markUpdateAvailable();
    expect(takeUpdateLoad()).toBe(true);
    expect(takeUpdateLoad()).toBe(false);
  });
});

describe("the outdated strip's Reload", () => {
  it('waits while the site still serves this release, then reloads', async () => {
    const { reloadIntoNewRelease } = await page();
    const fetch = serve(R1);
    vi.stubGlobal('fetch', fetch);
    expect(await reloadIntoNewRelease()).toBe(false);
    expect(location.reload).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledWith('/release.txt', { cache: 'no-store' });

    vi.stubGlobal('fetch', serve(R2));
    expect(await reloadIntoNewRelease()).toBe(true);
    expect(location.reload).toHaveBeenCalledOnce();
  });

  it('does not reload when the check fails', async () => {
    const { reloadIntoNewRelease } = await page();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      })
    );
    expect(await reloadIntoNewRelease()).toBe(false);
    expect(location.reload).not.toHaveBeenCalled();
  });
});
