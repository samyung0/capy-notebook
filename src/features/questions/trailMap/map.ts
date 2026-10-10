/**
 * The question bank progress map: one hand-drawn walk per topic, generated
 * from the topic id so every visit and device sees the same map.
 *
 * The map is a run of biomes of random length. Each biome scatters elements
 * by its own mix, capped per question-width by count and by visual weight, and
 * borders blend so one biome fades into the next. Every part of the map draws
 * from its own seeded stream (biome order, each landmark, each question-width,
 * sky, horizon), so adding questions only extends the end.
 *
 * Output is a list of pieces (SVG markup with a left and right edge) so views
 * draw only what is on screen.
 */
import * as E from './elements';
import {
  catmull,
  fill,
  hatch,
  lastOf,
  line,
  n,
  type Pt,
  Rng,
  sketch,
} from './sketch';

export const MAP_HEIGHT = 236;
const HORIZON_Y = 60;
const TRAIL_Y = 156;
/** Trail distance between two questions; also the unit of the budget. */
export const STEP = 60;
const FIRST_X = 70;
const SUMMIT_W = 300;
const BLEND = 60;
/** Biome length in map units: about 4 to 7 questions each. */
const BIOME_LENGTH = [260, 440] as const;

/** Per question-width ceilings for every biome: elements (small ground marks count half) and visual weight. */
const COUNT_CAP = 5;
const INK_CAP = 22;
/** Coloured fills (water, crop fields) read heavier than line drawing of the same size. */
const COLOUR = 1.6;
/** Measured weight per question-width that separates sparse | medium | dense. */
export const KIND_EDGES = [6, 11.5] as const;

type Draw = (rng: Rng) => string;
/** draw at the origin, half width, height, drawn variants */
const TEMPLATES = {
  bench: [(r) => E.bench(0, 0, r), 13, 17, 1],
  bird: [() => E.bird(-7, 0), 7, 4, 1],
  boat: [(r) => E.boat(-12, 0, 24, r), 13, 22, 1],
  bush: [(r) => E.bush(0, 0, 22, r), 11, 9, 3],
  butterfly: [() => E.butterfly(0, 0), 6, 6, 1],
  cabin: [(r) => E.cabin(-22, 0, 44, r), 28, 58, 2],
  deer: [(r) => E.deer(-4, 0, r), 16, 44, 1],
  duck: [(r) => E.duck(0, 0, r), 9, 16, 1],
  fence: [(r) => E.fence(-24, 24, 0, r), 27, 18, 2],
  fire: [(r) => E.campfire(0, 0, r), 16, 30, 1],
  fish: [() => E.fishJump(0, 0), 14, 18, 1],
  flower: [(r) => E.flower(0, 0, r), 3, 14, 2],
  hay: [(r) => E.haybale(0, 0, r), 11, 12, 1],
  mushroom: [(r) => E.mushroom(0, 0, r), 5, 10, 1],
  pebbles: [(r) => E.pebbles(0, 0, r), 10, 3, 2],
  pine: [(r) => E.pine(0, 0, 36, r), 15, 36, 4],
  rabbit: [(r) => E.rabbit(0, 0, r), 9, 19, 1],
  reeds: [(r) => E.reeds(-4, 0, r), 7, 19, 2],
  rock: [(r) => E.rock(-10, 0, 20, r), 10, 10, 3],
  sheep: [(r) => E.sheep(0, 0, r), 13, 19, 2],
  tent: [(r) => E.tent(0, 0, 38, r), 33, 34, 1],
  tower: [(r) => E.tower(0, 0, 56, r), 15, 56, 1],
  tree: [(r) => E.roundTree(0, 0, 46, r), 18, 46, 3],
  tuft: [(r) => E.tuft(0, 0, r), 6, 9, 3],
  well: [(r) => E.well(0, 0, r), 15, 38, 1],
  windmill: [(r) => E.windmill(0, 0, 62, r), 34, 76, 1],
} satisfies Record<string, [Draw, number, number, number]>;
type Element = keyof typeof TEMPLATES;

