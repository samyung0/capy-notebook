import { parseHTML } from 'linkedom/worker';

/*
 * A DOM for mermaid.js inside a Web Worker (mermaid.worker.ts): linkedom for
 * the tree, and the geometry mermaid reads (getBBox, getBoundingClientRect,
 * getComputedTextLength, getTotalLength, client sizes) computed from
 * attributes plus OffscreenCanvas text metrics. There is no layout engine:
 * fonts come from a small cascade over inline styles, the diagram's own
 * stylesheet and presentation attributes, and HTML labels are laid out the
 * way mermaid's createText styles them (nowrap up to max-width, then wrapped
 * at width). The per-type geometry check (e2e/editor/mermaid-geometry.spec.ts)
 * compares what it draws with the page's own drawing.
 */

interface Box {
  height: number;
  width: number;
  x: number;
  y: number;
}

interface Font {
  family: string;
  /** Line height as a multiple of the size (HTML labels). */
  lineHeight: number;
  size: number;
  weight: string;
}

const EMPTY: Box = { height: 0, width: 0, x: 0, y: 0 };
/** What the page's render host gives (`font-normal leading-normal`). */
const ROOT_FONT: Font = {
  family: 'sans-serif',
  lineHeight: 1.5,
  size: 16,
  weight: '400',
};
/** What the cascade reads: fonts (inherited) and side padding (not). */
const KEYS = [
  'font-family',
  'font-size',
  'font-weight',
  'line-height',
  'padding',
  'padding-left',
  'padding-right',
] as const;
type Key = (typeof KEYS)[number];

const context = new OffscreenCanvas(1, 1).getContext('2d');
if (!context) throw new Error('No 2D OffscreenCanvas.');
const ctx = context;

const num = (value: unknown, fallback = 0) => {
  const n = Number.parseFloat(String(value ?? ''));
  return Number.isFinite(n) ? n : fallback;
};

/** Advance width as the page lays text out: inline sizes are whole
 * LayoutUnits (1/64 px), rounded up; without it a mindmap's layout drifts. */
/** The faces the page draws generic families in (`genericFaces` in
 * Mermaid.tsx): a worker has no font settings, so its `sans-serif` is
 * another face. */
export const pageFaces: Record<string, string> = {};
const GENERIC =
  /(^|,)\s*(sans-serif|serif|monospace|cursive|fantasy)\s*(?=,|$)/g;
const families = new Map<string, string>();

function family(list: string) {
  let named = families.get(list);
  if (named === undefined) {
    named = list.replace(GENERIC, (whole, comma: string, generic: string) =>
      pageFaces[generic] ? `${comma}"${pageFaces[generic]}", ${generic}` : whole
    );
    families.set(list, named);
  }
  return named;
}

function measure(text: string, font: Font) {
  ctx.font = `${font.weight} ${font.size}px ${family(font.family)}`;
  const metrics = ctx.measureText(text);
  return {
    ascent: metrics.fontBoundingBoxAscent,
    descent: metrics.fontBoundingBoxDescent,
    /** Where the ink ends, in whole pixels (an SVG text's box takes it). */
    inkLeft: metrics.actualBoundingBoxLeft,
    inkRight: metrics.actualBoundingBoxRight,
    width: Math.ceil(metrics.width * 64) / 64,
  };
}

function styleOf(element: Element): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (element.getAttribute('style') ?? '').split(';')) {
    const colon = part.indexOf(':');
    if (colon > 0)
      out[part.slice(0, colon).trim().toLowerCase()] = part
        .slice(colon + 1)
        .trim();
  }
  return out;
}

// --------------------------------------------------------------- cascade

interface Rule {
  important: boolean;
  order: number;
  selector: string;
  specificity: number;
  value: string;
}

const COMMENT = /\/\*[\s\S]*?\*\//g;
const SPACES = /\s+/;
const IMPORTANT = /\s*!important\s*$/i;
const sheets = new Map<string, Map<Key, Rule[]>>();

