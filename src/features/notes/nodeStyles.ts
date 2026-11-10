/* Shared class names for note document nodes. Both the editable editor
 * components (nodeComponents.tsx) and the static preview components
 * (materials/staticNodeComponents.tsx) consume these so the two surfaces
 * cannot drift apart visually. */
import type { TElement, TText } from 'platejs';
import type { CSSProperties } from 'react';
import { isIndent, isStyleValue } from '@/features/materials/document';

/** Heading sizes shrink on narrow screens through `note-fs` (tailwind.css).
 * The Notion look (Epo 2026-11-10, mock N2), as the BlockSuite note draws it
 * (pageEditor.css): 30, 24 and 20px at 600 on a 1.3 line, with 32, 22 and 16px
 * above and a text block's own 3px above and below. */
export const HEADING_CLASS: Record<string, string> = {
  h1: 'mt-8 mb-1 py-[3px] note-fs [--note-fs:30] leading-[1.3] font-semibold text-fg',
  h2: 'mt-[22px] mb-px py-[3px] note-fs [--note-fs:24] leading-[1.3] font-semibold text-fg',
  h3: 'mt-4 mb-px py-[3px] note-fs [--note-fs:20] leading-[1.3] font-semibold text-fg',
  h4: 'mt-4 mb-px py-[3px] note-fs [--note-fs:18] leading-[1.3] font-semibold text-fg',
  h5: 'mt-4 mb-px py-[3px] text-base leading-[1.3] font-semibold text-fg',
  h6: 'mt-4 mb-px py-[3px] text-base leading-[1.3] font-semibold text-fg',
};

/** Plate draws a text mark (color, background, font size and family) into a
 * style only for a value the document check takes (`isStyleValue`). Shared by
 * the editor and static plugins. */
export const STYLE_MARK_NODE_PROPS = {
  query: ({
    nodeKey,
    nodeProps,
  }: {
    nodeKey?: string;
    nodeProps: { text?: TText };
  }) => nodeKey !== undefined && isStyleValue(nodeProps.text?.[nodeKey]),
};

/** Font size marks written in px render through `note-fs` like headings;
 * other units (pasted HTML) render as written. Shared by the editor and static
 * plugins. */
export const FONT_SIZE_NODE_PROPS = {
  ...STYLE_MARK_NODE_PROPS,
  nodeKey: 'fontSize',
  transformClassName: ({ nodeValue }: { nodeValue?: unknown }) =>
    pxFontSize(nodeValue) == null ? undefined : 'note-fs',
  transformStyle: ({ nodeValue }: { nodeValue?: unknown }) => {
    const px = pxFontSize(nodeValue);
    return (px == null
      ? { fontSize: nodeValue }
      : { '--note-fs': px }) as unknown as CSSStyleDeclaration;
  },
};

/** Plate draws a block's indent as a class and a margin: only for an indent
 * the document check takes (`isIndent`). Shared by the editor and static
 * plugins. */
export const INDENT_NODE_PROPS = {
  query: ({ nodeProps }: { nodeProps: { element?: TElement } }) =>
    isIndent(nodeProps.element?.indent),
};

const PX_FONT_SIZE = /^(\d+(?:\.\d+)?)px$/;

function pxFontSize(value: unknown) {
  const match = typeof value === 'string' && PX_FONT_SIZE.exec(value);
  return match ? Number(match[1]) : null;
}

/** List items are paragraphs too; they keep the tighter list rhythm. */
export const PARAGRAPH_CLASS =
  'py-(--note-p-py) px-0 leading-(--note-leading) text-fg [&[data-slate-list-style-type]]:py-(--note-li-py)';
export const BLOCKQUOTE_CLASS =
  'my-(--note-gap) border-l-[3px] border-fg py-[3px] pl-4 leading-(--note-leading) text-fg';
export const HR_CLASS = 'h-px border-none bg-divider bg-clip-content';
export const CODE_BLOCK_CLASS =
  'group/code relative overflow-auto rounded-button my-(--note-gap) bg-surface-hover-bg px-4 pt-6 pb-4 sm:p-6 sm:pr-4 text-sm [tab-size:2] print:break font-mono text-fg';
/** Lines grow with their text so the block's right padding survives scrolling. */
export const CODE_LINE_CLASS = 'w-max min-w-full';
export const LINK_CLASS = 'text-link underline underline-offset-2';