/** How much of an element's footprint is ink or filled colour (0..1). */
const FILL: Record<Element, number> = {
  bench: 0.5,
  bird: 0.3,
  boat: 0.9,
  bush: 1,
  butterfly: 0.5,
  cabin: 0.75,
  deer: 0.8,
  duck: 1,
  fence: 0.4,
  fire: 0.8,
  fish: 0.6,
  flower: 0.3,
  hay: 1,
  mushroom: 0.8,
  pebbles: 0.2,
  pine: 0.6,
  rabbit: 0.9,
  reeds: 0.4,
  rock: 0.9,
  sheep: 1,
  tent: 0.7,
  tower: 0.6,
  tree: 1,
  tuft: 0.3,
  well: 0.9,
  windmill: 0.9,
};
const SMALL = new Set<Element>(['tuft', 'pebbles', 'flower', 'butterfly']);
/** Extra copies placed around one: [min, max, spread]. */
const CLUSTER: Partial<Record<Element, [number, number, number]>> = {
  flower: [2, 5, 14],
  hay: [1, 3, 16],
  pine: [0, 2, 18],
  reeds: [0, 1, 8],
  sheep: [1, 3, 26],
  tuft: [0, 2, 10],
};
const FLIP = new Set<Element>([
  'pine',
  'tree',
  'bush',
  'tuft',
  'rock',
  'deer',
  'rabbit',
  'sheep',
  'duck',
  'reeds',
  'cabin',
  'pebbles',
]);

type Landmark = 'farm' | 'village' | 'lake' | 'river' | 'hills' | 'camp';
interface Biome {
  /** Elements per question-width it aims for, before the ceilings. */
  fill: number;
  /** Relative odds of each element. */
  items: Partial<Record<Element, number>>;
  landmark?: Landmark;
  /** Horizon height. */
  ridge: number;
}
export const BIOMES = {
  camp: {
    fill: 4.5,
    items: { mushroom: 0.3, pine: 4, rock: 0.3, tree: 0.4, tuft: 0.8 },
    landmark: 'camp',
    ridge: 12,
  },
  farm: {
    fill: 2,
    items: {
      fence: 0.25,
      flower: 0.6,
      hay: 0.3,
      sheep: 0.4,
      tree: 0.2,
      tuft: 1.4,
    },
    landmark: 'farm',
    ridge: 6,
  },
  forest: {
    fill: 4.5,
    items: {
      bush: 1,
      deer: 0.12,
      mushroom: 0.5,
      pine: 7,
      rabbit: 0.12,
      rock: 0.3,
      tree: 0.8,
      tuft: 0.8,
    },
    ridge: 14,
  },
  hills: {
    fill: 2.5,
    items: { deer: 0.12, pebbles: 0.8, pine: 0.4, rock: 1.4, tuft: 1.2 },
    landmark: 'hills',
    ridge: 36,
  },
  lake: {
    fill: 3,
    items: {
      bench: 0.1,
      bush: 0.5,
      flower: 0.8,
      reeds: 0.6,
      rock: 0.4,
      tree: 0.6,
      tuft: 1.2,
    },
    landmark: 'lake',
    ridge: 4,
  },
  meadow: {
    fill: 2.5,
    items: {
      bush: 0.35,
      butterfly: 0.35,
      flower: 1.8,
      rabbit: 0.2,
      rock: 0.2,
      sheep: 0.2,
      tree: 0.25,
      tuft: 3.2,
    },
    ridge: 8,
  },
  river: {
    fill: 3,
    items: {
      pebbles: 0.4,
      pine: 1.2,
      reeds: 0.6,
      rock: 0.6,
      tree: 0.5,
      tuft: 1.2,
    },
    landmark: 'river',
    ridge: 10,
  },
  village: {
    fill: 3,
    items: {
      bench: 0.15,
      bush: 0.8,
      fence: 0.3,
      flower: 1.2,
      rabbit: 0.1,
      tree: 0.7,
      tuft: 1,
    },
    landmark: 'village',
    ridge: 8,
  },
} satisfies Record<string, Biome>;
export type BiomeName = keyof typeof BIOMES;
const BIOME_NAMES = Object.keys(BIOMES) as BiomeName[];

export type Density = 'sparse' | 'medium' | 'dense';
/**
 * Labels from measure(): rerun it after changing a biome's mix and update
 * these (the trailMap test fails until they match).
 */
