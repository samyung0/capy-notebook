/* Static (non-React) plugin registry for read-only material previews.
   Mirrors MaterialKit's node schema using Plate's Base* plugin variants so
   PlateStatic can render (and markdown can deserialize) without pulling in
   the editing machinery. Keep node types/keys in sync with notes/plugins.ts. */
import {
  BaseBlockquotePlugin,
  BaseBoldPlugin,
  BaseCodePlugin,
  BaseH1Plugin,
  BaseH2Plugin,
  BaseH3Plugin,
  BaseH4Plugin,
  BaseH5Plugin,
  BaseH6Plugin,
  BaseHighlightPlugin,
  BaseHorizontalRulePlugin,
  BaseItalicPlugin,
  BaseKbdPlugin,
  BaseStrikethroughPlugin,
  BaseSubscriptPlugin,
  BaseSuperscriptPlugin,
  BaseUnderlinePlugin,
} from '@platejs/basic-nodes';
import {
  BaseFontBackgroundColorPlugin,
  BaseFontColorPlugin,
  BaseFontFamilyPlugin,
  BaseFontSizePlugin,
  BaseTextAlignPlugin,
} from '@platejs/basic-styles';
import { BaseCalloutPlugin } from '@platejs/callout';
import {
  BaseCodeBlockPlugin,
  BaseCodeLinePlugin,
  BaseCodeSyntaxPlugin,
} from '@platejs/code-block';
import { BaseIndentPlugin } from '@platejs/indent';
import { BaseColumnItemPlugin, BaseColumnPlugin } from '@platejs/layout';
import { BaseLinkPlugin } from '@platejs/link';
import { BaseListPlugin, isOrderedList } from '@platejs/list';
import {
  BaseAudioPlugin,
  BaseFilePlugin,
  BaseImagePlugin,
} from '@platejs/media';
import { BaseMentionPlugin } from '@platejs/mention';
import {
  BaseTableCellHeaderPlugin,
  BaseTableCellPlugin,
  BaseTablePlugin,
  BaseTableRowPlugin,
} from '@platejs/table';
import { BaseTocPlugin } from '@platejs/toc';
import { common, createLowlight } from 'lowlight';
import { BaseParagraphPlugin, createSlatePlugin, KEYS } from 'platejs';
import { createElement } from 'react';
import { noteMarkdownPlugin } from '@/features/notes/markdown';

// Plugin-derived types are intentionally wider than Plate's base tuple.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyPlugin = any;

const lowlight = createLowlight(common);
// Keep preview behavior aligned with the editor: code blocks are not list items.
const listTargets = [...KEYS.heading, KEYS.p, KEYS.blockquote, KEYS.img];

/** Persisted custom study-block node types (quiz / flashcards / mermaid trees). */
const CUSTOM_BLOCK_TYPES = [
  'quiz',
  'quiz_question',
  'quiz_prompt',
  'quiz_option',
  'quiz_explanation',
  'flashcards',
  'flashcard',
  'flashcard_front',
  'flashcard_back',
  'mermaid',
  'mermaid_caption',
] as const;

const staticCustomBlockPlugins = CUSTOM_BLOCK_TYPES.map((type) =>
  createSlatePlugin({ key: type, node: { isElement: true, type } })
);

/* Equation node schema, declared locally instead of importing from
   @platejs/math: that package's root entry statically imports the whole KaTeX
   library, which would defeat the lazy KaTeX loading in the preview chunk. */
const StaticEquationPlugin = createSlatePlugin({
  key: KEYS.equation,
  node: { isElement: true, isVoid: true },
});
const StaticInlineEquationPlugin = createSlatePlugin({
  key: KEYS.inlineEquation,
  node: { isElement: true, isInline: true, isVoid: true },
});
const StaticYouTubePlugin = createSlatePlugin({
  key: 'video',
  node: { isElement: true, type: 'video' },
});

