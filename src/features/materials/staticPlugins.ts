/* Static (non-React) plugin registry for read-only material previews.
   Mirrors MaterialKit's node schema using Plate's Base* plugin variants so
   PlateStatic can render without pulling in the editing machinery. Markdown
   import adds noteMarkdownPlugin on top (notes/markdownConvert.ts), so the
   renderer itself never loads the parser. Keep node types/keys in sync with
   notes/plugins.ts. */
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
import { BaseAudioPlugin, BaseImagePlugin } from '@platejs/media';
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
import {
  FONT_SIZE_NODE_PROPS,
  INDENT_NODE_PROPS,
  STYLE_MARK_NODE_PROPS,
} from '@/features/notes/nodeStyles';
import { isStyleValue } from './document';
import { UnsupportedBlockNotice } from './UnsupportedBlock';

// Plugin-derived types are intentionally wider than Plate's base tuple.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyPlugin = any;

const lowlight = createLowlight(common);
// Keep preview behavior aligned with the editor: code blocks are not list items.
const listTargets = [...KEYS.heading, KEYS.p, KEYS.blockquote, KEYS.img];

/** Persisted custom block node types (study blocks, diagrams, interactives). */
const CUSTOM_BLOCK_TYPES = [
  'chart',
  'plot',
  'graph',
  'quiz',
  'quiz_question',
  'flashcards',
  'flashcard',
  'flashcard_front',
  'flashcard_back',
  'mermaid',
  'mermaid_caption',
  'html_embed',
] as const;

const staticCustomBlockPlugins = [
  ...CUSTOM_BLOCK_TYPES.map((type) =>
    createSlatePlugin({
      key: type,
      node: {
        isElement: true,
        isVoid:
          type === 'quiz_question' ||
          type === 'chart' ||
          type === 'plot' ||
          type === 'graph' ||
          type === 'html_embed',
        type,
      },
    })
  ),
  createSlatePlugin({
    key: 'material_ref',
    node: { isElement: true, isVoid: true, type: 'material_ref' },
  }),
];

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
  node: { isElement: true, isVoid: true, type: 'video' },
});
/* The editor's transient elements (an upload in progress, a slash command
   being typed) can sit in a saved document; a read draws nothing for them. */
const StaticTransientPlugins = [
  createSlatePlugin({
    key: 'placeholder',
    node: { isElement: true, isVoid: true, type: 'placeholder' },
  }),
  createSlatePlugin({
    key: 'slash_input',
    node: {
      isElement: true,
      isInline: true,
      isVoid: true,
      type: 'slash_input',
    },
  }),
];
/** A notice under any element the embed catalog does not list. */
const UnsupportedBlockPlugin = createSlatePlugin({
  key: 'unsupportedBlock',
  render: { belowRootNodes: UnsupportedBlockNotice },
});

/* List rendering parity with the editable surface (see notes/plugins.ts):
   bullet items get list-item display via injected props, task items get a
   read-only checkbox, and ordered items get an <ol><li> wrapper below the node.
   All of this is plain render logic and static-safe. */
const StaticListKit: AnyPlugin[] = [
  BaseIndentPlugin.configure({
    inject: { nodeProps: INDENT_NODE_PROPS, targetPlugins: listTargets },
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
            };
            return createElement(
              'div',
              {
                className: 'relative',
              },
              createElement('input', {
                'aria-label': element.checked
                  ? 'Completed task'
                  : 'Incomplete task',
                checked: Boolean(element.checked),
                className:
                  'absolute -left-6 mt-[calc((1lh-1rem)/2)] size-4 rounded border-line-strong accent-action-accent [font:inherit]',
                disabled: true,
                readOnly: true,
                type: 'checkbox',
              }),
              createElement(
                'div',
                {
                  className: element.checked
                    ? 'min-w-0 text-fg-muted line-through'
                    : 'min-w-0',
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
              // No margin: the paragraph's list padding spaces items, as for bullets.
              className: 'relative m-0 ml-6 p-0',
              start: element.listStart,
              style: {
                listStyleType: isStyleValue(element.listStyleType)
                  ? element.listStyleType
                  : undefined,
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

/** Read-only material document plugins: schema + rendering. */
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
  ...StaticTransientPlugins,
  UnsupportedBlockPlugin,
  BaseAudioPlugin,
  BaseCalloutPlugin,
  BaseColumnPlugin,
  BaseColumnItemPlugin,
  StaticInlineEquationPlugin,
  StaticEquationPlugin,
  BaseMentionPlugin,
  // Text marks: an element carrying one is refused, and none is drawn.
  BaseFontColorPlugin.configure({
    inject: { isLeaf: true, nodeProps: STYLE_MARK_NODE_PROPS },
  }),
  BaseFontBackgroundColorPlugin.configure({
    inject: { isLeaf: true, nodeProps: STYLE_MARK_NODE_PROPS },
  }),
  BaseFontSizePlugin.configure({
    inject: { isLeaf: true, nodeProps: FONT_SIZE_NODE_PROPS },
  }),
  BaseFontFamilyPlugin.configure({
    inject: { isLeaf: true, nodeProps: STYLE_MARK_NODE_PROPS },
  }),
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
];
