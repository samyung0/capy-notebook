import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { handleSiteRequest } from './handler';

const template = readFileSync(
  new URL('../../summary.html', import.meta.url),
  'utf8'
);
const summary = {
  author: 'Mia',
  chapters: [{ files: ['Cells.pdf'], name: 'Cells' }],
  color: 'purple',
  description: 'Lecture files',
  files: ['Reading.pdf'],
  name: 'Biology',
  privacy: 'public',
  tags: ['Term 1'],
};
const env = {
  API_ORIGIN: 'https://api.example.test',
  APP_ORIGIN: 'https://app.example.test',
  ASSETS: { fetch: vi.fn(async () => new Response(template)) },
};
const request = (path = '/w/ws_0123456789', init?: RequestInit) =>
  new Request(`https://app.example.test${path}`, init);
const PRIVATE_CONTENT = /PRIVATE BODY|u_secret|capy-summary-body/;

const upstream = (data: unknown = summary) =>
  vi.fn<typeof fetch>().mockResolvedValue(Response.json(data));

describe('public workspace SSR', () => {
  it('renders the selected single-column outline, trusted canonical and built entry without exposing other backend fields', async () => {
    const fetcher = upstream({
      ...summary,
      material: 'PRIVATE BODY',
      ownerId: 'u_secret',
    });
    const response = await handleSiteRequest(request(), env, fetcher);
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(html).toContain('<h1>Biology</h1>');
    expect(html).toContain('Cells.pdf');
    expect(html).toContain('Reading.pdf');
    expect(html).toContain('https://app.example.test/w/ws_0123456789');
    expect(html).toContain('href="/workspaces/ws_0123456789"');
    expect(html).not.toMatch(PRIVATE_CONTENT);
    const sent = fetcher.mock.calls[0][0] as Request;
    expect(sent.url).toBe(
      'https://api.example.test/api/public/workspaces/ws_0123456789/summary'
    );
    expect(sent.redirect).toBe('manual');
    expect(sent.headers.has('Authorization')).toBe(false);
  });
  it('escapes text, attributes and JSON-LD without executing source HTML', async () => {
    const attack = '</script><script>alert("x")</script>';
    const response = await handleSiteRequest(
      request(),
      env,
      upstream({
        ...summary,
        author: attack,
        description: attack,
        files: [attack],
        name: attack + '$&',
        tags: [attack],
      })
    );
    const html = await response.text();
    expect(html).not.toContain(attack);
    expect(html).toContain('&lt;/script&gt;');
    expect(html).toContain('\\u003c/script\\u003e');
    expect(html).toContain('$&');
  });
  it('accepts Unicode rune lengths and file counts valid under the Go contract', async () => {
    const description = '🦫'.repeat(1000);
    const files = Array.from(
      { length: 150 },
      (_, index) => `Lecture ${index}.pdf`
    );
    const response = await handleSiteRequest(
      request(),
      env,
      upstream({ ...summary, description, files })
    );
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain(description);
    expect(html).toContain('Lecture 149.pdf');
  });
  it('noindexes links and reads visibility again on the next request', async () => {
    const fetcher = upstream({ ...summary, privacy: 'link' });
    const response = await handleSiteRequest(request(), env, fetcher);
    expect(response.headers.get('X-Robots-Tag')).toBe('noindex, nofollow');
    expect(await response.text()).toContain('Shared by link');
    fetcher.mockResolvedValue(new Response(null, { status: 404 }));
    const revoked = await handleSiteRequest(request(), env, fetcher);
    expect(revoked.status).toBe(404);
    expect(revoked.headers.get('Cache-Control')).toBe('no-store');
    expect(await revoked.text()).not.toContain('Biology');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('renders identical non-disclosing 404 pages for upstream 401, 403 and 404', async () => {
    const bodies: string[] = [];
    for (const status of [401, 403, 404]) {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response('PRIVATE BODY', { status }));
      const response = await handleSiteRequest(request(), env, fetcher);
      expect(response.status).toBe(404);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(response.headers.get('X-Robots-Tag')).toBe('noindex, nofollow');
      const html = await response.text();
      expect(html).toContain('This workspace is private or unavailable.');
      expect(html).not.toMatch(PRIVATE_CONTENT);
      bodies.push(html);
    }
    expect(new Set(bodies).size).toBe(1);
  });
  it('rejects invalid IDs, private data, redirects, oversized bodies and malformed JSON', async () => {
    expect(
      (await handleSiteRequest(request('/w/not-a-workspace'), env, upstream()))
        .status
    ).toBe(404);
    for (const response of [
      Response.redirect('https://elsewhere.test', 302),
      new Response('x'.repeat(512 * 1024 + 1)),
      new Response('no JSON'),
      Response.json({ ...summary, privacy: 'private' }),
    ]) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);
      const result = await handleSiteRequest(request(), env, fetcher);
      expect(result.status).toBe(503);
      expect(result.headers.get('Cache-Control')).toBe('no-store');
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });
  it('supports HEAD, Chinese text, and the old share URL without a SPA fetch', async () => {
    const head = await handleSiteRequest(
      request(undefined, { method: 'HEAD' }),
      env,
      upstream()
    );
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
    const chinese = await handleSiteRequest(
      request('/w/ws_0123456789?lang=zh'),
      env,
      upstream()
    );
    expect(await chinese.text()).toContain('打开工作区');
    const redirect = await handleSiteRequest(
      request('/share/workspaces/ws_0123456789?redirect=https://evil.test'),
      env,
      upstream()
    );
    expect(redirect.status).toBe(301);
    expect(redirect.headers.get('Location')).toBe('/w/ws_0123456789');
  });
});