/* List rendering parity with the editable surface (see notes/plugins.ts):
   bullet items get list-item display via injected props, task items get a
   read-only checkbox, and ordered items get an <ol><li> wrapper below the node.
   All of this is plain render logic and static-safe. */
const StaticListKit: AnyPlugin[] = [
  BaseIndentPlugin.configure({
    inject: { targetPlugins: listTargets },
    options: { offset: 24 },
  }),
  BaseListPlugin.configure({
    inject: {
      nodeProps: {
        nodeKey: KEYS.listType,
        query: ({ nodeProps }: AnyPlugin) => {
          const element = nodeProps.element;
          return (
            Boolean(element?.listStyleType) &&
            !!element &&
            !isOrderedList(element)
          );
        },
        transformProps: ({ props }: AnyPlugin) => ({
          ...props,
          role: 'listitem',
          style: { ...props.style, display: 'list-item' },
        }),
      },
      targetPlugins: listTargets,
    },
    render: {
      belowNodes: ((props: AnyPlugin) => {
        if (
          !listTargets.includes(props.element.type) ||
          !props.element.listStyleType
        )
          return;

        if (props.element.listStyleType === KEYS.listTodo) {
          return (nextProps: AnyPlugin) => {
            const element = nextProps.element as {
              checked?: boolean;
              indent?: number;
            };
            return createElement(
              'div',
              {
                className: 'relative my-1 flex items-start gap-2',
                style: {
                  marginLeft: element.indent
                    ? `${element.indent * 24}px`
                    : undefined,
                },
              },
              createElement('input', {
                'aria-label': element.checked
                  ? 'Completed task'
                  : 'Incomplete task',
                checked: Boolean(element.checked),
                className:
                  'mt-2 size-4 shrink-0 rounded border-line-strong accent-action-accent',
                disabled: true,
                readOnly: true,
                type: 'checkbox',
              }),
              createElement(
                'div',
                {
                  className: element.checked
                    ? 'min-w-0 flex-1 text-fg-muted line-through'
                    : 'min-w-0 flex-1',
                },
                nextProps.children
              )
            );
          };
        }

        if (!isOrderedList(props.element)) return;

        return (nextProps: AnyPlugin) => {
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
      }) as AnyPlugin,
    },
  }),
];

/** Read-only material document plugins: schema + rendering + markdown import. */
export const StaticMaterialKit: AnyPlugin[] = [
  BaseParagraphPlugin,
  BaseH1Plugin,
  BaseH2Plugin,
  BaseH3Plugin,
  BaseH4Plugin,
  BaseH5Plugin,
  BaseH6Plugin,
  BaseBlockquotePlugin,
  BaseHorizontalRulePlugin,
  BaseBoldPlugin,
  BaseItalicPlugin,
  BaseUnderlinePlugin,
  BaseCodePlugin,
  BaseStrikethroughPlugin,
  BaseSubscriptPlugin,
  BaseSuperscriptPlugin,
  BaseHighlightPlugin,
  BaseKbdPlugin,
  ...StaticListKit,
  BaseLinkPlugin,
  BaseCodeBlockPlugin.configure({ options: { lowlight } }),
  BaseCodeLinePlugin,
  BaseCodeSyntaxPlugin,
  BaseTablePlugin,
  BaseTableRowPlugin,
  BaseTableCellPlugin,
  BaseTableCellHeaderPlugin,
  BaseTocPlugin,
  BaseImagePlugin,
  StaticYouTubePlugin,
  BaseAudioPlugin,
  BaseFilePlugin,
  BaseCalloutPlugin,
  BaseColumnPlugin,
  BaseColumnItemPlugin,
  StaticInlineEquationPlugin,
  StaticEquationPlugin,
  BaseMentionPlugin,
  BaseFontColorPlugin,
  BaseFontBackgroundColorPlugin,
  BaseFontSizePlugin,
  BaseFontFamilyPlugin.configure({ inject: { targetPlugins: [KEYS.p] } }),
  BaseTextAlignPlugin.configure({
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
  ...staticCustomBlockPlugins,
  noteMarkdownPlugin,
];
