import { beforeEach, expect, it, vi } from 'vitest';

/* The formula loader (Q912): previews wait for MathLive and its static
   stylesheet, editing for MathLive alone; a failed load is not kept. */

vi.mock('mathlive', () => ({ MathfieldElement: class {} }));

class Sheet {
  text = '';
  replaceSync(text: string) {
    this.text = text;
  }
}
const stylesheet = (type: string, status = 200) =>
  new Response('.ML__latex{display:inline-block}', {
    headers: { 'content-type': type },
    status,
  });

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal('CSSStyleSheet', Sheet);
  vi.stubGlobal('document', { adoptedStyleSheets: [] });
});

it('fails on the single-page fallback, which answers a missing file with HTML', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(stylesheet('text/html')));
  const { loadMathLive, loadedMathLive } = await import('./mathLive');
  await expect(loadMathLive()).rejects.toThrow('text/html');
  expect(loadedMathLive()).toBeUndefined();
});

it('tries again on the next call after a failed load', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(stylesheet('text/css', 503))
    .mockResolvedValueOnce(stylesheet('text/css; charset=utf-8'));
  vi.stubGlobal('fetch', fetch);
  const { loadMathLive, loadedMathLive } = await import('./mathLive');
  await expect(loadMathLive()).rejects.toThrow('503');
  const loaded = await loadMathLive();
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(loadedMathLive()).toBe(loaded);
  expect(document.adoptedStyleSheets).toEqual([loaded.sheet]);
});

it('loads MathLive for editing without the stylesheet', async () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  const { loadMathLiveModule } = await import('./mathLive');
  await expect(loadMathLiveModule()).resolves.toHaveProperty(
    'MathfieldElement'
  );
  expect(fetch).not.toHaveBeenCalled();
});
