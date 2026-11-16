import * as Y from 'yjs';
import { type ElementEntry, readElements } from '@/features/graph/keyed';
import { repairFigureBlock } from '@/features/questions/repair';
import type {
  ChartBlock,
  GraphBlock,
  GraphElement,
  PlotBlock,
} from '@/features/questions/types';
import { uid } from '@/lib/id';
import { keyBetween } from '@/lib/orderKey';
import {
  alignAxis,
  child,
  mapAt,
  orderedKeys,
  risingOrders,
  samePlain,
  setPlain,
  type YMap,
} from './yMaps';

/* A chart, plot or graph held live (Epo 2026-11-16, D2/D3/D9/D15): one layout
 * wherever a room holds one, a quiz room's block entry (beside its `order`)
 * and a note figure's `block` alike. A figure is a map of its fields, each a
 * plain value replaced whole, so two editors changing different fields both
 * keep their change:
 *
 *   graph  {type, width, height, description?,
 *           board: {bbox, axis, grid, polar?},
 *           elements: element id -> {element, order}}   (graph/keyed.ts)
 *   chart  {type, kind, title, xTitle?, yTitle?, gridlines?, description?,
 *           series: id -> order key, labels: id -> order key,
 *           names: series or label id -> its name,
 *           values: "series/label" -> number (none: an empty cell)}
 *   plot   {type, ...its fields}
 *
 * A chart's series and labels are held as a table's rows and columns, and
 * its values as its cells, plain numbers instead of texts. Order keys sort as
 * strings and a tie (two editors adding at once) is broken by id. A read is
 * repaired (`repairFigureBlock`), as a merge may leave what no editor wrote;
 * the Rust server's twin is `notes::figure_map`. */

export type FigureBlock = ChartBlock | PlotBlock | GraphBlock;
export type FigureType = FigureBlock['type'];
export const isFigureType = (type: unknown): type is FigureType =>
  type === 'chart' || type === 'plot' || type === 'graph';

/** The keys a figure holds as maps, never as its plain fields. */
export const FIGURE_MAPS: Record<FigureType, readonly string[]> = {
  chart: ['series', 'labels', 'names', 'values'],
  graph: ['board', 'elements'],
  plot: [],
};

/** Keys a container gives a figure's map besides its block: a quiz entry's
 * `order` (and `type`, which a read takes from its caller). */
const held = (key: string, type: FigureType) =>
  key === 'order' || key === 'type' || FIGURE_MAPS[type].includes(key);

/** A figure as an editor follows it: the block, and a chart's series and
 * label ids in order (empty for a graph or plot). */
export type LiveFigure = {
  block: FigureBlock;
  labels: string[];
  series: string[];
};

/* --------------------------------------------------------------- reading */

/** The plain fields a figure's map holds. */
function fields(map: YMap, type: FigureType): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  map.forEach((value, key) => {
    if (held(key, type)) return;
    if (!(value instanceof Y.AbstractType)) out[key] = value;
  });
  return out;
}

export const isElementEntry = (
  value: unknown,
  id: string
): value is ElementEntry =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as ElementEntry).order === 'string' &&
  typeof (value as ElementEntry).element === 'object' &&
  (value as ElementEntry).element?.id === id;

/** A graph's element entries as held, malformed ones left out. */
function elementEntries(map: YMap): [string, ElementEntry<GraphElement>][] {
  const out: [string, ElementEntry<GraphElement>][] = [];
  map.forEach((value, id) => {
    if (isElementEntry(value, id))
      out.push([id, value as ElementEntry<GraphElement>]);
  });
  return out;
}

const nameOf = (names: YMap | undefined, id: string) => {
  const name = names?.get(id);
  return typeof name === 'string' ? name : '';
};

function cellOf(values: YMap | undefined, series: string, label: string) {
  const value = values?.get(`${series}/${label}`);
  return typeof value === 'number' ? value : null;
}

