import {
  BlockquoteRules,
  BoldRules,
  CodeRules,
  HeadingRules,
  HighlightRules,
  HorizontalRuleRules,
  ItalicRules,
  MarkComboRules,
  StrikethroughRules,
  SubscriptRules,
  SuperscriptRules,
  UnderlineRules,
} from '@platejs/basic-nodes';
import {
  BlockquotePlugin,
  BoldPlugin,
  CodePlugin,
  H1Plugin,
  H2Plugin,
  H3Plugin,
  H4Plugin,
  H5Plugin,
  H6Plugin,
  HighlightPlugin,
  HorizontalRulePlugin,
  ItalicPlugin,
  KbdPlugin,
  StrikethroughPlugin,
  SubscriptPlugin,
  SuperscriptPlugin,
  UnderlinePlugin,
} from '@platejs/basic-nodes/react';
import {
  FontBackgroundColorPlugin,
  FontColorPlugin,
  FontFamilyPlugin,
  FontSizePlugin,
  TextAlignPlugin,
} from '@platejs/basic-styles/react';
import { CalloutPlugin } from '@platejs/callout/react';
import { CaptionPlugin } from '@platejs/caption/react';
import { CodeBlockRules, toggleCodeBlock } from '@platejs/code-block';
import {
  CodeBlockPlugin,
  CodeLinePlugin,
  CodeSyntaxPlugin,
} from '@platejs/code-block/react';
import { DndPlugin } from '@platejs/dnd';
import { DocxPlugin } from '@platejs/docx';
import { IndentPlugin } from '@platejs/indent/react';
import { JuicePlugin } from '@platejs/juice';
import { ColumnItemPlugin, ColumnPlugin } from '@platejs/layout/react';
import { LinkRules } from '@platejs/link';
import { LinkPlugin } from '@platejs/link/react';
import {
  BulletedListRules,
  isOrderedList,
  OrderedListRules,
  TaskListRules,
} from '@platejs/list';
import {
  ListPlugin,
  useTodoListElement,
  useTodoListElementState,
} from '@platejs/list/react';
import { MathRules } from '@platejs/math';
import { EquationPlugin, InlineEquationPlugin } from '@platejs/math/react';
import {
  AudioPlugin,
  FilePlugin,
  ImagePlugin,
  PlaceholderPlugin,
} from '@platejs/media/react';
import { MentionInputPlugin, MentionPlugin } from '@platejs/mention/react';
import {
  BlockMenuPlugin,
  BlockSelectionPlugin,
  CursorOverlayPlugin,
} from '@platejs/selection/react';
import { SlashInputPlugin, SlashPlugin } from '@platejs/slash-command/react';
import {
  TableCellHeaderPlugin,
  TableCellPlugin,
  TablePlugin,
  TableRowPlugin,
} from '@platejs/table/react';
import { TocPlugin } from '@platejs/toc/react';
import { common, createLowlight } from 'lowlight';
import {
  createSlatePlugin,
  createTextSubstitutionInputRule,
  ExitBreakPlugin,
  isHotkey,
  KEYS,
  type SlateEditor,
  type TElement,
} from 'platejs';
import {
  BlockPlaceholderPlugin,
  createPlatePlugin,
  ParagraphPlugin,
  type RenderNodeWrapper,
} from 'platejs/react';
import { createElement } from 'react';
import { DndProvider } from 'react-dnd';
import { HTML5Backend } from 'react-dnd-html5-backend';
import { YouTubeEmbedElement } from '@/features/materials/YouTubeEmbed';
import { openAiMenu } from './ai/aiMenuState';
import { buildAiPlugins } from './ai/aiPlugins';
import { BlockContextMenu, BlockDraggable } from './BlockInteractions';
import {
  BlockSelectionBelowRootNodes,
  EditorCursorOverlay,
} from './BlockSelection';
import { customBlockPlugins } from './blocks/plugins';
import type { EditorCollaborationOptions } from './Collaboration';
import {
  buildCollaborationPlugins,
  collaborationTrailingBlockPlugin,
} from './collaborationPlugins';
import {
  canCreateExternalEditorAssets,
  type NoteEditorMode,
} from './editorMode';
import { LinkFloatingToolbar } from './LinkFloatingToolbar';
import { MediaPlaceholderElement } from './MediaNodes';
import { MentionInputElement } from './MentionInput';
import { noteMarkdownPlugin } from './markdown';
import { remoteCursorDecorationPlugin } from './RemoteCursors';
import { SlashInputElement } from './SlashInput';
import { stableElementIdsPlugin } from './stableElementIds';

