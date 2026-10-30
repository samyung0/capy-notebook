import type { CalloutVariant } from '@/features/notes/richBlockConfig';

/** Clipboard type a chat answer's copy carries for the note editor
 * (answerCopy.ts writes it, the note's ChatAnswerPastePlugin reads it). */
export const ANSWER_CLIPBOARD_TYPE = 'application/x-capy-answer';

/** Plain Markdown in the note format (math, GFM tables, chart, plot, mermaid
 * and html-embed fences); a callout's Markdown is its body. */
export interface CopiedBlock {
  callout?: CalloutVariant;
  md: string;
}
