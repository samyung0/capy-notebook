import { BaseYjsPlugin } from '@platejs/yjs';
import {
  slateNodesToInsertDelta,
  type YHistoryEditor,
  YjsEditor,
  yTextToSlateElement,
} from '@slate-yjs/core';
import { createPlateEditor } from 'platejs/react';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import type { MaterialValue } from '@/features/materials/document';
import { bindSyncedRoom, roomBindingPlugin, whenBound } from '../roomBinding';
import { stableElementIdsPlugin } from '../stableElementIds';
import { applyMergeSteps, asOneStep, replaceBlock } from './applyBlocks';
import { mergeBlocks } from './blockMerge';

/* Q229: a note painted from its saved copy before its room joined stays
 * editable; at the room's first sync the editor binds (roomBinding.ts) and
 * the copy's edits merge into the room's document as ordinary edits. */

const block = (id: string, text: string, extra = {}) => ({
  children: [{ text }],
  id,
  type: 'p',
  ...extra,
});
const PROJECTION = [block('a', 'Title'), block('b', 'Body'), block('c', 'End')];

/** The note editor before its room synced, holding the projection, with the
 * copy merge NoteEditorCore registers. */
function copyEditor() {
  const ydoc = new Y.Doc();
  const editor = createPlateEditor({
    nodeId: false,
    plugins: [
      BaseYjsPlugin.configure({ options: { ydoc } }),
      roomBindingPlugin,
      stableElementIdsPlugin,
    ],
    value: structuredClone(PROJECTION) as never,
  });
  const root = ydoc.get('content', Y.XmlText);
  const updates: unknown[] = [];
  ydoc.on('update', (_update: Uint8Array, origin: unknown) =>
    updates.push(origin)
  );
  whenBound(editor, (unbound) =>
    asOneStep(editor, () => {
      const { steps } = mergeBlocks(
        PROJECTION as MaterialValue,
        unbound as MaterialValue,
        editor.children as MaterialValue
      );
      applyMergeSteps(editor, steps);
    })
  );
  const sync = (value: unknown[]) => {
    const room = new Y.Doc();
    room
      .get('content', Y.XmlText)
      .applyDelta(slateNodesToInsertDelta(value as never), { sanitize: false });
    Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(room), 'room');
    YjsEditor.connect(editor as never);
    bindSyncedRoom(editor);
  };
  const roomBlocks = () => {
    YjsEditor.flushLocalChanges(editor as never);
    return yTextToSlateElement(root).children;
  };
  return { editor, roomBlocks, root, sync, updates };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('the copy merge at the bind', () => {
  it("merges the copy's edits into the room's document as the session's own updates, keeping the caret", async () => {
    const { editor, roomBlocks, sync, updates } = copyEditor();
    // Typed into the copy: the body edited, a new block after it.
    editor.tf.select({ offset: 4, path: [1, 0] });
    editor.tf.insertText(' typed');
    editor.tf.insertNodes(block('n', 'New') as never, { at: [2] });
    editor.tf.select({ offset: 10, path: [1, 0] });
    // Meanwhile the room changed the title.
    sync([block('a', 'Title room'), block('b', 'Body'), block('c', 'End')]);
    await settle();
    expect(roomBlocks()).toEqual([
      block('a', 'Title room'),
      block('b', 'Body typed'),
      block('n', 'New'),
      block('c', 'End'),
    ]);
    expect(editor.children).toEqual(roomBlocks());
    // Written by the editor (its local origin), so they sync and save as
    // any edit does.
    expect(updates.filter((origin) => origin !== 'room').length).toBe(1);
    expect(editor.selection).toEqual({
      anchor: { offset: 10, path: [1, 0] },
      focus: { offset: 10, path: [1, 0] },
    });
    // One Undo step takes the whole merge back.
    (editor as unknown as YHistoryEditor).undo();
    expect(roomBlocks()).toEqual([
      block('a', 'Title room'),
      block('b', 'Body'),
      block('c', 'End'),
    ]);
  });

  it('leaves the room’s document alone when the copy was not edited', async () => {
    const { roomBlocks, sync, updates } = copyEditor();
    const room = [block('a', 'Title room'), block('b', 'Body')];
    sync(room);
    await settle();
    expect(roomBlocks()).toEqual(room);
    expect(updates.filter((origin) => origin !== 'room')).toEqual([]);
  });
});

describe('replaceBlock', () => {
  it('keeps a block of the same type in place, setting and unsetting its attributes', async () => {
    const { editor, root, roomBlocks, sync } = copyEditor();
    sync([block('a', 'Title', { align: 'center' }), block('b', 'Body')]);
    await settle();
    const element = root.toDelta()[0].insert as Y.XmlText;
    replaceBlock(editor, 0, block('a', 'Title new', { indent: 1 }) as never);
    expect(roomBlocks()[0]).toEqual(block('a', 'Title new', { indent: 1 }));
    expect(root.toDelta()[0].insert).toBe(element);
  });

  it('replaces a block of another type at the same index, keeping its id', async () => {
    const { editor, roomBlocks, sync } = copyEditor();
    sync([block('a', 'Title'), block('b', 'Body')]);
    await settle();
    replaceBlock(editor, 0, {
      children: [{ text: 'Heading' }],
      id: 'a',
      type: 'h1',
    });
    expect(roomBlocks()[0]).toEqual({
      children: [{ text: 'Heading' }],
      id: 'a',
      type: 'h1',
    });
  });
});
