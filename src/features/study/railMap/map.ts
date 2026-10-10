/**
 * Learning's progress map: a workspace's tracked items as stops on a railway
 * line, a station at each chapter start, scenery from seeded biomes in between
 * (city and industry through town and farms to open country). Same rules as
 * the question bank's map: measured density labels, rhythm, a per
 * question-width budget, and the same workspace always draws the same map.
 */
import * as E from '@/features/questions/trailMap/elements';
import {
  fill,
  hatch,
  lastOf,
  n,
  type Pt,
  polyD,
  Rng,
  sketch,
} from '@/features/questions/trailMap/sketch';
import * as B from './buildings';

export const MAP_HEIGHT = 236;
const HORIZON_Y = 60;
const TRAIL_Y = 160;
/** Line distance between two items; also the unit of the budget. */
export const STEP = 60;
const BLEND = 60;
/** Biome length in map units: about 4 to 7 items each. */
const BIOME_LENGTH = [260, 440] as const;
/** Elements per question-width, small ground marks counting half. */
const COUNT_CAP = 6;
/** The visual-weight ceiling is split between the ground above and below the line, roughly by height. */
const SIDES = { above: 0.56, below: 0.44 } as const;
type Side = keyof typeof SIDES;
/** Coloured fills (water, crop fields) read heavier than line drawing of the same size. */
const COLOUR = 1.6;
/** Measured weight per question-width that separates sparse | medium | dense. */
export const KIND_EDGES = [7, 16] as const;
/** Name board lines on a station, at most two of this many characters. */
const LINE_CHARS = 18;
const SPACES = /\s+/;
const TRAILING_PUNCTUATION = /[\s,:;-]+$/;

type Draw = (rng: Rng) => string;
/** draw at the origin, half width, height, drawn variants */
const TEMPLATES = {
  barn: [B.barn, 22, 34, 1],
  barrels: [B.barrels, 9, 16, 2],
  bench: [(r) => E.bench(0, 0, r), 13, 17, 1],
  bird: [() => E.bird(-7, 0), 7, 4, 1],
  block: [B.block, 19, 66, 4],
  boat: [(r) => E.boat(-12, 0, 24, r), 13, 22, 1],
  bus: [B.bus, 20, 18, 2],
  bush: [(r) => E.bush(0, 0, 22, r), 11, 9, 3],
  butterfly: [() => E.butterfly(0, 0), 6, 6, 1],
  car: [B.car, 11, 12, 4],
  chimneys: [B.chimneys, 14, 98, 1],
  church: [B.church, 22, 73, 1],
  clocktower: [B.clockTower, 12, 94, 1],
  containers: [B.containers, 16, 16, 3],
  cow: [B.cow, 15, 14, 2],
  crane: [B.crane, 28, 94, 1],
  deer: [(r) => E.deer(-4, 0, r), 16, 44, 1],
  duck: [(r) => E.duck(0, 0, r), 9, 16, 1],
  factory: [B.factory, 30, 84, 3],
  fence: [(r) => E.fence(-24, 24, 0, r), 27, 18, 2],
  flower: [(r) => E.flower(0, 0, r), 3, 14, 2],
  hay: [(r) => E.haybale(0, 0, r), 11, 12, 1],
  hedge: [B.hedge, 20, 10, 3],
  house: [B.house, 16, 33, 5],
  lamp: [B.lamp, 4, 28, 1],
  mushroom: [(r) => E.mushroom(0, 0, r), 5, 10, 1],
  oak: [B.oak, 24, 60, 1],
  office: [B.office, 14, 90, 2],
  pebbles: [(r) => E.pebbles(0, 0, r), 10, 3, 2],
  pine: [(r) => E.pine(0, 0, 36, r), 15, 36, 4],
  pylon: [B.pylon, 13, 62, 1],
  rabbit: [(r) => E.rabbit(0, 0, r), 9, 19, 1],
  reeds: [(r) => E.reeds(-4, 0, r), 7, 19, 2],
  rock: [(r) => E.rock(-10, 0, 20, r), 10, 10, 3],
  sheep: [(r) => E.sheep(0, 0, r), 13, 19, 2],
  shop: [B.shop, 18, 24, 4],
  silo: [B.silo, 8, 50, 1],
  streettree: [(r) => E.roundTree(0, 0, 32, r), 12, 32, 2],
  tanks: [B.tanks, 18, 29, 2],
  terrace: [B.terrace, 26, 35, 3],
  tower: [B.tower, 13, 86, 4],
  tractor: [B.tractor, 12, 19, 2],
  tree: [(r) => E.roundTree(0, 0, 46, r), 18, 46, 3],
  truck: [B.truck, 22, 19, 3],
  tuft: [(r) => E.tuft(0, 0, r), 6, 9, 3],
  wall: [B.wall, 20, 6, 2],
  warehouse: [B.warehouse, 27, 31, 3],
} satisfies Record<string, [Draw, number, number, number]>;
type Element = keyof typeof TEMPLATES;

