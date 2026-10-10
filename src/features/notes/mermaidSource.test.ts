import {
  slateNodesToInsertDelta,
  withYjs,
  YjsEditor,
  type YjsEditor as YjsEditorType,
  yTextToSlateElement,
} from '@slate-yjs/core';
import { createSlateEditor } from 'platejs';
import { afterEach, expect, it } from 'vitest';
import * as Y from 'yjs';
import { LOCAL_EDIT } from '@/features/collaboration/yText';
import { mermaidSourceText } from './blocks/mermaidBlock';

/* A Mermaid block's source as a Y.Text read as a string in Slate (shape A,
 * Epo 2026-10-10), through the pnpm patch of @slate-yjs/core 1.0.2
 * (patches/@slate-yjs__core@1.0.2.patch). Each case fails on the stock
 * package. */

const SOURCE = 'graph TD\n  A --> B';

const mermaid = (id: string, source: string) => ({
  children: [{ children: [{ text: '' }], type: 'mermaid_caption' }],
  id,
  source,
  type: 'mermaid',
});

const opened: (() => void)[] = [];
afterEach(() => {
  for (const close of opened.splice(0)) close();
});

/** A room holding `value`, and an editor bound to its own copy. */
function setup(value: unknown[]) {
  const room = new Y.Doc();
  room
    .get('content', Y.XmlText)
    .applyDelta(slateNodesToInsertDelta(value as never));
  const doc = new Y.Doc();
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(room));
  const root = doc.get('content', Y.XmlText);
  const editor = withYjs(
    createSlateEditor({ value: [] }) as never,
    root
  ) as unknown as ReturnType<typeof createSlateEditor> & YjsEditorType;
  YjsEditor.connect(editor);
  opened.push(() => YjsEditor.disconnect(editor));
  const ops: string[] = [];
  const apply = editor.apply;
  editor.apply = (op) => {
    ops.push(op.type);
    apply(op);
  };
  /** Exchanges updates between the room and the editor's document. */
  const sync = () => {
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(room, Y.encodeStateVector(doc)));
    Y.applyUpdate(room, Y.encodeStateAsUpdate(doc, Y.encodeStateVector(room)));
  };
  return { doc, editor, ops, room, root, sync };
}

const blockAt = (doc: Y.Doc, index: number) =>
  (doc.get('content', Y.XmlText).toDelta() as { insert: Y.XmlText }[])[index]
    .insert;

it('inserts a source as a text that Slate reads as its string', () => {
  const { editor, room } = setup([mermaid('d1', SOURCE)]);
  expect(blockAt(room, 0).getAttribute('source')).toBeInstanceOf(Y.Text);
  expect(
    (yTextToSlateElement(room.get('content', Y.XmlText)).children[0] as never)[
      'source'
    ]
  ).toBe(SOURCE);
  expect((editor.children[0] as never)['source']).toBe(SOURCE);
});

it('takes a remote keystroke in the source as one set_node', () => {
  const { editor, ops, room, sync } = setup([mermaid('d1', SOURCE)]);
  const source = blockAt(room, 0).getAttribute('source') as unknown as Y.Text;
  source.insert(SOURCE.length, ' --> C');
  sync();
  expect(ops).toEqual(['set_node']);
  expect((editor.children[0] as never)['source']).toBe(`${SOURCE} --> C`);
});

it('writes a local source change as a text diff that keeps concurrent typing', () => {
  const { doc, editor, room, sync } = setup([mermaid('d1', SOURCE)]);
  // The room's writer types at the end; this editor rewrites the head.
  (blockAt(room, 0).getAttribute('source') as unknown as Y.Text).insert(
    SOURCE.length,
    ' --> C'
  );
  editor.tf.setNodes({ source: 'flowchart TD\n  A --> B' } as never, {
    at: [0],
  });
  YjsEditor.flushLocalChanges(editor);
  sync();
  expect(blockAt(doc, 0).getAttribute('source')).toBeInstanceOf(Y.Text);
  expect(String(blockAt(room, 0).getAttribute('source'))).toBe(
    'flowchart TD\n  A --> B --> C'
  );
});

it('keeps a moved block source a text', () => {
  const { doc, editor } = setup([
    mermaid('d1', SOURCE),
    { children: [{ text: 'after' }], id: 'p1', type: 'p' },
  ]);
  editor.tf.moveNodes({ at: [0], to: [1] });
  YjsEditor.flushLocalChanges(editor);
  const moved = blockAt(doc, 1).getAttribute('source');
  expect(moved).toBeInstanceOf(Y.Text);
  expect(String(moved)).toBe(SOURCE);
});

it('finds a block source for its dialog, turning a stored string into a text outside Undo', () => {
  const { editor, root } = setup([
    { children: [{ text: 'before' }], id: 'p1', type: 'p' },
  ]);
  // A block written before shape A: its source a plain string attribute.
  const legacy = new Y.XmlText();
  legacy.setAttribute('type', 'mermaid');
  legacy.setAttribute('id', 'd1');
  legacy.setAttribute('source', SOURCE);
  root.insertEmbed(1, legacy);
  const undo = new Y.UndoManager(root, {
    trackedOrigins: new Set([LOCAL_EDIT]),
  });
  const text = mermaidSourceText(editor as never, [1]);
  expect(text).toBeInstanceOf(Y.Text);
  expect(String(text)).toBe(SOURCE);
  expect(legacy.getAttribute('source')).toBe(text);
  expect(undo.undoStack).toHaveLength(0);
  expect(mermaidSourceText(editor as never, [1])).toBe(text);
  expect((editor.children[1] as never)['source']).toBe(SOURCE);
});

// REVIEW4 S1: a mermaid block inside a container (a callout, a column) opens
// its dialog too: its text is found by the block's path, not among the
// top-level blocks alone.
it('finds a nested block source by its path', () => {
  const { editor } = setup([
    { children: [{ text: 'before' }], id: 'p1', type: 'p' },
    {
      children: [
        { children: [{ text: 'inside' }], id: 'p2', type: 'p' },
        mermaid('d2', 'graph LR\n  In --> Out'),
      ],
      id: 'c1',
      type: 'callout',
    },
  ]);
  const text = mermaidSourceText(editor as never, [1, 1]);
  expect(String(text)).toBe('graph LR\n  In --> Out');
  expect(mermaidSourceText(editor as never, [1, 0])).toBeNull();
});