/** A figure as held; none while it lacks the maps its type writes. */
function build(map: YMap, type: FigureType): LiveFigure | null {
  const plainFields = fields(map, type);
  switch (type) {
    case 'plot':
      return {
        block: { ...plainFields, type } as PlotBlock,
        labels: [],
        series: [],
      };
    case 'graph': {
      const board = mapAt(map, 'board');
      const elements = mapAt(map, 'elements');
      if (!(board && elements)) return null;
      return {
        block: {
          ...plainFields,
          board: board.toJSON() as GraphBlock['board'],
          elements: readElements(elementEntries(elements)),
          type,
        } as GraphBlock,
        labels: [],
        series: [],
      };
    }
    case 'chart': {
      const seriesMap = mapAt(map, 'series');
      const labelMap = mapAt(map, 'labels');
      if (!(seriesMap && labelMap)) return null;
      const names = mapAt(map, 'names');
      const values = mapAt(map, 'values');
      const labels = orderedKeys(labelMap);
      const series = orderedKeys(seriesMap);
      return {
        block: {
          ...plainFields,
          labels: labels.map((id) => nameOf(names, id)),
          series: series.map((id) => ({
            name: nameOf(names, id),
            values: labels.map((label) => cellOf(values, id, label)),
          })),
          type,
        } as ChartBlock,
        labels,
        series,
      };
    }
  }
}

/** A figure's map as the plain block it holds, not repaired: what a note's
 * Slate value holds, whose editors show a merge's issues. A map lacking the
 * maps its type writes (no writer leaves one; admission refuses it) reads as
 * its plain fields. */
export function heldBlock(map: YMap, type: FigureType): FigureBlock {
  return (
    build(map, type)?.block ?? ({ ...fields(map, type), type } as FigureBlock)
  );
}

/* Each figure is read once per change of its own: a read is kept until the
 * map changes (its deep observer marks it, before the document's `update`
 * event), so an edit elsewhere in the document hands back the same block. */
type Held = { dirty: boolean; figure: LiveFigure | null; type: FigureType };
const reads = new WeakMap<YMap, Held>();

/** Whether the open transaction changed the map or one of its maps (its
 * observer runs only once the transaction ends): a writer reading back. */
function changedNow(map: YMap): boolean {
  const changed: ReadonlyMap<unknown, unknown> | undefined =
    map.doc?._transaction?.changed;
  if (!changed) return false;
  if (changed.has(map)) return true;
  for (const value of map.values()) if (changed.has(value)) return true;
  return false;
}

/** A figure's map as its block, repaired; none while incomplete. */
export function readFigure(map: YMap, type: FigureType): LiveFigure | null {
  let read = reads.get(map);
  if (!read) {
    const fresh: Held = { dirty: true, figure: null, type };
    map.observeDeep(() => {
      fresh.dirty = true;
    });
    reads.set(map, fresh);
    read = fresh;
  }
  if (read.dirty || read.type !== type || changedNow(map)) {
    const figure = build(map, type);
    read.figure = figure && {
      ...figure,
      block: repairFigureBlock(figure.block),
    };
    read.dirty = false;
    read.type = type;
  }
  return read.figure;
}

/* --------------------------------------------------------------- writing */

/** Plain fields written as what differs; ones the block no longer has go. */
function writeFields(map: YMap, block: FigureBlock) {
  for (const [key, value] of Object.entries(block))
    if (!held(key, block.type)) setPlain(map, key, value);
  for (const key of [...map.keys()])
    if (
      !held(key, block.type) &&
      (block as Record<string, unknown>)[key] === undefined
    )
      map.delete(key);
}

/** A graph's elements made `next`, touching only what changed: an equal
 * element keeps its entry, a new one takes an order key between its
 * neighbours, a moved one a new key, a gone one goes. */
