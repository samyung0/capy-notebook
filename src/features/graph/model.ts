/* The one graph model every surface draws (the graph convergence plan, Epo
 * 2026-11-16): the quiz and note kinds, whose constructions name their points
 * by id, and the canvas plane's free marks, which hold their own coordinates.
 * Validators admit only the quiz kinds for now; the engine draws them all. */
import type { GraphElement as QuizElement } from '@/features/questions/types';

export type Vec = [number, number];

type Style = { dash?: boolean; hidden?: boolean };

/** The quiz kinds, a segment taking an arrowhead at its second point and a
 * label a text size in pixels, as the plane's vector and label do. */
type Construction =
  | Exclude<QuizElement, { type: 'segment' | 'text' }>
  | (Extract<QuizElement, { type: 'segment' }> & { arrow?: boolean })
  | (Extract<QuizElement, { type: 'text' }> & { size?: number });

/** The plane's marks: a stroke (a two-point one with `arrow` is a vector), a
 * curve with optional [in, out] Bézier handles per point, an upright ellipse
 * and a LaTeX formula centred on its point at `size` pixels. */
type FreeMark =
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