export const UL_CLASS = 'my-(--note-gap) ml-5 list-disc space-y-1';
export const OL_CLASS = 'my-(--note-gap) ml-5 list-decimal space-y-1';
export const LI_CLASS = 'text-fg';

/** Padding, not margin, around a table: its column pills straddle the top
 * border and its + bars sit right of the last column and under the last row,
 * all inside the scroll box (TableNodes.tsx). The static table keeps the same
 * box, so both scroll sideways at the same width. */
export const TABLE_WRAP_CLASS = 'mt-1 overflow-auto pt-2 pr-5 pb-5';
export const TABLE_CLASS = 'w-full border-collapse text-sm';
export const TD_CLASS =
  'h-12 border border-line px-2 py-1.5 align-top sm:px-3 sm:py-2';
export const TH_CLASS =
  'h-12 border border-line bg-surface-hover-bg px-2 py-1.5 text-left font-semibold sm:px-3 sm:py-2';

export const CALLOUT_CLASS =
  'group/callout relative my-(--note-gap) flex items-start gap-2 px-3 py-2 leading-(--note-leading) sm:gap-2.5 sm:px-3.5 sm:py-2.5';
export const COLUMN_GROUP_CLASS =
  'group/columns relative my-(--note-gap) flex size-full gap-2 flex-row';
export const COLUMN_CLASS =
  'group/column relative min-w-0 shrink rounded-button border border-transparent p-1.5 sm:p-2 w-(--column-width) basis-(--column-width)';

export const TOC_BOX_CLASS = 'my-3 rounded-md';
export const TOC_ITEM_CLASS =
  'w-full justify-start whitespace-normal rounded-none px-0 py-1 text-left text-base font-medium leading-normal underline active:scale-100';
export const TOC_EMPTY_CLASS = 'text-sm text-fg-muted';
export function tocItemIndent(headingType: string): CSSProperties {
  return {
    paddingLeft: `${8 + Math.max(0, Number(headingType.slice(1)) - 1) * 12}px`,
  };
}

export const MENTION_CLASS = 'font-bold text-tint-accent-1-fg';
/** Larger @, nudged up so its bottom meets the text baseline. */
export const MENTION_AT_CLASS = 'relative -top-px mr-0.5 text-[1.12em]';

export const EQUATION_BLOCK_CLASS =
  'my-1 overflow-auto rounded-sm p-1 text-center';

/* leaf marks */
export const CODE_MARK_CLASS =
  'rounded-none bg-code-inline px-1 py-0 font-mono text-[0.85em] text-code-inline-fg font-medium';
export const HIGHLIGHT_MARK_CLASS =
  'bg-highlight border-b border-highlight-line text-inherit';
export const KBD_MARK_CLASS =
  'rounded border border-kbd-line bg-kbd px-1.5 py-0.5 text-sm font-mono text-fg';
export const BOLD_MARK_CLASS = 'font-extrabold';
export const ITALIC_MARK_CLASS = 'italic';

/* custom study blocks */
export const BLOCK_SHELL_CLASS =
  'my-4 rounded-card border border-line bg-surface/40 p-3';
export const QUIZ_EXPLANATION_CLASS =
  'mt-2 border-t border-divider pt-2 text-sm text-fg-muted';
export const STUDY_BLOCK_LIST_CLASS = 'flex flex-col gap-4 my-3';
export const QUIZ_REVIEW_QUESTION_CLASS =
  'grid grid-cols-[auto_minmax(0,1fr)] gap-x-1 gap-y-1 rounded-card border border-line bg-surface p-4 pt-6';
export const QUIZ_REVIEW_PROMPT_CLASS = 't-subtitle min-w-0 text-fg mb-3';
export const FLASHCARD_CLASS =
  'grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-start gap-3 rounded-card border border-line bg-surface p-3 text-sm';
export const FLASHCARD_FRONT_CLASS = 'font-medium text-fg';
export const FLASHCARD_BACK_CLASS = 'text-fg-secondary';
/** Images, embeds and diagrams stop at the half-width column in full-width notes. */
export const MEDIA_MAX_WIDTH_CLASS = 'mx-auto max-w-3xl';
export const MEDIA_CAPTION_CLASS =
  'mx-auto mt-2 block max-w-full text-center text-fg-muted text-sm';
export const MERMAID_CAPTION_CLASS = 'mt-2 text-center text-sm text-fg-muted';
