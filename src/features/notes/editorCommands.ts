import { ListStyleType, toggleList } from '@platejs/list';
import { KEYS } from 'platejs';
import type { IconName } from '@/components/ui/Icon';
import { m } from '@/i18n';
import type { NoteBlockDialogsApi } from './blocks/dialogContext';
import { customBlockNode } from './blocks/shared';
import { toggleEditorBlock } from './editorTransforms';
import { insertEditorNode, type NoteEditorInstance } from './insertEditorNode';
import { insertMediaPlaceholder } from './insertMediaPlaceholder';
import type { EditorCommandGroup, EditorWidgetId } from './noteEditorPrefs';
import { COLUMN_LAYOUTS } from './richBlockConfig';
import { insertYouTubeEmbed } from './youtube';

export { insertEditorNode, type NoteEditorInstance } from './insertEditorNode';

export type { EditorCommandGroup } from './noteEditorPrefs';

export interface EditorCommand {
  description: string;
  focusEditor?: boolean;
  group: EditorCommandGroup;
  icon: IconName;
  id: string;
  keywords?: string[];
  label: string;
  run: (
    editor: NoteEditorInstance,
    dialogs?: NoteBlockDialogsApi | null
  ) => void;
  shortcut?: string;
  widget?: EditorWidgetId;
}

export function emptyParagraph() {
  return { children: [{ text: '' }], type: 'p' };
}

export function columnGroupFromWidths(widths: readonly string[]) {
  return {
    children: widths.map((width) => ({
      children: [emptyParagraph()],
      type: KEYS.column,
      width,
    })),
    type: KEYS.columnGroup,
  };
}

export function insertInlineEquation(
  editor: NoteEditorInstance,
  promptForExpression: (
    message: string,
    defaultValue: string
  ) => string | null = (message, defaultValue) =>
    window.prompt(message, defaultValue)
) {
  const selection = editor.selection;
  const initialExpression =
    selection && !editor.api.isCollapsed(selection)
      ? editor.api.string(selection)
      : '';
  const texExpression = promptForExpression(
    m.editor_latex_prompt(),
    initialExpression
  );

  if (texExpression == null) return;

  editor.tf.focus();
  editor.tf.insertNodes(
    {
      children: [{ text: '' }],
      texExpression,
      type: KEYS.inlineEquation,
    },
    selection ? { at: selection, select: true } : { select: true }
  );
}

function blockCommand(
  id: string,
  label: () => string,
  type: string,
  icon: IconName,
  group: EditorCommandGroup,
  keywords: string[] = [],
  shortcut?: string
) {
  return {
    get description() {
      return m.editor_cmd_turn_into({ label: label() });
    },
    group,
    icon,
    id,
    keywords,
    get label() {
      return label();
    },
    run: (editor: NoteEditorInstance) => {
      editor.tf.focus();
      toggleEditorBlock(editor, type);
    },
    shortcut,
  } satisfies EditorCommand;
}

function listCommand(
  id: string,
  label: () => string,
  listStyleType: string,
  icon: IconName,
  keywords: string[] = []
) {
  return {
    get description() {
      return m.editor_cmd_create_indented({ label: label() });
    },
    group: 'blockDecorations',
    icon,
    id,
    keywords,
    get label() {
      return label();
    },
    run: (editor: NoteEditorInstance) => {
      editor.tf.focus();
      toggleList(editor, { listStyleType });
    },
  } satisfies EditorCommand;
}

function columnCommand(
  id: string,
  label: () => string,
  widths: readonly string[],
  icon: IconName,
  keywords: string[] = []
) {
  return {
    get description() {
      return m.editor_cmd_insert({ label: label() });
    },
    group: 'blockElements',
    icon,
    id,
    keywords,
    get label() {
      return label();
    },
    run: (editor: NoteEditorInstance) =>
      insertEditorNode(editor, columnGroupFromWidths(widths)),
    widget: 'columns',
  } satisfies EditorCommand;
}

