import { slateNodesToInsertDelta } from '@slate-yjs/core';
import { expect, it } from 'vitest';
import * as Y from 'yjs';
import '@/features/notes/figureBinding';
import type { GraphBlock, GraphElement } from '@/features/questions/types';
import {
  type FigureBlock,
  heldBlock,
  readFigure,
  setElement,
  writeFigure,
} from './figureMap';

/* One figure map in quiz rooms and note rooms (Epo 2026-11-16, D15): a quiz
 * block entry is the map beside its `order`, a note figure's `block` the map
 * alone, and the same reader and writer serve both. */

const chart = {
  kind: 'bar',
  labels: ['Jan', 'Feb'],
  series: [
    { name: 'A', values: [1, null] },
    { name: 'B', values: [3, 4] },
  ],
  title: 'Sales',
  type: 'chart',
} as FigureBlock;

const graph: GraphBlock = {
  board: { axis: true, bbox: [-5, 5, 5, -5], grid: true },
  elements: [
    { coords: [0, 0], id: 'p1', name: 'A', type: 'point' },
    { coords: [1, 1], id: 'p2', type: 'point' },
    { id: 's1', points: ['p1', 'p2'], type: 'segment' },
  ],
  height: 300,
  type: 'graph',
  width: 400,
};

const plot = {
  kind: 'line',
  series: [
    {
      name: 'S',
      points: [
        [0, 0],
        [1, 1],
      ],
    },
  ],
  title: 'Growth',
  type: 'plot',
} as FigureBlock;

/** A quiz block entry holding `block`, as liveQuiz writes one. */
function quizEntry(block: FigureBlock) {
  const entry = new Y.Doc().getMap<unknown>('entry');
  entry.doc?.transact(() => {
    entry.set('order', 'a0');
    entry.set('type', block.type);
    writeFigure(entry, block);
  });
  return entry;
}

/** A note figure's `block` map holding `block`, as the slate-yjs patch
 * inserts one. */
function noteMap(block: FigureBlock) {
  const root = new Y.Doc().get('content', Y.XmlText);
  root.applyDelta(
    slateNodesToInsertDelta([
      { block, children: [{ text: '' }], id: 'f', type: block.type },
    ] as never)
  );
  return (root.toDelta() as { insert: Y.XmlText }[])[0].insert.getAttribute(
    'block'
  ) as unknown as Y.Map<unknown>;
}

/** A map's layout: its keys and, for a map inside, that map's keys. */
const layout = (map: Y.Map<unknown>) =>
  Object.fromEntries(
    [...map.entries()].map(([key, value]) => [
      key,
      value instanceof Y.Map ? [...value.keys()].length : typeof value,
    ])
  );

it.each([chart, graph, plot].map((block) => [block.type, block] as const))(
  'holds a %s alike in a quiz entry and a note figure, read back by one reader',
  (type, block) => {
    const entry = quizEntry(block);
    const note = noteMap(block);
    const { order: _, ...quiz } = layout(entry);
    expect(layout(note)).toEqual(quiz);
    expect(readFigure(entry, type)?.block).toEqual(block);
    expect(readFigure(note, type)?.block).toEqual(block);
    expect(heldBlock(note, type)).toEqual(block);
  }
);

it('writes a changed figure as a diff in either container', () => {
  for (const map of [quizEntry(graph), noteMap(graph)]) {
    const doc = map.doc as Y.Doc;
    const before = Y.encodeStateVector(doc);
    const next: GraphBlock = {
      ...graph,
      elements: [
        graph.elements[0],
        { coords: [2, 2], id: 'p2', type: 'point' },
        graph.elements[2],
      ],
    };
    doc.transact(() => writeFigure(map, next));
    expect(
      Y.decodeUpdate(Y.encodeStateAsUpdate(doc, before)).structs
    ).toHaveLength(1);
    expect(readFigure(map, 'graph')?.block).toEqual(next);
  }
});

it("keeps a peer's edit of an element when another editor appends after a gap", () => {
  const point = (id: string, x: number): GraphElement => ({
    coords: [x, x],
    id,
    type: 'point',
  });
  const [p, q, r] = [point('p', 0), point('q', 2), point('r', 3)];
  const local = quizEntry({
    ...graph,
    elements: [p, point('x', 1), q],
  });
  const here = local.doc as Y.Doc;
  here.transact(() => writeFigure(local, { ...graph, elements: [p, q] }));
  const there = new Y.Doc();
  // The appender wins a clash on one key, so a re-key of q would show.
  there.clientID = 1;
  Y.applyUpdate(there, Y.encodeStateAsUpdate(here));
  const peer = there.getMap<unknown>('entry');
  there.transact(() => setElement(peer, point('q', 9)));
  here.transact(() => writeFigure(local, { ...graph, elements: [p, q, r] }));
  Y.applyUpdate(there, Y.encodeStateAsUpdate(here));
  Y.applyUpdate(here, Y.encodeStateAsUpdate(there));
  for (const map of [local, peer]) {
    expect(readFigure(map, 'graph')?.block).toEqual({
      ...graph,
      elements: [p, point('q', 9), r],
    });
    const elements = map.get('elements') as Y.Map<{ order: string }>;
    expect(elements.get('q')?.order).toBe('a2');
  }
});