/** How much of an element's footprint is ink or filled colour (0..1). */
const FILL: Record<Element, number> = {
  barn: 0.85,
  barrels: 0.8,
  bench: 0.5,
  bird: 0.3,
  block: 0.9,
  boat: 0.9,
  bus: 0.9,
  bush: 1,
  butterfly: 0.5,
  car: 0.8,
  chimneys: 0.45,
  church: 0.55,
  clocktower: 0.5,
  containers: 0.9,
  cow: 0.7,
  crane: 0.25,
  deer: 0.8,
  duck: 1,
  factory: 0.7,
  fence: 0.4,
  flower: 0.3,
  hay: 1,
  hedge: 0.9,
  house: 0.75,
  lamp: 0.3,
  mushroom: 0.8,
  oak: 0.9,
  office: 0.9,
  pebbles: 0.2,
  pine: 0.6,
  pylon: 0.3,
  rabbit: 0.9,
  reeds: 0.4,
  rock: 0.9,
  sheep: 1,
  shop: 0.9,
  silo: 0.8,
  streettree: 1,
  tanks: 0.8,
  terrace: 0.85,
  tower: 0.9,
  tractor: 0.7,
  tree: 1,
  truck: 0.85,
  tuft: 0.3,
  wall: 0.9,
  warehouse: 0.85,
};
const SMALL = new Set<Element>([
  'tuft',
  'pebbles',
  'flower',
  'butterfly',
  'lamp',
]);
/** Extra copies placed around one: [min, max, spread]. */
const CLUSTER: Partial<Record<Element, [number, number, number]>> = {
  car: [0, 1, 22],
  cow: [0, 2, 26],
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
  'streettree',
  'bush',
  'tuft',
  'rock',
  'deer',
  'rabbit',
  'sheep',
  'duck',
  'reeds',
  'pebbles',
  'cow',
  'car',
  'bus',
  'truck',
  'tractor',
  'house',
  'factory',
  'warehouse',
  'tanks',
  'shop',
  'oak',
  'hedge',
]);
/** Tall buildings that may stand in the front row cut off by the bottom edge, with the most of their height that may be hidden. */
const CROP: Partial<Record<Element, number>> = {
  block: 0.45,
  office: 0.45,
  tanks: 0.3,
  tower: 0.45,
  warehouse: 0.3,
};