function writeElements(map: YMap, next: GraphElement[]) {
  const entries = new Map(elementEntries(map));
  const orders = risingOrders(
    next.map((element) => entries.get(element.id)?.order ?? '')
  );
  next.forEach((element, i) => {
    const entry = entries.get(element.id);
    if (entry?.order === orders[i] && samePlain(entry.element, element)) return;
    map.set(element.id, {
      element:
        entry && samePlain(entry.element, element) ? entry.element : element,
      order: orders[i],
    });
  });
  const kept = new Set(next.map((element) => element.id));
  for (const id of [...map.keys()]) if (!kept.has(id)) map.delete(id);
}

function writeGraph(map: YMap, block: GraphBlock) {
  const board = child(map, 'board');
  const wanted = block.board as Record<string, unknown>;
  for (const [key, value] of Object.entries(wanted))
    setPlain(board, key, value);
  for (const key of [...board.keys()])
    if (wanted[key] === undefined) board.delete(key);
  writeElements(child(map, 'elements'), block.elements);
}

/** A chart's data written as its table would be: labels as columns, series as
 * rows, aligned by `alignAxis`; names and values only where they differ. */
function writeChart(map: YMap, block: ChartBlock) {
  const labelMap = child(map, 'labels');
  const seriesMap = child(map, 'series');
  const names = child(map, 'names');
  const values = child(map, 'values');
  const name = (id: string) => nameOf(names, id);
  const heldSeries = orderedKeys(seriesMap);
  const heldLabels = orderedKeys(labelMap);
  const labels = alignAxis(
    labelMap,
    block.labels.length,
    (h, w) =>
      name(heldLabels[h]) === block.labels[w] &&
      heldSeries.every(
        (series, s) =>
          cellOf(values, series, heldLabels[h]) ===
          (block.series[s]?.values[w] ?? null)
      ),
    'lab',
    (label) => names.delete(label)
  );
  const series = alignAxis(
    seriesMap,
    block.series.length,
    (h, w) =>
      name(heldSeries[h]) === block.series[w].name &&
      labels.every(
        (label, l) =>
          cellOf(values, heldSeries[h], label) ===
          (block.series[w].values[l] ?? null)
      ),
    'ser',
    (id) => names.delete(id)
  );
  labels.forEach((id, l) => {
    setPlain(names, id, block.labels[l]);
  });
  const kept = new Set<string>();
  series.forEach((id, s) => {
    setPlain(names, id, block.series[s].name);
    labels.forEach((label, l) => {
      const key = `${id}/${label}`;
      kept.add(key);
      setPlain(values, key, block.series[s].values[l] ?? undefined);
    });
  });
  // Values of a series or label that went (here or in a merge).
  for (const key of [...values.keys()]) if (!kept.has(key)) values.delete(key);
  const ids = new Set([...labels, ...series]);
  for (const id of [...names.keys()]) if (!ids.has(id)) names.delete(id);
}

/** A figure's map made to hold `block`, writing only what differs (the
 * diffing replace): server writers, a dialog's Save and a note's `set_node`
 * of a figure's block take this path. */
export function writeFigure(map: YMap, block: FigureBlock) {
  writeFields(map, block);
  if (block.type === 'graph') writeGraph(map, block);
  if (block.type === 'chart') writeChart(map, block);
}

/** A new figure map holding `block`, not yet in a document (an insert or a
 * clone): written by `writeFigure` in a scratch document and copied out. */
export function newFigureMap(block: FigureBlock): YMap {
  const map = new Y.Doc().getMap<unknown>('figure');
  map.set('type', block.type);
  writeFigure(map, block);
  return map.clone();
}

/* --------------------------------------------- one entry at a time (live) */

type Scalars<B, Held extends keyof B> = Partial<Omit<B, 'type' | Held>>;
/** A figure's plain fields (undefined removes an optional one). */
export type FigureFields =
  | Scalars<GraphBlock, 'board' | 'elements'>
  | Scalars<ChartBlock, 'labels' | 'series'>
  | Scalars<PlotBlock, never>;

/** Sets the named plain fields: a graph's size or description, a chart's
 * kind, titles, gridlines or description, any of a plot's. */
