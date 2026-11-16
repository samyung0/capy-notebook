import * as Y from 'yjs';
import { LOCAL_EDIT } from '@/features/collaboration/yText';
import { type ElementEntry, readElements } from '@/features/graph/keyed';
import type { BlockSection } from '@/features/questions/QuestionView';
import type { FigureAt } from '@/features/questions/questionEdits';
import { repairFigureBlock } from '@/features/questions/repair';
import type {
  ChartBlock,
  GraphBlock,
  GraphElement,
  PlotBlock,
  QuestionBlock,
} from '@/features/questions/types';
import { uid } from '@/lib/id';
import { keyBetween } from '@/lib/orderKey';
import {
  alignAxis,
  child,
  KEYS_ROOT,
  mapAt,
  orderedKeys,
  QUESTIONS_ROOT,
  risingOrders,
  samePlain,
  setPlain,
  type YMap,
} from './liveMaps';

/* A live quiz's charts, plots and graphs (Epo 2026-11-16, D2/D3/D9), in the
 * content document and, for a solution's, the keys document. A figure's
 * entry is a map of its fields, each a plain value replaced whole, so two
 * editors changing different fields both keep their change:
 *
 *   graph  {order, type, width, height, description?,
 *           board: {bbox, axis, grid, polar?},
 *           elements: element id -> {element, order}}   (graph/keyed.ts)
 *   chart  {order, type, kind, title, xTitle?, yTitle?, gridlines?,
 *           description?, series: id -> order key, labels: id -> order key,
 *           names: series or label id -> its name,
 *           values: "series/label" -> number (none: an empty cell)}
 *   plot   {order, type, ...its fields}
 *
 * A chart's series and labels are held as a table's rows and columns, and
 * its values as its cells, plain numbers instead of texts. The entry's key
 * is the figure's identity: the question editor carries it to the figure
 * dialog, which writes that entry (`FigureAt`). A read is repaired
 * (`repairFigureBlock`), as a merge may leave what no editor wrote. */

export type FigureBlock = ChartBlock | PlotBlock | GraphBlock;
export type FigureType = FigureBlock['type'];
export const isFigureType = (type: unknown): type is FigureType =>
  type === 'chart' || type === 'plot' || type === 'graph';

/** The keys a figure holds as maps, never as its plain fields. */
const MAPS: Record<FigureType, readonly string[]> = {
  chart: ['series', 'labels', 'names', 'values'],
  graph: ['board', 'elements'],
  plot: [],
};

/** A quiz's two documents. */
export type QuizDocs = { content: Y.Doc; keys: Y.Doc };

/** A figure as a dialog follows it: the block, and a chart's series and
 * label ids in order (empty for a graph or plot). */
export type LiveFigure = {
  block: FigureBlock;
  labels: string[];
  series: string[];
};

/* --------------------------------------------------------------- reading */

/** The plain fields an entry holds. */
function fields(entry: YMap, type: FigureType): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  entry.forEach((value, key) => {
    if (key === 'order' || key === 'type' || MAPS[type].includes(key)) return;
    if (!(value instanceof Y.AbstractType)) out[key] = value;
  });
  return out;
}

const isEntry = (value: unknown, id: string): value is ElementEntry =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as ElementEntry).order === 'string' &&
  typeof (value as ElementEntry).element === 'object' &&
  (value as ElementEntry).element?.id === id;

