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

/* A chart's, plot's or graph's `block` as a live Y.Map (Epo 2026-10-17),
 * through the pnpm patch of @slate-yjs/core 1.0.2: Slate holds the plain
 * block, each field, series and graph element is replaced on its own, so two
 * editors' changes to different ones merge. Each case fails on the stock
 * package. */

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
  image: { svg: '<svg xmlns="http://www.w3.org/2000/svg"/>' },
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

it('inserts a block as a map with its series as maps, read as the plain block', () => {
  const room = roomOf([figure(chart)]);
  const map = blockMap(room);
  expect(map).toBeInstanceOf(Y.Map);
  const series = map.get('series') as Y.Array<Y.Map<unknown>>;
  expect(series).toBeInstanceOf(Y.Array);
  expect(series.get(1)).toBeInstanceOf(Y.Map);
  expect(map.get('labels')).toEqual(['Jan', 'Feb']);
  const { editor } = editorOn(room);
  expect(blockOf(editor)).toEqual(chart);
});

it('takes a peer change inside the block as one set_node of the whole block', () => {
  const room = roomOf([figure(chart)]);
  const { doc, editor, ops } = editorOn(room);
  room.transact(() => {
    blockMap(room).set('title', 'Revenue');
    (
      (blockMap(room).get('series') as Y.Array<Y.Map<unknown>>).get(
        0
      ) as Y.Map<unknown>
    ).set('values', [5, 6]);
  });
  sync(room, doc);
  expect(ops).toEqual(['set_node']);
  expect(blockOf(editor)).toEqual({
    ...chart,
    series: [{ name: 'A', values: [5, 6] }, chart.series[1]],
    title: 'Revenue',
  });
});

it('merges two editors changing different fields and series', () => {
  const room = roomOf([figure(chart)]);
  const a = editorOn(room);
  const b = editorOn(room);
  save(a.editor, (block) => ({ ...block, title: 'Revenue' }));
  save(b.editor, (block) => ({
    ...block,
    series: [block.series[0], { name: 'B', values: [30, 40] }],
  }));
  sync(room, a.doc, b.doc);
  const merged = {
    ...chart,
    series: [chart.series[0], { name: 'B', values: [30, 40] }],
    title: 'Revenue',
  };
  expect(blockOf(a.editor)).toEqual(merged);
  expect(blockOf(b.editor)).toEqual(merged);
});

it('matches graph elements by id: one editor moves a point while another adds and removes elements', () => {
  const room = roomOf([figure(graph)]);
  const a = editorOn(room);
  const b = editorOn(room);
  type Graph = typeof graph;
  const edit = (editor: Editor, change: (block: Graph) => Graph) =>
    save(editor, (block) => change(block as unknown as Graph));
  edit(a.editor, (block) => ({
    ...block,
    elements: block.elements.map((element) =>
      element.id === 'p1' ? { ...element, coords: [2, 2] } : element
    ),
  }));
  edit(b.editor, (block) => ({
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
  expect((blockOf(a.editor) as unknown as Graph).elements).toEqual(want);
  expect((blockOf(b.editor) as unknown as Graph).elements).toEqual(want);
});

it('writes only the changed entries', () => {
  const room = roomOf([figure(chart)]);
  const { doc, editor } = editorOn(room);
  const before = Y.encodeStateVector(doc);
  const series = blockMap(doc).get('series');
  save(editor, (block) => ({ ...block, title: 'Revenue' }));
  // One new entry, the title; the series list is the same list.
  expect(
    Y.decodeUpdate(Y.encodeStateAsUpdate(doc, before)).structs
  ).toHaveLength(1);
  expect(blockMap(doc).get('series')).toBe(series);
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

it('keeps a moved block a map', () => {
  const room = roomOf([
    figure(chart),
    { children: [{ text: 'after' }], id: 'p1', type: 'p' },
  ]);
  const { doc, editor } = editorOn(room);
  editor.tf.moveNodes({ at: [0], to: [1] });
  YjsEditor.flushLocalChanges(editor);
  const moved = (
    doc.get('content', Y.XmlText).toDelta() as { insert: Y.XmlText }[]
  )[1].insert.getAttribute('block') as unknown as Y.Map<unknown>;
  expect(moved).toBeInstanceOf(Y.Map);
  expect(moved.get('series')).toBeInstanceOf(Y.Array);
  expect(moved.toJSON()).toEqual(chart);
});
