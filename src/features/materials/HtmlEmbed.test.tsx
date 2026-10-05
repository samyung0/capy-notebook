import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { EmbedFrame, frameResizeHeight } from './HtmlEmbed';

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
    expect(height(own, { height: 1e9, type: 'resize' })).toBe(2000);
    expect(height(own, { height: -5, type: 'resize' })).toBe(32);
  });
});