/** ids, then classes, attributes and pseudo-classes, then types. */
function specificity(selector: string) {
  const ids = selector.match(/#[\w-]+/g)?.length ?? 0;
  const classes =
    selector.match(/\.[\w-]+|\[[^\]]*\]|:(?!:)[\w-]+/g)?.length ?? 0;
  const types =
    selector
      .replace(/#[\w-]+|\.[\w-]+|\[[^\]]*\]|::?[\w-]+(\([^)]*\))?/g, ' ')
      .match(/[a-zA-Z][\w-]*/g)?.length ?? 0;
  return ids * 10_000 + classes * 100 + types;
}

/** The font declarations of a stylesheet, by property; @-rule blocks (the
 * keyframes) are skipped. */
function parseSheet(css: string) {
  const rules = new Map<Key, Rule[]>(KEYS.map((key) => [key, []]));
  let order = 0;
  let depth = 0;
  let start = 0;
  let selectors = '';
  const text = css.replace(COMMENT, '');
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '{') {
      if (depth === 0) selectors = text.slice(start, i).trim();
      depth++;
      start = i + 1;
    } else if (char === '}') {
      depth--;
      if (depth === 0 && !selectors.startsWith('@')) {
        const body = text.slice(start, i);
        for (const part of body.split(';')) {
          const colon = part.indexOf(':');
          const key = part.slice(0, colon).trim().toLowerCase() as Key;
          if (colon < 0 || !KEYS.includes(key)) continue;
          const raw = part.slice(colon + 1).trim();
          if (raw.includes('var(')) continue;
          for (const selector of selectors.split(','))
            rules.get(key)?.push({
              important: IMPORTANT.test(raw),
              order: order++,
              selector: selector.trim(),
              specificity: specificity(selector),
              value: raw.replace(IMPORTANT, ''),
            });
        }
      }
      if (depth <= 0) {
        depth = 0;
        start = i + 1;
        selectors = '';
      }
    }
  }
  return rules;
}

/** The stylesheet of the SVG holding `element` (mermaid inserts it before
 * drawing), by font property. */
function sheetOf(element: Element) {
  const svg = element.closest('svg');
  const style = svg && [...svg.children].find((c) => c.localName === 'style');
  const css = style?.textContent ?? '';
  let rules = sheets.get(css);
  if (!rules) {
    rules = parseSheet(css);
    sheets.set(css, rules);
  }
  return rules;
}

function matches(element: Element, selector: string) {
  try {
    return element.matches(selector);
  } catch {
    return false;
  }
}

/** A font property set on `element` itself: its inline style, then the
 * winning stylesheet rule, then its presentation attribute. */
function own(element: Element, key: Key): string | undefined {
  const inline = styleOf(element)[key];
  if (inline) return inline.replace(IMPORTANT, '');
  let best: Rule | undefined;
  for (const rule of sheetOf(element).get(key) ?? []) {
    if (
      best &&
      (best.important === rule.important
        ? best.specificity === rule.specificity
          ? best.order > rule.order
          : best.specificity > rule.specificity
        : best.important)
    )
      continue;
    if (matches(element, rule.selector)) best = rule;
  }
  return best?.value ?? element.getAttribute(key) ?? undefined;
}

/** A font property of `element`, its own or inherited. */
function property(element: Element, key: Key): string | undefined {
  for (
    let at: Element | null = element;
    at && at.nodeType === 1;
    at = at.parentElement
  ) {
    const value = own(at, key);
    if (value) return value;
  }
}

/** The font size of `element` in px: em, ex and % against its parent's. */
function sizeOf(element: Element | null): number {
  if (element?.nodeType !== 1) return ROOT_FONT.size;
  const value = own(element, 'font-size');
  const n = num(value, Number.NaN);
  if (!value || Number.isNaN(n)) return sizeOf(element.parentElement);
  if (value.endsWith('rem')) return n * ROOT_FONT.size;
  if (value.endsWith('em')) return n * sizeOf(element.parentElement);
  if (value.endsWith('%')) return (n / 100) * sizeOf(element.parentElement);
  if (value.endsWith('ex')) {
    const parent = element.parentElement;
    return n * xHeight(parent ? fontOf(parent) : ROOT_FONT);
  }
  return n;
}

/** A font's x-height, measured large: small glyph bounds are whole pixels.
 * ponytail: the glyph's height, about 1% over the font's own x-height the
 * page uses (OS/2 sxHeight), which canvas does not expose. */
function xHeight(font: Font) {
  ctx.font = `${font.weight} 1000px ${family(font.family)}`;
  return (font.size * ctx.measureText('x').actualBoundingBoxAscent) / 1000;
}

function fontOf(element: Element): Font {
  const size = sizeOf(element);
  const weight = property(element, 'font-weight') ?? ROOT_FONT.weight;
  const lineHeight = property(element, 'line-height');
  return {
    family: property(element, 'font-family') ?? ROOT_FONT.family,
    lineHeight: lineHeight?.endsWith('px')
      ? num(lineHeight) / size
      : num(lineHeight, ROOT_FONT.lineHeight),
    size,
    weight: weight === 'normal' ? '400' : weight === 'bold' ? '700' : weight,
  };
}

