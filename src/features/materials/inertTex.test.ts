import { convertLatexToMarkup } from 'mathlive/ssr';
import { expect, it } from 'vitest';
import { inertTex } from './inertTex';

/** An HTML command's style, class, id, data attribute or link in the markup. */
const HTML_OUTPUT =
  /style="[^"]*background|class="capy|id="capy|data-capy|href=/;
/** A paint or background fetch, inside an attribute value (text nodes with
 * `url(` draw as harmless literal text). */
const ATTR_FETCH = /[=]"[^"]*(?:url\(|image-set\()/i;
/** A fetch anywhere, used where MathLive drops an invalid value entirely. */
const FETCH = /url\(|image-set\(/i;
/** An element with an `on…=` inline event handler. */
const HANDLER = /<[^>]*\son[a-z]+\s*=/i;

// Security regression: a read-only formula draws MathLive's HTML commands as
// text, so they set no style, class, id, data attribute, link or fetch.
it.each([
  String.raw`\htmlStyle{background:url(https://example.test/a)}{x}`,
  String.raw`\style {background:url(https://example.test/a)}{x}`,
  String.raw`\class{capy}{x}`,
  String.raw`\htmlClass{capy}{x}`,
  String.raw`\cssId{capy}{x}`,
  String.raw`\htmlId{capy}{x}`,
  String.raw`\htmlData{capy=1}{\htmlStyle{background:url(https://example.test/a)}{x}}`,
  String.raw`\href{https://example.test/a}{x}`,
  String.raw`\csname htmlStyle\endcsname{background:url(https://example.test/a)}{x}`,
  String.raw`a \\\htmlStyle{background:url(https://example.test/a)}{x}`,
  String.raw`\text{\htmlStyle{background:url(https://example.test/a)}{x}}`,
])('draws %s as text', (tex) => {
  const raw = convertLatexToMarkup(tex);
  expect(HTML_OUTPUT.test(raw) || ATTR_FETCH.test(raw)).toBe(true);
  const inert = convertLatexToMarkup(inertTex(tex));
  expect(inert).not.toMatch(HTML_OUTPUT);
  expect(inert).not.toMatch(ATTR_FETCH);
});

it('draws \\url as text', () => {
  expect(inertTex(String.raw`\url{https://example.test/a}`)).toBe(
    String.raw`\backslash\mathrm{url}{https://example.test/a}`
  );
});

it('leaves ordinary LaTeX alone, a line break before a word included', () => {
  const tex = String.raw`\displaystyle\frac{a}{b} + \textstyle x \\style \\\\href \mathrm{classify}`;
  expect(inertTex(tex)).toBe(tex);
});

// Security regression (MathLive >= 0.111): the installed MathLive validates the
// CSS and SVG values that `\color`, `\colorbox`, `\bbox`, `\enclose` and
// `\fontfamily` take, so none reaches a paint/background fetch or an event
// handler without `inertTex`. A downgrade reopens that class, so this guards
// the pin.
it.each([
  String.raw`\colorbox{#fff;background:url(https://example.test/a)}{x}`,
  String.raw`\color{#fff;background:url(https://example.test/a)}x`,
  String.raw`\textcolor{#fff;background:url(https://example.test/a)}{x}`,
  String.raw`\fcolorbox{#fff;background:url(https://example.test/a)}{#fff}{x}`,
  String.raw`\bbox[border:0;background:url(https://example.test/a)]{x}`,
  String.raw`\text{\fontfamily{x;background:url(https://example.test/a)}y}`,
  String.raw`\enclose{updiagonalstrike}[mathcolor="url(https://example.test/a)"]{x}`,
  String.raw`\enclose{circle}[2px solid url(https://example.test/a)]{x}`,
  String.raw`\enclose{longdiv}[shadow="x onload=0//"]{x}`,
])('the pinned MathLive renders %s without a fetch or handler', (tex) => {
  const markup = convertLatexToMarkup(tex);
  expect(markup).not.toMatch(FETCH);
  expect(markup).not.toMatch(HANDLER);
});
