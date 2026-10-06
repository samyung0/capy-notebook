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
  mediaPurpose,
  noteAssetsPlugin,
  refAdoptions,
  repointMaterialRefs,
  swapAssetId,
} from './noteAssets';

const image = (assetId: string) => ({
  assetId,
  children: [{ text: '' }],
  id: `block-${assetId}`,
  type: 'img',
});
const quizRef = (materialId: string, id = `ref-${materialId}`) => ({
  children: [{ text: '' }],
  id,
  materialId,
  refKind: 'quiz',
  type: 'material_ref',
});
const paragraph = (text: string) => ({
  children: [{ text }],
  id: `p-${text}`,
  type: 'p',
});

describe('assetChanges', () => {
  it('nets inserted, removed and re-pointed asset ids', () => {
    const { added, nodes, removed } = assetChanges([
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
    ]);
    expect({ added, removed }).toEqual({
      added: ['a', 'e'],
      removed: ['b', 'd'],
    });
    // The removed node carries what a re-upload needs.
    expect(nodes.get('b')).toEqual(image('b'));
  });

  it('nets inserted quiz references, skipping pending ones', () => {
    const { refs } = assetChanges([
      {
        node: { children: [quizRef('pasted'), quizRef('')], type: 'column' },
        type: 'insert_node',
      },
      // Cut and pasted within the note: not new.
      { node: quizRef('moved'), type: 'remove_node' },
      { node: quizRef('moved'), type: 'insert_node' },
      { node: quizRef('deleted'), type: 'remove_node' },
    ]);
    expect(refs).toEqual(['pasted']);
  });
});

describe('mediaPurpose', () => {
  it('maps a node to the purpose its asset was stored under', () => {
    expect(mediaPurpose({ type: 'img' })).toBe('image');
    expect(mediaPurpose({ type: 'audio' })).toBe('audio');
    expect(mediaPurpose({ contentType: 'application/pdf', type: 'file' })).toBe(
      'pdf'
    );
    expect(mediaPurpose({ contentType: 'text/csv', type: 'file' })).toBe(
      'file'
    );
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

describe('refAdoptions', () => {
  const block = (blockId: string, materialId: string) => ({
    blockId,
    materialId,
  });

  it('keeps a quiz with the block that had it and copies it for the others', () => {
    // Pasted above and below the block that already had quiz a.
    const blocks = [block('p1', 'a'), block('old', 'a'), block('p2', 'a')];
    expect(
      refAdoptions(blocks, new Set(['old'])).map(({ copy }) => copy)
    ).toEqual([true, false, true]);
  });

  it('keeps the first block when every one is new', () => {
    // Another note's quiz pasted twice, next to a single new paste.
    const blocks = [block('p1', 'f'), block('p2', 'g'), block('p3', 'f')];
    expect(refAdoptions(blocks, new Set()).map(({ copy }) => copy)).toEqual([
      false,
      false,
      true,
    ]);
  });
});

describe('repointMaterialRefs', () => {
  it('re-points or removes pasted blocks one by one outside the undo history', () => {
    const { editor, heard } = yjsEditor();
    editor.tf.insertNodes(
      [
        quizRef('own', 'first'),
        quizRef('own', 'second'),
        quizRef('gone'),
      ] as never,
      { at: [1] }
    );
    YjsEditor.flushLocalChanges(editor);
    expect(assetChanges(heard).refs).toEqual(['own', 'gone']);
    editor.undoManager.stopCapturing();
    const undoSteps = editor.undoManager.undoStack.length;
    heard.length = 0;

    // Two blocks share a quiz: only the second one moves to the copy.
    repointMaterialRefs(
      editor,
      new Map([
        ['second', 'copy'],
        ['ref-gone', undefined],
      ])
    );
    YjsEditor.flushLocalChanges(editor);
    expect(editor.children).toHaveLength(3);
    expect(editor.children[1]).toMatchObject({
      id: 'first',
      materialId: 'own',
    });
    expect(editor.children[2]).toMatchObject({
      id: 'second',
      materialId: 'copy',
    });
    expect(editor.undoManager.undoStack).toHaveLength(undoSteps);
    expect(heard).toEqual([]);

    // Undo takes back the paste itself.
    editor.undo();
    expect(editor.children).toHaveLength(1);
  });
});