// -------------------------------------------------------------- geometry

const PATH_TOKEN = /[a-zA-Z]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/g;
const COMMAND = /[a-zA-Z]/;
const ARGS: Record<string, number> = {
  A: 7,
  C: 6,
  L: 2,
  M: 2,
  Q: 4,
  S: 4,
  T: 2,
};

/** Where a cubic or quadratic Bézier coordinate peaks between its ends:
 * the browser's bounding box takes the curve, not its control points. */
function extremes(points: number[]) {
  const out: number[] = [];
  if (points.length === 3) {
    const [a, b, c] = points as [number, number, number];
    const d = a - 2 * b + c;
    if (d !== 0) out.push((a - b) / d);
  } else {
    const [a, b, c, e] = points as [number, number, number, number];
    const qa = -a + 3 * b - 3 * c + e;
    const qb = 2 * (a - 2 * b + c);
    const qc = b - a;
    if (Math.abs(qa) < 1e-12) {
      if (qb !== 0) out.push(-qc / qb);
    } else {
      const disc = qb * qb - 4 * qa * qc;
      if (disc >= 0) {
        const root = Math.sqrt(disc);
        out.push((-qb + root) / (2 * qa), (-qb - root) / (2 * qa));
      }
    }
  }
  return out.filter((t) => t > 0 && t < 1);
}

function bezier(points: number[], t: number) {
  const s = 1 - t;
  return points.length === 3
    ? s * s * points[0]! + 2 * s * t * points[1]! + t * t * points[2]!
    : s * s * s * points[0]! +
        3 * s * s * t * points[1]! +
        3 * s * t * t * points[2]! +
        t * t * t * points[3]!;
}

function pathBox(d: string): Box | null {
  const tokens = d.match(PATH_TOKEN) ?? [];
  const xs: number[] = [];
  const ys: number[] = [];
  const add = (x: number, y: number) => {
    xs.push(x);
    ys.push(y);
  };
  /** A curve from the current point through its control points to its end. */
  const curve = (px: number[], py: number[]) => {
    for (const t of extremes(px)) add(bezier(px, t), bezier(py, t));
    for (const t of extremes(py)) add(bezier(px, t), bezier(py, t));
    add(px.at(-1)!, py.at(-1)!);
  };
  let i = 0;
  let cx = 0;
  let cy = 0;
  let sx = 0;
  let sy = 0;
  // The last control point, for S and T.
  let lx = 0;
  let ly = 0;
  let command = 'M';
  while (i < tokens.length) {
    if (COMMAND.test(tokens[i]!)) command = tokens[i++]!;
    const relative = command === command.toLowerCase();
    const upper = command.toUpperCase();
    const ox = relative ? cx : 0;
    const oy = relative ? cy : 0;
    if (upper === 'Z') {
      cx = sx;
      cy = sy;
      lx = cx;
      ly = cy;
      continue;
    }
    if (upper === 'H' || upper === 'V') {
      const value = Number(tokens[i++]);
      if (Number.isNaN(value)) break;
      if (upper === 'H') cx = value + ox;
      else cy = value + oy;
      add(cx, cy);
      lx = cx;
      ly = cy;
      continue;
    }
    const count = ARGS[upper] ?? 2;
    const v = Array.from({ length: count }, () => Number(tokens[i++]));
    if (v.some(Number.isNaN)) break;
    if (upper === 'C') {
      curve(
        [cx, v[0]! + ox, v[2]! + ox, v[4]! + ox],
        [cy, v[1]! + oy, v[3]! + oy, v[5]! + oy]
      );
      lx = v[2]! + ox;
      ly = v[3]! + oy;
    } else if (upper === 'S') {
      const [x1, y1] = [2 * cx - lx, 2 * cy - ly];
      curve([cx, x1, v[0]! + ox, v[2]! + ox], [cy, y1, v[1]! + oy, v[3]! + oy]);
      lx = v[0]! + ox;
      ly = v[1]! + oy;
    } else if (upper === 'Q') {
      curve([cx, v[0]! + ox, v[2]! + ox], [cy, v[1]! + oy, v[3]! + oy]);
      lx = v[0]! + ox;
      ly = v[1]! + oy;
    } else if (upper === 'T') {
      const [x1, y1] = [2 * cx - lx, 2 * cy - ly];
      curve([cx, x1, v[0]! + ox], [cy, y1, v[1]! + oy]);
      lx = x1;
      ly = y1;
    } else {
      // M, L, and an arc by its end point (mermaid's arcs are pie slices,
      // whose box the circle around them gives).
      const at = upper === 'A' ? 5 : 0;
      add(v[at]! + ox, v[at + 1]! + oy);
    }
    cx = v[count - 2]! + ox;
    cy = v[count - 1]! + oy;
    if (upper !== 'C' && upper !== 'S' && upper !== 'Q' && upper !== 'T') {
      lx = cx;
      ly = cy;
    }
    if (upper === 'M') {
      sx = cx;
      sy = cy;
      command = relative ? 'l' : 'L';
    }
  }
  if (!xs.length) return null;
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { height: Math.max(...ys) - y, width: Math.max(...xs) - x, x, y };
}

