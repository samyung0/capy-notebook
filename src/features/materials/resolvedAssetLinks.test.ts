import { beforeEach, expect, it, vi } from 'vitest';

const resolveEditorAsset = vi.hoisted(() => vi.fn());
vi.mock('@/api/editorAssets', () => ({ resolveEditorAsset }));

const { assetLink, forgetAssetLinks, heldAssetLink } = await import(
  './resolvedAssetLinks'
);

const link = (ms: number, url = 'https://bucket/a') => ({
  expiresAt: new Date(Date.now() + ms).toISOString(),
  url,
});
const fresh = () => new AbortController().signal;

beforeEach(() => {
  forgetAssetLinks();
  resolveEditorAsset.mockReset();
});

it('hands out a live link without asking, and asks once it nears its expiry', async () => {
  resolveEditorAsset.mockResolvedValueOnce(link(60_000));
  await assetLink('a', fresh(), false);
  expect(heldAssetLink('a')).toBeDefined();
  await assetLink('a', fresh(), false);
  expect(resolveEditorAsset).toHaveBeenCalledTimes(1);

  forgetAssetLinks();
  resolveEditorAsset.mockResolvedValueOnce(link(5000));
  resolveEditorAsset.mockResolvedValueOnce(link(60_000, 'https://bucket/b'));
  await assetLink('a', fresh(), false);
  expect(heldAssetLink('a')).toBeUndefined();
  expect((await assetLink('a', fresh(), false)).url).toBe('https://bucket/b');
});

it('keeps an expired link when nothing was decided, and drops it on a refusal', async () => {
  resolveEditorAsset.mockResolvedValueOnce(link(5000));
  await assetLink('a', fresh(), false);
  // Offline, a server error, a rate limit: the browser may still have the image.
  for (const failure of [
    new TypeError('Failed to fetch'),
    Object.assign(new Error('down'), { status: 503 }),
    Object.assign(new Error('slow'), { status: 429 }),
  ]) {
    resolveEditorAsset.mockRejectedValueOnce(failure);
    expect((await assetLink('a', fresh(), false)).url).toBe('https://bucket/a');
  }
  resolveEditorAsset.mockRejectedValueOnce(
    Object.assign(new Error('gone'), { status: 403 })
  );
  await expect(assetLink('a', fresh(), false)).rejects.toThrow('gone');
  resolveEditorAsset.mockRejectedValueOnce(new TypeError('Failed to fetch'));
  await expect(assetLink('a', fresh(), false)).rejects.toThrow('Failed');
});

it('asks again after a media error, and an abort gets no old link', async () => {
  resolveEditorAsset.mockResolvedValueOnce(link(60_000));
  await assetLink('a', fresh(), false);
  resolveEditorAsset.mockResolvedValueOnce(link(60_000, 'https://bucket/b'));
  expect((await assetLink('a', fresh(), true)).url).toBe('https://bucket/b');

  forgetAssetLinks();
  resolveEditorAsset.mockResolvedValueOnce(link(5000));
  await assetLink('a', fresh(), false);
  const stop = new AbortController();
  stop.abort();
  resolveEditorAsset.mockRejectedValueOnce(new DOMException('', 'AbortError'));
  await expect(assetLink('a', stop.signal, false)).rejects.toBeDefined();
});

it('another account in the tab, or a refused read, asks for its own', async () => {
  resolveEditorAsset.mockResolvedValue(link(60_000));
  await assetLink('a', fresh(), false);
  forgetAssetLinks();
  expect(heldAssetLink('a')).toBeUndefined();
  await assetLink('a', fresh(), false);
  expect(resolveEditorAsset).toHaveBeenCalledTimes(2);
});
