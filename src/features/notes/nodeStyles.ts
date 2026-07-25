/* Shared class names for note document nodes. Both the editable editor
 * components (nodeComponents.tsx) and the static preview components
 * (materials/staticNodeComponents.tsx) consume these so the two surfaces
 * cannot drift apart visually. */
import type { CSSProperties } from 'react';

export const HEADING_CLASS: Record<string, string> = {
  h1: 'mt-[1.6em] mb-1 pb-1 text-4xl font-extrabold text-fg',
  h2: 'mt-[1.4em] mb-1 pb-px text-2xl font-bold text-fg',
  h3: 'mt-[1em] mb-1 pb-px text-xl font-bold text-fg',
  h4: 'mt-[0.75em] mb-1 pb-px text-lg font-semibold text-fg',
  h5: 'mt-[0.75em] mb-1 pb-px text-lg font-semibold text-fg',
  h6: 'mt-[0.75em] mb-1 pb-px text-base font-semibold text-fg',
};

export const PARAGRAPH_CLASS = 'py-1 px-0 leading-relaxed text-fg';
export const BLOCKQUOTE_CLASS =
  'my-1 border-l-2 border-line pl-4 text-fg-secondary italic';
export const HR_CLASS = 'my-5 border-divider';
export const CODE_BLOCK_CLASS =
  'group/code relative overflow-auto rounded-row my-1 bg-surface-hover-bg pr-4 p-8 text-sm [tab-size:2] print:break font-mono text-fg';
export const LINK_CLASS = 'text-link underline underline-offset-2';

export const UL_CLASS = 'my-2 ml-5 list-disc space-y-1';
export const OL_CLASS = 'my-2 ml-5 list-decimal space-y-1';
export const LI_CLASS = 'text-fg';

export const TABLE_WRAP_CLASS = 'my-3 overflow-auto';
export const TABLE_CLASS = 'w-full border-collapse text-sm';
export const TD_CLASS = 'h-12 border border-line px-3 py-2 align-top';
export const TH_CLASS =
  'h-12 border border-line bg-surface-hover-bg px-3 py-2 text-left font-semibold';

export const CALLOUT_CLASS =
  'group/callout relative my-2 flex gap-3 rounded-row border-l-4 px-4 py-3';
export const COLUMN_GROUP_CLASS =
  'group/columns relative my-2 flex size-full gap-2 flex-row';
export const COLUMN_CLASS =
  'group/column relative min-w-0 shrink rounded-row border border-line border-dashed p-2 w-(--column-width) basis-(--column-width)';

export const TOC_BOX_CLASS = 'my-3';
export const TOC_TITLE_CLASS = 'mb-2 t-label text-fg-muted';
export const TOC_ITEM_CLASS =
  'rounded-row py-1 text-left underline hover:bg-surface-hover-bg -translate-x-1.5';
export const TOC_EMPTY_CLASS = 'text-sm text-fg-muted';
export function tocItemIndent(headingType: string): CSSProperties {
  return {
    paddingLeft: `${8 + Math.max(0, Number(headingType.slice(1)) - 1) * 12}px`,
  };
}

export const MENTION_CLASS =
  'rounded bg-tint-accent-1 px-1 text-tint-accent-1-fg';

export const EQUATION_BLOCK_CLASS =
  'my-3 overflow-auto rounded-card border border-line p-3 text-center';

/* leaf marks */
export const CODE_MARK_CLASS =
  'rounded bg-surface-hover-bg px-1 py-0.5 font-mono text-[0.85em]';
export const HIGHLIGHT_MARK_CLASS = 'bg-tint-info border-b border-solid-info';
export const KBD_MARK_CLASS =
  'rounded border border-line bg-surface-hover-bg px-1.5 py-0.5 text-sm font-mono text-fg';
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
export const QUIZ_REVIEW_OPTION_CLASS =
  'flex flex-col gap-1.5 rounded-row px-4 py-3 text-sm transition-colors';
export const QUIZ_REVIEW_OPTION_CORRECT_CLASS =
  'border-solid-success bg-tint-success text-tint-success-fg';
export const QUIZ_REVIEW_OPTION_NEUTRAL_CLASS = 'bg-surface text-fg';
export const FLASHCARD_CLASS =
  'grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-start gap-3 rounded-card border border-line bg-surface p-3 text-sm';
export const FLASHCARD_FRONT_CLASS = 'font-medium text-fg';
export const FLASHCARD_BACK_CLASS = 'text-fg-secondary';
export const MERMAID_CAPTION_CLASS = 'mt-2 text-center text-sm text-fg-muted';
