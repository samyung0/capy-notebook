import { BaseYjsPlugin } from '@platejs/yjs';
import {
  slateNodesToInsertDelta,
  YjsEditor,
  yTextToSlateElement,
} from '@slate-yjs/core';
import { createSlatePlugin } from 'platejs';
import { createPlateEditor } from 'platejs/react';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  bindSyncedRoom,
  openTrailingParagraph,
  roomBindingPlugin,
  takeLocalEdit,
  trailingBlockPlugin,
  writeNoEdit,
} from './roomBinding';

/* CAPY-WEB-7: a note editor painted before its room synced (the join's 30 s
 * ran out first) took a caret on the projection; Plate's init then bound it
 * to the still empty document after 5 s, and every later onChange threw
 * "Path doesn't match yText" while the editor stalled. */

const block = (id: string, text: string) => ({
  children: [{ text }],
  id,
  type: 'p',
});
const PROJECTION = [
  block('a', 'Title'),
  block('b', 'Owner line'),
  block('c', 'Editor line'),
];

/** The note editor before its room synced: YjsPlugin then this plugin over
 * an empty document, holding the projection. */
function unboundEditor() {
  const ydoc = new Y.Doc();
  const editor = createPlateEditor({
    nodeId: false,
    plugins: [
      BaseYjsPlugin.configure({ options: { ydoc } }),
      roomBindingPlugin,
    ],
    value: structuredClone(PROJECTION) as never,
  });
  const root = ydoc.get('content', Y.XmlText);
  /** The room's first sync: its state arrives, then the provider says so. */
  const sync = (value: unknown[]) => {
    const room = new Y.Doc();
    room
      .get('content', Y.XmlText)
      .applyDelta(slateNodesToInsertDelta(value as never), { sanitize: false });
    Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(room), 'room');
    bindSyncedRoom(editor);
  };
  /** Plate's init once its 5 s wait for the sync ran out. */
  const initWithoutSync = () => {
    YjsEditor.connect(editor as never);
    editor.tf.init({ shouldNormalizeEditor: false, value: null });
  };
  const roomBlocks = () => {
    YjsEditor.flushLocalChanges(editor as never);
    return yTextToSlateElement(root).children;
  };
  return { editor, initWithoutSync, roomBlocks, sync };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const TABLE = {
  children: [
    {
      children: [
        { children: [{ children: [{ text: 'Cell' }], type: 'p' }], type: 'td' },
      ],
      type: 'tr',
    },
  ],
  id: 't',
  type: 'table',
};
const INLINE = {
  children: [{ children: [{ text: 'A link' }], type: 'a', url: 'https://a.b' }],
  id: 'l',
  type: 'p',
};

/** A note the room holds, bound in a new editor with the trailing rule on;
 * `peer` is another client of the same document. */
async function openedNote(value: unknown[]) {
  const ydoc = new Y.Doc();
  const peer = new Y.Doc();
  peer
    .get('content', Y.XmlText)
    .applyDelta(slateNodesToInsertDelta(value as never), { sanitize: false });
  Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(peer), 'room');
  const editor = createPlateEditor({
    nodeId: false,
    plugins: [
      BaseYjsPlugin.configure({ options: { ydoc } }),
      roomBindingPlugin,
      createSlatePlugin({
        key: 'a',
        node: { isElement: true, isInline: true },
      }),
      trailingBlockPlugin,
    ],
    value: [{ children: [{ text: '' }], type: 'p' }] as never,
  });
  const updates: Uint8Array[] = [];
  ydoc.on('update', (update, origin) => {
    if (origin !== 'room') updates.push(update);
  });
  const yjs = editor as never as YjsEditor;
  bindSyncedRoom(editor);
  YjsEditor.connect(yjs);
  await settle();
  const root = ydoc.get('content', Y.XmlText);
  return {
    blocks: () =>
      yTextToSlateElement(root).children as unknown as Record<
        string,
        unknown
      >[],
    editor,
    /** A change another client made reaches this document. */
    fromPeer: () => Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(peer), 'room'),
    peer,
    undo: (editor as never as { undo: () => void }).undo,
    updates,
    yjs,
  };
}