const TRANSFORM = /(translate|scale)\(\s*([-\d.e]+)(?:[\s,]+([-\d.e]+))?\s*\)/g;

function transformBox(box: Box, transform: string | null): Box {
  if (!transform) return box;
  let { height, width, x, y } = box;
  // Applied right to left, as SVG composes them.
  for (const match of [...transform.matchAll(TRANSFORM)].reverse()) {
    const a = Number(match[2]);
    const b = match[3] === undefined ? undefined : Number(match[3]);
    if (match[1] === 'translate') {
      x += a;
      y += b ?? 0;
    } else {
      const sy = b ?? a;
      x *= a;
      width *= a;
      y *= sy;
      height *= sy;
    }
  }
  return { height, width, x, y };
}

function union(boxes: Box[]): Box {
  if (!boxes.length) return EMPTY;
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  return {
    height: Math.max(...boxes.map((b) => b.y + b.height)) - y,
    width: Math.max(...boxes.map((b) => b.x + b.width)) - x,
    x,
    y,
  };
}

/** An element's left plus right padding in px (not inherited). */
function sidePadding(element: Element) {
  const [top, right = top, , left = right] = (own(element, 'padding') ?? '')
    .split(SPACES)
    .filter(Boolean)
    .map((value) => num(value));
  const side = (key: Key, fallback = 0) => {
    const value = own(element, key);
    return value === undefined ? fallback : num(value);
  };
  return side('padding-left', left) + side('padding-right', right);
}

/** The laid-out size of an HTML label (a div or span in a foreignObject),
 * as mermaid's createText styles it. */
function htmlBox(element: Element): Box {
  const style = styleOf(element);
  // The text's own element sets its font (a theme styles the inner span).
  const holder =
    [element, ...element.querySelectorAll('*')].find((at) =>
      [...at.childNodes].some(
        (node) => node.nodeType === 3 && node.textContent?.trim()
      )
    ) ?? element;
  const font = fontOf(holder);
  const text = (element.textContent ?? '').replace(/\s+/g, ' ').trim();
  const lineHeight = font.size * font.lineHeight;
  // A span with side padding (a theme's edge label) widens its line and
  // keeps it when empty; a block inside one leaves a line before and after
  // (block-in-inline).
  let padded = 0;
  let splitLines = 0;
  for (const span of [element, ...element.querySelectorAll('span')]) {
    const padding = span.localName === 'span' ? sidePadding(span) : 0;
    if (!padding) continue;
    if (
      [...span.children].some(
        (c) => c.localName === 'p' || c.localName === 'div'
      )
    )
      splitLines += 2;
    else padded += padding;
  }
  const kept = text || padded || splitLines ? 1 : 0;
  const max = num(style['max-width'], Number.POSITIVE_INFINITY);
  const fixed = num(style.width, Number.NaN);
  const wraps =
    style['white-space'] &&
    style['white-space'] !== 'nowrap' &&
    Number.isFinite(fixed);
  if (!wraps)
    return {
      height: (kept + splitLines) * lineHeight,
      width: Math.min(measure(text, font).width + padded, max),
      x: 0,
      y: 0,
    };
  let lines = 1;
  let line = '';
  for (const word of text.split(' ')) {
    const next = line ? `${line} ${word}` : word;
    if (line && measure(next, font).width > fixed) {
      lines++;
      line = word;
    } else line = next;
  }
  return {
    height: (lines + splitLines) * lineHeight,
    width: fixed,
    x: 0,
    y: 0,
  };
}

const length = (value: string | null, font: Font) =>
  value?.endsWith('em') ? num(value) * font.size : num(value);

