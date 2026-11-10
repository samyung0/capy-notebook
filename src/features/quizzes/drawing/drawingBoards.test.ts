import { expect, it, vi } from 'vitest';

const get = vi.hoisted(() => vi.fn());
vi.mock('@/api/client', () => ({ api: { get }, isApiError: () => false }));

const { fetchDrawingPicture } = await import('./drawingBoards');

// A stored drawing's picture links last an hour or two, and this page's copy of
// them longer: one that no longer opens is asked for again.
it("reads a stored drawing's picture by its id, asking for its links again once they lapse", async () => {
  const gz = await new Response(
    new Blob(['board']).stream().pipeThrough(new CompressionStream('gzip'))
  ).arrayBuffer();
  let links = 0;
  get.mockImplementation(() => {
    links += 1;
    return Promise.resolve({
      boardUrl: 'https://bucket/board',
      pictures: [{ sourceId: 'hash1', url: `https://bucket/picture-${links}` }],
    });
  });
  const fetched = vi.fn((url: string) =>
    Promise.resolve(
      url === 'https://bucket/board'
        ? new Response(gz)
        : url === 'https://bucket/picture-1'
          ? new Response(null, { status: 403 })
          : new Response(new Blob(['picture']))
    )
  );
  vi.stubGlobal('fetch', fetched);

  const picture = await fetchDrawingPicture('dr_1', 'hash1');
  expect(await picture?.text()).toBe('picture');
  expect(get).toHaveBeenCalledTimes(2);
  expect(await fetchDrawingPicture('dr_1', 'none')).toBeNull();
  vi.unstubAllGlobals();
});
