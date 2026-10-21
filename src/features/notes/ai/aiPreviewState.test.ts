import { BaseYjsPlugin } from '@platejs/yjs';
import {
  slateNodesToInsertDelta,
  slateRangeToRelativeRange,
  type YHistoryEditor,
  YjsEditor,
  yTextToSlateElement,
} from '@slate-yjs/core';
import { NodeApi, type Point, type TElement } from 'platejs';
import { createPlateEditor } from 'platejs/react';
import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { StaticMaterialKit } from '@/features/materials/staticPlugins';
import { m } from '@/i18n';
import { noteMarkdownPlugin } from '../markdown';
import { resolveImported } from '../pendingRefs';
import { stableElementIdsPlugin } from '../stableElementIds';
import {
  type AiLocalPreview,
  applyAiPreview,
  getAiPreview,
  setAiPreview,
} from './aiPreviewState';

// Spied to see whether fence rows were created; the real one runs.
vi.mock('../pendingRefs', async (original) => {
  const actual = await original<typeof import('../pendingRefs')>();
  return { ...actual, resolveImported: vi.fn(actual.resolveImported) };
});

const QUIZ_FENCE = ['```quiz', 'questions: []', '```'].join('\n');

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
  const over = (
    proposedText: string,
    anchor: Point,
    focus: Point
  ): AiLocalPreview => ({
    kind: 'edit',
    originalText: '',
    proposedText,
    targetRange: slateRangeToRelativeRange(root, yjs, { anchor, focus }),
  });
  const edit = (
    proposedText: string,
    anchor: number,
    focus: number,
    path = [0, 0]
  ) => over(proposedText, { offset: anchor, path }, { offset: focus, path });
  return { edit, editor: yjs, over, room, texts, ydoc };
}

const paragraph = (id: string, text: string): TElement => ({
  children: [{ text }],
  id,
  type: 'p',
});

