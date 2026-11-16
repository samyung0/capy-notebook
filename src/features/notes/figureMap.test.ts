import {
  slateNodesToInsertDelta,
  withYHistory,
  withYjs,
  type YHistoryEditor,
  YjsEditor,
  type YjsEditor as YjsEditorType,
} from '@slate-yjs/core';
import { createSlateEditor } from 'platejs';
import { afterEach, expect, it } from 'vitest';
import * as Y from 'yjs';
import { rebaseBlock } from './blocks/rebase';
import './figureBinding';
import { setCell } from './tableView/edit';
import type { TableViewBlock } from './tableView/model';
import { tracker } from './tableView/testFixtures';

/* A chart's, plot's or graph's `block` as the figure map quiz rooms hold
 * (Epo 2026-11-16, D15; figures/figureMap.ts), through the pnpm patch of
 * @slate-yjs/core 1.0.2 and its figure codec: Slate holds the plain block,
 * each field, chart cell and graph element is its own entry, so two editors'
 * changes to different ones merge. */
const chart = {
  kind: 'bar',
  labels: ['Jan', 'Feb'],
  series: [
    { name: 'A', values: [1, 2] },
    { name: 'B', values: [3, 4] },
  ],
  title: 'Sales',
  type: 'chart',
};

const graph = {
  board: { axis: true, bbox: [-5, 5, 5, -5], grid: true },
  elements: [
    { coords: [0, 0], id: 'p1', name: 'A', type: 'point' },
    { coords: [1, 1], id: 'p2', name: 'B', type: 'point' },
    { id: 's1', points: ['p1', 'p2'], type: 'segment' },
  ] as Record<string, unknown>[],
  height: 300,
  type: 'graph',
  width: 400,
};

const figure = (block: { type: string }) => ({
  block,
  children: [{ text: '' }],
  id: `f_${block.type}`,
  type: block.type,
});

type Editor = ReturnType<typeof createSlateEditor> & YjsEditorType;

const opened: (() => void)[] = [];
afterEach(() => {
  for (const close of opened.splice(0)) close();
});

/** An editor bound to its own copy of `room`, with Yjs undo. */
function editorOn(room: Y.Doc) {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(room));
  const editor = withYHistory(
    withYjs(
      createSlateEditor({ value: [] }) as never,
      doc.get('content', Y.XmlText)
    )
  ) as unknown as Editor & YHistoryEditor;
  YjsEditor.connect(editor);
  opened.push(() => YjsEditor.disconnect(editor));
  const ops: string[] = [];
  const apply = editor.apply;
  editor.apply = (op) => {
    ops.push(op.type);
    apply(op);
  };
  return { doc, editor, ops };
}

function roomOf(value: unknown[]) {
  const room = new Y.Doc();
  room
    .get('content', Y.XmlText)
    .applyDelta(slateNodesToInsertDelta(value as never));
  return room;
}

/** Every document gets every other's updates. */
function sync(...docs: Y.Doc[]) {
  for (const from of docs)
    for (const to of docs)
      if (from !== to)
        Y.applyUpdate(to, Y.encodeStateAsUpdate(from, Y.encodeStateVector(to)));
}

const blockMap = (doc: Y.Doc) =>
  (
    doc.get('content', Y.XmlText).toDelta() as { insert: Y.XmlText }[]
  )[0].insert.getAttribute('block') as unknown as Y.Map<unknown>;

const blockOf = (editor: Editor) =>
  (editor.children[0] as unknown as { block: typeof chart }).block;

/** A local edit of the block, as the dialog's Save writes it. */
function save(editor: Editor, change: (block: typeof chart) => object) {
  editor.tf.setNodes(
    { block: change(structuredClone(blockOf(editor))) } as never,
    { at: [0] }
  );
  YjsEditor.flushLocalChanges(editor);
}

/** Whether `map` holds a Y.Array anywhere below it. */
const holdsArray = (map: Y.Map<unknown>): boolean =>
  [...map.values()].some(
    (value) =>
      value instanceof Y.Array || (value instanceof Y.Map && holdsArray(value))
  );

it('inserts a chart as the figure map, read as the plain block', () => {
  const room = roomOf([figure(chart)]);
  const map = blockMap(room);
  for (const key of ['series', 'labels', 'names', 'values'])
    expect(map.get(key)).toBeInstanceOf(Y.Map);
  expect(holdsArray(map)).toBe(false);
  expect([...(map.get('values') as Y.Map<unknown>).values()]).toEqual([
    1, 2, 3, 4,
  ]);
  const { editor } = editorOn(room);
  expect(blockOf(editor)).toEqual(chart);
});

