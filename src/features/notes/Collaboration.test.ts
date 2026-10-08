import {
  slateNodesToInsertDelta,
  slateRangeToRelativeRange,
  withYjs,
  YjsEditor,
  type YjsEditor as YjsEditorType,
} from '@slate-yjs/core';
import { createSlateEditor } from 'platejs';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  commentDecorationRangesForEntry,
  resolveCommentDecorations,
} from './Collaboration';

function base64(value: Uint8Array) {
  return Buffer.from(value).toString('base64');
}

describe('relative comment decorations', () => {
  it('follows selected text after a concurrent insertion', () => {
    const document = new Y.Doc();
    const root = document.get('content', Y.XmlText);
    root.applyDelta(
      slateNodesToInsertDelta([
        {
          children: [{ text: 'selected text' }],
          id: 'block',
          type: 'p',
        },
      ] as never)
    );
    const plateEditor = createSlateEditor({
      value: [{ children: [{ text: '' }], id: 'initial', type: 'p' }],
    });
    const editor = withYjs(
      plateEditor as never,
      root
    ) as unknown as typeof plateEditor & YjsEditorType;
    YjsEditor.connect(editor);
    const relative = slateRangeToRelativeRange(root, editor, {
      anchor: { offset: 0, path: [0, 0] },
      focus: { offset: 8, path: [0, 0] },
    });
    editor.tf.insertText('new ', {
      at: { offset: 0, path: [0, 0] },
    });
    YjsEditor.flushLocalChanges(editor);

    const decorations = resolveCommentDecorations(editor as never, [
      {
        anchorEnd: base64(Y.encodeRelativePosition(relative.focus)),
        anchorQuote: 'selected',
        anchorStart: base64(Y.encodeRelativePosition(relative.anchor)),
        anchorVersion: 1,
        id: 'discussion',
      } as never,
    ]);

    expect(decorations).toMatchObject([
      {
        anchor: { offset: 4, path: [0, 0] },
        commentId: 'discussion',
        focus: { offset: 12, path: [0, 0] },
      },
    ]);
    YjsEditor.disconnect(editor);
    document.destroy();
  });
});

describe('comment decorations per node', () => {
  // A comment from block 2 to block 10 reaches every block between, whatever
  // the number of digits in their indices.
  it('reaches every block a multi-block comment spans', () => {
    const range = {
      anchor: { offset: 1, path: [2, 0] },
      comment: true,
      focus: { offset: 3, path: [10, 0] },
    };
    const reached = Array.from({ length: 12 }, (_, block) => block).filter(
      (block) =>
        commentDecorationRangesForEntry([null, [block]], [range]).length > 0
    );
    expect(reached).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(
      commentDecorationRangesForEntry([null, [10, 0]], [range])
    ).toHaveLength(1);
    expect(
      commentDecorationRangesForEntry([null, [11, 0]], [range])
    ).toHaveLength(0);
  });
});