// Plugin-derived editor types are intentionally wider than Plate's base tuple.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyPlugin = any;

// `common` (~35 languages) instead of `all`: the full highlight.js language set
// is roughly a megabyte of grammars that almost no document uses.
const lowlight = createLowlight(common);
// Code blocks deliberately break out of lists instead of becoming list items.
const listTargets = [...KEYS.heading, KEYS.p, KEYS.blockquote, KEYS.img];
const codeBlockListProps = [
  'listStyleType',
  'indent',
  'checked',
  'listStart',
  'listRestart',
  'listRestartPolite',
];

function TodoListItem({
  element,
  children,
}: {
  element: TElement & { checked?: boolean; indent?: number };
  children: React.ReactNode;
}) {
  const state = useTodoListElementState({ element });
  const { checkboxProps } = useTodoListElement(state);

  return createElement(
    'div',
    {
      className: 'relative my-1 flex items-start gap-2',
      style: {
        marginLeft: element.indent ? `${element.indent * 24}px` : undefined,
      },
    },
    createElement('input', {
      'aria-label': checkboxProps.checked
        ? 'Mark task incomplete'
        : 'Mark task complete',
      checked: checkboxProps.checked,
      className:
        'mt-2 size-4 shrink-0 cursor-pointer rounded border-line-strong accent-action-accent',
      contentEditable: false,
      disabled: state.readOnly,
      onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
        checkboxProps.onCheckedChange(event.target.checked),
      onMouseDown: checkboxProps.onMouseDown,
      type: 'checkbox',
    }),
    createElement(
      'div',
      {
        className: checkboxProps.checked
          ? 'min-w-0 flex-1 text-fg-muted line-through'
          : 'min-w-0 flex-1',
      },
      children
    )
  );
}

const IndentListKit = [
  IndentPlugin.configure({
    inject: { targetPlugins: listTargets },
    options: { offset: 24 },
  }),
  ListPlugin.configure({
    inject: {
      nodeProps: {
        nodeKey: KEYS.listType,
        query: ({ nodeProps }) => {
          const element = nodeProps.element;
          return (
            Boolean(element?.listStyleType) &&
            !!element &&
            !isOrderedList(element)
          );
        },
        transformProps: ({ props }) => ({
          ...props,
          role: 'listitem',
          style: { ...props.style, display: 'list-item' },
        }),
      },
      targetPlugins: listTargets,
    },
    inputRules: [
      BulletedListRules.markdown({ variant: '-' }),
      BulletedListRules.markdown({ variant: '*' }),
      OrderedListRules.markdown({ variant: '.' }),
      OrderedListRules.markdown({ variant: ')' }),
      TaskListRules.markdown({ checked: false }),
      TaskListRules.markdown({ checked: true }),
    ],
    render: {
      belowNodes: ((props) => {
        if (
          !listTargets.includes(props.element.type) ||
          !props.element.listStyleType
        )
          return;

        if (props.element.listStyleType === KEYS.listTodo) {
          return (nextProps) =>
            createElement(TodoListItem, {
              // biome-ignore lint/correctness/noChildrenProp: This .ts plugin must use createElement instead of JSX.
              children: nextProps.children,
              element: nextProps.element,
            });
        }

        if (!isOrderedList(props.element)) return;

        return (nextProps) => {
          const element = nextProps.element as {
            indent?: number;
            listStart?: number;
            listStyleType?: string;
          };
          return createElement(
            'ol',
            {
              className: 'relative my-1 ml-6 p-0',
              start: element.listStart,
              style: {
                listStyleType: element.listStyleType,
                marginLeft: element.indent
                  ? `${element.indent * 24}px`
                  : undefined,
              },
            },
            createElement('li', null, nextProps.children)
          );
        };
      }) as RenderNodeWrapper,
    },
  }),
];

