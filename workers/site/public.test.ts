import { describe, expect, it, vi } from 'vitest';
import { DEV_SHARE_LINK_SECRET, shareToken } from '../../src/lib/shareLink';
import { handleSiteRequest } from './handler';

const env = {
  API_ORIGIN: 'https://api.example.test',
  APP_ORIGIN: 'https://app.example.test',
  ASSETS: { fetch: vi.fn(async () => new Response('')) },
  SHARE_LINK_SECRET: DEV_SHARE_LINK_SECRET,
};
const TOKEN = await shareToken(DEV_SHARE_LINK_SECRET, 'mat_0123456789');
const request = (path: string, init?: RequestInit) =>
  new Request(`https://app.example.test${path}`, init);
const cacheStub = () => {
  const store = new Map<string, Response>();
  return {
    match: vi.fn(async (key: Request) => store.get(key.url)?.clone()),
    put: vi.fn(async (key: Request, response: Response) => {
      store.set(key.url, response);
    }),
  };
};

describe('anonymous material routes', () => {
  it('stops forged and unsigned tokens before the API', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const path of [
      `/p/quizzes/${TOKEN.slice(0, -1)}x`,
      '/p/quizzes/mat_0123456789',
      `/p/flashcards/${TOKEN}/grade`,
    ]) {
      const response = await handleSiteRequest(request(path), env, fetcher);
      expect(response.status).toBe(404);
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('caches a quiz at the edge and serves repeats without the API', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ id: 'mat_0123456789', questions: [] })
      );
    const cache = cacheStub();
    const first = await handleSiteRequest(
      request(`/p/quizzes/${TOKEN}`),
      env,
      fetcher,
      cache
    );
    const second = await handleSiteRequest(
      request(`/p/quizzes/${TOKEN}`),
      env,
      fetcher,
      cache
    );
    expect(first.headers.get('Cache-Control')).toBe(
      'public, s-maxage=300, max-age=0, must-revalidate'
    );
    expect(await second.json()).toEqual({
      id: 'mat_0123456789',
      questions: [],
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(
      String(
        fetcher.mock.calls[0][0] instanceof Request
          ? fetcher.mock.calls[0][0].url
          : ''
      )
    ).toBe(`https://api.example.test/api/public/quizzes/${TOKEN}`);
  });

  it('serves quiz images as raster bytes only', async () => {
    const assetPath = `/p/quizzes/${TOKEN}/assets/asset_abc`;
    const png = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          contentType: 'image/png',
          url: 'https://b2.example.test/x',
        })
      )
      .mockResolvedValueOnce(new Response(new Uint8Array([137, 80, 78, 71])));
    const ok = await handleSiteRequest(request(assetPath), env, png);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('Content-Type')).toBe('image/png');
    const svg = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        contentType: 'image/svg+xml',
        url: 'https://b2.example.test/x',
      })
    );
    expect((await handleSiteRequest(request(assetPath), env, svg)).status).toBe(
      503
    );
    expect(svg).toHaveBeenCalledTimes(1);
  });

  it('forwards grading posts uncached and bounds their size', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ parts: {} }, { status: 200 }));
    const body = JSON.stringify({ parts: [] });
    const graded = await handleSiteRequest(
      request(`/p/quizzes/${TOKEN}/grade`, { body, method: 'POST' }),
      env,
      fetcher
    );
    expect(graded.status).toBe(200);
    expect(graded.headers.get('Cache-Control')).toBe('no-store');
    const sent = fetcher.mock.calls[0][0] as Request;
    expect(sent.method).toBe('POST');
    expect(await sent.text()).toBe(body);
    const tooLarge = await handleSiteRequest(
      request(`/p/quizzes/${TOKEN}/grade`, {
        body: 'x'.repeat(512 * 1024 + 1),
        method: 'POST',
      }),
      env,
      fetcher
    );
    expect(tooLarge.status).toBe(413);
    expect(
      (
        await handleSiteRequest(
          request(`/p/quizzes/${TOKEN}/grade`),
          env,
          fetcher
        )
      ).status
    ).toBe(405);
  });
});
