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
import {
  applyDiffed,
  mergeAtBind,
  replaceBlock,
  textChange,
} from './applyBlocks';
import { mergeBlocks, mergeCopies } from './blockMerge';

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
 * copy merge NoteEditorCore registers (its diff run in place of the
 * worker). */
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
    mergeAtBind(
      editor,
      [{ base: PROJECTION as MaterialValue, mine: unbound as MaterialValue }],
      async (pairs, theirs) => mergeCopies(pairs, theirs)
    )
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
  return { editor, roomBlocks, root, sync, updates, ydoc };
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

  // Review r1 L3: the Yjs history works on the bound document only; before
  // the bind Undo and Redo walk the copy's own.
  it('undoes and redoes edits in the copy before the bind', () => {
    const { editor } = copyEditor();
    editor.tf.insertText(' typed', { at: { offset: 4, path: [1, 0] } });
    editor.tf.undo();
    expect(editor.children[1]).toEqual(block('b', 'Body'));
    editor.tf.redo();
    expect(editor.children[1]).toEqual(block('b', 'Body typed'));
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

describe('applyDiffed', () => {
  // Review r1 L1: the diff runs in a worker, so the room or the user may
  // change a block before its steps apply; that block is left as it is now
  // and becomes a conflict, the rest applies as one Undo step.
  it('applies the steps but makes a block changed during the diff a conflict', async () => {
    const { editor, root, roomBlocks, sync } = copyEditor();
    sync(PROJECTION);
    await settle();
    const shown = editor.children as MaterialValue;
    const diffed = mergeBlocks(
      PROJECTION as MaterialValue,
      [block('a', 'Title mine'), block('b', 'Body mine'), block('c', 'End')],
      shown
    );
    const body = root.toDelta()[1].insert as Y.XmlText;
    Y.transact(root.doc as Y.Doc, () => body.insert(4, ' room'), 'room');
    const { applied, conflicts } = applyDiffed(editor, shown, diffed);
    expect(applied).toBe(true);
    expect(roomBlocks()).toEqual([
      block('a', 'Title mine'),
      block('b', 'Body room'),
      block('c', 'End'),
    ]);
    expect(conflicts).toMatchObject([
      {
        id: 'b',
        mine: block('b', 'Body mine'),
        theirs: block('b', 'Body room'),
      },
    ]);
    (editor as unknown as YHistoryEditor).undo();
    expect(roomBlocks()[0]).toEqual(block('a', 'Title'));
  });
});

describe('replaceBlock', () => {
  // Review r1 M3: only the changed run of text is rewritten, so a comment's
  // anchor (a Yjs relative position) on a word in the block holds.
  it("rewrites only a block's changed text, keeping anchors in it", async () => {
    const { editor, root, roomBlocks, sync, ydoc } = copyEditor();
    const said = 'The mitochondria is the powerhouse';
    sync([block('a', said)]);
    await settle();
    const text = root.toDelta()[0].insert as Y.XmlText;
    const at = said.indexOf('powerhouse');
    const anchor = Y.createRelativePositionFromTypeIndex(text, at);
    replaceBlock(editor, 0, block('a', `${said} of the cell`) as never);
    expect(roomBlocks()[0]).toEqual(block('a', `${said} of the cell`));
    const found = Y.createAbsolutePositionFromRelativePosition(anchor, ydoc);
    expect(found?.index).toBe(at);
  });

  it('keeps marked runs it does not change', async () => {
    const { editor, roomBlocks, sync } = copyEditor();
    const marked = (tail: string) => ({
      children: [{ bold: true, text: 'Bold' }, { text: tail }],
      id: 'a',
      type: 'p',
    });
    sync([marked(' plain')]);
    await settle();
    replaceBlock(editor, 0, marked(' plain edited') as never);
    expect(roomBlocks()[0]).toEqual(marked(' plain edited'));
  });

  it('finds the changed run without splitting a surrogate pair', () => {
    expect(textChange('a\u{1F600}b', 'a\u{1F603}b')).toEqual({
      inserted: '\u{1F603}',
      offset: 1,
      removed: '\u{1F600}',
    });
    expect(textChange('Body', 'Body typed')).toEqual({
      inserted: ' typed',
      offset: 4,
      removed: '',
    });
  });

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