type Landmark = 'city' | 'industry' | 'town' | 'farm' | 'country' | 'river';
interface Row {
  fill: number;
  gap: readonly [number, number];
  items: Partial<Record<Element, number>>;
}
interface Biome {
  /** Elements per question-width it aims for, before the ceilings. */
  fill: number;
  /** The same along the bottom edge, in front of the line. */
  front?: Row;
  /** Visual-weight ceiling per question-width. */
  ink: number;
  /** Relative odds of each scattered element. */
  items: Partial<Record<Element, number>>;
  landmark?: Landmark;
  /** Horizon height. */
  ridge: number;
  /** Buildings set side by side behind the line (fill: chance a slot is used). */
  row?: Row;
  treeline?: boolean;
  /** City and industry 3, town 2, farms 1, open country 0; a river goes anywhere. */
  urban: number | null;
}
export const BIOMES = {
  city: {
    fill: 6,
    front: {
      fill: 0.96,
      gap: [1, 5],
      items: {
        block: 1.8,
        bus: 0.2,
        car: 0.5,
        office: 0.6,
        shop: 1.8,
        streettree: 0.5,
        tower: 1.2,
      },
    },
    ink: 40,
    items: {
      bench: 0.3,
      bush: 0.4,
      car: 0.4,
      lamp: 0.8,
      streettree: 0.7,
      tuft: 0.3,
    },
    landmark: 'city',
    ridge: 3,
    row: {
      fill: 0.96,
      gap: [1, 5],
      items: { block: 3, office: 1.6, tower: 3 },
    },
    urban: 3,
  },
  country: {
    fill: 2.2,
    ink: 22,
    items: {
      bush: 0.4,
      butterfly: 0.3,
      flower: 1.4,
      hedge: 0.45,
      house: 0.06,
      pylon: 0.05,
      rabbit: 0.12,
      rock: 0.25,
      sheep: 0.35,
      tree: 0.6,
      tuft: 2.4,
      wall: 0.3,
    },
    landmark: 'country',
    ridge: 14,
    urban: 0,
  },
  farms: {
    fill: 2.2,
    ink: 22,
    items: {
      cow: 0.45,
      fence: 0.25,
      flower: 0.5,
      hay: 0.3,
      hedge: 0.15,
      sheep: 0.2,
      tractor: 0.08,
      tree: 0.2,
      tuft: 1.4,
    },
    landmark: 'farm',
    ridge: 8,
    urban: 1,
  },
  industry: {
    fill: 5,
    front: {
      fill: 0.9,
      gap: [2, 9],
      items: {
        barrels: 0.4,
        block: 0.5,
        containers: 1.4,
        tanks: 1.2,
        truck: 0.7,
        warehouse: 2,
      },
    },
    ink: 36,
    items: {
      barrels: 0.6,
      pebbles: 0.6,
      pylon: 0.12,
      rock: 0.3,
      truck: 0.2,
      tuft: 1,
    },
    landmark: 'industry',
    ridge: 4,
    row: {
      fill: 0.9,
      gap: [2, 9],
      items: { chimneys: 0.7, factory: 3, tanks: 1.6, warehouse: 2 },
    },
    urban: 3,
  },
  river: {
    fill: 2.6,
    ink: 22,
    items: {
      bush: 0.4,
      pebbles: 0.3,
      reeds: 0.8,
      rock: 0.4,
      tree: 0.5,
      tuft: 1.2,
    },
    landmark: 'river',
    ridge: 10,
    urban: null,
  },
  town: {
    fill: 3.2,
    front: {
      fill: 0.22,
      gap: [24, 60],
      items: { car: 0.4, fence: 0.7, house: 1, streettree: 0.8 },
    },
    ink: 22,
    items: {
      bench: 0.15,
      bush: 0.8,
      flower: 1.2,
      lamp: 0.3,
      tree: 0.5,
      tuft: 1,
    },
    landmark: 'town',
    ridge: 6,
    row: {
      fill: 0.6,
      gap: [8, 28],
      items: { house: 3, terrace: 1.4, tree: 1.2 },
    },
    urban: 2,
  },
  woods: {
    fill: 4.5,
    ink: 22,
    items: {
      bush: 1,
      deer: 0.12,
      mushroom: 0.5,
      pine: 7,
      rabbit: 0.1,
      tree: 0.8,
      tuft: 0.8,
    },
    ridge: 14,
    treeline: true,
    urban: 0,
  },
} satisfies Record<string, Biome>;
export type BiomeName = keyof typeof BIOMES;
const BIOME_NAMES = Object.keys(BIOMES) as BiomeName[];
const biome = (name: BiomeName): Biome => BIOMES[name];

export type Density = 'sparse' | 'medium' | 'dense';
/**
 * Labels from measure(): rerun it after changing a biome's mix and update
 * these (the railMap test fails until they match).
 */
