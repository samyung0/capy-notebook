import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** The module as a page running `release` has it. */
async function page(release = 'r1') {
  vi.resetModules();
  vi.stubEnv('VITE_RELEASE_SHA', release);
  return import('./appRelease');
}

const served = (release: string) =>
  new Headers({ 'X-Capy-App-Release': release });

let session: Map<string, string>;
let location: { assign: ReturnType<typeof vi.fn>; reload: () => void };
beforeEach(() => {
  session = new Map();
  vi.stubGlobal('sessionStorage', {
    getItem: (key: string) => session.get(key) ?? null,
    setItem: (key: string, value: string) => session.set(key, value),
  });
  location = { assign: vi.fn(), reload: vi.fn() };
  vi.stubGlobal('window', { location });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('the release nudge', () => {
  it('loads the page at the next path change once another release is served, once per release', async () => {
    const { loadUpdateOnPathChange, noteServedRelease } = await page();
    let navigate!: (event: {
      pathChanged: boolean;
      toLocation: { href: string };
    }) => void;
    loadUpdateOnPathChange({
      subscribe: (_event, listener) => {
        navigate = listener;
        return () => undefined;
      },
    });
    // The same release, or none (local dev, MSW): nothing happens.
    noteServedRelease(served('r1'));
    noteServedRelease(new Headers());
    navigate({ pathChanged: true, toLocation: { href: '/a' } });
    expect(location.assign).not.toHaveBeenCalled();

    noteServedRelease(served('r2'));
    // A search change (`?file=`) stays in the page.
    navigate({ pathChanged: false, toLocation: { href: '/a?file=f' } });
    expect(location.assign).not.toHaveBeenCalled();
    navigate({ pathChanged: true, toLocation: { href: '/b?x=1' } });
    expect(location.assign).toHaveBeenCalledWith('/b?x=1');

    // A stale edge served r1 again: this tab does not load for r2 twice.
    const again = await page();
    again.noteServedRelease(served('r2'));
    expect(again.takeUpdateLoad()).toBe(false);
    // A later release loads again.
    again.noteServedRelease(served('r3'));
    expect(again.takeUpdateLoad()).toBe(true);
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
  const index = (release: string) =>
    vi.fn(
      async () =>
        new Response(
          `<html><head><meta content="${release}" name="capy-release"></head></html>`
        )
    );

  it('waits while the site still serves this release, then reloads', async () => {
    const { reloadIntoNewRelease } = await page();
    const fetch = index('r1');
    vi.stubGlobal('fetch', fetch);
    expect(await reloadIntoNewRelease()).toBe(false);
    expect(location.reload).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledWith('/', { cache: 'no-store' });

    vi.stubGlobal('fetch', index('r2'));
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
