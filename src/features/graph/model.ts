/* The one graph model every surface holds and draws (the graph convergence
 * plan, Epo 2026-11-16, D1/D16): quiz and note graphs, the bank and the
 * canvas plane. Constructions name their points by id; free marks hold their
 * own coordinates. The validators (questions/validation.ts `graphElementSchema`,
 * Go `questions.graph`, Rust `questions::graph_element`) admit every kind. */

export type Vec = [number, number];

type Style = { dash?: boolean; hidden?: boolean };

/** The constructions: a function of x, points, and what is built on points
 * named by id. A segment may take an arrowhead at its second point and a
 * label a text size in pixels, as the plane's vector and label do. */
type Construction =
  | ({
      type: 'functiongraph';
      id: string;
      term: string;
      domain?: [number, number];
    } & Style)
  | {
      type: 'point';
      id: string;
      name?: string;
      coords: Vec;
      hidden?: boolean;
    }
  | ({ type: 'line'; id: string; points: [string, string] } & Style)
  | ({
      type: 'segment';
      id: string;
      points: [string, string];
      /** 1 to 3 hatch marks; segments with the same count are equal in length. */
      ticks?: number;
      arrow?: boolean;
    } & Style)
  | ({ type: 'circle'; id: string; center: string; radius: number } & Style)
  | {
      type: 'text';
      id: string;
      coords: Vec;
      text: string;
      size?: number;
      hidden?: boolean;
    }
  | {
      /** The non-reflex angle at the middle point; 90° draws the square mark. */
      type: 'angle';
      id: string;
      points: [string, string, string];
      label?: string;
      hidden?: boolean;
    }
  | ({
      /** Counterclockwise from the first point to the second around `center`. */
      type: 'arc';
      id: string;
      center: string;
      points: [string, string];
    } & Style)
  | ({
      type: 'sector';
      id: string;
      center: string;
      points: [string, string];
      shade?: boolean;
    } & Style)
  | ({
      type: 'polygon';
      id: string;
      points: string[];
      shade?: boolean;
    } & Style);

/** The free marks: a stroke (a two-point one with `arrow` is a vector), a
 * curve with optional [in, out] Bézier handles per point, an upright ellipse
 * and a LaTeX formula centred on its point at `size` pixels. */
export type FreeMark =
  | ({ type: 'polyline'; id: string; coords: Vec[]; arrow?: boolean } & Style)
  | ({
      type: 'curve';
      id: string;
      coords: Vec[];
      handles?: [Vec, Vec][];
    } & Style)
  | ({ type: 'ellipse'; id: string; center: Vec; radii: Vec } & Style)
  | {
      type: 'formula';
      id: string;
      coords: Vec;
      latex: string;
      size?: number;
      hidden?: boolean;
    };

export type GraphElement = Construction | FreeMark;

/** The kinds the question graph editor writes as rows. */
export type RowElement = Construction;

const FREE_MARKS = new Set<GraphElement['type']>([
  'curve',
  'ellipse',
  'formula',
  'polyline',
]);
export const isFreeMark = (element: GraphElement): element is FreeMark =>
  FREE_MARKS.has(element.type);

/** Axes and grid shown or not; a polar board draws rings and spokes. */
export type Board = {
  bbox: [number, number, number, number];
  axis: boolean;
  grid: boolean;
  polar?: boolean;
};

export type Graph = { board: Board; elements: GraphElement[] };

/** A graph at its pixel size, as a quiz or note graph is stored. */
export type SizedGraph = Graph & { width: number; height: number };

/** Where a graph is drawn on its canvas, in canvas pixels. */
export type Frame = { h: number; w: number; x: number; y: number };

/** Text sizes in pixels: a label's and a formula's, until a size is set (Epo
 * 2026-11-13). Text keeps its size as a graph zooms. */
export const LABEL_SIZE = 15;
export const FORMULA_SIZE = 18;
