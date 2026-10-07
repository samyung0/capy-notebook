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
 * then this plugin, with Plate's NodeIdPlugin on (Plate turns it off by
 * default under tests). */
function roomEditor() {
  const ydoc = new Y.Doc();
  const root = ydoc.get('content', Y.XmlText);
  root.applyDelta(
    slateNodesToInsertDelta([
      { children: [{ text: 'first' }], id: 'first', type: 'p' },
    ] as never)
  );
  const editor = createPlateEditor({
    nodeId: {},
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

  // Plate's NodeIdPlugin marks every node inserted with an id as `_id` and
  // removes the marker only on its own copy of the operation; the room must
  // never receive it (the store refuses unknown fields on interactive blocks).
  it('keeps the insert marker out of the room', () => {
    const { editor, room } = roomEditor();
    editor.tf.insertNodes(
      {
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
  });

  // Plate marks only the inserted roots; a descendant can still carry one when
  // it was copied out of a document that already holds the marker.
  it('keeps the marker out of an inserted subtree', () => {
    const { editor, room } = roomEditor();
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
      { at: [1] }
    );
    const json = JSON.stringify(room()[1]);
    expect(json).not.toContain('_id');
    expect(json).toContain('"id":"outer"');
    expect(json).toContain('"id":"inner"');
    expect(json).toContain('"id":"deep"');
  });
});