export const DENSITY: Record<BiomeName, Density> = {
  camp: 'dense',
  farm: 'medium',
  forest: 'dense',
  hills: 'sparse',
  lake: 'medium',
  meadow: 'sparse',
  river: 'medium',
  village: 'medium',
};

/** SVG markup with its horizontal extent in map units. */
export interface Piece {
  a: number;
  b: number;
  svg: string;
}
export interface Segment {
  a: number;
  b: number;
  biome: BiomeName;
}
export interface TrailMap {
  /** Visual weight per question-width, for measure(). */
  ink: Map<number, number>;
  /** Drawn after it: signpost, then placed elements back to front. */
  over: Piece[];
  /** Placed element x positions, for the budget test. */
  placed: number[];
  segments: Segment[];
  /** Question n sits at stops[n - 1]. */
  stops: Pt[];
  /** The walked line, start to summit. */
  trail: Pt[];
  /** Drawn before the trail: sky, horizon, fields, water, bridges, mountain. */
  under: Piece[];
  width: number;
}

const smooth = (t: number) => {
  const c = Math.max(0, Math.min(1, t));
  return c * c * (3 - 2 * c);
};

const TEMPLATE_ID = 'qbm';
let templateCache = '';
/** Every element variant as a <g>, placed on the map with <use>. Built once. */
export function templateDefs() {
  if (!templateCache)
    for (const [name, [draw, , , variants]] of Object.entries(TEMPLATES))
      for (let v = 0; v < variants; v++)
        templateCache += `<g id="${TEMPLATE_ID}-${name}-${v}">${(draw as Draw)(new Rng(`${name}-${v}`))}</g>`;
  return templateCache;
}

type Block = (x: number, y: number, top: number, r: number) => boolean;

class Builder {
  readonly width: number;
  readonly endX: number;
  segments: Segment[] = [];
  trail: Pt[] = [];
  stops: Pt[] = [];
  peak: Pt = [0, 0];
  ty: (x: number) => number = () => TRAIL_Y;
  rng: Rng;
  placed: { x: number; y: number; r: number }[] = [];
  blocks: Block[] = [];
  uses: { y: number; piece: Piece }[] = [];
  back: Piece[] = [];
  bridges: [number, number][] = [];
  ink = new Map<number, number>();
  used = new Map<number, number>();

  private readonly topicId: string;
  private readonly total: number;
  private readonly only?: BiomeName;

  constructor(topicId: string, total: number, only?: BiomeName) {
    this.topicId = topicId;
    this.total = total;
    this.only = only;
    this.endX = FIRST_X + (total - 1) * STEP;
    this.width = this.endX + SUMMIT_W;
    this.rng = this.rand('trail', 0);
    this.layoutSegments();
    this.layoutTrail();
  }

  /** Independent stream per purpose and index: earlier parts never shift. */
  rand(tag: string, i: number) {
    return new Rng(`${this.topicId}|${tag}|${i}`);
  }

  /** Shuffled bag of biomes: no repeats, no dense after dense, never three sparse in a row, a dense at least every fourth. */
  layoutSegments() {
    if (this.only) {
      this.segments = [{ a: 0, b: this.width, biome: this.only }];
      return;
    }
    const rng = this.rand('biomes', 0);
    let bag: BiomeName[] = [];
    let x = 0;
    while (x < this.width) {
      if (!bag.length) bag = rng.shuffle([...BIOME_NAMES]);
      const last = this.segments.slice(-2).map((s) => DENSITY[s.biome]);
      const sinceDense = [...this.segments]
        .reverse()
        .findIndex((s) => DENSITY[s.biome] === 'dense');
      const gap = sinceDense < 0 ? this.segments.length : sinceDense;
      const prev = this.segments.at(-1)?.biome;
      const fits = (b: BiomeName) => {
        const kind = DENSITY[b];
        if (b === prev || (last.at(-1) === 'dense' && kind === 'dense'))
          return false;
        if (
          last.length === 2 &&
          last.every((k) => k === 'sparse') &&
          kind === 'sparse'
        )
          return false;
        return kind === 'dense' || gap < 3;
      };
      let at = bag.findIndex(fits);
      let biome: BiomeName;
      if (at >= 0) biome = bag.splice(at, 1)[0];
      else {
        // nothing left in the bag fits: take a fitting biome from the full list
        biome = rng.shuffle([...BIOME_NAMES]).find(fits) ?? bag[0];
        at = bag.indexOf(biome);
        if (at >= 0) bag.splice(at, 1);
      }
      const length = rng.uniform(...BIOME_LENGTH);
      this.segments.push({ a: x, b: x + length, biome });
      x += length;
    }
  }

