import { describe, expect, it, vi } from 'vitest';
import type { NoteBlockDialogsApi } from './blocks/dialogContext';
import {
  columnGroupFromWidths,
  EDITOR_COMMANDS,
  insertInlineEquation,
} from './editorCommands';
import { COLUMN_LAYOUTS } from './richBlockConfig';

describe('editor insertion command catalog', () => {
  it.each(['chart', 'graph'])(
    'inserts a %s only after its block dialog saves',
    (kind) => {
      const openVisual = vi.fn<NoteBlockDialogsApi['openVisual']>();
      const editor = {
        api: { block: () => undefined },
        selection: null,
        tf: { focus: vi.fn(), insertNodes: vi.fn() },
      };
      const command = EDITOR_COMMANDS.find((item) => item.id === kind)!;
      command.run(editor, {
        createEmbedded: vi.fn(),
        insertEmbedded: vi.fn(),
        noteId: 'note',
        openVisual,
        openYouTube: vi.fn(),
      });
      expect(editor.tf.insertNodes).not.toHaveBeenCalled();
      const [draft, save] = openVisual.mock.calls[0];
      save(draft);
      expect(editor.tf.insertNodes).toHaveBeenCalledWith(
        expect.objectContaining({
          block: draft,
          children: [{ text: '' }],
          type: kind,
        }),
        { select: true }
      );
    }
  );
  it('covers every grouped insertion surface with an icon', () => {
    const groups = new Set(EDITOR_COMMANDS.map((command) => command.group));
    expect(groups).toEqual(
      new Set([
        'general',
        'fileOperations',
        'inlineElements',
        'blockDecorations',
        'blockElements',
      ])
    );
    expect(EDITOR_COMMANDS.every((command) => command.icon)).toBe(true);
  });

  it('includes the complete heading and list set', () => {
    expect(
      EDITOR_COMMANDS.filter((command) =>
        command.id.startsWith('heading-')
      ).map((command) => command.id)
    ).toEqual([
      'heading-1',
      'heading-2',
      'heading-3',
      'heading-4',
      'heading-5',
      'heading-6',
    ]);
    expect(
      EDITOR_COMMANDS.filter(
        (command) => command.group === 'blockDecorations'
      ).map((command) => command.id)
    ).toEqual(['bulleted-list', 'numbered-list', 'task-list']);
  });

  it('creates an insertion node for every supported column layout', () => {
    for (const layout of COLUMN_LAYOUTS) {
      const node = columnGroupFromWidths(layout.widths);
      expect(node.type).toBe('column_group');
      expect(node.children.map((column) => column.width)).toEqual(
        layout.widths
      );
      expect(
        node.children.every((column) => column.children[0]?.type === 'p')
      ).toBe(true);
    }
  });

  it('creates an inline equation from the selected text', () => {
    const selection = {
      anchor: { offset: 0, path: [0, 0] },
      focus: { offset: 3, path: [0, 0] },
    };
    const editor = {
      api: {
        isCollapsed: vi.fn(() => false),
        string: vi.fn(() => 'x^2'),
      },
      selection,
      tf: { focus: vi.fn(), insertNodes: vi.fn() },
    };
    insertInlineEquation(editor);
    expect(editor.tf.insertNodes).toHaveBeenCalledWith(
      {
        children: [{ text: '' }],
        texExpression: 'x^2',
        type: 'inline_equation',
      },
      { at: selection, select: true }
    );
  });

  it('inserts an empty equation at the caret for in-place editing', () => {
    const editor = {
      api: { isCollapsed: vi.fn(() => true), string: vi.fn() },
      selection: {
        anchor: { offset: 1, path: [0, 0] },
        focus: { offset: 1, path: [0, 0] },
      },
      tf: { focus: vi.fn(), insertNodes: vi.fn() },
    };
    insertInlineEquation(editor);
    expect(editor.tf.insertNodes).toHaveBeenCalledWith(
      { children: [{ text: '' }], texExpression: '', type: 'inline_equation' },
      { at: editor.selection, select: true }
    );
  });
});