export function setFields(map: YMap, type: FigureType, values: FigureFields) {
  for (const [key, value] of Object.entries(values)) {
    if (held(key, type))
      throw new Error(`${key} is not a plain field of a ${type}`);
    setPlain(map, key, value);
  }
}

/** Sets one board field of a graph (its view, axes, grid). */
export function setBoardField<K extends keyof GraphBlock['board']>(
  map: YMap,
  field: K,
  value: GraphBlock['board'][K]
) {
  setPlain(child(map, 'board'), field, value);
}

const lastOrder = (map: YMap) =>
  elementEntries(map).reduce<string | null>(
    (last, [, entry]) =>
      last === null || entry.order > last ? entry.order : last,
    null
  );

/** Sets a graph element by its id: a changed one keeps its place, a new one
 * goes last. */
export function setElement(map: YMap, element: GraphElement) {
  const elements = child(map, 'elements');
  const entry = elements.get(element.id);
  if (isElementEntry(entry, element.id)) {
    if (!samePlain(entry.element, element))
      elements.set(element.id, { element, order: entry.order });
    return;
  }
  elements.set(element.id, {
    element,
    order: keyBetween(lastOrder(elements), null),
  });
}

export function deleteElement(map: YMap, id: string) {
  mapAt(map, 'elements')?.delete(id);
}

/** An order key at `index` among `orders` (in order), the moved one left out. */
function orderAt(orders: string[], index: number) {
  const at = Math.max(0, Math.min(index, orders.length));
  const lower = orders[at - 1] ?? null;
  const upper =
    orders.slice(at).find((order) => lower === null || order > lower) ?? null;
  return keyBetween(lower, upper);
}

/** Moves a graph element to `index` in the drawing order. */
export function moveElement(map: YMap, id: string, index: number) {
  const elements = mapAt(map, 'elements');
  const entry = elements?.get(id);
  if (!(elements && isElementEntry(entry, id))) return;
  const others = elementEntries(elements)
    .filter(([key]) => key !== id)
    .map(([key, value]) => ({ id: key, order: value.order }))
    .sort((a, b) =>
      a.order < b.order ? -1 : a.order > b.order ? 1 : a.id < b.id ? -1 : 1
    )
    .map((item) => item.order);
  elements.set(id, { element: entry.element, order: orderAt(others, index) });
}

/** A chart's series (rows) or labels (columns). */
export type ChartAxis = 'series' | 'labels';

/** Adds a series or label named `name` at `index`; its values start empty.
 * The new id. */
export function addChartItem(
  map: YMap,
  axis: ChartAxis,
  index: number,
  name: string
): string {
  const id = uid(axis === 'series' ? 'ser' : 'lab');
  const items = child(map, axis);
  const orders = orderedKeys(items).map((key) => items.get(key) as string);
  items.set(id, orderAt(orders, index));
  child(map, 'names').set(id, name);
  return id;
}

/** Removes a series or label with its name and values. */
export function removeChartItem(map: YMap, axis: ChartAxis, id: string) {
  mapAt(map, axis)?.delete(id);
  mapAt(map, 'names')?.delete(id);
  const values = mapAt(map, 'values');
  for (const key of [...(values?.keys() ?? [])]) {
    const [series, label] = key.split('/');
    if ((axis === 'series' ? series : label) === id) values?.delete(key);
  }
}

/** Moves a series or label to `index`. */
export function moveChartItem(
  map: YMap,
  axis: ChartAxis,
  id: string,
  index: number
) {
  const items = mapAt(map, axis);
  if (!items?.has(id)) return;
  const orders = orderedKeys(items)
    .filter((key) => key !== id)
    .map((key) => items.get(key) as string);
  items.set(id, orderAt(orders, index));
}

/** Renames a series or label. */
export function setChartName(map: YMap, id: string, name: string) {
  setPlain(child(map, 'names'), id, name);
}

/** Sets one value of a chart (null: an empty cell). */
export function setChartCell(
  map: YMap,
  series: string,
  label: string,
  value: number | null
) {
  setPlain(child(map, 'values'), `${series}/${label}`, value ?? undefined);
}
