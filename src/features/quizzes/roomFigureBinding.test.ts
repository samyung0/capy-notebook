import { expect, it } from 'vitest';
import * as Y from 'yjs';
import type { FigureBinding } from '@/features/questions/figureBinding';
import {
  buildElements,
  type GraphRow,
  reconcileRows,
  rowsFromElements,
} from '@/features/questions/graphSyntax';
import { type Frames, graphWriter } from '@/features/questions/graphWriter';
import {
  bindFigure,
  newQuestionBlock,
} from '@/features/questions/questionEdits';
import type {
  ChartBlock,
  GraphBlock,
  GraphElement,
  Question,
} from '@/features/questions/types';
import type { QuizDocs } from './liveFigures';
import { figureRoom, readQuestions, seedQuiz } from './liveQuiz';

/* The figure dialog's writes through a quiz room (Epo 2026-11-16, D2/D3):
   two editors' dialogs on one figure each write their own change, and both
   keep both. */

const graph: GraphBlock = {
  board: { axis: true, bbox: [-5, 5, 5, -5], grid: false },
  elements: [
    { coords: [0, 0], id: 'A', name: 'A', type: 'point' },
    { coords: [2, 1], id: 'B', name: 'B', type: 'point' },
  ],
  height: 300,
  type: 'graph',
  width: 400,
};
const chart: ChartBlock = {
  kind: 'bar',
  labels: ['Mon', 'Tue'],
  series: [{ name: 'Rain', values: [1, 2] }],
  title: 'Week',
  type: 'chart',
};
const question: Question = {
  id: 'q1',
  labels: 'letters',
  layout: 'paper',
  parts: [
    {
      answer: { accepted: ['4'], type: 'short' },
      blocks: [{ text: 'Read it.', type: 'text' }],
      id: 'p1',
      marks: 1,
      solution: [],
    },
  ],
  stem: [graph, chart],
};

function seeded(): QuizDocs {
  const docs = { content: new Y.Doc(), keys: new Y.Doc() };
  seedQuiz(docs.content, docs.keys, [question]);
  return docs;
}

function peer(docs: QuizDocs): QuizDocs {
  const copy = (doc: Y.Doc) => {
    const other = new Y.Doc();
    Y.applyUpdate(other, Y.encodeStateAsUpdate(doc));
    return other;
  };
  return { content: copy(docs.content), keys: copy(docs.keys) };
}

function sync(a: QuizDocs, b: QuizDocs) {
  for (const key of ['content', 'keys'] as const) {
    const fromA = Y.encodeStateAsUpdate(a[key], Y.encodeStateVector(b[key]));
    const fromB = Y.encodeStateAsUpdate(b[key], Y.encodeStateVector(a[key]));
    Y.applyUpdate(b[key], fromA);
    Y.applyUpdate(a[key], fromB);
  }
}

/** The dialog's binding for the stem's figure at `index`. */
function bound(docs: QuizDocs, index: number): FigureBinding {
  const figures = figureRoom(docs);
  const block = readQuestions(docs.content, docs.keys)[0].stem[index];
  const entry = figures.key(block);
  if (!entry) throw new Error('no entry');
  return figures.bind({ entry, question: 'q1', section: {} });
}

/** The bound figure's graph as it is now. */
function graphOf(binding: FigureBinding): GraphBlock {
  const block = binding.read()?.block;
  if (block?.type !== 'graph') throw new Error('no graph');
  return block;
}

/** A graph dialog's rows and writer, its frames run by hand. */
function dialog(binding: FigureBinding) {
  let rows = rowsFromElements(graphOf(binding).elements);
  let queued: (() => void) | null = null;
  const frames: Frames = {
    cancel: () => {
      queued = null;
    },
    request: (run) => {
      queued = run;
      return 1;
    },
  };
  const writer = graphWriter(
    binding,
    () => buildElements(rows).elements,
    () => {},
    frames
  );
  return {
    frame() {
      queued?.();
    },
    /** The rows after the figure changed, as the editor reconciles them. */
    reconcile() {
      const held = graphOf(binding).elements;
      rows = reconcileRows(
        rows,
        held,
        new Map(buildElements(rows).elements.map((e) => [e.id, e])),
        writer.typing
      );
      return rows;
    },
    /** Types `latex` (read as `ascii`) into row `key`. */
    type(key: string, row: Partial<GraphRow> & Pick<GraphRow, 'kind'>) {
      rows = rows.map((item) =>
        item.key === key ? ({ ...item, ...row } as GraphRow) : item
      );
      writer.touch([key]);
    },
  };
}

