import {
  Airplane01Icon,
  Atom01Icon,
  Book02Icon,
  BookOpen01Icon,
  CalculatorIcon,
  Calendar03Icon,
  ChartHistogramIcon,
  Clock01Icon,
  Comment01Icon,
  DnaIcon,
  GlobeIcon,
  HeadphonesIcon,
  Leaf01Icon,
  Mic01Icon,
  PencilEdit01Icon,
  QuillWrite01Icon,
  RulerIcon,
  Sushi01Icon,
  TestTube01Icon,
  TranslateIcon,
} from '@hugeicons/core-free-icons';
import geopattern from 'geopattern';
import {
  bankNote,
  bubbles,
  current,
  diagonalLines,
  endlessClouds,
  formalInvitation,
  fourPointStars,
  graphPaper,
  hexagons,
  jigsaw,
  overlappingCircles,
  plus,
  polkaDots,
  signal,
  texture,
  wiggle,
  xEquals,
  zigZag,
} from 'hero-patterns';
import type { CoverConfig } from '@/api/types';

/** How a cover strip paints its background and label. */
export type CoverPaint = {
  color: string;
  /** A CSS background-image value. */
  image: string;
  /** Patterns repeat at their own size; drawings fill the strip. */
  repeat: boolean;
  /** Drawings anchored right keep the label's side clear on narrow strips. */
  right: boolean;
  /** Light art takes dark text; the rest take white text. */
  light: boolean;
  /** A bottom shade keeps white text readable on busy art. */
  shade: boolean;
};

type Kind = NonNullable<CoverConfig['kind']>;

// These lists must match server/internal/cover/cover.go.
export const COVER_COLORS = [
  '#7866cf',
  '#2a78d6',
  '#1b9e6f',
  '#d0505e',
  '#eb6834',
  '#c48a00',
  '#5b6472',
] as const;
export const GEO_PATTERNS = [
  'octogons',
  'overlappingCircles',
  'plusSigns',
  'xes',
  'sineWaves',
  'hexagons',
  'overlappingRings',
  'plaid',
  'triangles',
  'squares',
  'concentricCircles',
  'diamonds',
  'tessellation',
  'nestedSquares',
  'mosaicSquares',
  'chevrons',
] as const;
const HERO = {
  bankNote,
  bubbles,
  current,
  diagonalLines,
  endlessClouds,
  formalInvitation,
  fourPointStars,
  graphPaper,
  hexagons,
  jigsaw,
  overlappingCircles,
  plus,
  polkaDots,
  signal,
  texture,
  wiggle,
  xEquals,
  zigZag,
};

export const HERO_PATTERNS = Object.keys(HERO) as (keyof typeof HERO)[];

const GLYPHS: Record<Kind, string[]> = {
  kana: [
    'あ',
    'い',
    'う',
    'え',
    'お',
    'カ',
    'キ',
    'ク',
    '日',
    '本',
    '語',
    '漢',
    '字',
    'ん',
    'ツ',
    '学',
  ],
  latin: [
    'Aa',
    '“ ”',
    '?',
    '!',
    '&',
    '¶',
    'é',
    'Ww',
    'abc',
    'Q',
    '…',
    'Rr',
    ';',
    'ñ',
    'Bb',
    '‘s',
  ],
  math: [
    '∑',
    '∫',
    'π',
    '√x',
    '∞',
    '≈',
    '△',
    'x²',
    'θ',
    '∠',
    '±',
    'sin',
    'f(x)',
    'Δ',
    'λ',
    '÷',
    'μ',
    '≤',
  ],
};
/** A tile's single glyph for symbols covers. */
export const LEAD_GLYPH: Record<Kind, string> = {
  kana: 'あ',
  latin: 'Aa',
  math: '∑',
};
const ICONS: Record<Kind, (typeof CalculatorIcon)[]> = {
  kana: [
    Sushi01Icon,
    BookOpen01Icon,
    HeadphonesIcon,
    TranslateIcon,
    Leaf01Icon,
    PencilEdit01Icon,
    Calendar03Icon,
    Airplane01Icon,
  ],
  latin: [
    BookOpen01Icon,
    HeadphonesIcon,
    Mic01Icon,
    QuillWrite01Icon,
    Comment01Icon,
    GlobeIcon,
    Clock01Icon,
    Airplane01Icon,
  ],
  math: [
    CalculatorIcon,
    Atom01Icon,
    RulerIcon,
    TestTube01Icon,
    DnaIcon,
    Book02Icon,
    ChartHistogramIcon,
    GlobeIcon,
  ],
};
// Data URI images cannot reach the page's web fonts, so these are system faces.
export const glyphFont = (kind: Kind) =>
  kind === 'kana'
    ? "'Hiragino Sans','Noto Sans JP','Yu Gothic',sans-serif"
    : "'Times New Roman','STIX Two Text',Georgia,serif";

const W = 344;
const H = 76;