/** Where the alphabetic baseline sits below `y` for a dominant-baseline. */
function baselineShift(
  element: Element,
  font: Font,
  metrics: { ascent: number; descent: number }
) {
  const baseline =
    styleOf(element)['dominant-baseline'] ??
    element.getAttribute('dominant-baseline') ??
    element.getAttribute('alignment-baseline') ??
    element.parentElement?.getAttribute('dominant-baseline');
  switch (baseline) {
    case 'central':
      return (metrics.ascent - metrics.descent) / 2;
    case 'middle':
      return xHeight(font) / 2;
    case 'hanging':
    case 'text-before-edge':
      return metrics.ascent;
    case 'text-after-edge':
      return -metrics.descent;
    default:
      return 0;
  }
}

/** Text as SVG draws it: white space collapsed, none at the ends. */
const rendered = (text: string | null) =>
  (text ?? '').replace(/\s+/g, ' ').trim();

/** A text's box: each line (its tspans, or its own text) from its baseline
 * at x/y plus dy, anchored as the text is. A position a tspan sets wins
 * over its text's for its first character, as the browser places them. */
function textBox(element: Element): Box {
  const spans = [...element.children].filter(
    (child) => child.localName === 'tspan'
  );
  const lines = spans.length ? spans : [element];
  const anchor =
    styleOf(element)['text-anchor'] ??
    element.getAttribute('text-anchor') ??
    element.parentElement?.getAttribute('text-anchor');
  const own = fontOf(element);
  let x = num(element.getAttribute('x'));
  let y = num(element.getAttribute('y'));
  let dy = length(element.getAttribute('dy'), own);
  const boxes: Box[] = [];
  for (const line of lines) {
    const font = line === element ? own : fontOf(line);
    if (line !== element) {
      if (line.hasAttribute('x')) x = num(line.getAttribute('x'));
      if (line.hasAttribute('y')) y = num(line.getAttribute('y'));
      if (line.hasAttribute('dy')) dy = length(line.getAttribute('dy'), font);
    }
    y += dy;
    dy = 0;
    const text = rendered(line.textContent);
    if (!text) continue;
    const metrics = measure(text, font);
    // Anchored by its advance; the box also takes ink past either end.
    const start =
      x -
      (anchor === 'middle'
        ? metrics.width / 2
        : anchor === 'end'
          ? metrics.width
          : 0);
    const left = start - Math.max(0, metrics.inkLeft);
    const baseline = y + baselineShift(line, font, metrics);
    boxes.push({
      height: metrics.ascent + metrics.descent,
      width: start + Math.max(metrics.width, metrics.inkRight) - left,
      x: left,
      y: baseline - metrics.ascent,
    });
  }
  return union(boxes);
}

const SKIP = new Set(['style', 'defs', 'marker', 'title', 'desc']);

function bbox(element: Element): Box {
  const tag = element.localName.toLowerCase();
  const a = (key: string) => num(element.getAttribute(key));
  switch (tag) {
    case 'rect':
    case 'foreignobject':
    case 'image':
    case 'use':
      return { height: a('height'), width: a('width'), x: a('x'), y: a('y') };
    case 'circle':
      return {
        height: 2 * a('r'),
        width: 2 * a('r'),
        x: a('cx') - a('r'),
        y: a('cy') - a('r'),
      };
    case 'ellipse':
      return {
        height: 2 * a('ry'),
        width: 2 * a('rx'),
        x: a('cx') - a('rx'),
        y: a('cy') - a('ry'),
      };
    case 'line':
      return union([
        { height: 0, width: 0, x: a('x1'), y: a('y1') },
        { height: 0, width: 0, x: a('x2'), y: a('y2') },
      ]);
    case 'polygon':
    case 'polyline':
      return pathBox(`M${element.getAttribute('points') ?? ''}`) ?? EMPTY;
    case 'path':
      return pathBox(element.getAttribute('d') ?? '') ?? EMPTY;
    case 'text':
    case 'tspan':
      return textBox(element);
    case 'div':
    case 'span':
    case 'p':
      return htmlBox(element);
    default:
      return union(
        [...element.children]
          .map((child) => {
            const box = counted(child);
            return box && transformBox(box, child.getAttribute('transform'));
          })
          .filter((box) => box !== null)
      );
  }
}

const SIZED = new Set([
  'rect',
  'foreignobject',
  'image',
  'use',
  'circle',
  'ellipse',
]);
const SHAPES = new Set(['path', 'polygon', 'polyline', 'line']);

/** The box a child adds to its container's, or none when the browser leaves
 * it out: hidden, sizeless, a path with no points, a text with no glyphs, a
 * group with nothing counted inside. */