  layoutTrail() {
    const ph = [0, 0, 0].map(() => this.rng.uniform(0, Math.PI * 2));
    this.ty = (x) =>
      TRAIL_Y +
      9 * Math.sin(x / 70 + ph[0]) +
      6 * Math.sin(x / 31 + ph[1]) +
      2 * Math.sin(x / 13 + ph[2]);
    const pts: Pt[] = [];
    for (let x = 30; x <= this.endX + 60; x += 6) pts.push([x, this.ty(x)]);
    const [bx, by] = lastOf(pts);
    const climb: Pt[] = [
      [bx + 40, by - 8],
      [bx + 96, by - 26],
      [bx + 64, by - 52],
      [bx + 118, by - 74],
      [bx + 98, by - 100],
      [bx + 140, by - 122],
    ];
    this.trail = [
      ...pts,
      ...catmull([pts.at(-2) as Pt, lastOf(pts), ...climb], 10).slice(10),
    ];
    this.peak = lastOf(climb);
    for (let q = 0; q < this.total; q++) {
      const x = FIRST_X + q * STEP;
      this.stops.push([x, this.ty(x)]);
    }
  }

  weights(x: number) {
    const w = new Map<BiomeName, number>();
    for (const { biome, a, b } of this.segments) {
      const left = a <= 0 ? 1 : smooth((x - (a - BLEND)) / (2 * BLEND));
      const right =
        b >= this.width ? 1 : 1 - smooth((x - (b - BLEND)) / (2 * BLEND));
      const v = Math.min(left, right);
      if (v > 0) w.set(biome, (w.get(biome) ?? 0) + v);
    }
    let sum = 0;
    for (const v of w.values()) sum += v;
    for (const [k, v] of w) w.set(k, v / (sum || 1));
    return w;
  }

  pick(x: number) {
    const r = this.rng.next();
    let acc = 0;
    let last: BiomeName = this.segments[0].biome;
    for (const [k, v] of this.weights(x)) {
      acc += v;
      last = k;
      if (r <= acc) return k;
    }
    return last;
  }

  ridgeY(x: number) {
    let amp = 0;
    for (const [k, v] of this.weights(x)) amp += BIOMES[k].ridge * v;
    return (
      HORIZON_Y -
      amp *
        (0.55 + 0.45 * Math.sin(x / 47 + 1.3)) *
        (0.7 + 0.3 * Math.sin(x / 19))
    );
  }

  // ---------- placement ----------

  free(x: number, y: number, r: number, top: number) {
    if (
      x - r < 4 ||
      x + r > this.width - 4 ||
      top < HORIZON_Y - 30 ||
      y > MAP_HEIGHT - 4
    )
      return false;
    if (x > this.endX + 20) return false;
    const t = this.ty(x);
    if (!(y < t - 13 || top > t + 30)) return false;
    if (y < this.ridgeY(x) + 6) return false;
    if (this.blocks.some((b) => b(x, y, top, r))) return false;
    return !this.placed.some(
      (p) =>
        Math.abs(p.x - x) < (p.r + r) * 0.55 &&
        Math.abs(p.y - y) < 8 + (p.r + r) * 0.2
    );
  }

  scale(y: number) {
    return 0.62 + 0.43 * smooth((y - HORIZON_Y) / (MAP_HEIGHT - HORIZON_Y));
  }

  weight(name: Element, s: number) {
    const [, r, h] = TEMPLATES[name];
    return (2 * r * h * s * s * FILL[name]) / 100;
  }

  /** Spread a piece's visual weight over the question-widths it covers. */
  addInk(a0: number, b0: number, w: number) {
    const a = Math.max(a0, 0);
    const b = Math.max(b0, a + 1);
    for (let i = Math.floor(a / STEP); i <= Math.floor(b / STEP); i++) {
      const lo = Math.max(a, i * STEP);
      const hi = Math.min(b, (i + 1) * STEP);
      if (hi > lo)
        this.ink.set(i, (this.ink.get(i) ?? 0) + (w * (hi - lo)) / (b - a));
    }
  }

