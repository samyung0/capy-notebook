import { BaseYjsPlugin } from '@platejs/yjs';
import {
  relativeRangeToSlateRange,
  slateNodesToInsertDelta,
  slateRangeToRelativeRange,
  type YHistoryEditor,
  YjsEditor,
} from '@slate-yjs/core';
import { createPlateEditor } from 'platejs/react';
import { expect, it } from 'vitest';
import * as Y from 'yjs';
import { liveSlateRange } from './liveRange';

it('drops a range whose block left the document until Undo brings it back', () => {
  const ydoc = new Y.Doc();
  const root = ydoc.get('content', Y.XmlText);
  root.applyDelta(
    slateNodesToInsertDelta([
      { children: [{ text: 'gone' }], id: 'p1', type: 'p' },
      { children: [{ text: 'kept' }], id: 'p2', type: 'p' },
    ] as never),
    { sanitize: false }
  );
  const editor = createPlateEditor({
    nodeId: false,
    plugins: [BaseYjsPlugin.configure({ options: { ydoc } })],
  } as never) as unknown as YHistoryEditor &
    ReturnType<typeof createPlateEditor>;
  YjsEditor.connect(editor);
  const selected = {
    anchor: { offset: 0, path: [0, 0] },
    focus: { offset: 4, path: [0, 0] },
  };
  const range = slateRangeToRelativeRange(root, editor, selected);
  expect(liveSlateRange(editor, range)).toEqual(selected);

  editor.tf.removeNodes({ at: [0] });
  YjsEditor.flushLocalChanges(editor);
  // slate-yjs alone places it in the block that is left.
  expect(relativeRangeToSlateRange(root, editor, range)).not.toBeNull();
  expect(liveSlateRange(editor, range)).toBeNull();

  editor.undo();
  expect(liveSlateRange(editor, range)).toEqual(selected);
});