it('inserts a graph with its elements keyed by id, each with an order key', () => {
  const room = roomOf([figure(graph)]);
  const map = blockMap(room);
  expect(holdsArray(map)).toBe(false);
  const elements = map.get('elements') as Y.Map<{
    element: unknown;
    order: string;
  }>;
  expect([...elements.keys()].sort()).toEqual(['p1', 'p2', 's1']);
  expect(elements.get('s1')?.element).toEqual(graph.elements[2]);
  expect((map.get('board') as Y.Map<unknown>).toJSON()).toEqual(graph.board);
  const { editor } = editorOn(room);
  expect(blockOf(editor)).toEqual(graph);
});

it('takes a peer change inside the block as one set_node of the whole block', () => {
  const room = roomOf([figure(chart)]);
  const { doc, editor, ops } = editorOn(room);
  room.transact(() => {
    const map = blockMap(room);
    map.set('title', 'Revenue');
    const values = map.get('values') as Y.Map<number>;
    const first = [...values.keys()].find((key) => values.get(key) === 2);
    values.set(first as string, 5);
  });
  sync(room, doc);
  expect(ops).toEqual(['set_node']);
  expect(blockOf(editor)).toEqual({
    ...chart,
    series: [{ name: 'A', values: [1, 5] }, chart.series[1]],
    title: 'Revenue',
  });
});

it('merges two editors changing different cells and fields of one chart', () => {
  const room = roomOf([figure(chart)]);
  const a = editorOn(room);
  const b = editorOn(room);
  save(a.editor, (block) => ({
    ...block,
    series: [{ name: 'A', values: [1, 20] }, block.series[1]],
    title: 'Revenue',
  }));
  save(b.editor, (block) => ({
    ...block,
    series: [block.series[0], { name: 'B', values: [30, 4] }],
  }));
  sync(room, a.doc, b.doc);
  const merged = {
    ...chart,
    series: [
      { name: 'A', values: [1, 20] },
      { name: 'B', values: [30, 4] },
    ],
    title: 'Revenue',
  };
  expect(blockOf(a.editor)).toEqual(merged);
  expect(blockOf(b.editor)).toEqual(merged);
});

type Graph = typeof graph;
const editGraph = (editor: Editor, change: (block: Graph) => Graph) =>
  save(editor, (block) => change(block as unknown as Graph));
const elementsOf = (editor: Editor) =>
  (blockOf(editor) as unknown as Graph).elements;

it('merges two editors on different elements: one moves a point, the other adds and removes elements', () => {
  const room = roomOf([figure(graph)]);
  const a = editorOn(room);
  const b = editorOn(room);
  editGraph(a.editor, (block) => ({
    ...block,
    elements: block.elements.map((element) =>
      element.id === 'p1' ? { ...element, coords: [2, 2] } : element
    ),
  }));
  editGraph(b.editor, (block) => ({
    ...block,
    elements: [
      ...block.elements.filter((element) => element.id !== 's1'),
      { coords: [3, 3], id: 'p3', type: 'point' },
    ],
  }));
  sync(room, a.doc, b.doc);
  const want = [
    { coords: [2, 2], id: 'p1', name: 'A', type: 'point' },
    graph.elements[1],
    { coords: [3, 3], id: 'p3', type: 'point' },
  ];
  expect(elementsOf(a.editor)).toEqual(want);
  expect(elementsOf(b.editor)).toEqual(want);
});

it('merges a reorder with an edit of another element, each element once', () => {
  const room = roomOf([figure(graph)]);
  const a = editorOn(room);
  const b = editorOn(room);
  // A moves p1 last; B renames p2.
  editGraph(a.editor, (block) => ({
    ...block,
    elements: [block.elements[1], block.elements[2], block.elements[0]],
  }));
  editGraph(b.editor, (block) => ({
    ...block,
    elements: block.elements.map((element) =>
      element.id === 'p2' ? { ...element, name: 'Q' } : element
    ),
  }));
  sync(room, a.doc, b.doc);
  const want = [
    { ...graph.elements[1], name: 'Q' },
    graph.elements[2],
    graph.elements[0],
  ];
  expect(elementsOf(a.editor)).toEqual(want);
  expect(elementsOf(b.editor)).toEqual(want);
});

