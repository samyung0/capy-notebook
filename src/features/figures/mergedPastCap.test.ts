import { slateNodesToInsertDelta, withYjs, YjsEditor } from '@slate-yjs/core';
import { createSlateEditor } from 'platejs';
import { expect, it } from 'vitest';
import * as Y from 'yjs';
import '@/features/notes/figureBinding';
import {
  QUESTION_CHART_SERIES_MAX,
  QUESTION_GRAPH_ELEMENTS_MAX,
} from '@/api/limits.generated';
import { noteFigureBinding } from '@/features/notes/blocks/noteFigureBinding';
import { graphWriter } from '@/features/questions/graphWriter';
import type {
  ChartBlock,
  GraphBlock,
  GraphElement,
  Question,
} from '@/features/questions/types';
import { readQuestions, writeQuestion } from '@/features/quizzes/liveQuiz';
import { roomFigureBinding } from '@/features/quizzes/roomFigureBinding';
import {
  addChartItem,
  readFigure,
  removeChartItem,
  setElement,
  writeFigure,
} from './figureMap';

/* A figure two editors' adds merged past its cap (Epo 2026-11-22, "Yes, A
 * everywhere"): every reader keeps it whole up to twice the cap, every
 * editor edits each entry, and a whole-figure write removes only entries
 * its read showed. */

const point = (i: number, x = i): GraphElement => ({
  coords: [x, 0],
  id: `p${i}`,
  type: 'point',
});
const graph = (n: number): GraphBlock => ({
  board: { axis: true, bbox: [-5, 105, 105, -5], grid: true },
  elements: Array.from({ length: n }, (_, i) => point(i)),
  height: 300,
  type: 'graph',
  width: 400,
});
const frames = { cancel: () => undefined, request: () => 1 };
const sync = (a: Y.Doc, b: Y.Doc) => {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)));
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)));
};
const elementCount = (entry: Y.Map<unknown>) =>
  (entry.get('elements') as Y.Map<unknown>).size;

/** A quiz whose stem holds [text, graph of 99]; two peers each add one
 * element (a real merge), so the room holds 101. */
function quizAt101() {
  const content = new Y.Doc();
  const keys = new Y.Doc();
  const question: Question = {
    id: 'q1',
    labels: 'letters',
    layout: 'paper',
    parts: [
      {
        answer: { accepted: ['1'], type: 'short' },
        blocks: [{ text: 'Part', type: 'text' }],
        id: 'part1',
        marks: 1,
        solution: [],
      },
    ],
    stem: [
      { text: 'Stem', type: 'text' },
      graph(QUESTION_GRAPH_ELEMENTS_MAX - 1),
    ],
  };
  writeQuestion(content, keys, question);
  const stem = (doc: Y.Doc) =>
    (doc.getMap('questions').get('q1') as Y.Map<unknown>).get('stem') as Y.Map<
      Y.Map<unknown>
    >;
  const entryKey = [...stem(content).entries()].find(
    ([, e]) => e.get('type') === 'graph'
  )?.[0] as string;
  const peer = new Y.Doc();
  sync(content, peer);
  content.transact(() =>
    setElement(stem(content).get(entryKey) as Y.Map<unknown>, point(99))
  );
  peer.transact(() =>
    setElement(stem(peer).get(entryKey) as Y.Map<unknown>, point(100))
  );
  sync(content, peer);
  const entry = stem(content).get(entryKey) as Y.Map<unknown>;
  return { content, entry, entryKey, keys };
}

