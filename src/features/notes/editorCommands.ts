import { ListStyleType, toggleList } from '@platejs/list';
import {
  Braces,
  CircleAlert,
  Columns2,
  Columns3,
  FileAudio,
  FileText,
  FileVideo,
  Heading1,
  Heading2,
  Heading3,
  Image,
  Info,
  List,
  ListChecks,
  ListOrdered,
  type LucideIcon,
  MessageSquarePlus,
  Minus,
  PanelLeft,
  PanelRight,
  Pilcrow,
  Quote,
  Sigma,
  Table2,
} from 'lucide-react';
import { KEYS } from 'platejs';
import type { NoteBlockDialogsApi } from './blocks/dialogContext';
import { customBlockNode } from './blocks/shared';
import { toggleEditorBlock } from './editorTransforms';
import { insertEditorNode, type NoteEditorInstance } from './insertEditorNode';
import { insertMediaPlaceholder } from './MediaNodes';
import type { WidgetGroupId } from './noteEditorPrefs';
import { COLUMN_LAYOUTS } from './richBlockConfig';

export { insertEditorNode, type NoteEditorInstance } from './insertEditorNode';

export type EditorCommandGroup =
  | 'basic'
  | 'lists'
  | 'media'
  | 'advanced'
  | 'inline';

export interface EditorCommand {
  description: string;
  focusEditor?: boolean;
  group: EditorCommandGroup;
  icon: LucideIcon;
  id: string;
  keywords?: string[];
  label: string;
  run: (
    editor: NoteEditorInstance,
    dialogs?: NoteBlockDialogsApi | null
  ) => void;
  shortcut?: string;
  widget?: WidgetGroupId;
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

function blockCommand(
  id: string,
  label: string,
  type: string,
  icon: LucideIcon,
  group: EditorCommandGroup,
  keywords: string[] = [],
  shortcut?: string
) {
  return {
    description: `Turn the current block into ${label.toLowerCase()}`,
    group,
    icon,
    id,
    keywords,
    label,
    run: (editor: NoteEditorInstance) => {
      editor.tf.focus();
      toggleEditorBlock(editor, type);
    },
    shortcut,
  } satisfies EditorCommand;
}

function listCommand(
  id: string,
  label: string,
  listStyleType: string,
  icon: LucideIcon,
  keywords: string[] = []
) {
  return {
    description: `Create an indented ${label.toLowerCase()}`,
    group: 'lists',
    icon,
    id,
    keywords,
    label,
    run: (editor: NoteEditorInstance) => {
      editor.tf.focus();
      toggleList(editor, { listStyleType });
    },
  } satisfies EditorCommand;
}

function columnCommand(
  id: string,
  label: string,
  widths: readonly string[],
  icon: LucideIcon,
  keywords: string[] = []
) {
  return {
    description: `Insert ${label.toLowerCase()}`,
    group: 'advanced',
    icon,
    id,
    keywords,
    label,
    run: (editor: NoteEditorInstance) =>
      insertEditorNode(editor, columnGroupFromWidths(widths)),
    widget: 'columns',
  } satisfies EditorCommand;
}

export const EDITOR_COMMANDS: EditorCommand[] = [
  blockCommand('paragraph', 'Text', 'p', Pilcrow, 'basic', [
    'paragraph',
    'plain',
  ]),
  blockCommand(
    'heading-1',
    'Heading 1',
    'h1',
    Heading1,
    'basic',
    ['title', 'h1'],
    'Ctrl/Cmd+Alt+1'
  ),
  blockCommand(
    'heading-2',
    'Heading 2',
    'h2',
    Heading2,
    'basic',
    ['subtitle', 'h2'],
    'Ctrl/Cmd+Alt+2'
  ),
  blockCommand(
    'heading-3',
    'Heading 3',
    'h3',
    Heading3,
    'basic',
    ['section', 'h3'],
    'Ctrl/Cmd+Alt+3'
  ),
  blockCommand('heading-4', 'Heading 4', 'h4', Heading1, 'basic', ['h4']),
  blockCommand('heading-5', 'Heading 5', 'h5', Heading2, 'basic', ['h5']),
  blockCommand('heading-6', 'Heading 6', 'h6', Heading3, 'basic', ['h6']),
  blockCommand(
    'quote',
    'Blockquote',
    'blockquote',
    Quote,
    'basic',
    ['quote', 'citation'],
    'Ctrl/Cmd+Shift+.'
  ),
  blockCommand(
    'code-block',
    'Code block',
    'code_block',
    Braces,
    'basic',
    ['code', 'pre'],
    'Ctrl/Cmd+Alt+8'
  ),
  {
    description: 'Insert a horizontal divider',
    group: 'basic',
    icon: Minus,
    id: 'divider',
    label: 'Divider',
    run: (editor) =>
      insertEditorNode(editor, { children: [{ text: '' }], type: KEYS.hr }),
  },
  listCommand('bulleted-list', 'Bulleted list', ListStyleType.Disc, List, [
    'unordered',
    'ul',
    'bullet',
  ]),
  listCommand(
    'numbered-list',
    'Numbered list',
    ListStyleType.Decimal,
    ListOrdered,
    ['ordered', 'ol', 'number']
  ),
  listCommand('task-list', 'Task list', KEYS.listTodo, ListChecks, [
    'todo',
    'checklist',
  ]),
  {
    description: 'Insert a 2 × 2 table',
    group: 'advanced',
    icon: Table2,
    id: 'table',
    label: 'Table',
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
    description: 'Insert a highlighted note box',
    group: 'advanced',
    icon: Info,
    id: 'callout',
    label: 'Callout',
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
      layout.value === 'equal-2' ? 'Two columns' : layout.label,
      layout.widths,
      layout.value === 'equal-3'
        ? Columns3
        : layout.value === 'left-wide'
          ? PanelRight
          : layout.value === 'right-wide'
            ? PanelLeft
            : Columns2,
      ['columns', 'layout']
    )
  ),
  {
    description: 'Upload an image through workspace storage',
    group: 'media',
    icon: Image,
    id: 'image',
    label: 'Image',
    run: (editor) => insertMediaPlaceholder(editor, 'img'),
    widget: 'media',
  },
  {
    description: 'Upload a video through workspace storage',
    group: 'media',
    icon: FileVideo,
    id: 'video',
    label: 'Video',
    run: (editor) => insertMediaPlaceholder(editor, 'video'),
    widget: 'media',
  },
  {
    description: 'Upload audio through workspace storage',
    group: 'media',
    icon: FileAudio,
    id: 'audio',
    label: 'Audio',
    run: (editor) => insertMediaPlaceholder(editor, 'audio'),
    widget: 'media',
  },
  {
    description: 'Upload a document or attachment',
    group: 'media',
    icon: FileText,
    id: 'file',
    label: 'File',
    run: (editor) => insertMediaPlaceholder(editor, 'file'),
    widget: 'media',
  },
  {
    description: 'Mention a workspace member',
    focusEditor: false,
    group: 'inline',
    icon: MessageSquarePlus,
    id: 'mention',
    keywords: ['user', '@'],
    label: 'Mention',
    // Use the trigger path (same as typing `@`). Inserting mention_input via
    // insertEditorNode focuses the editor and immediately blur-cancels to `@`.
    run: (editor) => {
      editor.tf.insertText('@');
    },
  },
  {
    description: 'Insert a block equation',
    group: 'advanced',
    icon: Sigma,
    id: 'equation',
    label: 'Equation',
    run: (editor) =>
      insertEditorNode(editor, {
        children: [{ text: '' }],
        texExpression: '',
        type: KEYS.equation,
      }),
    widget: 'math',
  },
  {
    description: 'Insert an inline equation',
    group: 'inline',
    icon: Sigma,
    id: 'inline-equation',
    label: 'Inline equation',
    run: (editor) => {
      editor.tf.focus();
      editor.tf.insertNodes({
        children: [{ text: '' }],
        texExpression: '',
        type: KEYS.inlineEquation,
      });
    },
    widget: 'math',
  },
  {
    description: 'Insert a generated document outline',
    group: 'advanced',
    icon: List,
    id: 'toc',
    keywords: ['toc', 'outline'],
    label: 'Table of contents',
    run: (editor) =>
      insertEditorNode(editor, { children: [{ text: '' }], type: KEYS.toc }),
    widget: 'toc',
  },
  {
    description: 'Author an annotatable quiz block',
    group: 'advanced',
    icon: CircleAlert,
    id: 'quiz',
    label: 'Quiz',
    run: (editor, dialogs) =>
      dialogs?.openQuiz(undefined, (code) =>
        insertEditorNode(editor, customBlockNode('quiz', code))
      ),
    widget: 'quiz',
  },
  {
    description: 'Author an annotatable flashcard set',
    group: 'advanced',
    icon: ListChecks,
    id: 'flashcards',
    label: 'Flashcards',
    run: (editor, dialogs) =>
      dialogs?.openFlashcards(undefined, (code) =>
        insertEditorNode(editor, customBlockNode('flashcards', code))
      ),
    widget: 'flashcards',
  },
  {
    description: 'Insert a Mermaid diagram with a rich caption',
    group: 'advanced',
    icon: Braces,
    id: 'mermaid',
    keywords: ['diagram', 'flowchart'],
    label: 'Mermaid diagram',
    run: (editor) =>
      insertEditorNode(
        editor,
        customBlockNode('mermaid', 'flowchart LR\n  A --> B')
      ),
    widget: 'mermaid',
  },
];

export function commandMatches(command: EditorCommand, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  return [command.label, command.description, ...(command.keywords ?? [])].some(
    (value) => value.toLowerCase().includes(normalized)
  );
}
