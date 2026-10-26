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
import type { MaterialElement } from '@/features/materials/document';
import { stableElementIdsPlugin } from '../stableElementIds';
import { applyChoice } from './applyPiece';
import type { MergePiece } from './types';

/* The merge view's choices (Q253): each is one local Yjs
 * transaction and one Undo step on the bound note editor. */

const p = (id: string, text: string): MaterialElement => ({
  children: [{ text }],
  id,
  type: 'p',
});

/** A note editor bound to a room holding `value`, with Yjs history. */
function boundEditor(value: MaterialElement[]) {
  const ydoc = new Y.Doc();
  ydoc
    .get('content', Y.XmlText)
    .applyDelta(slateNodesToInsertDelta(value as never), { sanitize: false });
  const editor = createPlateEditor({
    nodeId: false,
    plugins: [
      BaseYjsPlugin.configure({ options: { ydoc } }),
      stableElementIdsPlugin,
    ],
    value: [] as never,
  });
  YjsEditor.connect(editor as never);
  const history = editor as unknown as YHistoryEditor;
  const room = () => {
    YjsEditor.flushLocalChanges(editor as never);
    return yTextToSlateElement(ydoc.get('content', Y.XmlText)).children;
  };
  const block = (id: string) =>
    (editor.children as MaterialElement[]).find((child) => child.id === id);
  return { block, editor, history, room };
}

const piece = (
  mine: MaterialElement | null,
  extra: Partial<MergePiece> = {}
): MergePiece => ({
  after: null,
  at: 1,
  block: 'b',
  mine,
  source: 'refused',
  ...extra,
});

describe('applyChoice', () => {
  it("applies the user's version in place as one Undo step, which Redo brings back in place", () => {
    const { block, editor, history, room } = boundEditor([
      p('a', 'A'),
      p('b', 'B room'),
      p('c', 'C'),
    ]);
    const before = history.undoManager.undoStack.length;
    expect(
      applyChoice(editor, piece(p('b', 'B mine')), 'apply', block('b'))
    ).toEqual({ insertedAs: undefined, result: 'applied' });
    expect(room()).toEqual([p('a', 'A'), p('b', 'B mine'), p('c', 'C')]);
    expect(history.undoManager.undoStack.length).toBe(before + 1);
    history.undo();
    expect(room()).toEqual([p('a', 'A'), p('b', 'B room'), p('c', 'C')]);
    history.redo();
    expect(room()).toEqual([p('a', 'A'), p('b', 'B mine'), p('c', 'C')]);
  });

  it("keeps the block's id when the user's version is of another type", () => {
    const { block, editor, room } = boundEditor([p('a', 'A'), p('b', 'B')]);
    const heading = { children: [{ text: 'B mine' }], id: 'b', type: 'h2' };
    applyChoice(editor, piece(heading), 'apply', block('b'));
    expect(room()).toEqual([p('a', 'A'), heading]);
  });

  it('inserts the user version as a new block after the current one, under a new id', () => {
    const { block, editor, room } = boundEditor([
      p('a', 'A'),
      p('b', 'B room'),
    ]);
    const done = applyChoice(
      editor,
      piece(p('b', 'B mine')),
      'insert',
      block('b')
    );
    if (done.result !== 'applied' || !done.insertedAs)
      throw new Error('Not inserted');
    expect(room()).toEqual([
      p('a', 'A'),
      p('b', 'B room'),
      p(done.insertedAs, 'B mine'),
    ]);
  });

  it('restores a block the room deleted after the block before it, else at the end', () => {
    const { editor, room } = boundEditor([p('a', 'A'), p('c', 'C')]);
    const done = applyChoice(
      editor,
      piece(p('b', 'B mine'), { after: 'a' }),
      'restore',
      undefined
    );
    const id = done.result === 'applied' ? done.insertedAs : undefined;
    expect(room()).toEqual([p('a', 'A'), p(id ?? '', 'B mine'), p('c', 'C')]);
    applyChoice(
      editor,
      piece(p('x', 'X mine'), { after: 'gone', block: 'x' }),
      'restore',
      undefined
    );
    expect((room().at(-1) as MaterialElement).children).toEqual([
      { text: 'X mine' },
    ]);
  });

  it('deletes the current block the user had deleted', () => {
    const { block, editor, room } = boundEditor([p('a', 'A'), p('b', 'B')]);
    applyChoice(editor, piece(null), 'delete', block('b'));
    expect(room()).toEqual([p('a', 'A')]);
  });

  // Q229's first applied wins: the block changed after the user looked at
  // it, so nothing is applied. Fails without the check.
  it('applies nothing when the block changed since it was shown', () => {
    const { block, editor, room } = boundEditor([p('a', 'A'), p('b', 'B')]);
    const shown = block('b');
    editor.tf.insertText(' peer', { at: { offset: 1, path: [1, 0] } });
    expect(
      applyChoice(editor, piece(p('b', 'B mine')), 'apply', shown)
    ).toEqual({ result: 'stale' });
    expect(room()).toEqual([p('a', 'A'), p('b', 'B peer')]);
  });
});
