import { BaseYjsPlugin } from '@platejs/yjs';
import {
  slateNodesToInsertDelta,
  type YHistoryEditor,
  YjsEditor,
  yTextToSlateElement,
} from '@slate-yjs/core';
import { createPlateEditor } from 'platejs/react';
import { describe, expect, it, vi } from 'vitest';

const toasts = vi.hoisted(() => ({ copyMergeFailed: 0 }));
vi.mock('../saveFailure', () => ({
  toastCopyMergeFailed: () => {
    toasts.copyMergeFailed++;
  },
}));

import * as Y from 'yjs';
import type { MaterialValue } from '@/features/materials/document';
import { DRAFT_EXPIRY_MS } from '@/lib/editDrafts';
import { bindSyncedRoom, roomBindingPlugin, whenBound } from '../roomBinding';
import { stableElementIdsPlugin } from '../stableElementIds';
import { mergeAtBind, replaceBlock, textChange } from './applyBlocks';

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

/** The note editor before its room synced, holding `value` (the
 * projection), with the copy merge NoteEditorCore registers; the copy was
 * last edited at `editedAt`. */
function copyEditor(
  value: MaterialValue = PROJECTION as MaterialValue,
  editedAt = Date.now()
) {
  const ydoc = new Y.Doc();
  const editor = createPlateEditor({
    nodeId: false,
    plugins: [
      BaseYjsPlugin.configure({ options: { ydoc } }),
      roomBindingPlugin,
      stableElementIdsPlugin,
    ],
    value: structuredClone(value) as never,
  });
  const root = ydoc.get('content', Y.XmlText);
  const updates: unknown[] = [];
  ydoc.on('update', (_update: Uint8Array, origin: unknown) =>
    updates.push(origin)
  );
  const merged: ReturnType<typeof mergeAtBind>[] = [];
  whenBound(editor, (unbound) => {
    merged.push(
      mergeAtBind(editor, [
        { base: value, editedAt, mine: unbound as MaterialValue },
      ])
    );
  });
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
  return { editor, merged, roomBlocks, root, sync, updates, ydoc };
}

describe('the copy merge at the bind', () => {
  it("merges the copy's edits into the room's document as the session's own updates, keeping the caret", () => {
    const { editor, roomBlocks, sync, updates } = copyEditor();
    // Typed into the copy: the body edited, a new block after it.
    editor.tf.select({ offset: 4, path: [1, 0] });
    editor.tf.insertText(' typed');
    editor.tf.insertNodes(block('n', 'New') as never, { at: [2] });
    editor.tf.select({ offset: 10, path: [1, 0] });
    // Meanwhile the room changed the title.
    sync([block('a', 'Title room'), block('b', 'Body'), block('c', 'End')]);
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

  // Merge view review r1 Q-M1 (Q408): the merge applies in the bind's own
  // task, so nothing (a keystroke, a merge view choice) can run between the
  // room's tree and the merged one, and the caret, placed after the merge,
  // lands in the merged text even where the merge shifted it.
  it('places the caret inside text the merge shifted, with the merge done when the bind returns', () => {
    const { editor, roomBlocks, sync } = copyEditor([
      block('a', 'Hello world'),
    ]);
    editor.tf.insertText('big ', { at: { offset: 6, path: [0, 0] } });
    editor.tf.select({ offset: 10, path: [0, 0] });
    sync([block('a', 'Hello world')]);
    // No await: the bind returned with the merge applied.
    expect(roomBlocks()).toEqual([block('a', 'Hello big world')]);
    expect(editor.selection).toEqual({
      anchor: { offset: 10, path: [0, 0] },
      focus: { offset: 10, path: [0, 0] },
    });
    editor.tf.insertText('X');
    expect(roomBlocks()).toEqual([block('a', 'Hello big Xworld')]);
  });

  // Merge view review r2 L2 (Q421): a copy last edited over 7 days ago is
  // never merged, the tab's own included; its blocks become pieces.
  it('makes a copy past the 7-day expiry pieces at the bind, merging nothing', () => {
    const { editor, merged, roomBlocks, sync, updates } = copyEditor(
      PROJECTION as MaterialValue,
      Date.now() - DRAFT_EXPIRY_MS - 1
    );
    editor.tf.insertText(' typed', { at: { offset: 4, path: [1, 0] } });
    sync(PROJECTION);
    expect(roomBlocks()).toEqual(PROJECTION);
    expect(updates.filter((origin) => origin !== 'room')).toEqual([]);
    expect(merged[0]).toMatchObject({
      applied: false,
      expired: [
        { block: 'b', mine: block('b', 'Body typed'), source: 'expired' },
      ],
    });
  });

  // Q433: a bind merge that throws keeps the copies (null: NoteEditorCore
  // deletes no row) and tells the user they are added at the next open.
  it('tells the user and keeps the copies when the merge throws', () => {
    const { editor, merged, sync } = copyEditor();
    editor.tf.insertText(' typed', { at: { offset: 4, path: [1, 0] } });
    vi.spyOn(editor.tf, 'withoutNormalizing').mockImplementation(() => {
      throw new Error('broken');
    });
    const before = toasts.copyMergeFailed;
    sync(PROJECTION);
    expect(merged).toEqual([null]);
    expect(toasts.copyMergeFailed).toBe(before + 1);
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

  it('leaves the room’s document alone when the copy was not edited', () => {
    const { roomBlocks, sync, updates } = copyEditor();
    const room = [block('a', 'Title room'), block('b', 'Body')];
    sync(room);
    expect(roomBlocks()).toEqual(room);
    expect(updates.filter((origin) => origin !== 'room')).toEqual([]);
  });
});

describe('replaceBlock', () => {
  // Review r1 M3: only the changed run of text is rewritten, so a comment's
  // anchor (a Yjs relative position) on a word in the block holds.
  it("rewrites only a block's changed text, keeping anchors in it", () => {
    const { editor, root, roomBlocks, sync, ydoc } = copyEditor();
    const said = 'The mitochondria is the powerhouse';
    sync([block('a', said)]);
    const text = root.toDelta()[0].insert as Y.XmlText;
    const at = said.indexOf('powerhouse');
    const anchor = Y.createRelativePositionFromTypeIndex(text, at);
    replaceBlock(editor, 0, block('a', `${said} of the cell`) as never);
    expect(roomBlocks()[0]).toEqual(block('a', `${said} of the cell`));
    const found = Y.createAbsolutePositionFromRelativePosition(anchor, ydoc);
    expect(found?.index).toBe(at);
  });

  it('keeps marked runs it does not change', () => {
    const { editor, roomBlocks, sync } = copyEditor();
    const marked = (tail: string) => ({
      children: [{ bold: true, text: 'Bold' }, { text: tail }],
      id: 'a',
      type: 'p',
    });
    sync([marked(' plain')]);
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

  it('keeps a block of the same type in place, setting and unsetting its attributes', () => {
    const { editor, root, roomBlocks, sync } = copyEditor();
    sync([block('a', 'Title', { align: 'center' }), block('b', 'Body')]);
    const element = root.toDelta()[0].insert as Y.XmlText;
    replaceBlock(editor, 0, block('a', 'Title new', { indent: 1 }) as never);
    expect(roomBlocks()[0]).toEqual(block('a', 'Title new', { indent: 1 }));
    expect(root.toDelta()[0].insert).toBe(element);
  });

  it('replaces a block of another type at the same index, keeping its id', () => {
    const { editor, roomBlocks, sync } = copyEditor();
    sync([block('a', 'Title'), block('b', 'Body')]);
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