  put(
    name: Element,
    x: number,
    y: number,
    opts: { s?: number; flip?: boolean; force?: boolean } = {}
  ) {
    const [, r, h, variants] = TEMPLATES[name];
    const s = opts.s ?? this.scale(y) * this.rng.uniform(0.85, 1.12);
    if (!opts.force && !this.free(x, y, r * s, y - h * s)) return false;
    const flip = opts.flip ?? (FLIP.has(name) && this.rng.next() < 0.5);
    const v = Math.floor(this.rng.next() * variants);
    if (opts.force) {
      const bin = Math.floor(x / STEP);
      this.used.set(bin, (this.used.get(bin) ?? 0) + 1);
    }
    this.uses.push({
      piece: {
        a: x - r * s,
        b: x + r * s,
        svg: `<use href="#${TEMPLATE_ID}-${name}-${v}" transform="translate(${n(x)} ${n(y)}) scale(${(flip ? -s : s).toFixed(2)} ${s.toFixed(2)})"/>`,
      },
      y,
    });
    this.placed.push({ r: r * s, x, y });
    this.addInk(x - r * s, x + r * s, this.weight(name, s));
    return true;
  }

  blockRect(x0: number, y0: number, x1: number, y1: number) {
    this.blocks.push(
      (x, y, top, r) => x + r > x0 && x - r < x1 && y > y0 && top < y1
    );
  }

  above(x: number, gap = 16) {
    return this.ty(x) - gap;
  }

  // ---------- landmarks ----------

  landmarks() {
    this.segments.forEach(({ biome, a, b }, i) => {
      this.rng = this.rand('landmark', i);
      const kind: Landmark | undefined = (BIOMES[biome] as Biome).landmark;
      const mid = (a + b) / 2;
      if (!kind || mid > this.endX - 20 || mid < 90) return;
      this[kind](mid, a, b);
    });
  }

  farm(mid: number) {
    const x = mid + this.rng.uniform(-50, 50);
    this.put('windmill', x, this.above(x, 18), { force: true, s: 1 });
    this.blockRect(x - 36, HORIZON_Y - 30, x + 36, this.above(x, 18) + 2);
    // crop fields: one above the trail, one below
    for (const [fx, side] of [
      [x + 70, 'above'],
      [x - 60, 'below'],
    ] as const) {
      const t = this.ty(fx);
      let [y0, y1] =
        side === 'above'
          ? [this.ridgeY(fx) + 10, t - 16]
          : [t + 32, MAP_HEIGHT - 8];
      if (y1 - y0 < 16) continue;
      if (y1 - y0 > 40)
        [y0, y1] = side === 'above' ? [y1 - 40, y1] : [y0, y0 + 40];
      const w = 96;
      const poly: Pt[] = [
        [fx - w / 2, y1],
        [fx - w / 2 + 22, y0],
        [fx + w / 2 + 22, y0],
        [fx + w / 2, y1],
      ];
      this.addInk(
        fx - w / 2,
        fx + w / 2 + 22,
        (w * (y1 - y0) * 0.8 * COLOUR) / 100
      );
      this.back.push({
        a: fx - w / 2,
        b: fx + w / 2 + 22,
        svg:
          fill(poly, 'field', this.rng, 0.3) +
          line(this.rng, [...poly, poly[0]], 'ink-soft', 0.4) +
          hatch(poly, this.rng, 174, 4.6, 'crop', 0.95),
      });
      this.blockRect(fx - w / 2, y0 - 4, fx + w / 2 + 22, y1 + 2);
    }
    const hx = x - 50;
    for (let k = 0; k < 3; k++)
      this.put(
        'hay',
        hx + k * 15 + this.rng.uniform(-3, 3),
        this.above(hx) - this.rng.uniform(0, 8)
      );
  }

