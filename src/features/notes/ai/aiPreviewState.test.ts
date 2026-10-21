import { BaseYjsPlugin } from '@platejs/yjs';
import {
  slateNodesToInsertDelta,
  slateRangeToRelativeRange,
  type YHistoryEditor,
  YjsEditor,
  yTextToSlateElement,
} from '@slate-yjs/core';
import { NodeApi, type TElement } from 'platejs';
import { createPlateEditor } from 'platejs/react';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { StaticMaterialKit } from '@/features/materials/staticPlugins';
import { noteMarkdownPlugin } from '../markdown';
import { stableElementIdsPlugin } from '../stableElementIds';
import {
  type AiLocalPreview,
  applyAiPreview,
  setAiPreview,
} from './aiPreviewState';

/** A Plate editor bound to a Yjs room as the note editor is (YjsPlugin first,
 * its stable ids, the note's markdown rules), with Yjs Undo. */
function roomEditor(value: TElement[]) {
  const ydoc = new Y.Doc();
  const root = ydoc.get('content', Y.XmlText);
  root.applyDelta(slateNodesToInsertDelta(value as never), { sanitize: false });
  const editor = createPlateEditor({
    nodeId: false,
    plugins: [
      BaseYjsPlugin.configure({ options: { ydoc } }),
      stableElementIdsPlugin,
      ...StaticMaterialKit,
      noteMarkdownPlugin,
    ],
  } as never);
  const yjs = editor as typeof editor & YHistoryEditor;
  YjsEditor.connect(yjs);
  const room = () => yTextToSlateElement(root).children as TElement[];
  const texts = (nodes: TElement[]) =>
    nodes.map((node) => NodeApi.string(node));
  const edit = (
    proposedText: string,
    anchor: number,
    focus: number,
    path = [0, 0]
  ): AiLocalPreview => ({
    kind: 'edit',
    originalText: '',
    proposedText,
    targetRange: slateRangeToRelativeRange(root, yjs, {
      anchor: { offset: anchor, path },
      focus: { offset: focus, path },
    }),
  });
  return { edit, editor: yjs, room, texts };
}

const paragraph = (id: string, text: string): TElement => ({
  children: [{ text }],
  id,
  type: 'p',
});

describe('applyAiPreview', () => {
  it('applies an edit once, in the editor and the room, as one Undo step', async () => {
    const { edit, editor, room, texts } = roomEditor([
      paragraph('p1', 'hello world'),
    ]);
    setAiPreview(editor, edit('wonderful world', 6, 11));
    await applyAiPreview(editor);

    expect(texts(editor.children as TElement[])).toEqual([
      'hello wonderful world',
    ]);
    expect(texts(room())).toEqual(['hello wonderful world']);
    expect(editor.undoManager.undoStack).toHaveLength(1);
    editor.undo();
    expect(texts(editor.children as TElement[])).toEqual(['hello world']);
    expect(texts(room())).toEqual(['hello world']);
  });

  it('writes over the previewed range after someone changed its text', async () => {
    const { edit, editor, texts } = roomEditor([
      paragraph('p1', 'hello world'),
    ]);
    setAiPreview(editor, edit('there', 6, 11));
    editor.tf.insertText('XX', { at: { offset: 8, path: [0, 0] } });
    await applyAiPreview(editor);
    expect(texts(editor.children as TElement[])).toEqual(['hello there']);
  });

  it('turns Markdown into formatted nodes', async () => {
    const { edit, editor, room } = roomEditor([
      paragraph('p1', 'plain'),
      paragraph('p2', 'after'),
    ]);
    setAiPreview(editor, edit('A **bold** claim', 0, 5));
    await applyAiPreview(editor);
    // The block keeps its id, and so its comments.
    expect(editor.children[0].id).toBe('p1');
    expect(editor.children[0].children).toEqual([
      { text: 'A ' },
      { bold: true, text: 'bold' },
      { text: ' claim' },
    ]);

    setAiPreview(editor, {
      insertAfterId: 'p1',
      kind: 'insert',
      originalText: '',
      proposedText: '# Heading\n\n- item',
    });
    await applyAiPreview(editor);
    expect(room().map((node) => [node.type, NodeApi.string(node)])).toEqual([
      ['p', 'A bold claim'],
      ['h1', 'Heading'],
      ['p', 'item'],
      ['p', 'after'],
    ]);
    expect(room()[2]).toMatchObject({ listStyleType: 'disc' });
  });

  it('changes table cell contents in place', async () => {
    const cell = (id: string, text: string) => ({
      children: [paragraph(`${id}-p`, text)],
      id,
      type: 'td',
    });
    const { editor, room } = roomEditor([
      {
        children: [
          {
            children: [cell('c1', 'one'), cell('c2', 'two')],
            id: 'r1',
            type: 'tr',
          },
        ],
        id: 't1',
        type: 'table',
      } as TElement,
    ]);
    setAiPreview(editor, {
      kind: 'table',
      originalText: '',
      proposedText: '',
      tableUpdates: [{ content: '**uno**', id: 'c1' }],
    });
    await applyAiPreview(editor);
    const [first, second] = (room()[0].children[0] as TElement)
      .children as TElement[];
    expect(first.id).toBe('c1');
    expect((first.children[0] as TElement).children).toEqual([
      { bold: true, text: 'uno' },
    ]);
    expect(second).toEqual(cell('c2', 'two'));
    expect(editor.undoManager.undoStack).toHaveLength(1);
  });

  it('writes nothing when the previewed block was removed', async () => {
    const { edit, editor, texts } = roomEditor([
      paragraph('p1', 'gone'),
      paragraph('p2', 'kept'),
    ]);
    setAiPreview(editor, edit('replacement', 0, 4));
    editor.tf.removeNodes({ at: [0] });
    await expect(applyAiPreview(editor)).rejects.toThrow();
    expect(texts(editor.children as TElement[])).toEqual(['kept']);
  });
});