describe('site routing and isolation', () => {
  it('streams authenticated API requests and responses without following file redirects', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('data: ready\n\n', {
        headers: { 'Content-Type': 'text/event-stream' },
      })
    );
    const result = await handleSiteRequest(
      request('/api/workspaces/ws_1/chat/stream', {
        body: 'question',
        headers: { Authorization: 'Bearer token', Cookie: 'session=value' },
        method: 'POST',
      }),
      env,
      fetcher
    );
    const sent = fetcher.mock.calls[0][0] as Request;
    expect(sent.url).toBe(
      'https://api.example.test/api/workspaces/ws_1/chat/stream'
    );
    expect(sent.headers.get('Authorization')).toBe('Bearer token');
    expect(sent.headers.get('Cookie')).toBe('session=value');
    expect(await sent.text()).toBe('question');
    expect(await result.text()).toBe('data: ready\n\n');
    fetcher.mockResolvedValue(
      Response.redirect('https://files.example.test/signed', 302)
    );
    const redirected = await handleSiteRequest(
      request('/api/files/f_1/raw'),
      env,
      fetcher
    );
    expect(redirected.headers.get('Location')).toBe(
      'https://files.example.test/signed'
    );
    expect((fetcher.mock.calls[1][0] as Request).redirect).toBe('manual');
  });
  it('rejects API requests on another origin and invalid configured origins', async () => {
    const fetcher = upstream();
    expect(
      (
        await handleSiteRequest(
          new Request('https://office.example.test/api/me'),
          env,
          fetcher
        )
      ).status
    ).toBe(403);
    expect(
      (
        await handleSiteRequest(
          request(),
          { ...env, API_ORIGIN: 'https://api.example.test/other' },
          fetcher
        )
      ).status
    ).toBe(503);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('applies runtime isolation when the Worker handles asset responses', async () => {
    const response = await handleSiteRequest(
      request('/llm-runtime.html'),
      env,
      upstream()
    );
    expect(response.headers.get('Cross-Origin-Opener-Policy')).toBe(
      'same-origin'
    );
    expect(response.headers.get('Cross-Origin-Embedder-Policy')).toBe(
      'credentialless'
    );
    expect(response.headers.get('Document-Isolation-Policy')).toBe(
      'isolate-and-credentialless'
    );
    expect(response.headers.get('Content-Security-Policy')).toBe(
      "frame-ancestors 'self' https://app.example.test"
    );
  });
});
