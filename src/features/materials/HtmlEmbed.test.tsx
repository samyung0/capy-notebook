import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { EmbedFrame, frameResizeHeight } from './HtmlEmbed';

const CSP_LINE = /^\s*Content-Security-Policy:\s*(.+)$/m;
const SPACES = /\s+/;

describe('interactive block frame', () => {
  it('sandboxes the frame to scripts only and keeps the snippet out of the page', () => {
    const markup = renderToStaticMarkup(
      <EmbedFrame
        height={240}
        html="<p>snippet</p>"
        onHeight={() => {}}
        onNavigate={() => {}}
        origin="https://embed.test"
        title="Tangent"
      />
    );
    expect(
      Array.from(markup.matchAll(/sandbox="([^"]*)"/g), (match) => match[1])
    ).toEqual(['allow-scripts']);
    expect(markup).toContain('src="https://embed.test/"');
    expect(markup).not.toContain('snippet');
  });

  // Security regression (interactive block decisions 2026-10-01/05/07: no
  // network from the frame): the wrapper's own headers block every request.
  it('serves its wrapper under a CSP that allows no request', () => {
    const headers = readFileSync(
      new URL('../../../embed/_headers', import.meta.url),
      'utf8'
    );
    const policy = headers.match(CSP_LINE)?.[1];
    const directives = new Map(
      (policy ?? '').split(';').map((directive) => {
        const [name = '', ...sources] = directive.trim().split(SPACES);
        return [name, sources] as const;
      })
    );
    expect(directives.get('default-src')).toEqual(["'none'"]);
    const allowed = new Set(["'none'", "'unsafe-inline'", 'data:', 'blob:']);
    for (const [name, sources] of directives)
      for (const source of sources)
        expect(allowed.has(source), `${name} ${source}`).toBe(true);
  });

  it('accepts only a finite resize posted by its own frame, clamped', () => {
    const own = {} as Window;
    const frame = { contentWindow: own };
    const height = (source: Window | null, data: unknown) =>
      frameResizeHeight({ data, source }, frame);
    expect(height(own, { height: 300.2, type: 'resize' })).toBe(301);
    expect(height({} as Window, { height: 300, type: 'resize' })).toBeNull();
    expect(height(null, { height: 300, type: 'resize' })).toBeNull();
    expect(height(own, { html: '<p>x</p>', type: 'render' })).toBeNull();
    expect(height(own, { height: Number.NaN, type: 'resize' })).toBeNull();
    expect(height(own, { height: '300', type: 'resize' })).toBeNull();
    expect(height(own, null)).toBeNull();
    expect(height(own, { height: 1e9, type: 'resize' })).toBe(600);
    expect(height(own, { height: -5, type: 'resize' })).toBe(32);
  });
});