describe('roomBindingPlugin', () => {
  it("binds at the room's first sync, not before, so the editor holds the room's blocks only", async () => {
    const { editor, initWithoutSync, roomBlocks, sync } = unboundEditor();
    initWithoutSync();
    // Bound to the empty document, it showed nothing.
    expect(editor.children).toEqual(PROJECTION);
    sync(PROJECTION);
    await settle();
    // Not the room's blocks plus the paragraph Plate gave the empty editor.
    expect(editor.children).toEqual(roomBlocks());
    // The last block's end maps onto the room: typing there is stored.
    editor.tf.select(editor.api.end([]));
    editor.tf.insertText('!');
    await settle();
    expect(roomBlocks().at(-1)).toEqual(block('c', 'Editor line!'));
  });

  it('keeps a caret placed before the bind in its block, by id', async () => {
    const { editor, initWithoutSync, sync } = unboundEditor();
    initWithoutSync();
    editor.tf.select({ offset: 4, path: [2, 0] });
    // A co-editor added a block on top meanwhile.
    sync([block('new', 'Peer line'), ...PROJECTION]);
    await settle();
    expect(editor.selection).toEqual({
      anchor: { offset: 4, path: [3, 0] },
      focus: { offset: 4, path: [3, 0] },
    });
  });

  it("drops a caret whose block the room's tree lacks", async () => {
    const { editor, initWithoutSync, roomBlocks, sync } = unboundEditor();
    initWithoutSync();
    editor.tf.select({ offset: 4, path: [2, 0] });
    sync([block('a', 'Title')]);
    await settle();
    expect(editor.selection).toBeNull();
    editor.tf.select(editor.api.end([]));
    editor.tf.insertText('!');
    await settle();
    expect(roomBlocks()).toEqual([block('a', 'Title!')]);
  });

  it('writes nothing when a note ending in a table opens', async () => {
    const { blocks, updates } = await openedNote([block('a', 'Intro'), TABLE]);
    expect(updates).toEqual([]);
    expect(blocks().map((node) => node.type)).toEqual(['p', 'table']);
  });

  it('still repairs the tree where Yjs holds nothing, writing nothing', async () => {
    const { editor, updates } = await openedNote([INLINE]);
    expect(updates).toEqual([]);
    expect(
      (editor.children[0] as { children: unknown[] }).children
    ).toHaveLength(3);
  });

  it("writes nothing when a co-editor's change arrives before any edit", async () => {
    const { fromPeer, peer, updates } = await openedNote([block('a', 'Intro')]);
    const root = peer.get('content', Y.XmlText);
    root.applyDelta([
      { retain: root.length },
      ...slateNodesToInsertDelta([TABLE] as never),
    ]);
    fromPeer();
    await settle();
    expect(updates).toEqual([]);
  });

  it('brings the trailing paragraph with the first real edit, outside its Undo', async () => {
    const { blocks, editor, undo, updates, yjs } = await openedNote([
      block('a', 'Intro'),
      TABLE,
    ]);
    editor.tf.select({ offset: 5, path: [0, 0] });
    expect(updates).toEqual([]);
    editor.tf.insertText('!');
    await settle();
    YjsEditor.flushLocalChanges(yjs);
    expect(updates.length).toBeGreaterThan(0);
    expect(blocks().map((node) => node.type)).toEqual(['p', 'table', 'p']);
    expect(blocks()[0]).toMatchObject({ children: [{ text: 'Intro!' }] });
    undo();
    await settle();
    expect(blocks()[0]).toMatchObject({ children: [{ text: 'Intro' }] });
    expect(blocks().map((node) => node.type)).toEqual(['p', 'table', 'p']);
  });

  it("reaches the room with a write of the editor's own, and brings no paragraph", async () => {
    const { blocks, editor, updates, yjs } = await openedNote([
      block('a', 'Intro'),
      TABLE,
    ]);
    writeNoEdit(editor, () =>
      editor.tf.setNodes({ marked: true } as never, { at: [0] })
    );
    await settle();
    YjsEditor.flushLocalChanges(yjs);
    expect(updates.length).toBeGreaterThan(0);
    expect(blocks()[0]).toMatchObject({ marked: true });
    expect(blocks().map((node) => node.type)).toEqual(['p', 'table']);
    expect(takeLocalEdit(editor)).toBe(false);
  });

  it('counts a real edit and an Undo as local edits, a normalization as none', async () => {
    const { editor, undo, yjs } = await openedNote([INLINE]);
    expect(takeLocalEdit(editor)).toBe(false);
    editor.tf.select(editor.api.end([]));
    expect(takeLocalEdit(editor)).toBe(false);
    editor.tf.insertText('!');
    expect(takeLocalEdit(editor)).toBe(true);
    await settle();
    YjsEditor.flushLocalChanges(yjs);
    undo();
    expect(takeLocalEdit(editor)).toBe(true);
    expect(takeLocalEdit(editor)).toBe(false);
  });

  it('opens a paragraph where a click below a closing table lands', async () => {
    const { blocks, editor } = await openedNote([block('a', 'Intro'), TABLE]);
    openTrailingParagraph(editor as never);
    await settle();
    expect(blocks().map((node) => node.type)).toEqual(['p', 'table', 'p']);
    expect(editor.selection?.anchor.path).toEqual([2, 0]);
  });

  // Our @slate-yjs/core patch: history maps the selection onto the room
  // only once the editor is bound to it.
  it('lets an unbound editor move its caret without mapping it onto the room', () => {
    const { editor } = unboundEditor();
    editor.tf.select({ offset: 4, path: [2, 0] });
    expect(() => editor.api.onChange()).not.toThrow();
  });
});
