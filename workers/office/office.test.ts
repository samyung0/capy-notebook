import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliDecompressSync } from 'node:zlib';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import worker from './index';

const origin = 'https://uat-office.capynotebook.com';
const parent = 'https://uat.capynotebook.com';
const env = () => ({
  ASSETS: {
    fetch: vi.fn(
      async (_request: Request) =>
        new Response('asset', {
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Content-Security-Policy': 'frame-ancestors *',
            'Content-Type': 'text/javascript',
            Location: 'https://elsewhere.example',
            'Set-Cookie': 'session=secret',
            'X-Frame-Options': 'SAMEORIGIN',
          },
        })
    ),
  },
  PARENT_ORIGINS: parent,
});

describe('isolated Office runtime', () => {
  it('serves only runtime/assets with exact parent CSP and strips credentials and inherited policies', async () => {
    for (const path of [
      '/office-runtime.html?parentOrigin=https://evil.example',
      '/assets/runtime.js',
    ]) {
      const bindings = env();
      const response = await worker.fetch(
        new Request(origin + path, {
          headers: {
            Authorization: 'Bearer secret',
            Cookie: 'secret',
            'If-None-Match': 'version',
          },
        }),
        bindings
      );
      expect(response.status).toBe(200);
      expect(response.headers.get('content-security-policy')).toContain(
        `frame-ancestors ${parent};`
      );
      for (const key of [
        'set-cookie',
        'access-control-allow-origin',
        'x-frame-options',
        'location',
      ])
        expect(response.headers.has(key)).toBe(false);
      const forwarded = bindings.ASSETS.fetch.mock.calls[0][0];
      expect([...forwarded.headers.keys()]).toEqual(['if-none-match']);
      expect(new URL(forwarded.url).search).toBe('');
    }
  });
  it('gives the frame document an agent cluster of its own origin', async () => {
    const cluster = async (path: string) =>
      (await worker.fetch(new Request(origin + path), env())).headers.get(
        'origin-agent-cluster'
      );
    expect(await cluster('/office-runtime.html')).toBe('?1');
    expect(await cluster('/assets/runtime.js')).toBeNull();
  });
  it('allows explicit hybrid parents and embedded DOCX blob fonts', async () => {
    const hybrid = 'https://dev-sam.uat.capynotebook.com';
    const bindings = { ...env(), PARENT_ORIGINS: `${parent}, ${hybrid}` };
    const response = await worker.fetch(
      new Request(origin + '/office-runtime.html'),
      bindings
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-security-policy')).toContain(
      `frame-ancestors ${parent} ${hybrid};`
    );
    expect(response.headers.get('content-security-policy')).toContain(
      "font-src 'self' data: blob:;"
    );
    for (const invalid of [
      '',
      'https://*.capynotebook.com',
      'http://dev-sam.uat.capynotebook.com',
      origin,
      parent,
    ]) {
      const rejected = await worker.fetch(
        new Request(origin + '/office-runtime.html'),
        { ...bindings, PARENT_ORIGINS: `${parent},${invalid}` }
      );
      expect(rejected.status).toBe(503);
    }
    expect(bindings.ASSETS.fetch).toHaveBeenCalledTimes(1);
  });
  it('denies application/API paths, unsafe methods, insecure or invalid/same parent origins', async () => {
    const bindings = env();
    for (const path of [
      '/',
      '/index.html',
      '/summary.html',
      '/api/files',
      '/office-runtime',
      '/assets/../index.html',
      '/assets/%2e%2e/index.html',
      '/assets/%2findex.html',
    ]) {
      expect(
        (await worker.fetch(new Request(origin + path), bindings)).status
      ).toBe(404);
    }
    expect(
      (
        await worker.fetch(
          new Request(origin + '/assets/a.js', { method: 'POST' }),
          bindings
        )
      ).status
    ).toBe(405);
    expect(
      (
        await worker.fetch(
          new Request('http://uat-office.capynotebook.com/office-runtime.html'),
          bindings
        )
      ).status
    ).toBe(400);
    for (const invalid of [
      '',
      'http://uat.capynotebook.com',
      parent + '/',
      parent + '/path',
      'https://user:pass@uat.capynotebook.com',
      origin,
    ]) {
      expect(
        (
          await worker.fetch(new Request(origin + '/office-runtime.html'), {
            ...bindings,
            PARENT_ORIGINS: invalid,
          })
        ).status
      ).toBe(503);
    }
    expect(bindings.ASSETS.fetch).not.toHaveBeenCalled();
  });
  it('does not forward asset redirects or missing-page bodies', async () => {
    const bindings = env();
    bindings.ASSETS.fetch.mockResolvedValue(
      new Response('SPA fallback', {
        headers: { 'Content-Length': '12', Location: '/index.html' },
        status: 302,
      })
    );
    const response = await worker.fetch(
      new Request(origin + '/assets/missing.js'),
      bindings
    );
    expect(response.status).toBe(404);
    expect(await response.text()).toBe('');
    expect(response.headers.has('location')).toBe(false);
    expect(response.headers.has('content-length')).toBe(false);
  });
  it('serves WASM and uncompressed fonts from their brotli files, whole and cached for a year', async () => {
    // Node ignores `encodeBody`; record the init so a Response built without
    // 'manual' (which the Workers runtime would brotli-compress a second
    // time) fails here.
    class InitRecordingResponse extends Response {
      readonly init?: ResponseInit & { encodeBody?: string };
      constructor(body?: BodyInit | null, init?: ResponseInit) {
        super(body, init);
        this.init = init;
      }
    }
    vi.stubGlobal('Response', InitRecordingResponse);
    onTestFinished(() => {
      vi.unstubAllGlobals();
    });
    // A conditional, ranged or HEAD request still gets the whole file from a
    // GET, so a cache filling from it never stores a 304 or an empty body.
    for (const [name, type, method] of [
      ['docx_bg-1.wasm', 'application/wasm', 'GET'],
      ['Carlito-Regular-1.ttf', 'font/ttf', 'GET'],
      ['NotoSansJP-Regular-1.otf', 'font/otf', 'GET'],
      ['docx_bg-1.wasm', 'application/wasm', 'HEAD'],
    ]) {
      const bindings = env();
      bindings.ASSETS.fetch.mockResolvedValue(
        new Response('brotli', {
          headers: {
            'Accept-Ranges': 'bytes',
            'Content-Length': '6',
            'Content-Type': 'application/octet-stream',
            ETag: 'W/"br"',
          },
        })
      );
      const response = await worker.fetch(
        new Request(`${origin}/assets/${name}?v=1`, {
          headers: {
            'If-Modified-Since': 'Sat, 17 Oct 2026 00:00:00 GMT',
            'If-None-Match': 'W/"br"',
            Range: 'bytes=0-1',
          },
          method,
        }),
        bindings
      );
      expect(response.status).toBe(200);
      expect((response as InitRecordingResponse).init?.encodeBody).toBe(
        'manual'
      );
      expect(await response.text()).toBe('brotli');
      expect(Object.fromEntries(response.headers)).toMatchObject({
        'cache-control': 'public, max-age=31536000, immutable',
        'content-encoding': 'br',
        'content-length': '6',
        'content-type': type,
        etag: 'W/"br"',
        'x-content-type-options': 'nosniff',
      });
      expect(response.headers.has('accept-ranges')).toBe(false);
      const forwarded = bindings.ASSETS.fetch.mock.calls[0][0];
      expect(new URL(forwarded.url).pathname).toBe(`/assets/${name}.br`);
      expect(new URL(forwarded.url).search).toBe('');
      expect(forwarded.method).toBe('GET');
      expect([...forwarded.headers.keys()]).toEqual([]);
    }
    // A missing brotli file is an uncached 404, never labelled br.
    const bindings = env();
    bindings.ASSETS.fetch.mockResolvedValue(
      new Response(null, { status: 404 })
    );
    const missing = await worker.fetch(
      new Request(`${origin}/assets/gone.wasm`),
      bindings
    );
    expect(missing.status).toBe(404);
    expect(missing.headers.get('cache-control')).toBe('no-store');
    expect(missing.headers.has('content-encoding')).toBe(false);
  });
  it('serves bundles directly with dedicated security/cache headers and stages only the allowed build entries', () => {
    const config = JSON.parse(readFileSync('wrangler.office.jsonc', 'utf8'));
    for (const target of [config, config.env.uat, config.env.production]) {
      expect(target.assets.run_worker_first).toEqual([
        '/office-runtime.html',
        '/assets/*.wasm',
        '/assets/*.ttf',
        '/assets/*.otf',
      ]);
      expect(target.assets.not_found_handling).toBe('none');
      expect(target.assets.html_handling).toBe('none');
    }
    // Workers Cache serves the immutable brotli files without running the
    // Worker, in every environment (inherited, never overridden).
    expect(config.cache).toEqual({ enabled: true });
    expect(config.env.uat.cache).toBeUndefined();
    expect(config.env.production.cache).toBeUndefined();
    const temp = mkdtempSync(join(tmpdir(), 'capy-office-test-'));
    try {
      const source = join(temp, 'dist');
      const target = join(temp, 'output');
      mkdirSync(source);
      mkdirSync(join(source, 'assets'));
      for (const name of [
        'office-runtime.html',
        'index.html',
        '_headers',
        '_redirects',
      ])
        writeFileSync(join(source, name), name);
      writeFileSync(join(source, 'assets/runtime.js'), 'runtime');
      for (const name of ['a.wasm', 'b.ttf', 'c.otf', 'd.woff2'])
        writeFileSync(join(source, 'assets', name), name.repeat(100));
      execFileSync(process.execPath, [
        'workers/office/stage.mjs',
        source,
        target,
      ]);
      expect(readdirSync(target).sort()).toEqual([
        '_headers',
        'assets',
        'office-runtime.html',
      ]);
      // WASM and uncompressed fonts are stored only as brotli; woff2 is
      // already brotli inside and stays a static file.
      expect(readdirSync(join(target, 'assets')).sort()).toEqual([
        'a.wasm.br',
        'b.ttf.br',
        'c.otf.br',
        'd.woff2',
        'runtime.js',
      ]);
      for (const name of ['a.wasm', 'b.ttf', 'c.otf'])
        expect(
          brotliDecompressSync(
            readFileSync(join(target, 'assets', `${name}.br`))
          ).toString()
        ).toBe(name.repeat(100));
      const headers = readFileSync(join(target, '_headers'), 'utf8');
      expect(headers).toContain('/assets/*');
      expect(headers).toContain('public, max-age=31536000, immutable');
      expect(headers).toContain("frame-ancestors 'none'");
      expect(headers).toContain("worker-src 'self' blob:");
      expect(headers).toContain('Referrer-Policy: no-referrer');
      expect(headers).toContain('X-Content-Type-Options: nosniff');
      expect(headers).toContain('X-Robots-Tag: noindex, nofollow');
      expect(readFileSync(join(target, 'assets/runtime.js'), 'utf8')).toBe(
        'runtime'
      );
    } finally {
      rmSync(temp, { recursive: true });
    }
  });
});
