import type {
  PageFrame,
  PageFrameColor,
  PageFrameColours,
  PageFramePattern,
} from '@/api/types';

/**
 * The painted page frame behind the page panel (openwiki/frontend/appearance.md):
 * a CSS gradient pattern drawn in a colour preset or in up to three custom
 * colours, each a point on the hue (x) and saturation (y) field, as custom
 * properties the stylesheet's `.page-frame` reads.
 */

export const FRAME_PATTERNS: PageFramePattern[] = [
  'none',
  'arc',
  'mesh',
  'glow',
];

type Preset = Exclude<PageFrameColours, 'custom'>;

/** Sky, horizon and ground of each preset, and the dots and Strength that
 * come closest to them as custom colours (fitted in Lab), which choosing the
 * preset moves the field and slider to. */
export const FRAME_PRESETS: Record<
  Preset,
  { stops: [string, string, string]; dots: PageFrameColor[]; strength: number }
> = {
  dusk: {
    dots: [
      { x: 0.67, y: 0.15 },
      { x: 0.8, y: 0.75 },
      { x: 0.09, y: 0.475 },
    ],
    stops: ['#4b3f9a', '#c9a0d4', '#f6cfa6'],
    strength: 0.36,
  },
  meadow: {
    dots: [
      { x: 0.64, y: 0.475 },
      { x: 0.08, y: 0.825 },
      { x: 0.34, y: 0.775 },
    ],
    stops: ['#6f80d8', '#f2c9b4', '#4f9a5c'],
    strength: 0.59,
  },
  mist: {
    dots: [
      { x: 0.61, y: 1 },
      { x: 0.54, y: 1 },
      { x: 0.45, y: 1 },
    ],
    stops: ['#5d6a86', '#c4c6d8', '#64786a'],
    strength: 0.92,
  },
  rose: {
    dots: [
      { x: 0.73, y: 0.65 },
      { x: 0.99, y: 0.85 },
      { x: 0.98, y: 0.575 },
    ],
    stops: ['#7a4fa8', '#f0a3a8', '#c9606a'],
    strength: 0.73,
  },
  sea: {
    dots: [
      { x: 0.58, y: 0.475 },
      { x: 0.5, y: 0.875 },
      { x: 0.45, y: 0.925 },
    ],
    stops: ['#4f8fd0', '#b5e0dc', '#2f7f72'],
    strength: 0.83,
  },
  sunset: {
    dots: [
      { x: 0.69, y: 0.575 },
      { x: 0.08, y: 0.6 },
      { x: 0.05, y: 0.35 },
    ],
    stops: ['#6a5bc8', '#f6b48a', '#c8693a'],
    strength: 0.76,
  },
  wheat: {
    dots: [
      { x: 0.61, y: 0.55 },
      { x: 0.12, y: 0.875 },
      { x: 0.1, y: 0.05 },
    ],
    stops: ['#7f9fd8', '#f2dcc0', '#b98a2a'],
    strength: 0.5,
  },
};
export const FRAME_PRESET_NAMES = Object.keys(FRAME_PRESETS) as Preset[];
/** The Strength the presets were approved at; a preset looks as approved
 * when the slider sits at its own fitted value. */
const PRESET_STRENGTH = 0.75;

/** Above this the frosted sidebar's muted labels lose their contrast. */
export const STRENGTH_MAX = 0.92;
export const MAX_FRAME_COLORS = 3;

export const DEFAULT_PAGE_FRAME: PageFrame = {
  colours: 'dusk',
  dots: FRAME_PRESETS.dusk.dots,
  pattern: 'none',
  strength: FRAME_PRESETS.dusk.strength,
};
const unit = (v: unknown): v is number =>
  typeof v === 'number' && v >= 0 && v <= 1;

/** A stored or synced frame as the app can draw it: each invalid field falls
 * back to the default, so a damaged value never breaks the page. */
export function sanitizePageFrame(raw: unknown): PageFrame {
  const f = (raw ?? {}) as Partial<Record<keyof PageFrame, unknown>>;
  const dots = Array.isArray(f.dots)
    ? f.dots
        .filter((d): d is PageFrameColor => unit(d?.x) && unit(d?.y))
        .slice(0, MAX_FRAME_COLORS)
        .map(({ x, y }) => ({ x, y }))
    : [];
  return {
    colours:
      f.colours === 'custom' || FRAME_PRESET_NAMES.includes(f.colours as Preset)
        ? (f.colours as PageFrameColours)
        : DEFAULT_PAGE_FRAME.colours,
    dots: dots.length ? dots : DEFAULT_PAGE_FRAME.dots,
    pattern: FRAME_PATTERNS.includes(f.pattern as PageFramePattern)
      ? (f.pattern as PageFramePattern)
      : DEFAULT_PAGE_FRAME.pattern,
    strength: unit(f.strength)
      ? Math.min(f.strength, STRENGTH_MAX)
      : DEFAULT_PAGE_FRAME.strength,
  };
}