export const EDITOR_COMMANDS: EditorCommand[] = [
  blockCommand(
    'paragraph',
    () => m.editor_block_text(),
    'p',
    'paragraph',
    'general',
    ['paragraph', 'plain']
  ),
  blockCommand(
    'heading-1',
    () => m.editor_heading_1(),
    'h1',
    'heading1',
    'general',
    ['title', 'h1'],
    'Ctrl/Cmd+Alt+1'
  ),
  blockCommand(
    'heading-2',
    () => m.editor_heading_2(),
    'h2',
    'heading2',
    'general',
    ['subtitle', 'h2'],
    'Ctrl/Cmd+Alt+2'
  ),
  blockCommand(
    'heading-3',
    () => m.editor_heading_3(),
    'h3',
    'heading3',
    'general',
    ['section', 'h3'],
    'Ctrl/Cmd+Alt+3'
  ),
  blockCommand(
    'heading-4',
    () => m.editor_heading_4(),
    'h4',
    'heading1',
    'general',
    ['h4']
  ),
  blockCommand(
    'heading-5',
    () => m.editor_heading_5(),
    'h5',
    'heading2',
    'general',
    ['h5']
  ),
  blockCommand(
    'heading-6',
    () => m.editor_heading_6(),
    'h6',
    'heading3',
    'general',
    ['h6']
  ),
  blockCommand(
    'quote',
    () => m.editor_blockquote(),
    'blockquote',
    'quote',
    'general',
    ['quote', 'citation'],
    'Ctrl/Cmd+Shift+.'
  ),
  blockCommand(
    'code-block',
    () => m.editor_code_block(),
    'code_block',
    'braces',
    'general',
    ['code', 'pre'],
    'Ctrl/Cmd+Alt+8'
  ),
  {
    get description() {
      return m.editor_cmd_divider();
    },
    group: 'general',
    icon: 'minus',
    id: 'divider',
    get label() {
      return m.editor_divider();
    },
    run: (editor) =>
      insertEditorNode(editor, { children: [{ text: '' }], type: KEYS.hr }),
  },
  listCommand(
    'bulleted-list',
    () => m.editor_bulleted_list(),
    ListStyleType.Disc,
    'list',
    ['unordered', 'ul', 'bullet']
  ),
  listCommand(
    'numbered-list',
    () => m.editor_numbered_list(),
    ListStyleType.Decimal,
    'listOrdered',
    ['ordered', 'ol', 'number']
  ),
  listCommand('task-list', () => m.editor_task_list(), KEYS.listTodo, 'todo', [
    'todo',
    'checklist',
  ]),
  {
    get description() {
      return m.editor_cmd_table();
    },
    group: 'blockElements',
    icon: 'table',
    id: 'table',
    get label() {
      return m.editor_table();
    },
    run: (editor) =>
      insertEditorNode(editor, {
        children: [0, 1].map(() => ({
          children: [0, 1].map(() => ({
            children: [emptyParagraph()],
            type: KEYS.td,
          })),
          type: KEYS.tr,
        })),
        type: KEYS.table,
      }),
    widget: 'table',
  },
  {
    get description() {
      return m.editor_cmd_callout();
    },
    group: 'blockElements',
    icon: 'info',
    id: 'callout',
    get label() {
      return m.editor_callout();
    },
    run: (editor) =>
      insertEditorNode(editor, {
        children: [emptyParagraph()],
        type: KEYS.callout,
        variant: 'info',
      }),
    widget: 'callout',
  },
  ...COLUMN_LAYOUTS.map((layout) =>
    columnCommand(
      layout.value === 'equal-2' ? 'columns' : `columns-${layout.value}`,
      layout.value === 'equal-2'
        ? () => m.editor_two_columns()
        : () => layout.label,
      layout.widths,
      layout.value === 'equal-3'
        ? 'columns3'
        : layout.value === 'left-wide'
          ? 'panelRight'
          : layout.value === 'right-wide'
            ? 'panelLeft'
            : 'columns2',
      ['columns', 'layout']
    )
  ),
  {
    get description() {
      return m.editor_cmd_image();
    },
    group: 'fileOperations',
    icon: 'image',
    id: 'image',
    get label() {
      return m.editor_image();
    },
    run: (editor) => insertMediaPlaceholder(editor, 'img'),
    widget: 'media',
  },
  {
    get description() {
      return m.editor_cmd_youtube();
    },
    group: 'fileOperations',
    icon: 'externalLink',
    id: 'youtube',
    get label() {
      return m.editor_youtube_embed();
    },
    run: (editor, dialogs) =>
      dialogs?.openYouTube(undefined, (videoId) => {
        insertYouTubeEmbed(editor, videoId);
      }),
    widget: 'media',
  },
  {
    get description() {
      return m.editor_cmd_audio();
    },
    group: 'fileOperations',
    icon: 'fileAudio',
    id: 'audio',
    get label() {
      return m.editor_audio();
    },
    run: (editor) => insertMediaPlaceholder(editor, 'audio'),
    widget: 'media',
  },
  {
    get description() {
      return m.editor_cmd_file();
    },
    group: 'fileOperations',
    icon: 'fileText',
    id: 'file',
    get label() {
      return m.editor_file();
    },
    run: (editor) => insertMediaPlaceholder(editor, 'file'),
    widget: 'media',
  },
  {
    get description() {
      return m.editor_cmd_mention();
    },
    focusEditor: false,
    group: 'inlineElements',
    icon: 'at',
    id: 'mention',
    keywords: ['user', '@'],
    get label() {
      return m.editor_mention();
    },
    // Use the trigger path (same as typing `@`). Inserting mention_input via
    // insertEditorNode focuses the editor and immediately blur-cancels to `@`.
    run: (editor) => {
      editor.tf.insertText('@');
    },
  },
  {
    get description() {
      return m.editor_cmd_equation();
    },
    group: 'blockElements',
    icon: 'sigma',
    id: 'equation',
    get label() {
      return m.editor_equation();
    },
    run: (editor) =>
      insertEditorNode(editor, {
        children: [{ text: '' }],
        texExpression: '',
        type: KEYS.equation,
      }),
    widget: 'math',
  },
  {
    get description() {
      return m.editor_cmd_inline_equation();
    },
    group: 'inlineElements',
    icon: 'sigma',
    id: 'inline-equation',
    get label() {
      return m.editor_inline_equation();
    },
    run: (editor) => insertInlineEquation(editor),
    widget: 'math',
  },
  {
    get description() {
      return m.editor_cmd_toc();
    },
    group: 'blockElements',
    icon: 'list',
    id: 'toc',
    keywords: ['toc', 'outline'],
    get label() {
      return m.toc_title();
    },
    run: (editor) =>
      insertEditorNode(editor, { children: [{ text: '' }], type: KEYS.toc }),
    widget: 'toc',
  },
  {
    get description() {
      return m.editor_cmd_quiz();
    },
    group: 'blockElements',
    icon: 'warning',
    id: 'quiz',
    get label() {
      return m.editor_quiz();
    },
    run: (editor, dialogs) => {
      if (insideContainer(editor)) return;
      dialogs?.openQuiz(undefined, (code) => {
        void dialogs.insertEmbedded(editor, 'quiz', code);
      });
    },
    widget: 'quiz',
  },
  {
    get description() {
      return m.editor_cmd_flashcards();
    },
    group: 'blockElements',
    icon: 'todo',
    id: 'flashcards',
    get label() {
      return m.editor_flashcards();
    },
    run: (editor, dialogs) => {
      if (insideContainer(editor)) return;
      dialogs?.openFlashcards(undefined, (code) => {
        void dialogs.insertEmbedded(editor, 'flashcards', code);
      });
    },
    widget: 'flashcards',
  },
  {
    get description() {
      return m.editor_cmd_mermaid();
    },
    group: 'blockElements',
    icon: 'braces',
    id: 'mermaid',
    keywords: ['diagram', 'flowchart'],
    get label() {
      return m.editor_mermaid();
    },
    run: (editor) => {
      if (insideContainer(editor)) return;
      insertEditorNode(
        editor,
        customBlockNode('mermaid', 'flowchart LR\n  A --> B')
      );
    },
    widget: 'mermaid',
  },
];

/** Study blocks and diagrams live at the top level only. With the caret
 * inside a callout, column, table or other container the insert commands do
 * nothing. */
export function insideContainer(editor: NoteEditorInstance): boolean {
  const block = editor.api.block();
  return !!block && block[1].length > 1;
}

export function commandMatches(command: EditorCommand, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  return [command.label, command.description, ...(command.keywords ?? [])].some(
    (value) => value.toLowerCase().includes(normalized)
  );
}