/** A seeded generator, so an exam's cover never changes between renders. */
function random(seed: string) {
  let h = 2_166_136_261;
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16_777_619) >>> 0;
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2_246_822_507) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 3_266_489_909) >>> 0;
    h ^= h >>> 16;
    return (h >>> 0) / 4_294_967_296;
  };
}
/** Mixes toward white for t > 0 and toward black for t < 0. */
function shade(hex: string, t: number) {
  const n = Number.parseInt(hex.slice(1), 16);
  return `#${[n >> 16, (n >> 8) & 255, n & 255]
    .map((v) => Math.round(t > 0 ? v + (255 - v) * t : v * (1 + t)))
    .map((v) => v.toString(16).padStart(2, '0'))
    .join('')}`;
}
const xmlText = (text: string) =>
  text.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
const svg = (body: string, anchor: 'xMid' | 'xMax') =>
  `url("data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="${anchor}YMid slice">${body}</svg>`
  )}")`;

// Maths, letters and kana together: the dashboard banner's "any subject" art.
const MIXED = [
  '∑',
  'Aa',
  'あ',
  'π',
  '?',
  '∫',
  '“ ”',
  '△',
  'x²',
  '!',
  'é',
  '√x',
  '学',
  '¶',
  'θ',
  '&',
];

function symbols(
  id: string,
  color: string,
  set: string[],
  font: string,
  italic: boolean
) {
  const r = random(`${id}-sym`);
  let i = Math.floor(r() * set.length);
  let out = '';
  for (let y = 0; y < 2; y++) {
    for (let x = 0; x < 9; x++) {
      const cx = ((x + 0.5 + (r() - 0.5) * 0.6) * W) / 9;
      const cy = ((y + 0.6 + (r() - 0.5) * 0.5) * H) / 2;
      const turn = `rotate(${((r() - 0.5) * 36).toFixed(0)} ${cx.toFixed(1)} ${cy.toFixed(1)})`;
      out += `<text x="${cx.toFixed(1)}" y="${cy.toFixed(1)}" font-size="${(14 + r() * 18).toFixed(1)}" fill-opacity="${(0.16 + r() * 0.2).toFixed(2)}" text-anchor="middle" transform="${turn}">${xmlText(set[i++ % set.length])}</text>`;
    }
  }
  const style = italic ? ' font-style="italic"' : '';
  return svg(
    `<rect width="${W}" height="${H}" fill="${color}"/><g fill="#fff" font-family="${font}"${style}>${out}</g>`,
    'xMid'
  );
}

/** The dashboard's default banner: mixed symbols on the accent purple. */
export const mixedSymbolsArt = (seed: string) =>
  symbols(
    seed,
    COVER_COLORS[0],
    MIXED,
    "'Times New Roman',Georgia,'Hiragino Sans','Noto Sans JP',serif",
    true
  );

function doodles(id: string, color: string, kind: Kind) {
  const r = random(`${id}-doodle`);
  const icons = ICONS[kind];
  const defs = icons
    .map(
      (icon, n) =>
        `<symbol id="i${n}" viewBox="0 0 24 24">${icon
          .map(([tag, attrs]) => {
            const d = 'd' in attrs ? ` d="${attrs.d}"` : '';
            const shape = Object.entries(attrs)
              .filter(([k]) =>
                ['cx', 'cy', 'r', 'x', 'y', 'width', 'height', 'rx'].includes(k)
              )
              .map(([k, v]) => ` ${k}="${v}"`)
              .join('');
            return `<${tag}${d}${shape}/>`;
          })
          .join('')}</symbol>`
    )
    .join('');
  let out = '';
  let n = 0;
  for (let y = 0; y < 3; y++) {
    for (let x = 0; x < 11; x++) {
      const cx = x * 34 + (y % 2 ? 17 : 0) + (r() - 0.5) * 6 - 6;
      const cy = y * 28 + (r() - 0.5) * 6 - 4;
      out += `<use href="#i${n++ % icons.length}" width="18" height="18" transform="translate(${cx.toFixed(0)} ${cy.toFixed(0)}) rotate(${((r() - 0.5) * 40).toFixed(0)} 9 9)"/>`;
    }
  }
  return svg(
    `<defs>${defs}</defs><rect width="${W}" height="${H}" fill="${color}"/><g stroke="#fff" stroke-opacity=".28" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${out}</g>`,
    'xMid'
  );
}

