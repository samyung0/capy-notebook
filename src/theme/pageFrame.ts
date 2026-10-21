import type {
  PageFrame,
  PageFrameColor,
  PageFrameColours,
  PageFramePattern,
} from '@/api/types';
import brush from '@/assets/paint/brush.webp';
import contours from '@/assets/paint/contours.webp';
import grain from '@/assets/paint/grain.webp';
import waves from '@/assets/paint/waves.webp';

/**
 * The painted page frame behind the page panel (openwiki/frontend/appearance.md):
 * a pattern drawn in a colour preset or in up to three custom colours, each a
 * point on the hue (x) and saturation (y) field. It is drawn with CSS
 * gradients and, for the textured patterns, one small grey texture blended
 * over them, as custom properties the stylesheet's `.page-frame` reads.
 */

export const FRAME_PATTERNS: PageFramePattern[] = [
  'none',
  'arc',
  'mesh',
  'glow',
  'painted',
  'waves',
  'contours',
];

type Preset = Exclude<PageFrameColours, 'custom'>;

/** Sky, horizon and ground of each preset. */
export const FRAME_PRESETS: Record<Preset, [string, string, string]> = {
  dusk: ['#4b3f9a', '#c9a0d4', '#f6cfa6'],
  meadow: ['#6f80d8', '#f2c9b4', '#4f9a5c'],
  mist: ['#5d6a86', '#c4c6d8', '#64786a'],
  rose: ['#7a4fa8', '#f0a3a8', '#c9606a'],
  sea: ['#4f8fd0', '#b5e0dc', '#2f7f72'],
  sunset: ['#6a5bc8', '#f6b48a', '#c8693a'],
  wheat: ['#7f9fd8', '#f2dcc0', '#b98a2a'],
};
export const FRAME_PRESET_NAMES = Object.keys(FRAME_PRESETS) as Preset[];

/** Above this the frosted sidebar's muted labels lose their contrast. */
export const STRENGTH_MAX = 0.92;
export const MAX_FRAME_COLORS = 3;

export const DEFAULT_PAGE_FRAME: PageFrame = {
  colours: 'dusk',
  dots: [
    { x: 0.9, y: 0.25 },
    { x: 0.5, y: 0.3 },
    { x: 0.13, y: 0.32 },
  ],
  grain: 0.35,
  pattern: 'none',
  strength: 0.75,
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
    grain: unit(f.grain) ? f.grain : DEFAULT_PAGE_FRAME.grain,
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

/** The frame's three stops, before strength. */
export function frameStops(frame: PageFrame): [string, string, string] {
  if (frame.colours !== 'custom') return FRAME_PRESETS[frame.colours];
  const c = frame.dots.map(dotColor);
  if (c.length === 1)
    return [
      mixColor(c[0], '#000000', 0.2),
      mixColor(c[0], '#ffffff', 0.45),
      c[0],
    ];
  if (c.length === 2)
    return [c[0], mixColor(mixColor(c[0], c[1], 0.5), '#ffffff', 0.3), c[1]];
  return [c[0], c[1], c[2]];
}

/** Strength 1 is the stops as picked; lower mixes them toward white. */
export const strengthen = (stops: string[], strength: number) =>
  stops.map((s) => mixColor(s, '#ffffff', (1 - strength) * 0.75));

type Layers = { image: string; blend: string; size: string };

/** One pattern's background layers in three stops. */
export function patternLayers(
  pattern: Exclude<PageFramePattern, 'none'>,
  [a, b, c]: string[]
): Layers {
  const plain = (image: string): Layers => ({
    blend: 'normal',
    image,
    size: 'cover',
  });
  const textured = (url: string, angle: number, blend: string): Layers => ({
    blend: `${blend}, normal`,
    image: `url("${url}"), linear-gradient(${angle}deg, ${a}, ${b} 52%, ${c})`,
    size: 'cover, 100% 100%',
  });
  switch (pattern) {
    case 'arc':
      return plain(
        `radial-gradient(120% 90% at 0% 0%, rgb(255 255 255 / 0.28), transparent 60%), linear-gradient(135deg, ${a}, ${b} 52%, ${c})`
      );
    case 'mesh':
      return plain(
        `radial-gradient(55% 60% at 12% 18%, ${a}, transparent 70%), radial-gradient(50% 55% at 88% 22%, ${b}, transparent 70%), radial-gradient(60% 60% at 70% 92%, ${c}, transparent 70%), radial-gradient(60% 60% at 18% 88%, ${b}, transparent 70%), linear-gradient(${a}, ${c})`
      );
    case 'glow':
      return plain(
        `radial-gradient(130% 100% at 50% 115%, ${c}, ${b} 42%, ${a} 88%)`
      );
    case 'painted':
      return textured(brush, 180, 'overlay');
    case 'waves':
      return textured(waves, 165, 'overlay');
    case 'contours':
      return textured(contours, 135, 'soft-light');
  }
}

/** The custom properties `.page-frame` draws, or null for no frame. */
export function pageFrameStyle(
  frame: PageFrame
): Record<string, string> | null {
  if (frame.pattern === 'none') return null;
  const layers = patternLayers(
    frame.pattern,
    strengthen(frameStops(frame), frame.strength)
  );
  return {
    '--page-frame-blend': layers.blend,
    '--page-frame-grain': String(frame.grain),
    '--page-frame-grain-image': `url("${grain}")`,
    '--page-frame-image': layers.image,
    '--page-frame-size': layers.size,
  };
}