  /** A cabin pair and a well in the middle, then houses every 2 to 3 questions through the stretch. */
  village(mid: number, a: number, b: number) {
    for (let k = 0; k < 2; k++) {
      const cx = mid - 34 + k * 68 + this.rng.uniform(-8, 8);
      const y = this.above(cx) - this.rng.uniform(0, 14);
      this.put('cabin', cx, y, { force: true, s: this.rng.uniform(0.8, 1.05) });
      this.blockRect(cx - 30, y - 62, cx + 30, y + 3);
    }
    const wx = mid + this.rng.uniform(-20, 20);
    const wy = this.ty(wx) + 64;
    if (wy < MAP_HEIGHT - 4) {
      this.put('well', wx, wy, { force: true, s: 0.95 });
      this.blockRect(wx - 16, wy - 40, wx + 16, wy + 2);
    }
    for (
      let x = a + this.rng.uniform(60, 120);
      x < Math.min(b - 60, this.endX - 30);
      x += this.rng.uniform(130, 190)
    ) {
      if (x > mid - 110 && x < mid + 110) continue;
      let s = this.rng.uniform(0.7, 0.9);
      let y: number;
      if (this.rng.next() < 0.7) y = this.above(x) - this.rng.uniform(0, 18);
      else {
        s = 0.7;
        y = Math.min(MAP_HEIGHT - 3, this.ty(x) + 32 + 58 * s);
      }
      if (this.put('cabin', x, y, { s }))
        this.blockRect(x - 26, y - 58 * s - 4, x + 26, y + 3);
    }
  }

  lake(mid: number) {
    const x = mid + this.rng.uniform(-30, 30);
    const t = this.ty(x);
    const cy = (this.ridgeY(x) + t) / 2 + 2;
    const rx = this.rng.uniform(50, 70);
    const ry = 15;
    this.addInk(x - rx, x + rx, (Math.PI * rx * ry * COLOUR) / 100);
    this.back.push({
      a: x - rx - 4,
      b: x + rx + 4,
      svg: E.lake(x, cy, rx, ry, this.rng),
    });
    this.blocks.push(
      (px, py, top, r) =>
        ((px - x) / (rx + r + 6)) ** 2 + ((py - cy) / (ry + 10)) ** 2 < 1 ||
        (Math.abs(px - x) < rx + r && top < cy + ry && py > cy - ry - 4)
    );
    this.put('boat', x - rx * 0.45, cy + 4, { force: true, s: 0.9 });
    const ducks = this.rng.int(2, 3);
    for (let k = 0; k < ducks; k++)
      this.put(
        'duck',
        x + rx * (0.05 + 0.2 * k),
        cy + this.rng.uniform(-4, 6),
        { flip: k === 1, force: true, s: 0.85 }
      );
    for (const side of [-1, 1])
      this.put('reeds', x + side * (rx + 6), cy + 10, { force: true, s: 0.9 });
  }

  river(mid: number) {
    const x = mid + this.rng.uniform(-30, 30);
    const t = this.ty(x);
    const top = this.ridgeY(x) + 2;
    const drift = this.rng.uniform(-14, 14);
    const pts: Pt[] = [
      [x + drift * 0.6, top],
      [x + 8, top + 30],
      [x - 6, (top + t) / 2 + 10],
      [x, t],
      [x - 10, t + 34],
      [x + drift, MAP_HEIGHT + 8],
    ];
    this.addInk(x - 20, x + 30, (16 * (MAP_HEIGHT - top) * 0.8 * COLOUR) / 100);
    this.back.push({ a: x - 40, b: x + 50, svg: E.stream(pts, this.rng, 16) });
    this.blocks.push((px, _py, _top, r) => Math.abs(px - (x + 8)) < r + 22);
    this.bridges.push([x - 18, x + 34]);
    this.put('fish', x + 6, t + 58, { force: true, s: 0.9 });
  }

  hills(mid: number) {
    const x = mid + this.rng.uniform(-40, 40);
    this.put('tower', x, this.above(x), { force: true, s: 1 });
    this.blockRect(x - 16, HORIZON_Y - 40, x + 16, this.above(x) + 2);
  }

  camp(mid: number) {
    const x = mid + this.rng.uniform(-30, 30);
    const y = this.above(x);
    this.put('tent', x, y, { force: true, s: 1 });
    this.blockRect(x - 36, y - 40, x + 36, y + 2);
    const fx = x + 52;
    const fy = this.above(fx, 20);
    this.put('fire', fx, fy, { force: true, s: 0.9 });
    this.blockRect(fx - 18, fy - 30, fx + 24, fy + 4);
  }

