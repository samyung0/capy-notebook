import {
  slateNodesToInsertDelta,
  withYHistory,
  withYjs,
  YjsEditor,
} from '@slate-yjs/core';
import { createPlateEditor } from 'platejs/react';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  type AssetOperation,
  assetChanges,
  listenAssetOperations,
  noteAssetsPlugin,
  swapAssetId,
} from './noteAssets';

const image = (assetId: string) => ({
  assetId,
  children: [{ text: '' }],
  id: `block-${assetId}`,
  type: 'img',
});
const paragraph = (text: string) => ({
  children: [{ text }],
  id: `p-${text}`,
  type: 'p',
});

describe('assetChanges', () => {
  it('nets inserted, removed and re-pointed asset ids', () => {
    expect(
      assetChanges([
        {
          node: { children: [image('a'), paragraph('x')], type: 'column' },
          type: 'insert_node',
        },
        { node: image('b'), type: 'remove_node' },
        // Moved: removed and inserted again.
        { node: image('c'), type: 'remove_node' },
        { node: image('c'), type: 'insert_node' },
        {
          newProperties: { assetId: 'e' },
          properties: { assetId: 'd' },
          type: 'set_node',
        },
        { type: 'insert_text' },
      ])
    ).toEqual({ added: ['a', 'e'], removed: ['b', 'd'] });
  });
});

function yjsEditor() {
  const doc = new Y.Doc();
  const root = doc.get('content', Y.XmlText);
  root.applyDelta(slateNodesToInsertDelta([paragraph('start')] as never));
  const editor = withYHistory(
    withYjs(
      createPlateEditor({
        plugins: [noteAssetsPlugin],
        value: [paragraph('start')],
      }) as never,
      root
    )
  ) as unknown as ReturnType<typeof createPlateEditor> & YHistory;
  YjsEditor.connect(editor);
  const heard: AssetOperation[] = [];
  listenAssetOperations(editor, (operation) => heard.push(operation));
  return { doc, editor, heard };
}
type YHistory = ReturnType<typeof withYHistory>;

describe('noteAssetsPlugin', () => {
  it('hears local edits and their undo, not remote updates', () => {
    const { doc, editor, heard } = yjsEditor();
    editor.tf.insertNodes(image('local') as never, { at: [1] });
    YjsEditor.flushLocalChanges(editor);
    expect(assetChanges(heard).added).toEqual(['local']);

    heard.length = 0;
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
    peer.get('content', Y.XmlText).insertEmbed(
      2,
      (
        slateNodesToInsertDelta([image('remote')] as never)[0] as {
          insert: Y.XmlText;
        }
      ).insert
    );
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer), 'provider');
    expect(editor.children).toHaveLength(3);
    expect(heard).toEqual([]);

    editor.undo();
    expect(assetChanges(heard).removed).toEqual(['local']);
  });

  it('swaps asset ids outside the undo history', () => {
    const { editor, heard } = yjsEditor();
    editor.tf.insertNodes(image('pasted') as never, { at: [1] });
    YjsEditor.flushLocalChanges(editor);
    // A tracked swap would now be a step of its own.
    editor.undoManager.stopCapturing();
    const undoSteps = editor.undoManager.undoStack.length;
    heard.length = 0;

    swapAssetId(editor, 'pasted', 'copy');
    YjsEditor.flushLocalChanges(editor);
    expect(editor.children[1]).toMatchObject({ assetId: 'copy' });
    expect(editor.undoManager.undoStack).toHaveLength(undoSteps);
    expect(heard).toEqual([]);

    // Undo takes back the paste itself, not the swap.
    editor.undo();
    expect(editor.children).toHaveLength(1);
  });
});