const listItem = (): TElement => ({
  children: [{ text: 'item text' }],
  id: 'l1',
  indent: 1,
  listStyleType: 'disc',
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

    // A cell the model emptied is written empty; the others still change.
    setAiPreview(editor, {
      kind: 'table',
      originalText: '',
      proposedText: '',
      tableUpdates: [
        { content: '', id: 'c1' },
        { content: 'dos', id: 'c2' },
      ],
    });
    await applyAiPreview(editor);
    const cells = (room()[0].children[0] as TElement).children as TElement[];
    expect(cells.map((node) => NodeApi.string(node))).toEqual(['', 'dos']);

    // A cell removed alone is skipped; the others are written.
    setAiPreview(editor, {
      kind: 'table',
      originalText: '',
      proposedText: '',
      tableUpdates: [
        { content: 'gone', id: 'c9' },
        { content: 'tres', id: 'c2' },
      ],
    });
    await expect(applyAiPreview(editor)).resolves.toBe(true);
    const after = (room()[0].children[0] as TElement).children as TElement[];
    expect(after.map((node) => NodeApi.string(node))).toEqual(['', 'tres']);
  });

  // Epo 2026-10-21: the removal is already visible, so no message.
  it('drops the suggestion when the text it was for was removed', async () => {
    const { edit, editor, texts } = roomEditor([
      paragraph('p1', 'gone'),
      paragraph('p2', 'kept text'),
    ]);
    setAiPreview(editor, edit('replacement', 0, 4));
    editor.tf.removeNodes({ at: [0] });
    await expect(applyAiPreview(editor)).resolves.toBe(true);
    expect(getAiPreview(editor)).toBeNull();
    expect(texts(editor.children as TElement[])).toEqual(['kept text']);

    // Its block stays but all of its text is gone.
    setAiPreview(editor, {
      ...edit('replacement', 0, 4),
      originalText: 'kept',
    });
    editor.tf.delete({
      at: {
        anchor: { offset: 0, path: [0, 0] },
        focus: { offset: 4, path: [0, 0] },
      },
    });
    await expect(applyAiPreview(editor)).resolves.toBe(true);
    expect(getAiPreview(editor)).toBeNull();
    expect(texts(editor.children as TElement[])).toEqual([' text']);
  });

  it('keeps whole blocks with their type, properties and Yjs text', async () => {
    const { editor, over, room, ydoc } = roomEditor([
      listItem(),
      {
        align: 'center',
        children: [{ text: 'Old title' }],
        id: 'h',
        type: 'h2',
      },
    ]);
    // A peer types at the heading's end while the answer is accepted.
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(ydoc));
    const [, heading] = peer.get('content', Y.XmlText).toDelta() as {
      insert: Y.XmlText;
    }[];
    heading.insert.insert(9, '!');

    // Both blocks, as a block selection gives them, answered without the
    // list marker or the heading's ## (the adapter sends neither).
    setAiPreview(
      editor,
      over(
        'Better item\n\nNew title',
        { offset: 0, path: [0, 0] },
        { offset: 9, path: [1, 0] }
      )
    );
    await applyAiPreview(editor);
    Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(peer), 'room');

    const [item, title] = room();
    expect(item).toEqual({
      ...listItem(),
      children: [{ text: 'Better item' }],
    });
    expect(title).toMatchObject({ align: 'center', id: 'h', type: 'h2' });
    // The peer's typing stays (on either side: concurrent inserts order by
    // client id).
    expect(NodeApi.string(title).replace('!', '')).toBe('New title');
    expect(NodeApi.string(title)).toContain('!');
    expect(editor.undoManager.undoStack).toHaveLength(1);
  });

  it('gives a plain first paragraph the shape of the whole block it replaces', async () => {
    const { edit, editor, room } = roomEditor([listItem()]);
    setAiPreview(editor, edit('First\n\nSecond', 0, 9));
    await applyAiPreview(editor);
    expect(room()[0]).toEqual({ ...listItem(), children: [{ text: 'First' }] });
    expect(room().map((node) => NodeApi.string(node))).toEqual([
      'First',
      'Second',
    ]);
  });

  it('writes over a range that ends on a void block', async () => {
    const { editor, over, texts } = roomEditor([
      paragraph('p1', 'text'),
      { children: [{ text: '' }], id: 'hr', type: 'hr' } as TElement,
      paragraph('p2', 'after'),
    ]);
    setAiPreview(
      editor,
      over(
        'Rewritten',
        { offset: 0, path: [0, 0] },
        { offset: 0, path: [1, 0] }
      )
    );
    await expect(applyAiPreview(editor)).resolves.toBe(true);
    expect(texts(editor.children as TElement[])).toEqual([
      'Rewritten',
      'after',
    ]);
  });

  it('refuses an answer with nothing to write and keeps the preview', async () => {
    const { edit, editor, texts } = roomEditor([paragraph('p1', 'kept')]);
    // A fence whose row cannot be created leaves no nodes.
    const preview = edit(QUIZ_FENCE, 0, 4);
    setAiPreview(editor, preview);
    await expect(applyAiPreview(editor)).rejects.toThrow(
      m.editor_ai_accept_failed()
    );
    expect(texts(editor.children as TElement[])).toEqual(['kept']);
    expect(getAiPreview(editor)).toBe(preview);
  });

  it('writes nothing once the preview was rejected while it was converted', async () => {
    const { edit, editor, texts } = roomEditor([paragraph('p1', 'kept')]);
    setAiPreview(editor, edit('replaced', 0, 4));
    const accepting = applyAiPreview(editor);
    setAiPreview(editor, null);
    await expect(accepting).resolves.toBe(false);
    expect(texts(editor.children as TElement[])).toEqual(['kept']);
  });

  it('creates no fence rows for a target that was removed', async () => {
    const { edit, editor } = roomEditor([
      paragraph('p1', 'gone'),
      paragraph('p2', 'kept'),
    ]);
    setAiPreview(editor, edit(QUIZ_FENCE, 0, 4));
    editor.tf.removeNodes({ at: [0] });
    vi.mocked(resolveImported).mockClear();
    await expect(applyAiPreview(editor)).resolves.toBe(true);
    expect(resolveImported).not.toHaveBeenCalled();
  });
});
