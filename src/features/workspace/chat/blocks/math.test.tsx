import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadKatex, prepareMath } from './math';
import { Prose } from './text';

describe('prepareMath', () => {
  it.each([
    ['It costs $5 and $10.', 'It costs \\$5 and \\$10.'],
    ['From $5-$10 a month', 'From \\$5-\\$10 a month'],
    ['US$3.50 per $x$ unit', 'US\\$3.50 per $x$ unit'],
    ['$x^2$ and $2x + 1$', '$x^2$ and $2x + 1$'],
    ['Streaming $x^2 +', 'Streaming \\$x^2 +'],
    ['$a\n\nb$', '\\$a\n\nb\\$'],
    ['`$HOME` costs $5', '`$HOME` costs \\$5'],
    ['$$\\$5 = x$$ and \\$3', '$$\\$5 = x$$ and \\$3'],
    ['Then\n$$x^2$$\nso', 'Then\n$$\nx^2\n$$\nso'],
  ])('%j', (source, expected) => {
    expect(prepareMath(source)).toBe(expected);
  });
});

describe('Prose math', () => {
  beforeAll(loadKatex);

  it('renders inline and display math with KaTeX and keeps prices as text', () => {
    const html = renderToStaticMarkup(
      <Prose
        text={
          'Energy is $E = mc^2$; a ticket costs $5 or $10.\n\n$$\\frac{a}{b}$$'
        }
      />
    );
    expect(html.match(/class="katex"/g)).toHaveLength(2);
    expect(html).toContain('katex-display');
    expect(html).toContain('a ticket costs $5 or $10.');
  });

  it('shows the source of a half-streamed formula', () => {
    const html = renderToStaticMarkup(<Prose text={'$$\\frac{a}{'} />);
    expect(html).not.toContain('class="katex"');
    expect(html).toContain('\\frac{a}{');
  });
});

const IMAGE_LOAD = /<img|<source|rel="preload"/;
const CHART_LINK =
  /<a [^>]*href="https:\/\/example.test\/a.png"[^>]*>chart<\/a>/;
const RAW_LINK = /<a [^>]*href="https:\/\/example.test\/b.png"[^>]*>raw<\/a>/;
const LINKED_IMAGE =
  /<a [^>]*href="https:\/\/example.test\/d"[^>]*>linked<\/a>/;

// Security regression: an answer draws images only as links.
it('draws an image in an answer as a link to it', () => {
  const html = renderToStaticMarkup(
    <Prose
      text={[
        '![chart](https://example.test/a.png)',
        '<img src="https://example.test/b.png" alt="raw">',
        '<picture><source srcset="https://example.test/c.png"></picture>',
        '[![linked](https://example.test/d.png)](https://example.test/d)',
      ].join('\n\n')}
    />
  );
  expect(html).not.toMatch(IMAGE_LOAD);
  expect(html).not.toContain('c.png');
  expect(html).toMatch(CHART_LINK);
  expect(html).toMatch(RAW_LINK);
  // A linked image is its link's text, not a link inside a link.
  expect(html).toMatch(LINKED_IMAGE);
  expect(html).not.toContain('d.png');
});
