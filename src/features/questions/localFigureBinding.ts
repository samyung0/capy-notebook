import { alignPlaces } from '@/features/figures/align';
import type { FigureBlock } from '@/features/quizzes/liveFigures';
import { sameJson } from '@/lib/sameJson';
import type { BoundFigure, FigureBinding } from './figureBinding';
import type { ChartBlock, GraphBlock } from './types';

/** A local figure's holder: each change's block with the one it replaced, and
 * Remove with the figure as it stands. */
export type FigureHolder = {
  remove: (block: FigureBlock) => void;
  write: (next: FigureBlock, previous: FigureBlock) => void;
};

/** A chart's label rows: one for each value a merge left past the labels,
 * as the chart editor shows them. */
const rowsOf = (block: ChartBlock) =>
  Math.max(
    block.labels.length,
    ...block.series.map((item) => item.values.length)
  );

/** `list` with `value` at `at`, padded with `empty` up to it. */
const setAt = <T>(list: T[], at: number, value: T, empty: T) =>
  Array.from({ length: Math.max(list.length, at + 1) }, (_, i) =>
    i === at ? value : (list[i] ?? empty)
  );

/** `list` with `value` inserted at `at`. */
const insertAt = <T>(list: T[], at: number, value: T) => [
  ...list.slice(0, at),
  value,
  ...list.slice(at),
];

const cell = (series: ChartBlock['series'][number] | undefined, at: number) =>
  at < 0 ? null : (series?.values[at] ?? null);

/**
 * A figure its caller holds as a plain block (Epo 2026-11-16, one dialog
 * behaviour everywhere): a question draft, or a note's figure, written as a
 * note edit (`noteFigureBinding`). Each change makes the next block at once
 * and hands it to the holder, as a room's binding writes its entry. A plain
 * chart's series and labels have no ids, so the binding gives each a handle:
 * its own changes keep them (an added one gets a new handle, a removed one's
 * goes), and `receive`, the holder's block changed from elsewhere (a note
 * peer's edit, an Undo), carries them across the change by `alignPlaces`, the
 * rule a room's chart writer keeps its ids by. A field left with a handle
 * that went meanwhile writes nothing.
 */