const hex = (rgb: number[]) =>
  `#${rgb
    .map((v) =>
      Math.round(Math.max(0, Math.min(255, v)))
        .toString(16)
        .padStart(2, '0')
    )
    .join('')}`;
const rgb = (h: string) => {
  const n = Number.parseInt(h.slice(1), 16);
  return [n >> 16, (n >> 8) & 255, n & 255];
};
/** Mixes `a` toward `b` by `t`. */
export const mixColor = (a: string, b: string, t: number) => {
  const y = rgb(b);
  return hex(rgb(a).map((v, i) => v + (y[i] - v) * t));
};

/** A custom colour's point on the field: hue across, saturation down. */
export function dotColor({ x, y }: PageFrameColor) {
  const s = (92 - y * 72) / 100;
  const l = 0.58;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + x * 12) % 12;
    return 255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)));
  };
  return hex([f(0), f(8), f(4)]);
}

/** The frame's three colours as drawn at `strength` (the frame's own by
 * default): a preset slides from its approved look, custom colours mix
 * toward white as Strength drops. */
export function frameColors(
  frame: PageFrame,
  strength = frame.strength
): string[] {
  if (frame.colours !== 'custom') {
    const preset = FRAME_PRESETS[frame.colours];
    return strengthen(
      preset.stops,
      Math.min(1, Math.max(0, PRESET_STRENGTH + strength - preset.strength))
    );
  }
  const c = frame.dots.map(dotColor);
  const stops =
    c.length === 1
      ? [mixColor(c[0], '#000000', 0.2), mixColor(c[0], '#ffffff', 0.45), c[0]]
      : c.length === 2
        ? [c[0], mixColor(mixColor(c[0], c[1], 0.5), '#ffffff', 0.3), c[1]]
        : c;
  return strengthen(stops, strength);
}

/** Strength 1 is the stops as picked; lower mixes them toward white. */
const strengthen = (stops: string[], strength: number) =>
  stops.map((s) => mixColor(s, '#ffffff', (1 - strength) * 0.75));

/** A random frame in the same pattern and number of colours. */
export function shuffleFrame(frame: PageFrame): PageFrame {
  return {
    ...frame,
    colours: 'custom',
    dots: frame.dots.map(() => ({ x: Math.random(), y: Math.random() })),
    strength: Math.random() * STRENGTH_MAX,
  };
}

/** One pattern's background in three colours. */
export function patternImage(
  pattern: Exclude<PageFramePattern, 'none'>,
  [a, b, c]: string[]
): string {
  switch (pattern) {
    case 'arc':
      return `radial-gradient(120% 90% at 0% 0%, rgb(255 255 255 / 0.28), transparent 60%), linear-gradient(135deg, ${a}, ${b} 52%, ${c})`;
    case 'mesh':
      return `radial-gradient(55% 60% at 12% 18%, ${a}, transparent 70%), radial-gradient(50% 55% at 88% 22%, ${b}, transparent 70%), radial-gradient(60% 60% at 70% 92%, ${c}, transparent 70%), radial-gradient(60% 60% at 18% 88%, ${b}, transparent 70%), linear-gradient(${a}, ${c})`;
    case 'glow':
      return `radial-gradient(130% 100% at 50% 115%, ${c}, ${b} 42%, ${a} 88%)`;
  }
}

/** The custom properties `.page-frame` draws, or null for no frame. The
 * colours are their own registered properties, so the stylesheet
 * transitions between them instead of jumping. */
export function pageFrameStyle(
  frame: PageFrame
): Record<string, string> | null {
  if (frame.pattern === 'none') return null;
  const [a, b, c] = frameColors(frame);
  return {
    '--page-frame-a': a,
    '--page-frame-b': b,
    '--page-frame-c': c,
    '--page-frame-image': patternImage(frame.pattern, [
      'var(--page-frame-a)',
      'var(--page-frame-b)',
      'var(--page-frame-c)',
    ]),
  };
}
