import { convertLatexToMarkup } from 'mathlive/ssr';
import { expect, it } from 'vitest';
import { markupIsInert } from './mathTripwire';

// Security regression: the share tripwire rejects markup that carries an event
// handler or a paint/background fetch, decoding character references first, and
// passes ordinary math markup.
it.each([
  '<svg onload="x()"></svg>',
  '<svg ONLOAD="x()"></svg>',
  '<span style="background:url(https://h.test/a)">x</span>',
  '<span style="background:URL(https://h.test/a)">x</span>',
  '<span style="background:image-set(&quot;https://h.test/a&quot; 1x)">x</span>',
  '<span style="background:url&#40;https://h.test/a)">x</span>',
  '<span style="background:ur&#x6c;(https://h.test/a)">x</span>',
])('rejects %s', (markup) => {
  expect(markupIsInert(markup)).toBe(false);
});

it('passes ordinary math markup', () => {
  for (const tex of [
    String.raw`\frac{a}{b} + \textcolor{red}{x^2}`,
    String.raw`\ce{2H2 + O2 -> 2H2O}`,
    String.raw`\enclose{circle}{x} + \colorbox{yellow}{z}`,
  ])
    expect(markupIsInert(convertLatexToMarkup(tex))).toBe(true);
});