const CodeBlockListCleanupPlugin = createSlatePlugin({
  key: 'evo-code-block-list-cleanup',
}).overrideEditor(({ editor, tf: { normalizeNode } }) => ({
  transforms: {
    normalizeNode([node, path]) {
      // toggleBlock can preserve list props while changing a list paragraph to
      // a code block. Remove them before the list plugin can render markers.
      if (
        'type' in node &&
        node.type === editor.getType(KEYS.codeBlock) &&
        codeBlockListProps.some((key) => key in node)
      ) {
        editor.tf.unsetNodes(codeBlockListProps, { at: path });
        return;
      }

      normalizeNode([node, path]);
    },
  },
}));

const BasicBlocksKit = [
  ParagraphPlugin,
  H1Plugin.configure({
    inputRules: [HeadingRules.markdown()],
    rules: { break: { empty: 'reset' } },
    shortcuts: { toggle: { keys: 'mod+alt+1' } },
  }),
  H2Plugin.configure({
    inputRules: [HeadingRules.markdown()],
    rules: { break: { empty: 'reset' } },
    shortcuts: { toggle: { keys: 'mod+alt+2' } },
  }),
  H3Plugin.configure({
    inputRules: [HeadingRules.markdown()],
    rules: { break: { empty: 'reset' } },
    shortcuts: { toggle: { keys: 'mod+alt+3' } },
  }),
  H4Plugin.configure({ inputRules: [HeadingRules.markdown()] }),
  H5Plugin.configure({ inputRules: [HeadingRules.markdown()] }),
  H6Plugin.configure({ inputRules: [HeadingRules.markdown()] }),
  BlockquotePlugin.configure({
    inputRules: [BlockquoteRules.markdown()],
    shortcuts: { toggle: { keys: 'mod+shift+period' } },
  }),
  HorizontalRulePlugin.configure({
    inputRules: [
      HorizontalRuleRules.markdown({ variant: '-' }),
      HorizontalRuleRules.markdown({ variant: '_' }),
    ],
  }),
];

const BasicMarksKit = [
  BoldPlugin.configure({
    inputRules: [
      BoldRules.markdown({ variant: '*' }),
      BoldRules.markdown({ variant: '_' }),
      MarkComboRules.markdown({ variant: 'boldItalic' }),
      MarkComboRules.markdown({ variant: 'boldUnderline' }),
      MarkComboRules.markdown({ variant: 'boldItalicUnderline' }),
      MarkComboRules.markdown({ variant: 'italicUnderline' }),
    ],
  }),
  ItalicPlugin.configure({
    inputRules: [
      ItalicRules.markdown({ variant: '*' }),
      ItalicRules.markdown({ variant: '_' }),
    ],
  }),
  UnderlinePlugin.configure({ inputRules: [UnderlineRules.markdown()] }),
  CodePlugin.configure({
    inputRules: [CodeRules.markdown()],
    shortcuts: { toggle: { keys: 'mod+e' } },
  }),
  StrikethroughPlugin.configure({
    inputRules: [StrikethroughRules.markdown()],
    shortcuts: { toggle: { keys: 'mod+shift+x' } },
  }),
  SubscriptPlugin.configure({
    inputRules: [SubscriptRules.markdown()],
    shortcuts: { toggle: { keys: 'mod+comma' } },
  }),
  SuperscriptPlugin.configure({
    inputRules: [SuperscriptRules.markdown()],
    shortcuts: { toggle: { keys: 'mod+period' } },
  }),
  HighlightPlugin.configure({
    inputRules: [
      HighlightRules.markdown({ variant: '==' }),
      HighlightRules.markdown({ variant: '≡' }),
    ],
    shortcuts: { toggle: { keys: 'mod+shift+h' } },
  }),
  KbdPlugin,
];

