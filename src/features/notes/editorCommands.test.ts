import { describe, expect, it, vi } from 'vitest';
import { blockIssues } from '@/features/questions/issues';
import type { NoteBlockDialogsApi } from './blocks/dialogContext';
import { opensOnMount } from './blocks/openFigure';
import {
  columnGroupFromWidths,
  EDITOR_COMMANDS,
  insertInlineEquation,
} from './editorCommands';
import { COLUMN_LAYOUTS } from './richBlockConfig';

describe('editor insertion command catalog', () => {
  const dialogs = (openPlot = vi.fn<NoteBlockDialogsApi['openPlot']>()) => ({
    createEmbedded: vi.fn(),
    insertEmbedded: vi.fn(),
    noteId: 'note',
    openPlot,
    openYouTube: vi.fn(),
  });
  const editor = () => ({
    api: { block: () => undefined },
    selection: null,
    tf: { focus: vi.fn(), insertNodes: vi.fn() },
  });

  it.each(['chart', 'graph'])(
    'inserts a %s at once and opens its live dialog on it',
    (kind) => {
      const target = editor();
      EDITOR_COMMANDS.find((item) => item.id === kind)!.run(target, dialogs());
      const [node] = target.tf.insertNodes.mock.calls[0];
      expect(node).toMatchObject({ children: [{ text: '' }], type: kind });
      expect(node.block.type).toBe(kind);
      expect(opensOnMount(node.id)).toBe(true);
    }
  );

  it('inserts a plot only after its dialog saves', () => {
    const target = editor();
    const openPlot = vi.fn<NoteBlockDialogsApi['openPlot']>();
    EDITOR_COMMANDS.find((item) => item.id === 'plot')!.run(
      target,
      dialogs(openPlot)
    );
    expect(target.tf.insertNodes).not.toHaveBeenCalled();
    const [draft, save] = openPlot.mock.calls[0];
    save(draft);
    expect(target.tf.insertNodes).toHaveBeenCalledWith(
      expect.objectContaining({
        block: draft,
        children: [{ text: '' }],
        type: 'plot',
      }),
      { select: true }
    );
  });

  it('opens a new plot on a line through (0, 0) and (1, 1) that saves as it is', () => {
    const openPlot = vi.fn<NoteBlockDialogsApi['openPlot']>();
    EDITOR_COMMANDS.find((item) => item.id === 'plot')!.run(
      editor(),
      dialogs(openPlot)
    );
    const [draft] = openPlot.mock.calls[0];
    expect(draft).toMatchObject({
      kind: 'line',
      series: [
        {
          name: '',
          points: [
            [0, 0],
            [1, 1],
          ],
        },
      ],
    });
    expect(blockIssues(draft)).toEqual([]);
  });
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

  it('offers images, YouTube and audio as media, no PDF or file block', () => {
    expect(
      EDITOR_COMMANDS.filter(
        (command) => command.group === 'fileOperations'
      ).map((command) => command.id)
    ).toEqual(['image', 'youtube', 'audio']);
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
