import { BaseYjsPlugin } from '@platejs/yjs';
import {
  slateNodesToInsertDelta,
  YjsEditor,
  yTextToSlateElement,
} from '@slate-yjs/core';
import { createPlateEditor } from 'platejs/react';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { stableElementIdsPlugin } from './stableElementIds';

/** A Plate editor bound to a Yjs room as the note editor is: YjsPlugin first,
 * then this plugin, without Plate's NodeIdPlugin. The room starts with a
 * paragraph that carries Plate's `_id` marker, as one written before can. */
function roomEditor() {
  const ydoc = new Y.Doc();
  const root = ydoc.get('content', Y.XmlText);
  root.applyDelta(
    slateNodesToInsertDelta([
      { _id: 'first', children: [{ text: 'first' }], id: 'first', type: 'p' },
    ] as never)
  );
  const editor = createPlateEditor({
    nodeId: false,
    plugins: [
      BaseYjsPlugin.configure({ options: { ydoc } }),
      stableElementIdsPlugin,
    ],
  });
  YjsEditor.connect(editor as never);
  const room = () => {
    YjsEditor.flushLocalChanges(editor as never);
    return yTextToSlateElement(root).children;
  };
  return { editor, room };
}

describe('stableElementIdsPlugin', () => {
  it('assigns IDs recursively before inserted nodes enter the editor', () => {
    const editor = createPlateEditor({
      plugins: [stableElementIdsPlugin],
      value: [{ children: [{ text: '' }], id: 'initial', type: 'p' }],
    });
    editor.tf.insertNodes(
      {
        children: [
          {
            children: [{ text: 'nested' }],
            type: 'p',
          },
        ],
        type: 'blockquote',
      } as never,
      { at: [1] }
    );
    const block = editor.children[1] as {
      children: Array<{ id?: string }>;
      id?: string;
    };
    expect(block.id).toBeTruthy();
    expect(block.children[0].id).toBeTruthy();
  });

  // Content copied from an editor that runs NodeIdPlugin (question text) or
  // from a room written before can carry its `_id` marker, at any depth; the
  // store refuses it on interactive blocks.
  it('keeps the insert marker out of the room', () => {
    const { editor, room } = roomEditor();
    editor.tf.insertNodes(
      {
        _id: 'embed',
        caption: 'Embed',
        children: [{ text: '' }],
        html: '<p>hi</p>',
        id: 'embed',
        type: 'html_embed',
      } as never,
      { at: [1] }
    );
    expect(room()[1]).toEqual({
      caption: 'Embed',
      children: [{ text: '' }],
      html: '<p>hi</p>',
      id: 'embed',
      type: 'html_embed',
    });
    editor.tf.insertNodes(
      {
        children: [
          {
            _id: 'inner',
            children: [{ children: [{ text: 'deep' }], id: 'deep', type: 'p' }],
            id: 'inner',
            type: 'blockquote',
          },
        ],
        id: 'outer',
        type: 'blockquote',
      } as never,
      { at: [2] }
    );
    const json = JSON.stringify(room()[2]);
    expect(json).not.toContain('_id');
    expect(json).toContain('"id":"outer"');
    expect(json).toContain('"id":"inner"');
    expect(json).toContain('"id":"deep"');
  });

  it('keeps the marker out of a block split from one that has it', () => {
    const { editor, room } = roomEditor();
    editor.tf.select({ offset: 2, path: [0, 0] });
    editor.tf.insertBreak();
    expect(room()[1]).not.toHaveProperty('_id');
  });

  it('counts an id as metadata, not block state', () => {
    const { editor } = roomEditor();
    expect(
      editor.api.isElementStateEmpty({
        children: [{ text: '' }],
        id: 'block',
        type: 'p',
      })
    ).toBe(true);
  });
});
