/**
 * Cuts a stylesheet down to the rules one rendered page can use, so the
 * Worker inlines a few kilobytes instead of the whole Tailwind build.
 *
 * A style rule is kept when one of its selectors could match: every class
 * that selector names outside a functional pseudo-class (`:not()`, `:is()`,
 * `:where()`, `:has()`) appears in the page's `class` attributes. Rules
 * without a class (elements, `:root`, attributes) always stay, and so does
 * everything that is not a style rule (`@property`, `@font-face`,
 * `@keyframes`, layer statements). Grouping rules (`@layer`, `@media`,
 * `@supports`, `@container`) are filtered inside. Kept rules keep their
 * order and their nested rules, so the cascade for the page's elements is the
 * full stylesheet's. Elements added later in the browser get the full
 * stylesheet, which the page loads before it hydrates (src/lib/fullStyles.ts).
 */

type Block =
  | { kind: 'keep'; text: string }
  | { kind: 'rule'; selectors: string[][]; text: string }
  | { children: Block[]; kind: 'group'; layer: boolean; prelude: string };

/** Classes the theme script in summary.html and share.html may add before
 * first paint, whatever the server rendered. */
const BEFORE_PAINT = ['dark'];
const GROUPS = /^@(layer|media|supports|container)\b/;
const ESCAPE = /\\([0-9a-fA-F]{1,6}\s?|[\s\S])/g;
const HEX = /^[0-9a-fA-F]{1,6}\s?/;
const HEX_START = /^[0-9a-fA-F]/;
const CLASS_END = /[\s.#:[\]>+~,()*&|{}]/;
const SPACE = /\s/;
const SPACES = /\s+/;
const CLASS_ATTRIBUTE = /\sclass="([^"]*)"/g;
const ENTITY = /&(#x[0-9a-f]+|#\d+|\w+);/gi;

/** The index of the first `stops` character outside brackets, strings,
 * escapes and comments, where `{`, `(` and `[` open a nesting level; the
 * closing bracket that ends the level `start` sits in also stops. */
function scan(css: string, start: number, stops: string): number {
  let depth = 0;
  for (let i = start; i < css.length; i++) {
    const char = css[i];
    if (depth === 0 && stops.includes(char)) return i;
    if (char === '\\') i++;
    else if (char === '"' || char === "'") {
      for (i++; i < css.length && css[i] !== char; i++)
        if (css[i] === '\\') i++;
    } else if (char === '/' && css[i + 1] === '*')
      i = css.indexOf('*/', i + 2) + 1 || css.length;
    else if ('{(['.includes(char)) depth++;
    else if ('})]'.includes(char) && --depth < 0) return i;
  }
  return css.length;
}

/** Splits a list at top-level commas. */
function splitList(list: string): string[] {
  const parts: string[] = [];
  for (let start = 0; start <= list.length; ) {
    const end = scan(list, start, ',');
    parts.push(list.slice(start, end));
    start = end + 1;
  }
  return parts;
}

/** CSS identifier escapes: `\:` is `:` and `\32 ` is `2`. */
const unescapeIdentifier = (identifier: string) =>
  identifier.replace(ESCAPE, (_, escaped: string) =>
    HEX_START.test(escaped)
      ? String.fromCodePoint(Number.parseInt(escaped, 16))
      : escaped
  );

/** The classes a complex selector needs, outside functional pseudo-classes
 * and attribute selectors. */
function requiredClasses(selector: string): string[] {
  const classes: string[] = [];
  let depth = 0;
  for (let i = 0; i < selector.length; i++) {
    const char = selector[i];
    if (char === '\\') i++;
    else if (char === '"' || char === "'") {
      for (i++; i < selector.length && selector[i] !== char; i++)
        if (selector[i] === '\\') i++;
    } else if (
      depth === 0 &&
      (selector.startsWith(':is(', i) || selector.startsWith(':where(', i))
    ) {
      // One argument must match, so its classes are needed too (Tailwind
      // wraps `space-y-*` and `**:` utilities this way); with several, any
      // one may match, so none is required.
      const open = selector.indexOf('(', i);
      const close = scan(selector, open + 1, '');
      const args = splitList(selector.slice(open + 1, close));
      if (args.length === 1) classes.push(...requiredClasses(args[0]));
      i = close;
    } else if (char === '(' || char === '[') depth++;
    else if (char === ')' || char === ']') depth--;
    else if (char === '.' && depth === 0) {
      let end = i + 1;
      while (end < selector.length) {
        if (selector[end] === '\\') {
          // A hex escape takes up to six digits and one following space.
          const hex = HEX.exec(selector.slice(end + 1));
          end += 1 + (hex ? hex[0].length : 1);
        } else if (CLASS_END.test(selector[end])) break;
        else end++;
      }
      classes.push(unescapeIdentifier(selector.slice(i + 1, end)));
      i = end - 1;
    }
  }
  return classes;
}

function parse(css: string): Block[] {
  const blocks: Block[] = [];
  let i = 0;
  while (i < css.length) {
    while (i < css.length && SPACE.test(css[i])) i++;
    if (i >= css.length) break;
    if (css.startsWith('/*', i)) {
      i = css.indexOf('*/', i + 2) + 2 || css.length;
      continue;
    }
    const open = scan(css, i, '{;');
    if (open >= css.length || css[open] === ';') {
      // A statement such as `@layer theme, base;` or `@import …;`.
      blocks.push({ kind: 'keep', text: css.slice(i, open + 1) });
      i = open + 1;
      continue;
    }
    // `scan` stops at the `}` that closes the block's own level.
    const close = scan(css, open + 1, '') + 1;
    const prelude = css.slice(i, open).trim();
    const text = css.slice(i, close);
    if (GROUPS.test(prelude))
      blocks.push({
        children: parse(css.slice(open + 1, close - 1)),
        kind: 'group',
        layer: prelude.startsWith('@layer'),
        prelude,
      });
    else if (prelude.startsWith('@')) blocks.push({ kind: 'keep', text });
    else
      blocks.push({
        kind: 'rule',
        selectors: splitList(prelude).map(requiredClasses),
        text,
      });
    i = close;
  }
  return blocks;
}

function emit(blocks: Block[], classes: Set<string>): string {
  let out = '';
  for (const block of blocks) {
    if (block.kind === 'keep') out += block.text;
    else if (block.kind === 'rule') {
      if (
        block.selectors.some((needed) =>
          needed.every((name) => classes.has(name))
        )
      )
        out += block.text;
    } else {
      const inner = emit(block.children, classes);
      // An empty layer still fixes its place in the layer order.
      if (inner || block.layer) out += `${block.prelude}{${inner}}`;
    }
  }
  return out;
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  apos: "'",
  gt: '>',
  lt: '<',
  quot: '"',
};

/** Every class token in the document's `class` attributes. */
export function pageClasses(html: string): Set<string> {
  const classes = new Set(BEFORE_PAINT);
  for (const [, value] of html.matchAll(CLASS_ATTRIBUTE))
    for (const token of value
      .replace(ENTITY, (entity, name: string) =>
        name.startsWith('#x') || name.startsWith('#X')
          ? String.fromCodePoint(Number.parseInt(name.slice(2), 16))
          : name.startsWith('#')
            ? String.fromCodePoint(Number(name.slice(1)))
            : (ENTITIES[name] ?? entity)
      )
      .split(SPACES))
      if (token) classes.add(token);
  return classes;
}

/** A parsed stylesheet that cuts itself down for one page. */
export function usedCss(css: string): (classes: Set<string>) => string {
  const blocks = parse(css);
  return (classes) => emit(blocks, classes);
}