const AutoformatPlugin = createSlatePlugin({
  inputRules: [
    createTextSubstitutionInputRule({
      enabled: ({ editor }) =>
        !editor.api.some({ match: { type: editor.getType(KEYS.codeBlock) } }),
      patterns: [
        { format: '→', match: '->' },
        { format: '←', match: '<-' },
        { format: '⇒', match: '=>' },
        { format: '≥', match: '>=' },
        { format: '≤', match: '<=' },
        { format: '≠', match: '!=' },
        { format: '≈', match: '~=' },
        { format: '½', match: '1/2' },
        { format: '⅓', match: '1/3' },
        { format: '¼', match: '1/4' },
        { format: '™', match: ['(tm)', '(TM)'] },
        { format: '®', match: ['(r)', '(R)'] },
        { format: '©', match: ['(c)', '(C)'] },
        { format: '±', match: '+-' },
        { format: ['“', '”'], match: '"' },
        { format: ['‘', '’'], match: "'" },
        { format: '²', match: '^2' },
        { format: '³', match: '^3' },
        { format: '₁', match: '~1' },
        { format: '₂', match: '~2' },
      ],
    }),
  ],
  key: 'evo-autoformat',
});

function createSaveShortcutPlugin(onSave: () => void) {
  return createPlatePlugin({
    key: 'evo-save-shortcut',
    shortcuts: {
      save: {
        handler: ({ event }) => {
          event.preventDefault();
          onSave();
          return true;
        },
        keys: 'mod+s',
      },
    },
  });
}

const SlashKit = [
  SlashPlugin.configure({
    options: {
      triggerQuery: (editor: SlateEditor) =>
        !editor.api.some({ match: { type: editor.getType(KEYS.codeBlock) } }),
    },
  }),
  SlashInputPlugin.withComponent(SlashInputElement),
];

const MediaKit = [
  ImagePlugin.configure({ options: { disableUploadInsert: true } }),
  createPlatePlugin({
    key: 'video',
    node: { isElement: true, type: 'video' },
  }).withComponent(YouTubeEmbedElement),
  AudioPlugin,
  FilePlugin,
  PlaceholderPlugin.configure({
    options: { disableEmptyPlaceholder: true },
    render: { node: MediaPlaceholderElement },
  }),
  CaptionPlugin.configure({
    options: {
      query: { allow: [KEYS.img, KEYS.video, KEYS.audio, KEYS.file] },
    },
  }),
];

function buildBlockInteractionKit(
  mode: NoteEditorMode,
  allowExternalAssets: boolean
) {
  return [
    BlockSelectionPlugin.configure(({ editor }) => ({
      options: {
        enableContextMenu: true,
        // Nested structures keep normal text selection; their top-level
        // ancestors (table, column_group, code_block) are block-selectable.
        isSelectable: (element, path) =>
          ![
            editor.getType(KEYS.column),
            editor.getType(KEYS.codeLine),
            editor.getType(KEYS.td),
          ].includes(element.type) &&
          !(
            path.length === 1 &&
            path[0] === editor.children.length - 1 &&
            editor.api.isEmpty(element)
          ),
        ...(allowExternalAssets && {
          onKeyDownSelecting: (
            keyEditor: SlateEditor,
            event: KeyboardEvent
          ) => {
            if (isHotkey('mod+j')(event)) openAiMenu(keyEditor);
          },
        }),
      },
      render: { belowRootNodes: BlockSelectionBelowRootNodes as AnyPlugin },
    })),
    BlockMenuPlugin.configure({ render: { aboveEditable: BlockContextMenu } }),
    DndPlugin.configure({
      options: {
        enableScroller: true,
        onDropFiles: ({ dragItem, editor, target }) => {
          if (!canCreateExternalEditorAssets(mode, allowExternalAssets)) return;
          return editor
            .getTransforms(PlaceholderPlugin)
            .insert.media(dragItem.files, {
              at: target,
              nextBlock: false,
            });
        },
      },
      render: {
        aboveNodes: BlockDraggable,
        aboveSlate: ({ children }) =>
          createElement(DndProvider, { backend: HTML5Backend }, children),
      },
    }),
  ];
}