it('a quiz graph merged to 101: the dialog shows and writes every element', () => {
  const { content, entry, entryKey, keys } = quizAt101();
  expect(elementCount(entry)).toBe(101);
  const binding = roomFigureBinding(
    { content, keys },
    { entry: entryKey, question: 'q1', section: {} },
    () => undefined
  );
  const shown = binding.read()?.block as GraphBlock;
  expect(shown.elements).toHaveLength(101);
  // The 101st row edits as any other.
  const elements = shown.elements.map((e) =>
    e.id === 'p100' ? point(100, 50) : e
  );
  const refused: string[] = [];
  const writer = graphWriter(
    binding,
    () => ({ elements, keys: elements.map((e) => e.id) }),
    (r) => refused.push(...r.values()),
    frames
  );
  writer.touch(['p100']);
  writer.flush();
  expect(refused).toEqual([]);
  expect(elementCount(entry)).toBe(101);
  const read = readFigure(entry, 'graph')?.block as GraphBlock;
  expect(read.elements.find((e) => e.id === 'p100')).toEqual(point(100, 50));
});

it('a quiz graph merged to 101 reads whole, and question and figure writes keep it', () => {
  const { content, entry, keys } = quizAt101();
  const [question] = readQuestions(content, keys);
  expect((question.stem[1] as GraphBlock).elements).toHaveLength(101);
  writeQuestion(content, keys, {
    ...question,
    stem: [{ text: 'Stem edited', type: 'text' }, question.stem[1]],
  });
  expect(elementCount(entry)).toBe(101);
  const block = readFigure(entry, 'graph')?.block as GraphBlock;
  entry.doc?.transact(() => writeFigure(entry, { ...block, width: 420 }));
  expect(elementCount(entry)).toBe(101);
});

it('a whole-figure write removes only elements its read showed', () => {
  const doc = new Y.Doc();
  const entry = doc.getMap<unknown>('entry');
  doc.transact(() => {
    entry.set('type', 'graph');
    writeFigure(entry, graph(3));
  });
  // A segment naming a point that is gone: reads leave it out.
  doc.transact(() =>
    setElement(entry, { id: 's', points: ['p0', 'gone'], type: 'segment' })
  );
  const block = readFigure(entry, 'graph')?.block as GraphBlock;
  expect(block.elements.map((e) => e.id)).toEqual(['p0', 'p1', 'p2']);
  doc.transact(() =>
    writeFigure(entry, {
      ...block,
      elements: block.elements.filter((e) => e.id !== 'p1'),
    })
  );
  const held = entry.get('elements') as Y.Map<unknown>;
  expect(held.has('s')).toBe(true);
  expect(held.has('p1')).toBe(false);
});

it('a note graph merged to 101: the dialog holds and writes every element', () => {
  const room = new Y.Doc();
  room.get('content', Y.XmlText).applyDelta(
    slateNodesToInsertDelta([
      {
        block: graph(QUESTION_GRAPH_ELEMENTS_MAX - 1),
        children: [{ text: '' }],
        id: 'f',
        type: 'graph',
      },
    ] as never)
  );
  const blockMap = (doc: Y.Doc) =>
    (
      doc.get('content', Y.XmlText).toDelta() as { insert: Y.XmlText }[]
    )[0].insert.getAttribute('block') as unknown as Y.Map<unknown>;
  const peer = new Y.Doc();
  sync(room, peer);
  room.transact(() => setElement(blockMap(room), point(99)));
  peer.transact(() => setElement(blockMap(peer), point(100)));
  sync(room, peer);
  const editor = withYjs(
    createSlateEditor({ value: [] }) as never,
    room.get('content', Y.XmlText)
  ) as unknown as ReturnType<typeof createSlateEditor> & YjsEditor;
  YjsEditor.connect(editor);
  const held = (editor.children[0] as unknown as { block: GraphBlock }).block;
  const binding = noteFigureBinding(editor as never, 'f', held);
  const shown = binding.read()?.block as GraphBlock;
  expect(shown.elements).toHaveLength(101);
  const elements = shown.elements.map((e, i) => (i === 0 ? point(0, 50) : e));
  const writer = graphWriter(
    binding,
    () => ({ elements, keys: elements.map((e) => e.id) }),
    () => undefined,
    frames
  );
  writer.touch(['p0']);
  writer.flush();
  YjsEditor.flushLocalChanges(editor);
  expect(elementCount(blockMap(room))).toBe(101);
  const written = readFigure(blockMap(room), 'graph')?.block as GraphBlock;
  expect(written.elements[0]).toEqual(point(0, 50));
  YjsEditor.disconnect(editor);
});