function shelf(id: string, color: string) {
  const r = random(`${id}-shelf`);
  const tones = [-0.45, -0.25, 0.15, 0.35, 0.55, -0.1, 0.7];
  let x = 196;
  let out = '';
  while (x < W - 6) {
    const bw = 9 + Math.floor(r() * 12);
    const bh = 38 + Math.floor(r() * 26);
    const top = H - 6 - bh;
    const fill = shade(color, tones[Math.floor(r() * tones.length)]);
    const lean = r() < 0.12 && x < W - 40;
    const bands =
      r() < 0.6
        ? `<rect x="${x}" y="${top + 6}" width="${bw}" height="3" fill="#fff" fill-opacity=".35"/><rect x="${x}" y="${H - 18}" width="${bw}" height="2" fill="#000" fill-opacity=".15"/>`
        : '';
    const book = `<rect x="${x}" y="${top}" width="${bw}" height="${bh}" rx="1.5" fill="${fill}"/>${bands}`;
    out += lean
      ? `<g transform="rotate(14 ${x + bw} ${H - 6})">${book}</g>`
      : book;
    x += bw + (lean ? 10 : 1);
  }
  return svg(
    `<rect width="${W}" height="${H}" fill="${shade(color, 0.78)}"/><circle cx="${W - 40}" cy="8" r="34" fill="${shade(color, 0.62)}"/>${out}<rect y="${H - 6}" width="${W}" height="6" fill="${shade(color, -0.55)}"/>`,
    'xMax'
  );
}

/** Paper covers: the colour is the paper; print and pen are fixed. */
export const PAPER_COLORS = [
  '#fbf9f3',
  '#ffffff',
  '#eceef1',
  '#f8efc9',
] as const;
const PAPER_LINE = '#6f8fbf';
const GENKO_LINE = '#b98a6a';
export const PAPER_INK = '#2f4f86';

function paper(color: string, kind: Kind, line: string) {
  let lines = '';
  if (kind === 'math') {
    for (let i = 0; i < W; i += 12) lines += `M${i} 0V${H}`;
    for (let j = 0; j < H; j += 12) lines += `M0 ${j}H${W}`;
  }
  if (kind === 'latin')
    for (let j = 18; j < H; j += 18) lines += `M0 ${j}H${W}`;
  let squares = '';
  if (kind === 'kana') {
    for (let i = 8; i < W; i += 22) {
      for (let j = 6; j < H; j += 22)
        squares += `<rect x="${i}" y="${j}" width="18" height="18"/>`;
    }
  }
  const margin =
    kind === 'latin'
      ? `<path d="M26 0V${H}" stroke="#e0505e" stroke-opacity=".55"/>`
      : '';
  const italic = kind === 'kana' ? '' : ' font-style="italic"';
  const hand = line
    ? `<text x="${W - 14}" y="22" text-anchor="end" font-size="${kind === 'kana' ? 13 : 15}" fill="${PAPER_INK}" fill-opacity=".85" font-family="${glyphFont(kind)}"${italic} transform="rotate(-3 ${W - 14} 22)">${xmlText(line)}</text>`
    : '';
  return svg(
    `<rect width="${W}" height="${H}" fill="${color}"/><path d="${lines}" stroke="${PAPER_LINE}" stroke-opacity=".3"/><g fill="none" stroke="${GENKO_LINE}" stroke-opacity=".45">${squares}</g>${margin}${hand}`,
    'xMax'
  );
}

function bigType(color: string, label: string) {
  const code = xmlText(label.split(' ')[0]);
  const font =
    'font-size="104" font-weight="800" font-family="system-ui,sans-serif" letter-spacing="-4" text-anchor="end"';
  return svg(
    `<rect width="${W}" height="${H}" fill="${color}"/><text x="${W + 6}" y="${H + 22}" ${font} fill="#fff" fill-opacity=".16">${code}</text><text x="${W - 70}" y="${H - 30}" ${font} fill="none" stroke="#fff" stroke-opacity=".12">${code}</text>`,
    'xMax'
  );
}

/**
 * Draws a cover from its stored config. The art is seeded by the cover's own
 * seed (Shuffle) or else the owner's id, so it never changes between renders.
 */
export function coverPaint(
  ownerId: string,
  label: string,
  cover: CoverConfig
): CoverPaint {
  const { color } = cover;
  const id = cover.seed || ownerId;
  const base = {
    color,
    light: false,
    repeat: false,
    right: false,
    shade: true,
  };
  // The server's Cover.Check guarantees kind and pattern for the styles that use them.
  const kind = cover.kind as Kind;
  switch (cover.style) {
    case 'symbols':
      return {
        ...base,
        image: symbols(
          id,
          color,
          GLYPHS[kind],
          glyphFont(kind),
          kind !== 'kana'
        ),
      };
    case 'doodles':
      return { ...base, image: doodles(id, color, kind) };
    case 'shelf':
      return {
        ...base,
        image: shelf(id, color),
        light: true,
        right: true,
        shade: false,
      };
    case 'paper':
      return {
        ...base,
        image: paper(color, kind, cover.line ?? ''),
        light: true,
        right: true,
        shade: false,
      };
    case 'type':
      return {
        ...base,
        image: bigType(color, label),
        right: true,
        shade: false,
      };
    case 'geo':
      return {
        ...base,
        image: geopattern
          .generate(id, { color, generator: cover.pattern ?? '' })
          .toDataUrl(),
        repeat: true,
      };
    case 'hero':
      return {
        ...base,
        image: HERO[cover.pattern as keyof typeof HERO]('#ffffff', 0.28),
        repeat: true,
      };
    default:
      throw new Error(`Unknown cover style ${cover.style satisfies never}`);
  }
}