const at = (x: number, y: number) => ({
  kind: 'expression' as const,
  parsed: { coords: [x, y] as [number, number], kind: 'point' as const },
});
const elementsOf = (binding: FigureBinding) => graphOf(binding).elements;

it('two editors’ graph dialogs moving different points both keep their move', () => {
  const a = seeded();
  const b = peer(a);
  const mine = dialog(bound(a, 0));
  const theirs = dialog(bound(b, 0));
  mine.type('A', at(1, 1));
  theirs.type('B', at(3, 3));
  mine.frame();
  theirs.frame();
  sync(a, b);
  const both: GraphElement[] = [
    { coords: [1, 1], id: 'A', type: 'point' },
    { coords: [3, 3], id: 'B', type: 'point' },
  ];
  expect(elementsOf(bound(a, 0))).toEqual(both);
  expect(elementsOf(bound(b, 0))).toEqual(both);
});

it('keeps a row being typed over a co-editor’s change, then writes it', () => {
  const a = seeded();
  const b = peer(a);
  const binding = bound(a, 0);
  const mine = dialog(binding);
  // Point B typed here, its frame not come yet; a co-editor moves A and B.
  mine.type('B', at(7, 7));
  const theirs = bound(b, 0);
  theirs.setElement({ coords: [5, 5], id: 'A', type: 'point' });
  theirs.setElement({ coords: [9, 9], id: 'B', type: 'point' });
  sync(a, b);
  const rows = mine.reconcile();
  // A follows the co-editor; B keeps what is typed here.
  expect(buildElements(rows).elements).toEqual([
    { coords: [5, 5], id: 'A', type: 'point' },
    { coords: [7, 7], id: 'B', type: 'point' },
  ]);
  mine.frame();
  sync(a, b);
  expect(elementsOf(theirs)).toEqual(buildElements(rows).elements);
});

it('two editors’ chart dialogs typing in different cells both keep their numbers', () => {
  const a = seeded();
  const b = peer(a);
  const mine = bound(a, 1);
  const theirs = bound(b, 1);
  const read = mine.read();
  if (!read) throw new Error('no chart');
  const [rain] = read.series;
  const [mon, tue] = read.labels;
  mine.setChartCell(rain, mon, 10);
  theirs.setChartCell(rain, tue, 20);
  theirs.setChartName(tue, 'Tuesday');
  sync(a, b);
  const merged = {
    ...chart,
    labels: ['Mon', 'Tuesday'],
    series: [{ name: 'Rain', values: [10, 20] }],
  };
  expect(mine.read()?.block).toEqual(merged);
  expect(theirs.read()?.block).toEqual(merged);
});

it('puts a figure just added into the room, and Remove takes it out', () => {
  const docs = seeded();
  const figures = figureRoom(docs);
  const [first] = readQuestions(docs.content, docs.keys)[0].stem;
  const block = newQuestionBlock('graph');
  const opened = bindFigure(
    { before: first, block, index: 1, isNew: true, section: {} },
    {
      figures,
      question: 'q1',
      writeBlocks: () => {
        throw new Error('a live quiz writes its room');
      },
    }
  );
  if (!opened) throw new Error('not added');
  const stem = () => readQuestions(docs.content, docs.keys)[0].stem;
  expect(stem().map((item) => item.type)).toEqual(['graph', 'graph', 'chart']);
  expect(opened.binding.read()?.block).toEqual(block);
  opened.binding.remove();
  expect(opened.binding.read()).toBeNull();
  expect(stem().map((item) => item.type)).toEqual(['graph', 'chart']);
});
