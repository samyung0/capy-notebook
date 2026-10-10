/* Shared class names for note document nodes. Both the editable editor
 * components (nodeComponents.tsx) and the static preview components
 * (materials/staticNodeComponents.tsx) consume these so the two surfaces
 * cannot drift apart visually. */
import type { CSSProperties } from 'react';

/** Heading sizes shrink on narrow screens through `note-fs` (tailwind.css);
 * the line heights are Tailwind's text-4xl/2xl/xl/lg ratios. */
export const HEADING_CLASS: Record<string, string> = {
  h1: 'mt-[1.6em] mb-1 pb-1 note-fs [--note-fs:36] leading-[1.11] font-extrabold text-fg',
  h2: 'mt-[1.4em] mb-1 pb-px note-fs [--note-fs:24] leading-[1.33] font-bold text-fg',
  h3: 'mt-[1em] mb-1 pb-px note-fs [--note-fs:20] leading-[1.4] font-bold text-fg',
  h4: 'mt-[0.75em] mb-1 pb-px note-fs [--note-fs:18] leading-[1.56] font-semibold text-fg',
  h5: 'mt-[0.75em] mb-1 pb-px note-fs [--note-fs:18] leading-[1.56] font-semibold text-fg',
  h6: 'mt-[0.75em] mb-1 pb-px text-base font-semibold text-fg',
};

/** Font size marks written in px render through `note-fs` like headings;
 * other units (pasted HTML) render as written. Shared by the editor and static
 * plugins. */
export const FONT_SIZE_NODE_PROPS = {
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

const PX_FONT_SIZE = /^(\d+(?:\.\d+)?)px$/;

function pxFontSize(value: unknown) {
  const match = typeof value === 'string' && PX_FONT_SIZE.exec(value);
  return match ? Number(match[1]) : null;
}

export const PARAGRAPH_CLASS = 'py-1.5 px-0 leading-relaxed text-fg';
export const BLOCKQUOTE_CLASS =
  'my-2 border-l-2 border-line pl-4 text-fg-secondary italic';
export const HR_CLASS =
  'h-0.5 rounded-sm border-none bg-divider bg-clip-content';
export const CODE_BLOCK_CLASS =
  'group/code relative overflow-auto rounded-button my-1 bg-surface-hover-bg px-4 pt-6 pb-4 sm:p-6 sm:pr-4 text-sm [tab-size:2] print:break font-mono text-fg';
/** Lines grow with their text so the block's right padding survives scrolling. */
export const CODE_LINE_CLASS = 'w-max min-w-full';
export const LINK_CLASS = 'text-link underline underline-offset-2';

export const UL_CLASS = 'my-2 ml-5 list-disc space-y-1';
export const OL_CLASS = 'my-2 ml-5 list-decimal space-y-1';
export const LI_CLASS = 'text-fg';

export const TABLE_WRAP_CLASS = 'my-3 overflow-auto';
export const TABLE_CLASS = 'w-full border-collapse text-sm';
export const TD_CLASS =
  'h-12 border border-line px-2 py-1.5 align-top sm:px-3 sm:py-2';
export const TH_CLASS =
  'h-12 border border-line bg-surface-hover-bg px-2 py-1.5 text-left font-semibold sm:px-3 sm:py-2';

export const CALLOUT_CLASS =
  'group/callout relative my-2 flex items-start gap-2 px-3 py-2 leading-relaxed sm:gap-2.5 sm:px-3.5 sm:py-2.5';
export const COLUMN_GROUP_CLASS =
  'group/columns relative my-2 flex size-full gap-2 flex-row';
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

export const EQUATION_BLOCK_CLASS = 'overflow-auto rounded-sm p-1 text-center';

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