/** A quiz chart entry holding `block`. */
function chartEntry(block: ChartBlock) {
  const doc = new Y.Doc();
  const entry = doc.getMap<unknown>('entry');
  doc.transact(() => {
    entry.set('order', 'a0');
    entry.set('type', 'chart');
    writeFigure(entry, block);
  });
  return entry;
}
const bars = (series: number): ChartBlock => ({
  kind: 'bar',
  labels: ['A', 'B'],
  series: Array.from({ length: series }, (_, s) => ({
    name: `S${s}`,
    values: [s, s],
  })),
  title: 'T',
  type: 'chart',
});

it('a chart two editors took past six series reads every one, up to twice the cap', () => {
  for (const count of [
    QUESTION_CHART_SERIES_MAX + 1,
    2 * QUESTION_CHART_SERIES_MAX,
  ]) {
    const live = readFigure(chartEntry(bars(count)), 'chart')
      ?.block as ChartBlock;
    expect(live.series).toHaveLength(count);
  }
  const past = readFigure(
    chartEntry(bars(2 * QUESTION_CHART_SERIES_MAX + 1)),
    'chart'
  )?.block as ChartBlock;
  expect(past.series).toHaveLength(2 * QUESTION_CHART_SERIES_MAX);
});

it('Remove last column takes the last series on screen, never one a read leaves out', () => {
  const entry = chartEntry(bars(2 * QUESTION_CHART_SERIES_MAX + 1));
  const live = readFigure(entry, 'chart');
  const block = live?.block as ChartBlock;
  // BlockEditor's rule: the id of the last series the block shows.
  const last = live?.series[block.series.length - 1] as string;
  entry.doc?.transact(() => removeChartItem(entry, 'series', last));
  const after = readFigure(entry, 'chart')?.block as ChartBlock;
  expect(after.series.map((s) => s.name)).not.toContain(
    `S${2 * QUESTION_CHART_SERIES_MAX - 1}`
  );
  expect(after.series.map((s) => s.name)).toContain(
    `S${2 * QUESTION_CHART_SERIES_MAX}`
  );
});

it("a pie's second series a merge left stays through a write of the read", () => {
  const pie = { ...bars(1), kind: 'pie' as const };
  const entry = chartEntry(pie);
  entry.doc?.transact(() => addChartItem(entry, 'series', 1, 'Second'));
  const read = readFigure(entry, 'chart')?.block as ChartBlock;
  expect(read.series).toHaveLength(1);
  entry.doc?.transact(() => writeFigure(entry, { ...read, title: 'Share' }));
  expect((entry.get('series') as Y.Map<unknown>).size).toBe(2);
  expect([...(entry.get('names') as Y.Map<string>).values()]).toContain(
    'Second'
  );
});

it('adds a series only under the cap as the chart reads when written; two at once pass it', () => {
  const entry = chartEntry(bars(QUESTION_CHART_SERIES_MAX));
  expect(addChartItem(entry, 'series', 0, 'X')).toBeNull();
  const a = chartEntry(bars(QUESTION_CHART_SERIES_MAX - 1));
  const peerDoc = new Y.Doc();
  Y.applyUpdate(peerDoc, Y.encodeStateAsUpdate(a.doc as Y.Doc));
  const b = peerDoc.getMap<unknown>('entry');
  expect(addChartItem(a, 'series', 9, 'A')).not.toBeNull();
  expect(addChartItem(b, 'series', 9, 'B')).not.toBeNull();
  sync(a.doc as Y.Doc, peerDoc);
  const merged = readFigure(a, 'chart')?.block as ChartBlock;
  expect(merged.series).toHaveLength(QUESTION_CHART_SERIES_MAX + 1);
  expect(addChartItem(a, 'series', 0, 'C')).toBeNull();
});