it('writes only the changed entry', () => {
  const room = roomOf([figure(chart)]);
  const { doc, editor } = editorOn(room);
  const before = Y.encodeStateVector(doc);
  const values = blockMap(doc).get('values');
  save(editor, (block) => ({
    ...block,
    series: [block.series[0], { name: 'B', values: [3, 40] }],
  }));
  // One new entry, the cell; the values map is the same map.
  expect(
    Y.decodeUpdate(Y.encodeStateAsUpdate(doc, before)).structs
  ).toHaveLength(1);
  expect(blockMap(doc).get('values')).toBe(values);
});

it("saves a dialog's draft as a diff, keeping a peer's change to another element", () => {
  const room = roomOf([figure(graph)]);
  const a = editorOn(room);
  const b = editorOn(room);
  const base = structuredClone(blockOf(a.editor)) as unknown as Graph;
  // The dialog on A moves p1 while B renames p2.
  const draft = {
    ...base,
    elements: base.elements.map((element) =>
      element.id === 'p1' ? { ...element, coords: [4, 4] } : element
    ),
  };
  editGraph(b.editor, (block) => ({
    ...block,
    elements: block.elements.map((element) =>
      element.id === 'p2' ? { ...element, name: 'Q' } : element
    ),
  }));
  sync(room, a.doc, b.doc);
  const before = Y.encodeStateVector(a.doc);
  editGraph(a.editor, (current) => rebaseBlock(base, draft, current));
  expect(
    Y.decodeUpdate(Y.encodeStateAsUpdate(a.doc, before)).structs
  ).toHaveLength(1);
  sync(room, a.doc, b.doc);
  const want = [
    { ...graph.elements[0], coords: [4, 4] },
    { ...graph.elements[1], name: 'Q' },
    graph.elements[2],
  ];
  expect(elementsOf(a.editor)).toEqual(want);
  expect(elementsOf(b.editor)).toEqual(want);
});

it('undoes a saved change through the Yjs undo manager', () => {
  const room = roomOf([figure(chart)]);
  const { editor } = editorOn(room);
  save(editor, (block) => ({
    ...block,
    series: [block.series[0]],
    title: 'Revenue',
  }));
  expect(blockOf(editor).title).toBe('Revenue');
  editor.undo();
  expect(blockOf(editor)).toEqual(chart);
  editor.redo();
  expect(blockOf(editor)).toEqual({
    ...chart,
    series: [chart.series[0]],
    title: 'Revenue',
  });
});

it('keeps a moved block the figure map', () => {
  const room = roomOf([
    figure(graph),
    { children: [{ text: 'after' }], id: 'p1', type: 'p' },
  ]);
  const { doc, editor } = editorOn(room);
  editor.tf.moveNodes({ at: [0], to: [1] });
  YjsEditor.flushLocalChanges(editor);
  const moved = (
    doc.get('content', Y.XmlText).toDelta() as { insert: Y.XmlText }[]
  )[1].insert.getAttribute('block') as unknown as Y.Map<unknown>;
  expect(moved.get('elements')).toBeInstanceOf(Y.Map);
  expect(holdsArray(moved)).toBe(false);
  expect((editor.children[1] as unknown as { block: Graph }).block).toEqual(
    graph
  );
});

it('merges two editors writing different cells of one table view row (revision 2.1)', () => {
  const block = tracker();
  const room = roomOf([
    { block, children: [{ text: '' }], id: 'tv', type: 'table_view' },
  ]);
  const a = editorOn(room);
  const b = editorOn(room);
  const write = (editor: Editor, change: (block: TableViewBlock) => object) => {
    editor.tf.setNodes(
      { block: change(blockOf(editor) as unknown as TableViewBlock) } as never,
      { at: [0] }
    );
    YjsEditor.flushLocalChanges(editor);
  };
  write(a.editor, (current) => setCell(current, 'r_1', 'c_mark', 9));
  write(b.editor, (current) => setCell(current, 'r_1', 'c_done', true));
  sync(room, a.doc, b.doc);
  const want = { ...block.rows[0], c_done: true, c_mark: 9 };
  for (const { editor } of [a, b])
    expect((blockOf(editor) as unknown as TableViewBlock).rows[0]).toEqual(
      want
    );
});
