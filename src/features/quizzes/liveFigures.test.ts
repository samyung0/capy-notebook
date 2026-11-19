import { expect, it } from 'vitest';
import * as Y from 'yjs';
import type { FigureAt } from '@/features/questions/questionEdits';
import type {
  ChartBlock,
  GraphBlock,
  PlotBlock,
  Question,
} from '@/features/questions/types';
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
import { figureRoom, readQuestions, seedQuiz, writeQuestion } from './liveQuiz';

const graph: GraphBlock = {
  board: { axis: true, bbox: [-5, 5, 5, -5], grid: false },
  description: 'Two points',
  elements: [
    { coords: [0, 0], id: 'A', type: 'point' },
    { coords: [2, 1], id: 'B', type: 'point' },
    { id: 's', points: ['A', 'B'], type: 'segment' },
  ],
  height: 300,
  type: 'graph',
  width: 400,
};
const chart: ChartBlock = {
  kind: 'bar',
  labels: ['Mon', 'Tue'],
  series: [
    { name: 'Rain', values: [1, null] },
    { name: 'Sun', values: [3, 4] },
  ],
  title: 'Week',
  type: 'chart',
};
const plot: PlotBlock = {
  series: [
    {
      name: 'v',
      points: [
        [0, 0],
        [1, 2],
      ],
    },
  ],
  title: 'Speed',
  type: 'plot',
  xTitle: 't',
  yTitle: 'v',
};
const question: Question = {
  id: 'q1',
  labels: 'letters',
  layout: 'paper',
  parts: [
    {
      answer: { accepted: ['4'], type: 'short' },
      blocks: [{ text: 'Read the chart.', type: 'text' }, chart],
      id: 'p1',
      marks: 1,
      solution: [{ text: 'So:', type: 'text' }, plot, graph],
    },
  ],
  stem: [graph],
};

function seeded(): QuizDocs {
  const docs = { content: new Y.Doc(), keys: new Y.Doc() };
  seedQuiz(docs.content, docs.keys, [question]);
  return docs;
}

/** A second editor's copy of both documents. */
function peer(docs: QuizDocs): QuizDocs {
  const copy = (doc: Y.Doc) => {
    const other = new Y.Doc();
    Y.applyUpdate(other, Y.encodeStateAsUpdate(doc));
    return other;
  };
  return { content: copy(docs.content), keys: copy(docs.keys) };
}

/** Both editors exchange what the other lacks. */
function sync(a: QuizDocs, b: QuizDocs) {
  for (const key of ['content', 'keys'] as const) {
    const fromA = Y.encodeStateAsUpdate(a[key], Y.encodeStateVector(b[key]));
    const fromB = Y.encodeStateAsUpdate(b[key], Y.encodeStateVector(a[key]));
    Y.applyUpdate(b[key], fromA);
    Y.applyUpdate(a[key], fromB);
  }
}

const keyOf = (docs: QuizDocs, at: Omit<FigureAt, 'entry'>, index: number) => {
  const question = readQuestions(docs.content, docs.keys)[0];
  const blocks = at.section.solution
    ? question.parts[0].solution
    : at.section.partId
      ? question.parts[0].blocks
      : question.stem;
  const entry = figureRoom(docs).key(blocks[index]);
  if (!entry) throw new Error('no entry');
  return { ...at, entry };
};
const stemGraph = (docs: QuizDocs) =>
  keyOf(docs, { question: 'q1', section: {} }, 0);
const partChart = (docs: QuizDocs) =>
  keyOf(docs, { question: 'q1', section: { partId: 'p1' } }, 1);
const solutionGraph = (docs: QuizDocs) =>
  keyOf(docs, { question: 'q1', section: { partId: 'p1', solution: true } }, 2);

/** The map at `path` from a document's root. */
function mapIn(doc: Y.Doc, [root, ...path]: string[]): Y.Map<unknown> {
  let map = doc.getMap<unknown>(root);
  for (const key of path) {
    const next = map.get(key);
    if (!(next instanceof Y.Map)) throw new Error(`no map at ${key}`);
    map = next;
  }
  return map;
}

