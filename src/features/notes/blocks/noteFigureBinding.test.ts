import {
  slateNodesToInsertDelta,
  withYHistory,
  withYjs,
  type YHistoryEditor,
  YjsEditor,
} from '@slate-yjs/core';
import { createSlateEditor, type SlateEditor } from 'platejs';
import { afterEach, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import type { ChartBlock, GraphBlock } from '@/features/questions/types';
import '../figureBinding';
import { noteFigureBinding } from './noteFigureBinding';

/* A note's chart or graph edited live through its dialog's binding (Epo
 * 2026-11-16, D15): each change is a `set_node` of the block, written to the
 * room as the entries that changed. */

const graph: GraphBlock = {
  board: { axis: true, bbox: [-5, 5, 5, -5], grid: true },
  elements: [
    { coords: [0, 0], id: 'p1', name: 'A', type: 'point' },
    { coords: [1, 1], id: 'p2', name: 'B', type: 'point' },
  ],
  height: 300,
  type: 'graph',
  width: 400,
};

const chart: ChartBlock = {
  kind: 'bar',
  labels: ['Jan', 'Feb'],
  series: [
    { name: 'A', values: [1, 2] },
    { name: 'B', values: [3, 4] },
  ],
  title: 'Sales',
  type: 'chart',
};

const figure = (block: ChartBlock | GraphBlock) => ({
  block,
  children: [{ text: '' }],
  id: 'fig',
  type: block.type,
});
const paragraph = { children: [{ text: 'before' }], id: 'p', type: 'p' };

type Editor = SlateEditor & YjsEditor & YHistoryEditor;

const opened: (() => void)[] = [];
afterEach(() => {
  for (const close of opened.splice(0)) close();
});

function roomOf(block: ChartBlock | GraphBlock) {
  const room = new Y.Doc();
  room
    .get('content', Y.XmlText)
    .applyDelta(slateNodesToInsertDelta([paragraph, figure(block)] as never));
  return room;
}

/** A note editor bound to its own copy of `room`, with the note's Yjs undo. */
function editorOn(room: Y.Doc) {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(room));
  const editor = withYHistory(
    withYjs(
      createSlateEditor({ value: [] }) as never,
      doc.get('content', Y.XmlText)
    )
  ) as unknown as Editor;
  YjsEditor.connect(editor);
  opened.push(() => YjsEditor.disconnect(editor));
  return { doc, editor };
}

/** The dialog over the figure: its binding, fed each change of the element's
 * block as the element is. */
function dialogOn(editor: Editor) {
  const binding = noteFigureBinding(editor, 'fig', blockOf(editor));
  const follow = () => {
    const block = editor.children[1]?.block;
    if (block) binding.receive(block as GraphBlock);
  };
  return { binding, follow };
}

/** The graph a dialog's binding reads now. */
function graphIn(binding: ReturnType<typeof noteFigureBinding>) {
  const figure = binding.read();
  if (figure?.block.type !== 'graph') throw new Error('No graph');
  return figure.block;
}

const blockOf = (editor: SlateEditor) =>
  editor.children[1].block as GraphBlock | ChartBlock;

function sync(...docs: Y.Doc[]) {
  for (const from of docs)
    for (const to of docs)
      if (from !== to)
        Y.applyUpdate(to, Y.encodeStateAsUpdate(from, Y.encodeStateVector(to)));
}

/** The structs a change wrote to `doc`. */
function written(doc: Y.Doc, change: () => void) {
  const before = Y.encodeStateVector(doc);
  change();
  return Y.decodeUpdate(Y.encodeStateAsUpdate(doc, before)).structs.length;
}

it('writes a moved point as its one element entry, and the note shows it', () => {
  const { doc, editor } = editorOn(roomOf(graph));
  const { binding } = dialogOn(editor);
  const structs = written(doc, () => {
    binding.setElement({ coords: [2, 3], id: 'p1', name: 'A', type: 'point' });
    YjsEditor.flushLocalChanges(editor);
  });
  expect(structs).toBe(1);
  expect((blockOf(editor) as GraphBlock).elements[0]).toEqual({
    coords: [2, 3],
    id: 'p1',
    name: 'A',
    type: 'point',
  });
  expect(binding.read()?.block).toBe(blockOf(editor));
});

