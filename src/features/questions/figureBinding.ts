import { useRef, useSyncExternalStore } from 'react';
import type {
  ChartAxis,
  FigureBlock,
  FigureFields,
} from '@/features/quizzes/liveFigures';
import type { GraphBlock, GraphElement } from './types';

/** A figure as its dialog follows it: the block, and a chart's series and
 * label ids in order (empty for a graph or plot). */
export type BoundFigure = {
  block: FigureBlock;
  labels: string[];
  series: string[];
};

type Board = GraphBlock['board'];

/**
 * What a chart or graph dialog edits (Epo 2026-11-16, live figures): the
 * figure where it lives, written a change at a time, so the dialog holds no
 * draft and Done only closes it. A quiz room's entry (`figureRoom().bind`)
 * and a question draft (`localFigureBinding`) implement it; each write is one
 * change, and does nothing once the figure is gone.
 */
export interface FigureBinding {
  /** Adds a chart series or label named `name` at `index`; its new id, none once gone. */
  addChartItem(axis: ChartAxis, index: number, name: string): string | null;
  /** Removes a graph element. */
  deleteElement(id: string): void;
  /** Moves a chart series or label to `index`. */
  moveChartItem(axis: ChartAxis, id: string, index: number): void;
  /** Moves a graph element to `index` among the others. */
  moveElement(id: string, index: number): void;
  /** The figure now, the same object until it changes; null once it is gone. */
  read(): BoundFigure | null;
  /** Takes the figure out of where it lives. */
  remove(): void;
  /** Removes a chart series or label with its values. */
  removeChartItem(axis: ChartAxis, id: string): void;
  /** Sets one board field of a graph (its view, axes, grid). */
  setBoard<K extends keyof Board>(field: K, value: Board[K]): void;
  /** Sets one chart value (null: an empty cell). */
  setChartCell(series: string, label: string, value: number | null): void;
  /** Renames a chart series or label. */
  setChartName(id: string, name: string): void;
  /** Sets a graph element by its id: a changed one keeps its place, a new one goes last. */
  setElement(element: GraphElement): void;
  /** Sets plain fields (titles, kind, size, description); undefined removes one. */
  setFields(values: FigureFields): void;
  /** Calls `listener` after each change of this figure; returns the unsubscribe. */
  subscribe(listener: () => void): () => void;
}

/** The figure as it is now, re-rendering on each of its changes; the last
 * one read once it is gone (its dialog is closing). */
export function useBoundFigure(binding: FigureBinding): BoundFigure {
  const figure = useSyncExternalStore(binding.subscribe, binding.read);
  const last = useRef(figure);
  if (figure) last.current = figure;
  if (!last.current)
    throw new Error('A figure dialog opened on a figure that is gone');
  return last.current;
}