it('holds each figure as a map of fields in both documents and reads it back', () => {
  const docs = seeded();
  expect(readQuestions(docs.content, docs.keys)).toEqual([question]);
  const held = mapIn(docs.content, [
    'questions',
    'q1',
    'stem',
    stemGraph(docs).entry,
  ]).toJSON();
  expect(held).toMatchObject({
    board: { axis: true, bbox: [-5, 5, 5, -5], grid: false },
    description: 'Two points',
    height: 300,
    type: 'graph',
    width: 400,
  });
  expect(held.elements.A).toEqual({
    element: graph.elements[0],
    order: expect.any(String),
  });
  const chartHeld = mapIn(docs.content, [
    'questions',
    'q1',
    'parts',
    'p1',
    'blocks',
    partChart(docs).entry,
  ]).toJSON();
  expect(Object.keys(chartHeld.series)).toHaveLength(2);
  expect(Object.keys(chartHeld.labels)).toHaveLength(2);
  expect(Object.values(chartHeld.values).sort()).toEqual([1, 3, 4]);
  const solution = mapIn(docs.keys, [
    'keys',
    'p1',
    'solution',
    solutionGraph(docs).entry,
  ]).toJSON();
  expect(Object.keys(solution.elements).sort()).toEqual(['A', 'B', 's']);
});

it('merges two editors changing different elements and board fields of one graph', () => {
  const a = seeded();
  const b = peer(a);
  const at = stemGraph(a);
  setGraphElement(a, at, { coords: [1, 1], id: 'A', type: 'point' });
  setGraphElement(b, at, { coords: [3, 3], id: 'B', type: 'point' });
  setGraphBoard(a, at, 'grid', true);
  setGraphBoard(b, at, 'bbox', [-1, 1, 1, -1]);
  sync(a, b);
  const expected = {
    ...graph,
    board: { axis: true, bbox: [-1, 1, 1, -1], grid: true },
    elements: [
      { coords: [1, 1], id: 'A', type: 'point' },
      { coords: [3, 3], id: 'B', type: 'point' },
      graph.elements[2],
    ],
  };
  expect(liveFigure(a, at)?.block).toEqual(expected);
  expect(liveFigure(b, at)?.block).toEqual(expected);
});

it('merges an added element with another removed, in a solution figure', () => {
  const a = seeded();
  const b = peer(a);
  const at = solutionGraph(a);
  setGraphElement(a, at, { coords: [4, 0], id: 'C', type: 'point' });
  deleteGraphElement(b, at, 's');
  sync(a, b);
  const ids = (docs: QuizDocs) =>
    (liveFigure(docs, at)?.block as GraphBlock | undefined)?.elements.map(
      (e) => e.id
    );
  expect(ids(a)).toEqual(['A', 'B', 'C']);
  expect(ids(b)).toEqual(['A', 'B', 'C']);
});

it('reorders an element by its order key, and two moves at once keep it once', () => {
  const a = seeded();
  const b = peer(a);
  const at = stemGraph(a);
  moveGraphElement(a, at, 's', 0);
  moveGraphElement(b, at, 's', 1);
  sync(a, b);
  const ids =
    (liveFigure(a, at)?.block as GraphBlock | undefined)?.elements.map(
      (e) => e.id
    ) ?? [];
  expect(ids.filter((id) => id === 's')).toHaveLength(1);
  expect(ids).toHaveLength(3);
  expect(liveFigure(b, at)?.block).toEqual(liveFigure(a, at)?.block);
});