/** A graph's element entries as held, malformed ones left out. */
function elementEntries(map: YMap): [string, ElementEntry<GraphElement>][] {
  const out: [string, ElementEntry<GraphElement>][] = [];
  map.forEach((value, id) => {
    if (isEntry(value, id)) out.push([id, value as ElementEntry<GraphElement>]);
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
function build(entry: YMap, type: FigureType): LiveFigure | null {
  const plainFields = fields(entry, type);
  switch (type) {
    case 'plot':
      return {
        block: { ...plainFields, type } as PlotBlock,
        labels: [],
        series: [],
      };
    case 'graph': {
      const board = mapAt(entry, 'board');
      const elements = mapAt(entry, 'elements');
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
      const seriesMap = mapAt(entry, 'series');
      const labelMap = mapAt(entry, 'labels');
      if (!(seriesMap && labelMap)) return null;
      const names = mapAt(entry, 'names');
      const values = mapAt(entry, 'values');
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

/* Each figure is read once per change of its own: a read is kept until the
 * entry changes (its deep observer marks it, before the document's `update`
 * event), so an edit elsewhere in the quiz hands back the same block. */
type Held = { dirty: boolean; figure: LiveFigure | null; type: FigureType };
const reads = new WeakMap<YMap, Held>();

/** Whether the open transaction changed the entry or one of its maps (its
 * observer runs only once the transaction ends): a writer reading back. */
function changedNow(entry: YMap): boolean {
  const changed: ReadonlyMap<unknown, unknown> | undefined =
    entry.doc?._transaction?.changed;
  if (!changed) return false;
  if (changed.has(entry)) return true;
  for (const value of entry.values()) if (changed.has(value)) return true;
  return false;
}

/** A figure entry as its block, repaired; none while incomplete. */
export function readFigure(entry: YMap, type: FigureType): LiveFigure | null {
  let held = reads.get(entry);
  if (!held) {
    const fresh: Held = { dirty: true, figure: null, type };
    entry.observeDeep(() => {
      fresh.dirty = true;
    });
    reads.set(entry, fresh);
    held = fresh;
  }
  if (held.dirty || held.type !== type || changedNow(entry)) {
    const figure = build(entry, type);
    held.figure = figure && {
      ...figure,
      block: repairFigureBlock(figure.block),
    };
    held.dirty = false;
    held.type = type;
  }
  return held.figure;
}

/* Blocks read from a room remember their entry's key, so the question editor
 * can address the figure a dialog saves (`FigureRoom.key`). */
const blockKeys = new WeakMap<QuestionBlock, string>();
export const keyBlock = (block: QuestionBlock, key: string) => {
  blockKeys.set(block, key);
};
export const blockKey = (block: QuestionBlock) => blockKeys.get(block);

/* --------------------------------------------------------------- writing */

/** Plain fields written as what differs; ones the block no longer has go. */
function writeFields(entry: YMap, block: FigureBlock) {
  const maps = MAPS[block.type];
  for (const [key, value] of Object.entries(block))
    if (key !== 'type' && !maps.includes(key)) setPlain(entry, key, value);
  for (const key of [...entry.keys()])
    if (
      key !== 'order' &&
      key !== 'type' &&
      !maps.includes(key) &&
      (block as Record<string, unknown>)[key] === undefined
    )
      entry.delete(key);
}

/** A graph's elements made `next`, touching only what changed: an equal
 * element keeps its entry, a new one takes an order key between its
 * neighbours, a moved one a new key, a gone one goes. */
function writeElements(map: YMap, next: GraphElement[]) {
  const held = new Map(elementEntries(map));
  const orders = risingOrders(
    next.map((element) => held.get(element.id)?.order ?? '')
  );
  next.forEach((element, i) => {
    const entry = held.get(element.id);
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

function writeGraph(entry: YMap, block: GraphBlock) {
  const board = child(entry, 'board');
  const wanted = block.board as Record<string, unknown>;
  for (const [key, value] of Object.entries(wanted))
    setPlain(board, key, value);
  for (const key of [...board.keys()])
    if (wanted[key] === undefined) board.delete(key);
  writeElements(child(entry, 'elements'), block.elements);
}

/** A chart's data written as its table would be: labels as columns, series as
 * rows, aligned by `alignAxis`; names and values only where they differ. */
function writeChart(entry: YMap, block: ChartBlock) {
  const labelMap = child(entry, 'labels');
  const seriesMap = child(entry, 'series');
  const names = child(entry, 'names');
  const values = child(entry, 'values');
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

/** A figure's entry made to hold `block`, writing only what differs (the
 * diffing replace): server writers and a dialog's Done take this path. */
export function writeFigure(entry: YMap, block: FigureBlock) {
  writeFields(entry, block);
  if (block.type === 'graph') writeGraph(entry, block);
  if (block.type === 'chart') writeChart(entry, block);
}

/* ------------------------------------------------- the dialogs' writes */

/** The blocks map of a question's section, and the document holding it. */
export function sectionMap(
  docs: QuizDocs,
  question: string,
  section: BlockSection
) {
  if (section.solution) {
    const key = section.partId
      ? mapAt(docs.keys.getMap<unknown>(KEYS_ROOT), section.partId)
      : undefined;
    return { doc: docs.keys, map: mapAt(key, 'solution') };
  }
  const entry = mapAt(docs.content.getMap<unknown>(QUESTIONS_ROOT), question);
  const map = section.groupId
    ? mapAt(mapAt(mapAt(entry, 'groups'), section.groupId), 'blocks')
    : section.partId
      ? mapAt(mapAt(mapAt(entry, 'parts'), section.partId), 'blocks')
      : mapAt(entry, 'stem');
  return { doc: docs.content, map };
}

/** The figure's entry and its document; none once it is gone. */
function located(docs: QuizDocs, at: FigureAt) {
  const { doc, map } = sectionMap(docs, at.question, at.section);
  const entry = mapAt(map, at.entry);
  const type = entry?.get('type');
  return entry && isFigureType(type) ? { doc, entry, type } : undefined;
}

/** Runs `write` on the figure's entry as one undoable step; false when the
 * figure is gone (a co-editor removed it). */
function edit(
  docs: QuizDocs,
  at: FigureAt,
  write: (entry: YMap, type: FigureType) => void
): boolean {
  const found = located(docs, at);
  if (!found) return false;
  found.doc.transact(() => write(found.entry, found.type), LOCAL_EDIT);
  return true;
}

/** The figure as it is now; none once it is gone. */
export function liveFigure(docs: QuizDocs, at: FigureAt): LiveFigure | null {
  const found = located(docs, at);
  return found ? readFigure(found.entry, found.type) : null;
}

/** Follows a figure: `listener` hears it after each change of its own (none
 * once it is gone), not after edits elsewhere. Returns the unsubscribe. */
export function subscribeFigure(
  docs: QuizDocs,
  at: FigureAt,
  listener: (figure: LiveFigure | null) => void
): () => void {
  const doc = at.section.solution ? docs.keys : docs.content;
  let last = liveFigure(docs, at);
  const update = () => {
    const next = liveFigure(docs, at);
    if (next === last) return;
    last = next;
    listener(next);
  };
  doc.on('update', update);
  return () => doc.off('update', update);
}

type Scalars<B, Held extends keyof B> = Partial<Omit<B, 'type' | Held>>;
/** A figure's plain fields (undefined removes an optional one). */
export type FigureFields =
  | Scalars<GraphBlock, 'board' | 'elements'>
  | Scalars<ChartBlock, 'labels' | 'series'>
  | Scalars<PlotBlock, never>;

/** Sets the named plain fields: a graph's size or description, a chart's
 * kind, titles, gridlines or description, any of a plot's. */
export function setFigureFields(
  docs: QuizDocs,
  at: FigureAt,
  values: FigureFields
): boolean {
  return edit(docs, at, (entry, type) => {
    for (const [key, value] of Object.entries(values)) {
      if (key === 'type' || key === 'order' || MAPS[type].includes(key))
        throw new Error(`${key} is not a plain field of a ${type}`);
      setPlain(entry, key, value);
    }
  });
}

/** Sets one board field of a graph (its view, axes, grid). */
export function setGraphBoard<K extends keyof GraphBlock['board']>(
  docs: QuizDocs,
  at: FigureAt,
  field: K,
  value: GraphBlock['board'][K]
): boolean {
  return edit(docs, at, (entry) => {
    setPlain(child(entry, 'board'), field, value);
  });
}

const lastOrder = (map: YMap) =>
  elementEntries(map).reduce<string | null>(
    (last, [, entry]) =>
      last === null || entry.order > last ? entry.order : last,
    null
  );

/** Sets a graph element by its id: a changed one keeps its place, a new one
 * goes last. */
export function setGraphElement(
  docs: QuizDocs,
  at: FigureAt,
  element: GraphElement
): boolean {
  return edit(docs, at, (entry) => {
    const map = child(entry, 'elements');
    const held = map.get(element.id);
    if (isEntry(held, element.id)) {
      if (!samePlain(held.element, element))
        map.set(element.id, { element, order: held.order });
      return;
    }
    map.set(element.id, { element, order: keyBetween(lastOrder(map), null) });
  });
}

export function deleteGraphElement(
  docs: QuizDocs,
  at: FigureAt,
  id: string
): boolean {
  return edit(docs, at, (entry) => {
    mapAt(entry, 'elements')?.delete(id);
  });
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
export function moveGraphElement(
  docs: QuizDocs,
  at: FigureAt,
  id: string,
  index: number
): boolean {
  return edit(docs, at, (entry) => {
    const map = mapAt(entry, 'elements');
    const held = map?.get(id);
    if (!(map && isEntry(held, id))) return;
    const others = elementEntries(map)
      .filter(([key]) => key !== id)
      .map(([key, value]) => ({ id: key, order: value.order }))
      .sort((a, b) =>
        a.order < b.order ? -1 : a.order > b.order ? 1 : a.id < b.id ? -1 : 1
      )
      .map((item) => item.order);
    map.set(id, { element: held.element, order: orderAt(others, index) });
  });
}

/** A chart's series (rows) or labels (columns). */
export type ChartAxis = 'series' | 'labels';

/** Adds a series or label named `name` at `index`; its values start empty.
 * The new id, or none when the chart is gone. */
export function addChartItem(
  docs: QuizDocs,
  at: FigureAt,
  axis: ChartAxis,
  index: number,
  name: string
): string | null {
  const id = uid(axis === 'series' ? 'ser' : 'lab');
  const done = edit(docs, at, (entry) => {
    const map = child(entry, axis);
    const orders = orderedKeys(map).map((key) => map.get(key) as string);
    map.set(id, orderAt(orders, index));
    child(entry, 'names').set(id, name);
  });
  return done ? id : null;
}

/** Removes a series or label with its name and values. */
export function removeChartItem(
  docs: QuizDocs,
  at: FigureAt,
  axis: ChartAxis,
  id: string
): boolean {
  return edit(docs, at, (entry) => {
    mapAt(entry, axis)?.delete(id);
    mapAt(entry, 'names')?.delete(id);
    const values = mapAt(entry, 'values');
    for (const key of [...(values?.keys() ?? [])]) {
      const [series, label] = key.split('/');
      if ((axis === 'series' ? series : label) === id) values?.delete(key);
    }
  });
}

/** Moves a series or label to `index`. */
export function moveChartItem(
  docs: QuizDocs,
  at: FigureAt,
  axis: ChartAxis,
  id: string,
  index: number
): boolean {
  return edit(docs, at, (entry) => {
    const map = mapAt(entry, axis);
    if (!map?.has(id)) return;
    const orders = orderedKeys(map)
      .filter((key) => key !== id)
      .map((key) => map.get(key) as string);
    map.set(id, orderAt(orders, index));
  });
}

/** Renames a series or label. */
export function setChartName(
  docs: QuizDocs,
  at: FigureAt,
  id: string,
  name: string
): boolean {
  return edit(docs, at, (entry) => {
    setPlain(child(entry, 'names'), id, name);
  });
}

/** Sets one value of a chart (null: an empty cell). */
export function setChartCell(
  docs: QuizDocs,
  at: FigureAt,
  series: string,
  label: string,
  value: number | null
): boolean {
  return edit(docs, at, (entry) => {
    setPlain(child(entry, 'values'), `${series}/${label}`, value ?? undefined);
  });
}