export function localFigureBinding(
  block: FigureBlock,
  holder: FigureHolder
): FigureBinding & { receive: (block: FigureBlock) => void } {
  let made = 0;
  const handle = (prefix: 's' | 'l') => `${prefix}${made++}`;
  /** `next` with handles: those of `previous` carried over where they align. */
  const bound = (next: FigureBlock, previous?: BoundFigure): BoundFigure => {
    if (next.type !== 'chart') return { block: next, labels: [], series: [] };
    const before = previous?.block.type === 'chart' ? previous : null;
    if (!before)
      return {
        block: next,
        labels: Array.from({ length: rowsOf(next) }, () => handle('l')),
        series: next.series.map(() => handle('s')),
      };
    const held = before.block as ChartBlock;
    const labels = alignPlaces(
      before.labels.length,
      rowsOf(next),
      (h, w) =>
        held.labels[h] === next.labels[w] &&
        held.series.every(
          (series, s) => cell(series, h) === cell(next.series[s], w)
        )
    );
    const series = alignPlaces(
      before.series.length,
      next.series.length,
      (h, w) =>
        held.series[h].name === next.series[w].name &&
        labels.every(
          (at, l) => cell(held.series[h], at) === cell(next.series[w], l)
        )
    );
    return {
      block: next,
      labels: labels.map((at) => (at < 0 ? handle('l') : before.labels[at])),
      series: series.map((at) => (at < 0 ? handle('s') : before.series[at])),
    };
  };
  let figure = bound(block);
  // Removed: it reads as gone and takes no more changes.
  let gone = false;
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const listener of [...listeners]) listener();
  };
  const change = (make: (figure: BoundFigure) => BoundFigure) => {
    if (gone) return;
    const previous = figure;
    const next = make(previous);
    if (next.block === previous.block || sameJson(next.block, previous.block))
      return;
    figure = next;
    changed();
    holder.write(next.block, previous.block);
  };
  const graph = (make: (block: GraphBlock) => GraphBlock) =>
    change((current) => {
      if (current.block.type !== 'graph') throw new Error('Not a graph');
      return { ...current, block: make(current.block) };
    });
  const chart = (
    make: (block: ChartBlock, current: BoundFigure) => BoundFigure
  ) =>
    change((current) => {
      if (current.block.type !== 'chart') throw new Error('Not a chart');
      return make(current.block, current);
    });
  return {
    addChartItem: (axis, index, name) => {
      let id: string | null = null;
      chart((block, current) => {
        const added = handle(axis === 'series' ? 's' : 'l');
        id = added;
        if (axis === 'series') {
          const at = Math.max(0, Math.min(index, block.series.length));
          const series = [...block.series];
          series.splice(at, 0, { name, values: block.labels.map(() => null) });
          return {
            ...current,
            block: { ...block, series },
            series: insertAt(current.series, at, added),
          };
        }
        const at = Math.max(0, Math.min(index, block.labels.length));
        const labels = [...block.labels];
        labels.splice(at, 0, name);
        return {
          ...current,
          block: {
            ...block,
            labels,
            series: block.series.map((series) => {
              const values = [...series.values];
              values.splice(at, 0, null);
              return { ...series, values };
            }),
          },
          labels: insertAt(current.labels, at, added),
        };
      });
      return id;
    },
    deleteElement: (id) =>
      graph((block) => ({
        ...block,
        elements: block.elements.filter((element) => element.id !== id),
      })),
    moveElement: (id, index) =>
      graph((block) => {
        const from = block.elements.findIndex((element) => element.id === id);
        if (from < 0) return block;
        const elements = block.elements.filter((_, i) => i !== from);
        elements.splice(
          Math.max(0, Math.min(index, elements.length)),
          0,
          block.elements[from]
        );
        return { ...block, elements };
      }),
    read: () => (gone ? null : figure),
    receive: (next) => {
      if (gone || next === figure.block) return;
      figure = bound(next, figure);
      changed();
    },
    remove: () => {
      if (gone) return;
      gone = true;
      holder.remove(figure.block);
      changed();
    },
    removeChartItem: (axis, id) =>
      chart((block, current) => {
        const at = current[axis].indexOf(id);
        if (at < 0) return current;
        const kept = <T>(list: T[]) => list.filter((_, i) => i !== at);
        if (axis === 'series') {
          const next = { ...block, series: kept(block.series) };
          // Rows only its values made past the labels go with it.
          return {
            block: next,
            labels: current.labels.slice(0, rowsOf(next)),
            series: kept(current.series),
          };
        }
        return {
          ...current,
          block: {
            ...block,
            labels: kept(block.labels),
            series: block.series.map((series) => ({
              ...series,
              values: kept(series.values),
            })),
          },
          labels: kept(current.labels),
        };
      }),
    setBoard: (field, value) =>
      graph((block) => {
        const board = { ...block.board, [field]: value };
        if (value === undefined) delete board[field];
        return { ...block, board };
      }),
    setChartCell: (series, label, value) =>
      chart((block, current) => {
        const s = current.series.indexOf(series);
        const l = current.labels.indexOf(label);
        if (s < 0 || l < 0) return current;
        return {
          ...current,
          block: {
            ...block,
            series: block.series.map((item, i) =>
              i === s
                ? { ...item, values: setAt(item.values, l, value, null) }
                : item
            ),
          },
        };
      }),
    setChartName: (id, name) =>
      chart((block, current) => {
        const s = current.series.indexOf(id);
        if (s >= 0)
          return {
            ...current,
            block: {
              ...block,
              series: block.series.map((item, i) =>
                i === s ? { ...item, name } : item
              ),
            },
          };
        const l = current.labels.indexOf(id);
        if (l < 0) return current;
        return {
          ...current,
          block: { ...block, labels: setAt(block.labels, l, name, '') },
        };
      }),
    setElement: (element) =>
      graph((block) => {
        const at = block.elements.findIndex((item) => item.id === element.id);
        if (at < 0) return { ...block, elements: [...block.elements, element] };
        if (sameJson(block.elements[at], element)) return block;
        return {
          ...block,
          elements: block.elements.map((item, i) =>
            i === at ? element : item
          ),
        };
      }),
    setFields: (values) =>
      change((current) => {
        const next: Record<string, unknown> = { ...current.block };
        for (const [key, value] of Object.entries(values)) {
          if (value === undefined) delete next[key];
          else next[key] = value;
        }
        return { ...current, block: next as FigureBlock };
      }),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