it('merges two editors changing different cells, series and labels of one chart', () => {
  const a = seeded();
  const b = peer(a);
  const at = partChart(a);
  const { labels, series } = liveFigure(a, at) ?? { labels: [], series: [] };
  setChartCell(a, at, series[0], labels[1], 2);
  setChartCell(b, at, series[1], labels[0], 5);
  setChartName(b, at, labels[0], 'Monday');
  const added = addChartItem(a, at, 'series', 2, 'Wind');
  setFigureFields(b, at, { title: 'Weather' });
  sync(a, b);
  if (!added) throw new Error('no series added');
  setChartCell(a, at, added, labels[0], 7);
  sync(a, b);
  const expected: ChartBlock = {
    ...chart,
    labels: ['Monday', 'Tue'],
    series: [
      { name: 'Rain', values: [1, 2] },
      { name: 'Sun', values: [5, 4] },
      { name: 'Wind', values: [7, null] },
    ],
    title: 'Weather',
  };
  expect(liveFigure(a, at)?.block).toEqual(expected);
  expect(liveFigure(b, at)?.block).toEqual(expected);
});

it('removes a chart series or label with its values', () => {
  const docs = seeded();
  const at = partChart(docs);
  const { labels, series } = liveFigure(docs, at) ?? { labels: [], series: [] };
  removeChartItem(docs, at, 'series', series[0]);
  removeChartItem(docs, at, 'labels', labels[0]);
  expect(liveFigure(docs, at)?.block).toEqual({
    ...chart,
    labels: ['Tue'],
    series: [{ name: 'Sun', values: [4] }],
  });
});

it("sets a plot's fields", () => {
  const docs = seeded();
  const at = keyOf(
    docs,
    { question: 'q1', section: { partId: 'p1', solution: true } },
    1
  );
  setFigureFields(docs, at, { kind: 'scatter', title: 'Velocity' });
  expect(liveFigure(docs, at)?.block).toEqual({
    ...plot,
    kind: 'scatter',
    title: 'Velocity',
  });
});

it('saves a figure a co-editor changed meanwhile in place, writing only what differs', () => {
  const a = seeded();
  const b = peer(a);
  const room = figureRoom(a);
  const at = stemGraph(a);
  // B moves point B while A's dialog is open on the graph as it was.
  setGraphElement(b, at, { coords: [3, 3], id: 'B', type: 'point' });
  sync(a, b);
  const saved: GraphBlock = {
    ...graph,
    elements: [
      { coords: [-1, -1], id: 'A', type: 'point' },
      ...graph.elements.slice(1),
    ],
  };
  const changed: string[] = [];
  const elements = mapIn(a.content, [
    'questions',
    'q1',
    'stem',
    at.entry,
    'elements',
  ]);
  elements.observe((event) => changed.push(...event.keysChanged));
  expect(room.replace(at, saved)).toBe(true);
  // Done writes the graph as the dialog holds it, B's point too, and leaves
  // the segment's entry alone.
  expect(changed.sort()).toEqual(['A', 'B']);
  const stem = readQuestions(a.content, a.keys)[0].stem;
  expect(stem).toEqual([saved]);
});

it('inserts a figure after the block it followed and removes it by its entry', () => {
  const docs = seeded();
  const room = figureRoom(docs);
  const section = { partId: 'p1' };
  const text = readQuestions(docs.content, docs.keys)[0].parts[0].blocks[0];
  const entry = room.insert(
    { after: room.key(text), index: 1, question: 'q1', section },
    graph
  );
  expect(
    readQuestions(docs.content, docs.keys)[0].parts[0].blocks.map((b) => b.type)
  ).toEqual(['text', 'graph', 'chart']);
  if (!entry) throw new Error('not inserted');
  expect(room.remove({ entry, question: 'q1', section })).toBe(true);
  expect(readQuestions(docs.content, docs.keys)).toEqual([question]);
});

it('tells a dialog of its own figure changing, not of edits elsewhere', () => {
  const docs = seeded();
  const at = stemGraph(docs);
  const heard: unknown[] = [];
  const stop = subscribeFigure(docs, at, (figure) => heard.push(figure?.block));
  const before = liveFigure(docs, at);
  writeQuestion(docs.content, docs.keys, {
    ...question,
    stem: [graph, { text: 'More', type: 'text' }],
  });
  expect(heard).toEqual([]);
  expect(liveFigure(docs, at)).toBe(before);
  setFigureFields(docs, at, { width: 500 });
  expect(heard).toEqual([{ ...graph, width: 500 }]);
  stop();
});
