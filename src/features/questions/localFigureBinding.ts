import type { ChartAxis, FigureBlock } from '@/features/quizzes/liveFigures';
import { sameJson } from '@/lib/sameJson';
import type { BoundFigure, FigureBinding } from './figureBinding';
import type { ChartBlock, GraphBlock } from './types';

/** A local figure's holder: each change's block with the one it replaced, and
 * Remove with the figure as it stands. */
export type FigureHolder = {
  remove: (block: FigureBlock) => void;
  write: (next: FigureBlock, previous: FigureBlock) => void;
};

/** A plain block's series and label rows by place: a label row for each
 * value a merge left past the labels, as the chart editor shows them. */
function bound(block: FigureBlock): BoundFigure {
  if (block.type !== 'chart') return { block, labels: [], series: [] };
  const rows = Math.max(
    block.labels.length,
    ...block.series.map((series) => series.values.length)
  );
  return {
    block,
    labels: Array.from({ length: rows }, (_, i) => `l${i}`),
    series: block.series.map((_, i) => `s${i}`),
  };
}

function place(id: string, axis: ChartAxis) {
  const prefix = axis === 'series' ? 's' : 'l';
  const at = Number(id.slice(1));
  if (!id.startsWith(prefix) || !Number.isInteger(at))
    throw new Error(`${id} is not a chart ${axis} id`);
  return at;
}

const axisOf = (id: string): ChartAxis =>
  id.startsWith('s') ? 'series' : 'labels';

/** `list` with `value` at `at`, padded with `empty` up to it. */
const setAt = <T>(list: T[], at: number, value: T, empty: T) =>
  Array.from({ length: Math.max(list.length, at + 1) }, (_, i) =>
    i === at ? value : (list[i] ?? empty)
  );

function moved<T>(list: T[], from: number, to: number) {
  if (from < 0 || from >= list.length) return list;
  const next = list.filter((_, i) => i !== from);
  next.splice(Math.max(0, Math.min(to, next.length)), 0, list[from]);
  return next;
}

/**
 * A figure its caller holds as a plain block (Epo 2026-11-16, one dialog
 * behaviour everywhere): a question draft, or a note's figure, written as a
 * note edit (`noteFigureBinding`). Each change makes the next block at once
 * and hands it to the holder, as a room's binding writes its entry. A plain
 * chart's series and labels have no ids: they go by place (`s0`, `l0`),
 * which holds while one editor changes them. `receive` takes the holder's
 * block when it changed from elsewhere (a note peer's edit, an Undo).
 */
export function localFigureBinding(
  block: FigureBlock,
  holder: FigureHolder
): FigureBinding & { receive: (block: FigureBlock) => void } {
  let figure = bound(block);
  // Removed: it reads as gone and takes no more changes.
  let gone = false;
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const listener of [...listeners]) listener();
  };
  const change = (make: (block: FigureBlock) => FigureBlock) => {
    if (gone) return;
    const previous = figure.block;
    const next = make(previous);
    if (next === previous || sameJson(next, previous)) return;
    figure = bound(next);
    changed();
    holder.write(next, previous);
  };
  const graph = (make: (block: GraphBlock) => GraphBlock) =>
    change((block) => {
      if (block.type !== 'graph') throw new Error('Not a graph');
      return make(block);
    });
  const chart = (make: (block: ChartBlock) => ChartBlock) =>
    change((block) => {
      if (block.type !== 'chart') throw new Error('Not a chart');
      return make(block);
    });
  return {
    addChartItem: (axis, index, name) => {
      let id: string | null = null;
      chart((block) => {
        if (axis === 'series') {
          const at = Math.max(0, Math.min(index, block.series.length));
          id = `s${at}`;
          const series = [...block.series];
          series.splice(at, 0, { name, values: block.labels.map(() => null) });
          return { ...block, series };
        }
        const at = Math.max(0, Math.min(index, block.labels.length));
        id = `l${at}`;
        const labels = [...block.labels];
        labels.splice(at, 0, name);
        return {
          ...block,
          labels,
          series: block.series.map((series) => {
            const values = [...series.values];
            values.splice(at, 0, null);
            return { ...series, values };
          }),
        };
      });
      return id;
    },
    deleteElement: (id) =>
      graph((block) => ({
        ...block,
        elements: block.elements.filter((element) => element.id !== id),
      })),
    moveChartItem: (axis, id, index) =>
      chart((block) => {
        const from = place(id, axis);
        return axis === 'series'
          ? { ...block, series: moved(block.series, from, index) }
          : {
              ...block,
              labels: moved(block.labels, from, index),
              series: block.series.map((series) => ({
                ...series,
                values: moved(series.values, from, index),
              })),
            };
      }),
    moveElement: (id, index) =>
      graph((block) => ({
        ...block,
        elements: moved(
          block.elements,
          block.elements.findIndex((element) => element.id === id),
          index
        ),
      })),
    read: () => (gone ? null : figure),
    receive: (next) => {
      if (gone || next === figure.block) return;
      figure = bound(next);
      changed();
    },
    remove: () => {
      if (gone) return;
      gone = true;
      holder.remove(figure.block);
      changed();
    },
    removeChartItem: (axis, id) =>
      chart((block) => {
        const at = place(id, axis);
        return axis === 'series'
          ? { ...block, series: block.series.filter((_, i) => i !== at) }
          : {
              ...block,
              labels: block.labels.filter((_, i) => i !== at),
              series: block.series.map((series) => ({
                ...series,
                values: series.values.filter((_, i) => i !== at),
              })),
            };
      }),
    setBoard: (field, value) =>
      graph((block) => {
        const board = { ...block.board, [field]: value };
        if (value === undefined) delete board[field];
        return { ...block, board };
      }),
    setChartCell: (series, label, value) =>
      chart((block) => {
        const s = place(series, 'series');
        const l = place(label, 'labels');
        return {
          ...block,
          series: block.series.map((item, i) =>
            i === s
              ? { ...item, values: setAt(item.values, l, value, null) }
              : item
          ),
        };
      }),
    setChartName: (id, name) =>
      chart((block) => {
        const axis = axisOf(id);
        const at = place(id, axis);
        return axis === 'series'
          ? {
              ...block,
              series: block.series.map((item, i) =>
                i === at ? { ...item, name } : item
              ),
            }
          : { ...block, labels: setAt(block.labels, at, name, '') };
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
      change((block) => {
        const next: Record<string, unknown> = { ...block };
        for (const [key, value] of Object.entries(values)) {
          if (value === undefined) delete next[key];
          else next[key] = value;
        }
        return next as FigureBlock;
      }),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