  // ---------- scatter ----------

  /** Fill each question-width up to its budget, left to right, one seeded stream per question-width. */
  scatter() {
    const maxOdds = 9;
    for (let bin = 0; bin <= Math.floor((this.endX + 10) / STEP); bin++) {
      this.rng = this.rand('bin', bin);
      const x0 = bin * STEP;
      let budget = 0;
      for (const [k, v] of this.weights(x0 + STEP / 2))
        budget += BIOMES[k].fill * v;
      budget = Math.min(COUNT_CAP, budget);
      for (
        let attempt = 0;
        attempt < 70 && (this.used.get(bin) ?? 0) < budget;
        attempt++
      ) {
        const x = this.rng.uniform(Math.max(8, x0), x0 + STEP);
        const y = this.rng.uniform(HORIZON_Y + 4, MAP_HEIGHT - 2);
        const items = Object.entries(BIOMES[this.pick(x)].items) as [
          Element,
          number,
        ][];
        const total = items.reduce((sum, [, d]) => sum + d, 0);
        if (this.rng.next() > total / maxOdds) continue;
        let r = this.rng.next() * total;
        let name = items[0][0];
        for (const [item, odds] of items) {
          name = item;
          r -= odds;
          if (r <= 0) break;
        }
        const group: Pt[] = [[x, y]];
        const cluster = CLUSTER[name];
        if (cluster) {
          const [lo, hi, spread] = cluster;
          const extra = this.rng.int(lo, hi);
          for (let k = 0; k < extra; k++)
            group.push([
              x + this.rng.uniform(-spread, spread),
              y + this.rng.uniform(-spread * 0.4, spread * 0.4),
            ]);
        }
        const cost = SMALL.has(name) ? 0.5 : 1;
        for (const [gx, gy] of group) {
          if ((this.used.get(bin) ?? 0) + cost > budget) break;
          if (
            (this.ink.get(bin) ?? 0) + this.weight(name, this.scale(gy)) >
            INK_CAP
          )
            break;
          if (this.put(name, gx, gy))
            this.used.set(bin, (this.used.get(bin) ?? 0) + cost);
        }
      }
    }
  }

  // ---------- backdrop ----------

  sky() {
    const rng = this.rand('sky', 0);
    const out: Piece[] = [];
    for (
      let x = rng.uniform(40, 200);
      x < this.width - 60;
      x += rng.uniform(120, 260)
    ) {
      const y = rng.uniform(22, HORIZON_Y - 18);
      if (rng.next() >= 0.6) continue;
      const count = rng.int(2, 3);
      let svg = '';
      for (let k = 0; k < count; k++)
        svg += `<use href="#${TEMPLATE_ID}-bird-0" transform="translate(${n(x + k * 14)} ${n(y + rng.uniform(-5, 5))}) scale(.9)"/>`;
      out.push({ a: x - 8, b: x + count * 14 + 8, svg });
    }
    return out;
  }

  /** Ridge line in short pieces (endpoints shared, so no joins show), slope shading, distant tree line. */
  horizon() {
    const rng = this.rand('horizon', 0);
    const pts: Pt[] = [];
    for (let x = 0; x <= this.width; x += 8) pts.push([x, this.ridgeY(x)]);
    const out: Piece[] = [];
    for (let i = 0; i < pts.length - 1; i += 6) {
      const piece = pts.slice(i, i + 7);
      out.push({
        a: piece[0][0],
        b: lastOf(piece)[0],
        svg: sketch(piece, rng, 'ink-soft', { amp: 0.6, passes: 1 }),
      });
    }
    for (let i = 0; i + 3 < pts.length; i += 3) {
      const [x0, y0] = pts[i];
      const [x1, y1] = pts[i + 3];
      if (y1 > y0 + 3 && y0 < HORIZON_Y - 14)
        out.push({
          a: x0,
          b: x1,
          svg: hatch(
            [
              [x0, y0],
              [x1, y1],
              [x1, HORIZON_Y],
              [x0, HORIZON_Y],
            ],
            rng,
            118,
            3.4,
            'ink-hatch',
            0.6
          ),
        });
    }
    for (let x = 10; x < this.width - 10; x += rng.uniform(5, 9)) {
      const w = this.weights(x);
      if (
        (w.get('forest') ?? 0) + (w.get('camp') ?? 0) >
        rng.uniform(0.2, 0.9)
      ) {
        const y = this.ridgeY(x) + 3;
        const h = rng.uniform(7, 12);
        out.push({
          a: x - 5,
          b: x + 5,
          svg: `<path class="tm-ink-soft" d="M${n(x - h * 0.35)} ${n(y)} ${n(x)} ${n(y - h)} ${n(x + h * 0.35)} ${n(y)}"/>`,
        });
      }
    }
    return out;
  }

