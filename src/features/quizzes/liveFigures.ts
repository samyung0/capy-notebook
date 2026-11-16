import type * as Y from 'yjs';
import { LOCAL_EDIT } from '@/features/collaboration/yText';
import {
  addChartItem as addChartItemIn,
  type ChartAxis,
  deleteElement,
  type FigureFields,
  type FigureType,
  isFigureType,
  type LiveFigure,
  moveElement,
  readFigure,
  removeChartItem as removeChartItemIn,
  setBoardField,
  setChartCell as setChartCellIn,
  setChartName as setChartNameIn,
  setElement,
  setFields,
} from '@/features/figures/figureMap';
import type { BlockSection } from '@/features/questions/QuestionView';
import type { FigureAt } from '@/features/questions/questionEdits';
import type {
  GraphBlock,
  GraphElement,
  QuestionBlock,
} from '@/features/questions/types';
import { KEYS_ROOT, mapAt, QUESTIONS_ROOT, type YMap } from './liveMaps';

/* A live quiz's charts, plots and graphs (Epo 2026-11-16, D2/D3/D9), in the
 * content document and, for a solution's, the keys document. A figure's
 * entry holds the figure map (figures/figureMap.ts, the layout note figures
 * share) beside its `order`. The entry's key is the figure's identity: the
 * question editor carries it to the figure dialog, which writes that entry
 * (`FigureAt`). */

export {
  type ChartAxis,
  type FigureBlock,
  type FigureFields,
  type FigureType,
  isFigureType,
  type LiveFigure,
  readFigure,
  writeFigure,
} from '@/features/figures/figureMap';

/** A quiz's two documents. */
export type QuizDocs = { content: Y.Doc; keys: Y.Doc };

/* Blocks read from a room remember their entry's key, so the question editor
 * can address the figure a dialog saves (`FigureRoom.key`). */
const blockKeys = new WeakMap<QuestionBlock, string>();
export const keyBlock = (block: QuestionBlock, key: string) => {
  blockKeys.set(block, key);
};
export const blockKey = (block: QuestionBlock) => blockKeys.get(block);

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

/** Sets the named plain fields: a graph's size or description, a chart's
 * kind, titles, gridlines or description, any of a plot's. */
export function setFigureFields(
  docs: QuizDocs,
  at: FigureAt,
  values: FigureFields
): boolean {
  return edit(docs, at, (entry, type) => setFields(entry, type, values));
}

/** Sets one board field of a graph (its view, axes, grid). */
export function setGraphBoard<K extends keyof GraphBlock['board']>(
  docs: QuizDocs,
  at: FigureAt,
  field: K,
  value: GraphBlock['board'][K]
): boolean {
  return edit(docs, at, (entry) => setBoardField(entry, field, value));
}

/** Sets a graph element by its id: a changed one keeps its place, a new one
 * goes last. */
export function setGraphElement(
  docs: QuizDocs,
  at: FigureAt,
  element: GraphElement
): boolean {
  return edit(docs, at, (entry) => setElement(entry, element));
}

export function deleteGraphElement(
  docs: QuizDocs,
  at: FigureAt,
  id: string
): boolean {
  return edit(docs, at, (entry) => deleteElement(entry, id));
}

/** Moves a graph element to `index` in the drawing order. */
export function moveGraphElement(
  docs: QuizDocs,
  at: FigureAt,
  id: string,
  index: number
): boolean {
  return edit(docs, at, (entry) => moveElement(entry, id, index));
}

/** Adds a series or label named `name` at `index`; its values start empty.
 * The new id, or none when the chart is gone. */
export function addChartItem(
  docs: QuizDocs,
  at: FigureAt,
  axis: ChartAxis,
  index: number,
  name: string
): string | null {
  let id: string | null = null;
  edit(docs, at, (entry) => {
    id = addChartItemIn(entry, axis, index, name);
  });
  return id;
}

/** Removes a series or label with its name and values. */
export function removeChartItem(
  docs: QuizDocs,
  at: FigureAt,
  axis: ChartAxis,
  id: string
): boolean {
  return edit(docs, at, (entry) => removeChartItemIn(entry, axis, id));
}

/** Renames a series or label. */
export function setChartName(
  docs: QuizDocs,
  at: FigureAt,
  id: string,
  name: string
): boolean {
  return edit(docs, at, (entry) => setChartNameIn(entry, id, name));
}

/** Sets one value of a chart (null: an empty cell). */
export function setChartCell(
  docs: QuizDocs,
  at: FigureAt,
  series: string,
  label: string,
  value: number | null
): boolean {
  return edit(docs, at, (entry) => setChartCellIn(entry, series, label, value));
}