/** Plugins needed by both interactive and static universal document surfaces. */
export const MaterialKit: AnyPlugin[] = [
  ...BasicBlocksKit,
  ...BasicMarksKit,
  ...IndentListKit,
  LinkPlugin.configure({
    inputRules: [
      LinkRules.markdown(),
      LinkRules.autolink({ variant: 'paste' }),
      LinkRules.autolink({ variant: 'space' }),
      LinkRules.autolink({ variant: 'break' }),
    ],
    render: {
      afterEditable: () => createElement(LinkFloatingToolbar),
    },
  }),
  CodeBlockPlugin.configure({
    inputRules: [CodeBlockRules.markdown({ on: 'match' })],
    options: { lowlight },
    shortcuts: {
      toggle: {
        handler: ({ editor }) => {
          toggleCodeBlock(editor);
          return true;
        },
        keys: 'mod+alt+8',
      },
    },
  }),
  CodeLinePlugin,
  CodeSyntaxPlugin,
  CodeBlockListCleanupPlugin,
  TablePlugin.configure({ options: { minColumnWidth: 48 } }),
  TableRowPlugin,
  TableCellPlugin,
  TableCellHeaderPlugin,
  TocPlugin,
  ...MediaKit,
  CalloutPlugin,
  ColumnPlugin,
  ColumnItemPlugin,
  InlineEquationPlugin.configure({
    inputRules: [MathRules.markdown({ variant: '$' })],
  }),
  EquationPlugin.configure({
    inputRules: [MathRules.markdown({ on: 'break', variant: '$$' })],
  }),
  MentionPlugin.configure({
    options: { triggerPreviousCharPattern: /^$|^[\s"']$/ },
  }),
  MentionInputPlugin.withComponent(MentionInputElement),
  FontColorPlugin,
  FontBackgroundColorPlugin,
  FontSizePlugin,
  FontFamilyPlugin.configure({ inject: { targetPlugins: [KEYS.p] } }),
  TextAlignPlugin.configure({
    inject: {
      nodeProps: {
        defaultNodeValue: 'start',
        nodeKey: 'align',
        styleKey: 'textAlign',
        validNodeValues: ['start', 'left', 'center', 'right', 'end', 'justify'],
      },
      targetPlugins: [...KEYS.heading, KEYS.p, KEYS.img],
    },
  }),
  ...customBlockPlugins,
  DocxPlugin,
  JuicePlugin,
  noteMarkdownPlugin,
];

export interface BuildPluginsOptions extends EditorCollaborationOptions {
  allowExternalAssets: boolean;
  mode: NoteEditorMode;
  onSave: () => void;
  workspaceId: string;
}
/** Full playground registry. Preferences filter commands only; no document
 * parser or renderer plugin is ever unloaded. */
export function buildPlugins(options: BuildPluginsOptions): AnyPlugin[] {
  return [
    ...(options.mode === 'edit' && options.allowExternalAssets
      ? buildAiPlugins(options.workspaceId)
      : // The AI plugin set registers its own CursorOverlay variant; non-AI
        // editors still need the overlay for selection feedback in dialogs.
        [
          CursorOverlayPlugin.configure({
            render: { afterEditable: EditorCursorOverlay },
          }),
        ]),
    stableElementIdsPlugin,
    remoteCursorDecorationPlugin,
    ...MaterialKit,
    ...buildCollaborationPlugins(options),
    ...(options.mode === 'edit'
      ? [
          ...SlashKit,
          AutoformatPlugin,
          createSaveShortcutPlugin(options.onSave),
          ...buildBlockInteractionKit(
            options.mode,
            options.allowExternalAssets
          ),
          ExitBreakPlugin.configure({
            shortcuts: {
              insert: { keys: 'mod+enter' },
              insertBefore: { keys: 'mod+shift+enter' },
            },
          }),
          collaborationTrailingBlockPlugin,
          BlockPlaceholderPlugin.configure({
            options: {
              className:
                'before:absolute before:cursor-text before:text-placeholder before:text-sm before:leading-[2] before:font-normal before:content-[attr(placeholder)]',
              placeholders: { [KEYS.p]: 'Type  /  for commands ...' },
              query: ({ path }) => path.length === 1,
            },
          }),
        ]
      : []),
  ];
}