function counted(element: Element): Box | null {
  const tag = element.localName.toLowerCase();
  if (element.getAttribute('display') === 'none' || SKIP.has(tag)) return null;
  if (SIZED.has(tag) || tag === 'text') {
    const box = bbox(element);
    return box.width > 0 && box.height > 0 ? box : null;
  }
  if (SHAPES.has(tag))
    return tag === 'line'
      ? bbox(element)
      : pathBox(
          tag === 'path'
            ? (element.getAttribute('d') ?? '')
            : `M${element.getAttribute('points') ?? ''}`
        );
  if (tag === 'tspan' || tag === 'div' || tag === 'span' || tag === 'p')
    return bbox(element);
  const boxes = [...element.children]
    .map((child) => {
      const box = counted(child);
      return box && transformBox(box, child.getAttribute('transform'));
    })
    .filter((box) => box !== null);
  return boxes.length ? union(boxes) : null;
}

/** Installs the shim's document and window as the worker's globals, for
 * mermaid (and the d3, DOMPurify and Cytoscape it brings) to find on import:
 * import mermaid only after this runs. */
export function installDom() {
  const { document, window } = parseHTML(
    '<!doctype html><html><head></head><body></body></html>'
  );
  const view = window as unknown as Record<string, unknown> & typeof globalThis;
  const proto = (view.Element as typeof Element).prototype as Element &
    Record<string, unknown>;
  Object.assign(proto, {
    getBBox(this: Element) {
      return bbox(this);
    },
    getBoundingClientRect(this: Element) {
      const box = bbox(this);
      return {
        ...box,
        bottom: box.y + box.height,
        left: box.x,
        right: box.x + box.width,
        toJSON: () => box,
        top: box.y,
      };
    },
    getComputedTextLength(this: Element) {
      return measure(rendered(this.textContent), fontOf(this)).width;
    },
    getTotalLength(this: Element) {
      const box = bbox(this);
      return box.width + box.height;
    },
  });
  for (const key of [
    'clientWidth',
    'clientHeight',
    'offsetWidth',
    'offsetHeight',
  ])
    Object.defineProperty(proto, key, {
      configurable: true,
      get(this: Element) {
        const box = bbox(this);
        return key.endsWith('Width') ? box.width : box.height;
      },
    });
  // Nothing loads here: an image in a label is complete at once (mermaid
  // waits for it). DOMPurify finds no document implementation in linkedom
  // and passes labels through; the page's own pass (forPage in Mermaid.tsx)
  // is the sanitizer, as it removes what the page's mermaid would have.
  Object.defineProperty(
    (view.HTMLImageElement as typeof HTMLImageElement).prototype,
    'complete',
    { configurable: true, get: () => true }
  );
  // Cytoscape (mindmap layout) asks a canvas for a 2D context, and animates.
  const canvas = (view.HTMLCanvasElement as typeof HTMLCanvasElement)
    .prototype as unknown as Record<string, unknown>;
  canvas.getContext = (type: string) =>
    new OffscreenCanvas(300, 150).getContext(type as '2d');
  const getComputedStyle = (element: Element) => {
    const style = styleOf(element);
    return {
      ...style,
      getPropertyValue: (key: string) =>
        style[key] ?? (key.startsWith('padding') ? '0' : ''),
    };
  };
  Object.assign(view, {
    cancelAnimationFrame: (id: number) => clearTimeout(id),
    getComputedStyle,
    requestAnimationFrame: (callback: (time: number) => void) =>
      setTimeout(() => callback(performance.now()), 16),
  });
  const scope = globalThis as unknown as Record<string, unknown>;
  scope.window = view;
  scope.document = document;
  scope.getComputedStyle = getComputedStyle;
  for (const key of [
    'Comment',
    'Document',
    'DocumentFragment',
    'DOMParser',
    'Element',
    'HTMLElement',
    'HTMLFormElement',
    'HTMLTemplateElement',
    'NamedNodeMap',
    'Node',
    'NodeFilter',
    'SVGElement',
    'Text',
  ])
    if (view[key] && !(key in scope)) scope[key] = view[key];
  // Workers have no CSSOM: mermaid keeps the theme CSS as text (its browser
  // parse is lost; ours is a constant).
  scope.CSSStyleSheet ??= class {
    cssRules: { cssText: string }[] = [];
    insertRule(rule: string, index = 0) {
      this.cssRules.splice(index, 0, { cssText: rule });
      return index;
    }
  };
}
