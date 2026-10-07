import { describe, expect, it, vi } from 'vitest';
import {
  DEV_SHARE_LINK_SECRET,
  sharePath,
  shareToken,
} from '../../src/lib/shareLink';
import { handleSiteRequest } from './handler';

const SHARE_TEMPLATE =
  '<html lang="en"><head><link rel="stylesheet" crossorigin href="/assets/app-1.css"><!--capy-share-head--></head><body><!--capy-share-body--></body></html>';
const env = {
  API_ORIGIN: 'https://api.example.test',
  APP_ORIGIN: 'https://app.example.test',
  ASSETS: {
    fetch: vi.fn(async (asset: Request) =>
      new URL(asset.url).pathname === '/assets/app-1.css'
        ? new Response('body{color:red}')
        : new Response(SHARE_TEMPLATE)
    ),
  },
  SHARE_LINK_SECRET: DEV_SHARE_LINK_SECRET,
};
const quiz = {
  author: { name: 'Mia' },
  id: 'mat_0123456789',
  name: 'Cell quiz',
  privacy: 'link',
  questions: [],
  updatedAt: '2026-10-04T10:00:00Z',
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
  it('stops forged, unsigned and data paths before the API', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const path of [
      `/p/quizzes/${TOKEN.slice(0, -1)}x/assets/asset_1`,
      '/p/quizzes/mat_0123456789/assets/asset_1',
      // Pages render in the Worker now; there is no JSON read.
      `/p/quizzes/${TOKEN}`,
      `/p/notes/${TOKEN}`,
    ]) {
      const response = await handleSiteRequest(request(path), env, fetcher);
      expect(response.status).toBe(404);
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('renders a shared page once and serves repeats from the edge', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json(quiz));
    const cache = cacheStub();
    const first = await handleSiteRequest(
      request(`/share/quizzes/${TOKEN}`),
      env,
      fetcher,
      cache
    );
    expect(first.status).toBe(200);
    expect(first.headers.get('Cache-Control')).toBe(
      'public, s-maxage=300, max-age=0, must-revalidate'
    );
    expect(first.headers.get('X-Robots-Tag')).toBe('noindex, nofollow');
    const html = await first.text();
    expect(html).toContain('<title>Cell quiz | Capy Notebook</title>');
    expect(html).toContain('Updated Oct 4, 2026');
    // The stylesheet travels in the page, so first paint waits for nothing.
    expect(html).toContain('<style>body{color:red}</style>');
    expect(html).not.toContain('<link rel="stylesheet"');
    // The data the browser hydrates from, so it fetches nothing.
    expect(html).toContain('<script type="application/json" id="share-state">');
    await handleSiteRequest(
      request(`/share/quizzes/${TOKEN}`),
      env,
      fetcher,
      cache
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect((fetcher.mock.calls[0][0] as Request).url).toBe(
      `https://api.example.test/api/public/quizzes/${TOKEN}`
    );
    expect(cache.put.mock.calls[0][0].url).toBe(
      'https://app.example.test/share/quizzes/mat_0123456789'
    );
  });

  it('answers a private or missing item with the not-found page', async () => {
    const fetcher = vi.fn<typeof fetch>(
      async () => new Response('PRIVATE', { status: 404 })
    );
    const response = await handleSiteRequest(
      request(`/share/notes/${TOKEN}`),
      env,
      fetcher
    );
    expect(response.status).toBe(404);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.text()).not.toContain('PRIVATE');
  });

  it('keeps browsers revalidating when the edge returns a cached copy', async () => {
    // Cloudflare stamps the zone's Browser Cache TTL onto Cache API hits.
    const cache = {
      match: vi.fn(
        async () =>
          new Response('{}', {
            headers: {
              'Cache-Control': 'public, max-age=14400, s-maxage=300',
            },
          })
      ),
      put: vi.fn(),
    };
    const summary = await sharePath(DEV_SHARE_LINK_SECRET, 'ws_0123456789');
    for (const path of [
      `/share/quizzes/${TOKEN}`,
      `/p/quizzes/${TOKEN}/assets/asset_1`,
      summary,
    ]) {
      const response = await handleSiteRequest(
        request(path),
        env,
        vi.fn<typeof fetch>(),
        cache
      );
      expect(response.headers.get('Cache-Control')).toBe(
        'public, s-maxage=300, max-age=0, must-revalidate'
      );
    }
  });

  it.each(['quizzes', 'flashcards'])(
    'serves %s images as raster bytes only',
    async (kind) => {
      const assetPath = `/p/${kind}/${TOKEN}/assets/asset_abc`;
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
      expect(
        (await handleSiteRequest(request(assetPath), env, svg)).status
      ).toBe(503);
      expect(svg).toHaveBeenCalledTimes(1);
    }
  );
});