export const DENSITY: Record<BiomeName, Density> = {
  city: 'dense',
  country: 'sparse',
  farms: 'medium',
  industry: 'dense',
  river: 'sparse',
  town: 'medium',
  woods: 'medium',
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
export interface RailMap {
  /** Visual weight per question-width, both sides summed, for measure(). */
  ink: Map<number, number>;
  /** Drawn after the backdrop: stations, then placed elements back to front. */
  over: Piece[];
  placed: number[];
  segments: Segment[];
  /** Each station's extent, the terminus last, so the Next tag can rise above one. */
  stations: { a: number; b: number }[];
  /** Item i sits at stops[i]. */
  stops: Pt[];
  /** The line, start to buffer stop. */
  trail: Pt[];
  /** Sky, horizon, fields, water, bridges. */
  under: Piece[];
  width: number;
}

const smooth = (t: number) => {
  const c = Math.max(0, Math.min(1, t));
  return c * c * (3 - 2 * c);
};

/** A chapter name on at most two board lines; longer names end in an ellipsis. */
export function wrapName(name: string) {
  const lines: string[] = [];
  let cur = '';
  for (let word of name.split(SPACES).filter(Boolean)) {
    while (word.length > LINE_CHARS) {
      if (cur) lines.push(cur);
      cur = '';
      lines.push(`${word.slice(0, LINE_CHARS - 1)}-`);
      word = word.slice(LINE_CHARS - 1);
    }
    if (!cur) cur = word;
    else if (cur.length + 1 + word.length <= LINE_CHARS) cur += ` ${word}`;
    else {
      lines.push(cur);
      cur = word;
    }
  }
  if (cur) lines.push(cur);
  if (lines.length > 2)
    return [
      lines[0],
      `${lines[1].slice(0, LINE_CHARS - 1).replace(TRAILING_PUNCTUATION, '')}…`,
    ];
  return lines.length ? lines : [''];
}

const TEMPLATE_ID = 'rlm';
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
  readonly termX: number;
  readonly lineEnd: number;
  xs: number[] = [];
  starts: { sx: number; right: number; lines: string[] }[] = [];
  segments: Segment[] = [];
  trail: Pt[] = [];
  stops: Pt[] = [];
  ty: (x: number) => number = () => TRAIL_Y;
  placed: { x: number; y: number; r: number }[] = [];
  blocks: Block[] = [];
  uses: { y: number; piece: Piece }[] = [];
  back: Piece[] = [];
  bridges: [number, number][] = [];
  ink = new Map<string, number>();
  used = new Map<number, number>();

  private readonly id: string;
  private readonly only?: BiomeName;

  constructor(
    id: string,
    chapters: readonly string[],
    items: readonly (number | null)[],
    minWidth: number,
    only?: BiomeName
  ) {
    this.id = id;
    this.only = only;
    // Each chapter opens with its station and the first item comes a little
    // after the platform; unfiled items have no station and just follow on.
    let x = 20;
    items.forEach((chapter, i) => {
      if (chapter === null) x += i === 0 ? 60 : STEP;
      else if (i === 0 || chapter !== items[i - 1]) {
        const sx = x + (i === 0 ? 40 : 56);
        const lines = wrapName(chapters[chapter]);
        const right = sx + B.stationWidth(lines);
        this.starts.push({ lines, right, sx });
        x = right + 52;
      } else x += STEP;
      this.xs.push(x);
    });
    this.endX = this.xs.at(-1) ?? 20;
    this.termX = this.endX + 60;
    this.lineEnd = this.termX + B.stationWidth(['Terminus']) + 26;
    // A short workspace still fills the panel: the scenery runs on past the buffer stop.
    this.width = Math.max(this.lineEnd + 70, minWidth);
    this.layoutSegments();
    this.layoutTrail();
  }

  /** Independent stream per purpose and index: earlier parts never shift. */
  rand(tag: string, i: number | string) {
    return new Rng(`${this.id}|${tag}|${i}`);
  }

  /**
   * Shuffled bag of biomes: no repeats, no dense after dense, never three
   * sparse in a row; (gradient) the urban level changes by at most one across
   * a border, so a city thins out through town; (rhythm) a dense one at least
   * every fifth. When nothing fits, rhythm gives way first, then the gradient.
   */
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
      const fits = (b: BiomeName, gradient = true, rhythm = true) => {
        const kind = DENSITY[b];
        if (b === prev || (last.at(-1) === 'dense' && kind === 'dense'))
          return false;
        if (
          last.length === 2 &&
          last.every((k) => k === 'sparse') &&
          kind === 'sparse'
        )
          return false;
        if (gradient && prev) {
          const [u0, u1] = [biome(prev).urban, biome(b).urban];
          if (u0 !== null && u1 !== null && Math.abs(u0 - u1) > 1) return false;
        }
        return !rhythm || kind === 'dense' || gap < 4;
      };
      let at = bag.findIndex((b) => fits(b));
      let name: BiomeName;
      if (at >= 0) name = bag.splice(at, 1)[0];
      else {
        const pool = rng.shuffle([...BIOME_NAMES]);
        name =
          pool.find((b) => fits(b)) ??
          pool.find((b) => fits(b, true, false)) ??
          pool.find((b) => fits(b, false, false)) ??
          bag[0];
        at = bag.indexOf(name);
        if (at >= 0) bag.splice(at, 1);
      }
      const length = rng.uniform(...BIOME_LENGTH);
      this.segments.push({ a: x, b: x + length, biome: name });
      x += length;
    }
  }

  /** A gentle seeded wander; stations keep no level ground and may overlap the line. */
  layoutTrail() {
    const rng = this.rand('trail', 0);
    const ph = [0, 0, 0].map(() => rng.uniform(0, Math.PI * 2));
    this.ty = (x) =>
      TRAIL_Y +
      7 * Math.sin(x / 90 + ph[0]) +
      4 * Math.sin(x / 37 + ph[1]) +
      1.5 * Math.sin(x / 13 + ph[2]);
    for (let x = 20; x <= this.lineEnd; x += 6)
      this.trail.push([x, this.ty(x)]);
    this.stops = this.xs.map((x) => [x, this.ty(x)]);
  }

  weights(x: number) {
    const w = new Map<BiomeName, number>();
    for (const { biome: name, a, b } of this.segments) {
      const left = a <= 0 ? 1 : smooth((x - (a - BLEND)) / (2 * BLEND));
      const right =
        b >= this.width ? 1 : 1 - smooth((x - (b - BLEND)) / (2 * BLEND));
      const v = Math.min(left, right);
      if (v > 0) w.set(name, (w.get(name) ?? 0) + v);
    }
    let sum = 0;
    for (const v of w.values()) sum += v;
    for (const [k, v] of w) w.set(k, v / (sum || 1));
    return w;
  }

  pick(x: number, rng: Rng) {
    const r = rng.next();
    let acc = 0;
    let last: BiomeName = this.segments[0].biome;
    for (const [k, v] of this.weights(x)) {
      acc += v;
      last = k;
      if (r <= acc) return k;
    }
    return last;
  }

  blended(x: number, key: 'fill' | 'ink' | 'ridge') {
    let sum = 0;
    for (const [k, v] of this.weights(x)) sum += biome(k)[key] * v;
    return sum;
  }

  ridgeY(x: number) {
    return (
      HORIZON_Y -
      this.blended(x, 'ridge') *
        (0.55 + 0.45 * Math.sin(x / 47 + 1.3)) *
        (0.7 + 0.3 * Math.sin(x / 19))
    );
  }

  // ---------- placement ----------

  /** Room for an element: off the line, under the horizon, clear of blocks and others. A cropped one may stand below the bottom edge. */
  free(x: number, y: number, r: number, top: number, crop: boolean) {
    if (crop ? top > MAP_HEIGHT - 14 : y > MAP_HEIGHT - 2) return false;
    if (x - r < 4 || x + r > this.width - 4 || top < 14) return false;
    const t = this.ty(x);
    if (!(y < t - 6 || top > t + 12)) return false;
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

  /** Visual weight; a building cut off by the bottom edge counts only its visible part. */
  weight(name: Element, s: number, y: number) {
    const [, r, h] = TEMPLATES[name];
    const vis = y <= MAP_HEIGHT ? h * s : Math.max(0, MAP_HEIGHT - (y - h * s));
    return (2 * r * vis * s * FILL[name]) / 100;
  }

  side(x: number, y: number): Side {
    return y < this.ty(x) ? 'above' : 'below';
  }

  /** Spread a piece's weight over its question-widths, in one side's pool (or both). */
  addInk(a0: number, b0: number, w: number, side?: Side) {
    if (!side) {
      for (const k of Object.keys(SIDES) as Side[])
        this.addInk(a0, b0, w * SIDES[k], k);
      return;
    }
    const a = Math.max(a0, 0);
    const b = Math.max(b0, a + 1);
    for (let i = Math.floor(a / STEP); i <= Math.floor(b / STEP); i++) {
      const lo = Math.max(a, i * STEP);
      const hi = Math.min(b, (i + 1) * STEP);
      const key = `${i}|${side}`;
      if (hi > lo)
        this.ink.set(key, (this.ink.get(key) ?? 0) + (w * (hi - lo)) / (b - a));
    }
  }

  /** Every question-width the piece covers stays under its side's share of the biome's ceiling. */
  inkFits(a0: number, b0: number, w: number, side: Side) {
    const a = Math.max(a0, 0);
    const b = Math.max(b0, a + 1);
    for (let i = Math.floor(a / STEP); i <= Math.floor(b / STEP); i++) {
      const lo = Math.max(a, i * STEP);
      const hi = Math.min(b, (i + 1) * STEP);
      if (
        hi > lo &&
        (this.ink.get(`${i}|${side}`) ?? 0) + (w * (hi - lo)) / (b - a) >
          SIDES[side] * this.blended(i * STEP + STEP / 2, 'ink')
      )
        return false;
    }
    return true;
  }

  put(
    name: Element,
    x: number,
    y: number,
    rng: Rng,
    opts: { s?: number; flip?: boolean; force?: boolean } = {}
  ) {
    const [, r, h, variants] = TEMPLATES[name];
    const s = opts.s ?? this.scale(y) * rng.uniform(0.85, 1.12);
    const side = this.side(x, y);
    const weight = this.weight(name, s, y);
    if (
      !opts.force &&
      (!this.free(x, y, r * s, y - h * s, y > MAP_HEIGHT) ||
        !this.inkFits(x - r * s, x + r * s, weight, side))
    )
      return false;
    const flip = opts.flip ?? (FLIP.has(name) && rng.next() < 0.5);
    const v = rng.int(0, variants - 1);
    this.uses.push({
      piece: {
        a: x - r * s,
        b: x + r * s,
        svg: `<use href="#${TEMPLATE_ID}-${name}-${v}" transform="translate(${n(x)} ${n(y)}) scale(${(flip ? -s : s).toFixed(2)} ${s.toFixed(2)})"/>`,
      },
      y,
    });
    this.placed.push({ r: r * s, x, y });
    this.addInk(x - r * s, x + r * s, weight, side);
    const bin = Math.floor(x / STEP);
    this.used.set(bin, (this.used.get(bin) ?? 0) + (SMALL.has(name) ? 0.5 : 1));
    return true;
  }

  blockRect(x0: number, y0: number, x1: number, y1: number) {
    this.blocks.push(
      (x, y, top, r) => x + r > x0 && x - r < x1 && y > y0 && top < y1
    );
  }

  /** Where an element stands just behind the line. */
  behind(x: number, gap = 16) {
    return this.ty(x) - gap;
  }

  // ---------- stations ----------

  stations(): Piece[] {
    const out: Piece[] = [];
    this.starts.forEach(({ sx, lines }, k) => {
      const y = this.ty(sx + 60);
      const { right, svg, top } = B.station(
        sx,
        y,
        lines,
        this.rand('station', k)
      );
      out.push({ a: sx - 4, b: right, svg });
      this.blockRect(sx - 6, top - 6, right + 4, y - 8);
    });
    const y = this.ty(this.termX + 60);
    this.blockRect(this.termX - 6, y - 90, this.lineEnd + 12, y - 4);
    const end = B.station(
      this.termX,
      y,
      ['Terminus'],
      this.rand('station', 'end'),
      true
    );
    out.push({ a: this.termX - 4, b: end.right, svg: end.svg });
    out.push({
      a: end.right,
      b: this.lineEnd + 12,
      svg: B.bufferStop(this.lineEnd + 2, y, this.rand('buffer', 0)),
    });
    return out;
  }

  // ---------- landmarks ----------

  landmarks() {
    this.segments.forEach(({ biome: name, a, b }, i) => {
      const rng = this.rand('landmark', i);
      const kind = biome(name).landmark;
      const mid = (a + b) / 2 + rng.uniform(-30, 30);
      if (!kind || mid > this.width - 60 || mid < 120) return;
      this[kind](mid, rng);
    });
  }

  city(x: number, rng: Rng) {
    const name = rng.next() < 0.5 ? 'clocktower' : 'crane';
    if (this.put(name, x, this.behind(x, 20), rng, { s: 1 }))
      this.blockRect(x - 16, 0, x + 16, this.behind(x) + 2);
  }

  industry(x: number, rng: Rng) {
    if (this.put('chimneys', x, this.behind(x, 18), rng, { s: 1 }))
      this.blockRect(x - 16, 0, x + 16, this.behind(x) + 2);
  }

  town(x: number, rng: Rng) {
    if (this.put('church', x, this.behind(x, 18), rng, { s: 1 }))
      this.blockRect(x - 24, 0, x + 24, this.behind(x) + 2);
  }

  country(x: number, rng: Rng) {
    if (this.put('oak', x, this.behind(x, 20), rng, { s: 1 })) {
      this.put('bench', x + 30, this.behind(x, 18), rng, { s: 0.85 });
      this.put('sheep', x - 50, this.ty(x) + 60, rng, { s: 0.95 });
    }
  }

  farm(x: number, rng: Rng) {
    this.put('barn', x, this.behind(x, 18), rng, { s: 1 });
    this.put('silo', x + 34, this.behind(x + 34, 18), rng, { s: 1 });
    for (const [fx, side] of [
      [x + 100, 'above'],
      [x - 70, 'below'],
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
      if (this.blocks.some((b) => b(fx, y1, y0, w / 2))) continue;
      this.addInk(
        fx - w / 2,
        fx + w / 2 + 22,
        (w * (y1 - y0) * 0.8 * COLOUR) / 100,
        side
      );
      this.back.push({
        a: fx - w / 2,
        b: fx + w / 2 + 22,
        svg:
          fill(poly, 'field', rng, 0.3) +
          sketch([...poly, poly[0]], rng, 'ink-soft', {
            amp: 0.4,
            passes: 1,
            smooth: false,
          }) +
          hatch(poly, rng, 174, 4.6, 'crop', 0.95),
      });
      this.blockRect(fx - w / 2, y0 - 4, fx + w / 2 + 22, y1 + 2);
    }
    for (let k = 0; k < 3; k++) {
      const hx = x - 60 + k * 15;
      this.put('hay', hx, this.behind(hx, 16) - rng.uniform(0, 8), rng);
    }
  }

  river(x: number, rng: Rng) {
    const t = this.ty(x);
    if (this.blocks.some((b) => b(x, t - 20, t - 40, 30))) return;
    const top = this.ridgeY(x) + 2;
    const drift = rng.uniform(-14, 14);
    const pts: Pt[] = [
      [x + drift * 0.6, top],
      [x + 8, top + 30],
      [x - 6, (top + t) / 2 + 10],
      [x, t],
      [x - 10, t + 34],
      [x + drift, MAP_HEIGHT + 8],
    ];
    this.addInk(x - 20, x + 30, (16 * (MAP_HEIGHT - top) * 0.8 * COLOUR) / 100);
    this.back.push({ a: x - 40, b: x + 50, svg: E.stream(pts, rng, 16) });
    this.blocks.push((px, _py, _top, r) => Math.abs(px - (x + 8)) < r + 24);
    this.bridges.push([x - 24, x + 40]);
    this.put('boat', x - 10, t + 52, rng, { force: true, s: 0.85 });
    this.put('duck', x + 12, t + 76, rng, { force: true, s: 0.8 });
  }

  // ---------- rows and scatter ----------

  /** Buildings side by side behind the line, then along the bottom edge in front of it. */
  rows() {
    for (const key of ['row', 'front'] as const) {
      const rng = this.rand(key, 0);
      let x = 10;
      while (x < this.width - 20) {
        const spec = biome(this.pick(x, rng))[key];
        if (!spec) {
          x += 24;
          continue;
        }
        if (rng.next() > spec.fill) {
          x += rng.uniform(20, 40);
          continue;
        }
        const items = Object.entries(spec.items) as [Element, number][];
        let roll = rng.next() * items.reduce((sum, [, d]) => sum + d, 0);
        let name = items[0][0];
        for (const [item, odds] of items) {
          name = item;
          roll -= odds;
          if (roll <= 0) break;
        }
        const [, r, h] = TEMPLATES[name];
        let s: number;
        let y: number;
        const hidden = CROP[name];
        if (key === 'row') {
          s = rng.uniform(0.82, 1);
          y = this.behind(x + r * s, 16) - rng.uniform(0, 5);
        } else if (hidden) {
          // tall buildings in front stand a little below the bottom edge, partly hidden
          s = rng.uniform(0.8, 0.92);
          y = Math.max(
            MAP_HEIGHT + rng.uniform(4, 16),
            this.ty(x + r * s) + 14 + h * s
          );
          if (y - MAP_HEIGHT > hidden * h * s) {
            x += 8;
            continue;
          }
        } else {
          s = rng.uniform(0.88, 1);
          y = MAP_HEIGHT - rng.uniform(3, 9);
        }
        const cx = x + r * s;
        if (this.put(name, cx, y, rng, { s }))
          x = cx + r * s + rng.uniform(...spec.gap);
        else x += 8;
      }
    }
  }

  /** Fill each question-width up to its budget, one seeded stream per question-width. */
  scatter() {
    const maxOdds = 9;
    for (let bin = 0; bin <= Math.floor((this.width - 10) / STEP); bin++) {
      const rng = this.rand('bin', bin);
      const x0 = bin * STEP;
      const budget = Math.min(COUNT_CAP, this.blended(x0 + STEP / 2, 'fill'));
      for (
        let attempt = 0;
        attempt < 70 && (this.used.get(bin) ?? 0) < budget;
        attempt++
      ) {
        const x = rng.uniform(Math.max(8, x0), x0 + STEP);
        const y = rng.uniform(HORIZON_Y + 4, MAP_HEIGHT - 2);
        const items = Object.entries(biome(this.pick(x, rng)).items) as [
          Element,
          number,
        ][];
        const total = items.reduce((sum, [, d]) => sum + d, 0);
        if (rng.next() > total / maxOdds) continue;
        let roll = rng.next() * total;
        let name = items[0][0];
        for (const [item, odds] of items) {
          name = item;
          roll -= odds;
          if (roll <= 0) break;
        }
        const group: Pt[] = [[x, y]];
        const cluster = CLUSTER[name];
        if (cluster) {
          const [lo, hi, spread] = cluster;
          const extra = rng.int(lo, hi);
          for (let k = 0; k < extra; k++)
            group.push([
              x + rng.uniform(-spread, spread),
              y + rng.uniform(-spread * 0.4, spread * 0.4),
            ]);
        }
        const cost = SMALL.has(name) ? 0.5 : 1;
        for (const [gx, gy] of group) {
          if ((this.used.get(bin) ?? 0) + cost > budget) break;
          this.put(name, gx, gy, rng);
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
      x += rng.uniform(140, 280)
    ) {
      const y = rng.uniform(20, HORIZON_Y - 22);
      if (rng.next() >= 0.6) continue;
      const count = rng.int(2, 3);
      let svg = '';
      for (let k = 0; k < count; k++)
        svg += `<use href="#${TEMPLATE_ID}-bird-0" transform="translate(${n(x + k * 14)} ${n(y + rng.uniform(-5, 5))}) scale(.9)"/>`;
      out.push({ a: x - 8, b: x + count * 14 + 8, svg });
    }
    return out;
  }

  /** Ridge in short pieces; far off, a stepped skyline where the land is built up, a tree line in the woods. */
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
    let run: Pt[] = [];
    const close = () => {
      if (!run.length) return;
      const [a] = run[0];
      const [b] = lastOf(run);
      out.push({
        a,
        b,
        svg: `<path class="tm-ink-soft" d="${polyD([[a, this.ridgeY(a) + 2], ...run, [b, this.ridgeY(b) + 2]])}"/>`,
      });
      run = [];
    };
    for (let x = 6; x < this.width - 10; ) {
      const w = this.weights(x);
      const urban =
        (w.get('city') ?? 0) +
        (w.get('industry') ?? 0) +
        0.5 * (w.get('town') ?? 0);
      const y = this.ridgeY(x) + 2;
      if (urban > rng.uniform(0.3, 0.7)) {
        if ((w.get('industry') ?? 0) > 0.4 && rng.next() < 0.2) {
          const h = rng.uniform(18, 26);
          run.push([x, y - h], [x + 3, y - h], [x + 3, y - 6]);
          x += 3;
          continue;
        }
        const bw = rng.uniform(6, 14);
        const h = rng.uniform(5, 20) * ((w.get('city') ?? 0) > 0.3 ? 1 : 0.6);
        run.push([x, y - h], [x + bw, y - h]);
        x += bw;
        continue;
      }
      close();
      if ((w.get('woods') ?? 0) > rng.uniform(0.2, 0.9)) {
        const h = rng.uniform(7, 12);
        out.push({
          a: x - 5,
          b: x + 5,
          svg: `<path class="tm-ink-soft" d="M${n(x - h * 0.35)} ${n(y + 1)} ${n(x)} ${n(y + 1 - h)} ${n(x + h * 0.35)} ${n(y + 1)}"/>`,
        });
      }
      x += rng.uniform(5, 9);
    }
    close();
    return out;
  }

  build(): RailMap {
    const stations = this.stations();
    this.landmarks();
    this.rows();
    this.scatter();
    const bridges = this.bridges.map(([x0, x1], i) => ({
      a: x0 - 4,
      b: x1 + 4,
      svg: B.girderBridge(
        x0,
        x1,
        this.ty((x0 + x1) / 2),
        this.rand('bridge', i)
      ),
    }));
    const ink = new Map<number, number>();
    for (const [key, v] of this.ink) {
      const bin = Number(key.split('|')[0]);
      ink.set(bin, (ink.get(bin) ?? 0) + v);
    }
    return {
      ink,
      over: [
        ...stations,
        ...[...this.uses].sort((p, q) => p.y - q.y).map((u) => u.piece),
      ],
      placed: this.placed.map((p) => p.x),
      segments: this.segments,
      stations: [
        ...this.starts.map(({ sx, right }) => ({ a: sx, b: right })),
        { a: this.termX, b: this.lineEnd },
      ],
      stops: this.stops,
      trail: this.trail,
      under: [...this.sky(), ...this.horizon(), ...this.back, ...bridges],
      width: this.width,
    };
  }
}

/**
 * The map for one workspace: chapter names, and each tracked item's chapter
 * index in reading order (null when unfiled). Same input, same map; more items
 * only extend it. minWidth (map units) lets a short workspace fill its panel.
 */
export const buildRailMap = (
  workspaceId: string,
  chapters: readonly string[],
  items: readonly (number | null)[],
  minWidth = 0
) => new Builder(workspaceId, chapters, items, minWidth).build();

/** Mean visual weight per question-width of each biome on its own, over many seeds. */
export function measure(seeds = 20, total = 20) {
  const out = {} as Record<BiomeName, number>;
  for (const name of BIOME_NAMES) {
    let sum = 0;
    for (let k = 0; k < seeds; k++) {
      const builder = new Builder(
        `measure-${name}-${k}`,
        ['Chapter'],
        Array.from({ length: total }, () => 0),
        0,
        name
      );
      const map = builder.build();
      const last = Math.floor(builder.endX / STEP) - 1;
      let weight = 0;
      for (let i = 4; i < last; i++) weight += map.ink.get(i) ?? 0;
      sum += weight / (last - 4);
    }
    out[name] = sum / seeds;
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
