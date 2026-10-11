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
