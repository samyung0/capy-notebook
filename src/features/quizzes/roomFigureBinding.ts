import type { FigureBinding } from '@/features/questions/figureBinding';
import type { FigureAt } from '@/features/questions/questionEdits';
import {
  addChartItem,
  deleteGraphElement,
  liveFigure,
  moveGraphElement,
  type QuizDocs,
  removeChartItem,
  setChartCell,
  setChartName,
  setFigureFields,
  setGraphBoard,
  setGraphElement,
  subscribeFigure,
} from './liveFigures';

/** A live quiz's figure as its dialog edits it (Epo 2026-11-16, D2/D3): each
 * change is written to the room entry at once, one transaction in the
 * room's undo history, so co-editors see it as it is made. */
export function roomFigureBinding(
  docs: QuizDocs,
  at: FigureAt,
  remove: () => void
): FigureBinding {
  return {
    addChartItem: (axis, index, name) =>
      addChartItem(docs, at, axis, index, name),
    deleteElement: (id) => {
      deleteGraphElement(docs, at, id);
    },
    moveElement: (id, index) => {
      moveGraphElement(docs, at, id, index);
    },
    read: () => liveFigure(docs, at),
    remove,
    removeChartItem: (axis, id) => {
      removeChartItem(docs, at, axis, id);
    },
    setBoard: (field, value) => {
      setGraphBoard(docs, at, field, value);
    },
    setChartCell: (series, label, value) => {
      setChartCell(docs, at, series, label, value);
    },
    setChartName: (id, name) => {
      setChartName(docs, at, id, name);
    },
    setElement: (element) => {
      setGraphElement(docs, at, element);
    },
    setFields: (values) => {
      setFigureFields(docs, at, values);
    },
    subscribe: (listener) => subscribeFigure(docs, at, () => listener()),
  };
}
