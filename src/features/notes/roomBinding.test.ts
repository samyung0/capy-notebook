import { BaseYjsPlugin } from '@platejs/yjs';
import {
  slateNodesToInsertDelta,
  YjsEditor,
  yTextToSlateElement,
} from '@slate-yjs/core';
import { createPlateEditor } from 'platejs/react';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { bindSyncedRoom, roomBindingPlugin } from './roomBinding';

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

  // Our @slate-yjs/core patch: history maps the selection onto the room
  // only once the editor is bound to it.
  it('lets an unbound editor move its caret without mapping it onto the room', () => {
    const { editor } = unboundEditor();
    editor.tf.select({ offset: 4, path: [2, 0] });
    expect(() => editor.api.onChange()).not.toThrow();
  });
});