  summit(): Piece {
    const bx = this.endX + 60;
    const [px, py] = this.peak;
    const rng = this.rand('summit', this.total);
    const base = MAP_HEIGHT - 10;
    const svg =
      hatch(
        [
          [px, py - 6],
          [px, base],
          [bx + 260, base],
          [px + 50, py + 60],
        ],
        rng,
        118,
        3.4,
        'ink-hatch',
        0.9
      ) +
      hatch(
        [
          [px, py - 6],
          [bx + 30, py + 100],
          [px, py + 120],
        ],
        rng,
        62,
        6,
        'ink-hatch',
        0.4
      ) +
      sketch(
        [
          [bx - 20, base],
          [bx + 40, py + 90],
          [px - 30, py + 30],
          [px, py - 6],
        ],
        rng,
        'ink',
        { amp: 1.1 }
      ) +
      sketch(
        [
          [px, py - 6],
          [px + 26, py + 34],
          [px + 46, py + 70],
          [bx + 230, base],
        ],
        rng,
        'ink',
        { amp: 1.1 }
      ) +
      sketch(
        [
          [px - 20, py + 18],
          [px - 10, py + 24],
          [px - 2, py + 14],
          [px + 8, py + 26],
          [px + 18, py + 20],
        ],
        rng,
        'ink',
        { amp: 0.4, passes: 1 }
      ) +
      E.flag(px, py, rng);
    return { a: bx - 30, b: this.width, svg };
  }

  build(startLabel: string): TrailMap {
    this.landmarks();
    this.scatter();
    const bridges = this.bridges.map(([x0, x1], i) => ({
      a: x0 - 4,
      b: x1 + 4,
      svg: E.bridge(x0, x1, this.ty((x0 + x1) / 2), this.rand('bridge', i)),
    }));
    const over: Piece[] = [
      {
        a: 0,
        b: 64,
        svg: E.signpost(18, this.ty(30), startLabel, this.rand('start', 0)),
      },
    ];
    for (const u of [...this.uses].sort((p, q) => p.y - q.y))
      over.push(u.piece);
    return {
      ink: this.ink,
      over,
      placed: this.placed.map((p) => p.x),
      segments: this.segments,
      stops: this.stops,
      trail: this.trail,
      under: [
        ...this.sky(),
        ...this.horizon(),
        ...this.back,
        ...bridges,
        this.summit(),
      ],
      width: this.width,
    };
  }
}

/** The map for one topic. Same id and question count, same map. */
export const buildTrailMap = (
  topicId: string,
  total: number,
  startLabel: string
) => new Builder(topicId, total).build(startLabel);

/** Mean visual weight per question-width of each biome on its own, over many seeds. */
export function measure(seeds = 30, total = 20) {
  const out = {} as Record<BiomeName, number>;
  for (const biome of BIOME_NAMES) {
    let sum = 0;
    for (let k = 0; k < seeds; k++) {
      const map = new Builder(`measure-${biome}-${k}`, total, biome).build('');
      const last = Math.floor((FIRST_X + (total - 1) * STEP) / STEP) - 1;
      let weight = 0;
      for (let i = 2; i < last; i++) weight += map.ink.get(i) ?? 0;
      sum += weight / (last - 2);
    }
    out[biome] = sum / seeds;
  }
  return out;
}

/** Visual-weight label for a measured value. */
export const densityOf = (weight: number): Density =>
  weight < KIND_EDGES[0]
    ? 'sparse'
    : weight < KIND_EDGES[1]
      ? 'medium'
      : 'dense';
