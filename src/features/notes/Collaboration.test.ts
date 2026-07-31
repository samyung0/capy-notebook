import {
  slateNodesToInsertDelta,
  slateRangeToRelativeRange,
  type YjsEditor as YjsEditorType,
  withYjs,
  YjsEditor,
} from '@slate-yjs/core';
import { createSlateEditor } from 'platejs';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { resolveCommentDecorations } from './Collaboration';

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
    const editor = withYjs(plateEditor as never, root) as unknown as typeof plateEditor &
      YjsEditorType;
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