it('writes a chart cell as its one value entry', () => {
  const { doc, editor } = editorOn(roomOf(chart));
  const { binding } = dialogOn(editor);
  const figureNow = binding.read();
  if (!figureNow) throw new Error('no chart');
  const structs = written(doc, () => {
    binding.setChartCell(figureNow.series[1], figureNow.labels[1], 40);
    YjsEditor.flushLocalChanges(editor);
  });
  expect(structs).toBe(1);
  expect((blockOf(editor) as ChartBlock).series[1].values).toEqual([3, 40]);
});

it('hears its own figure only: an edit elsewhere in the note keeps its block', () => {
  const { editor } = editorOn(roomOf(graph));
  const { binding } = dialogOn(editor);
  const heard = vi.fn();
  binding.subscribe(heard);
  const held = blockOf(editor);
  editor.tf.insertText(' typed', { at: { offset: 6, path: [0, 0] } });
  YjsEditor.flushLocalChanges(editor);
  expect(blockOf(editor)).toBe(held);
  binding.receive(blockOf(editor) as GraphBlock);
  expect(heard).not.toHaveBeenCalled();
});

it('merges two editors editing one figure through their dialogs', () => {
  const room = roomOf(graph);
  const a = editorOn(room);
  const b = editorOn(room);
  const dialogA = dialogOn(a.editor);
  const dialogB = dialogOn(b.editor);
  dialogA.binding.setElement({
    coords: [4, 4],
    id: 'p1',
    name: 'A',
    type: 'point',
  });
  dialogB.binding.setElement({
    coords: [1, 1],
    id: 'p2',
    name: 'Q',
    type: 'point',
  });
  dialogB.binding.setElement({
    id: 'f1',
    latex: 'y=x^{2}',
    type: 'expression',
  });
  YjsEditor.flushLocalChanges(a.editor);
  YjsEditor.flushLocalChanges(b.editor);
  sync(room, a.doc, b.doc);
  dialogA.follow();
  dialogB.follow();
  const want = [
    { coords: [4, 4], id: 'p1', name: 'A', type: 'point' },
    { coords: [1, 1], id: 'p2', name: 'Q', type: 'point' },
    { id: 'f1', latex: 'y=x^{2}', type: 'expression' },
  ];
  for (const dialog of [dialogA, dialogB])
    expect(graphIn(dialog.binding).elements).toEqual(want);
});

it('keeps a live edit made offline in the note and syncs it when the room is back', () => {
  const room = roomOf(graph);
  const { doc, editor } = editorOn(room);
  dialogOn(editor).binding.setBoard('grid', false);
  YjsEditor.flushLocalChanges(editor);
  const roomEditor = editorOn(room).editor;
  expect((blockOf(roomEditor) as GraphBlock).board.grid).toBe(true);
  sync(room, doc);
  expect((blockOf(editorOn(room).editor) as GraphBlock).board.grid).toBe(false);
});

it('undoes a live edit in the note, and the open dialog follows', () => {
  const { editor } = editorOn(roomOf(graph));
  const { binding, follow } = dialogOn(editor);
  binding.setFields({ width: 500 });
  YjsEditor.flushLocalChanges(editor);
  editor.undo();
  follow();
  expect(binding.read()?.block).toEqual(graph);
  editor.redo();
  follow();
  expect(graphIn(binding).width).toBe(500);
});

it('removes the figure from the note', () => {
  const { editor } = editorOn(roomOf(graph));
  const { binding } = dialogOn(editor);
  binding.remove();
  expect(editor.children.map((node) => node.id)).toEqual(['p']);
  expect(binding.read()).toBeNull();
});

it('edits the saved copy before the room binds, as any note edit', () => {
  const editor = createSlateEditor({ value: [paragraph, figure(graph)] });
  const binding = noteFigureBinding(editor, 'fig', graph);
  binding.setBoard('grid', false);
  expect((blockOf(editor) as GraphBlock).board.grid).toBe(false);
});
