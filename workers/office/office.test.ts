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
import { describe, expect, it, vi } from 'vitest';
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
  it('runs all requests through the Worker and stages only the allowed build entries', () => {
    const config = JSON.parse(readFileSync('wrangler.office.jsonc', 'utf8'));
    for (const target of [config, config.env.uat, config.env.production]) {
      expect(target.assets.run_worker_first).toBe(true);
      expect(target.assets.not_found_handling).toBe('none');
      expect(target.assets.html_handling).toBe('none');
    }
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
      execFileSync(process.execPath, [
        'workers/office/stage.mjs',
        source,
        target,
      ]);
      expect(readdirSync(target).sort()).toEqual([
        'assets',
        'office-runtime.html',
      ]);
      expect(readFileSync(join(target, 'assets/runtime.js'), 'utf8')).toBe(
        'runtime'
      );
    } finally {
      rmSync(temp, { recursive: true });
    }
  });
});
