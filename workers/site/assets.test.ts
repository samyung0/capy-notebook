import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import assets from './assets';

type Config = {
  assets: Record<string, unknown>;
  cache?: unknown;
  env: Record<
    string,
    { assets: Record<string, unknown>; routes: { pattern: string }[] }
  >;
};
// The wrangler files comment only on whole lines.
const LINE_COMMENT = /^\s*\/\/.*$/gm;
const jsonc = (path: string): Config =>
  JSON.parse(readFileSync(path, 'utf8').replace(LINE_COMMENT, ''));
const HOST_WIDE = /\/\*$/;
const IMMUTABLE_ASSETS =
  /^\/assets\/\*\n {2}Cache-Control: public, max-age=31536000, immutable$/m;

describe('app /assets/* route', () => {
  it('answers a name no file matches with an uncached 404, never the SPA page', async () => {
    const response = assets.fetch();
    expect(response.status).toBe(404);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.has('content-type')).toBe(false);
    expect(await response.text()).toBe('');
  });

  it('owns /assets/* on every app host, runs only on misses and keeps hits static and immutable', () => {
    const site = jsonc('wrangler.jsonc');
    const own = jsonc('wrangler.assets.jsonc');
    // A Workers Cache block would bill every static hit as a Worker request.
    expect(own.cache).toBeUndefined();
    for (const target of [own, ...Object.values(own.env)]) {
      expect(target.assets).toEqual({
        directory: './dist',
        html_handling: 'none',
        not_found_handling: 'none',
      });
    }
    for (const name of ['uat', 'production']) {
      expect(own.env[name].routes.map((route) => route.pattern)).toEqual(
        site.env[name].routes.map((route) =>
          route.pattern.replace(HOST_WIDE, '/assets/*')
        )
      );
    }
    expect(readFileSync('public/_headers', 'utf8')).toMatch(IMMUTABLE_ASSETS);
  });
});
