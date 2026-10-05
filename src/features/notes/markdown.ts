/* ============================================================
   Shared MarkdownPlugin configuration for the note editor. Enables GFM, math,
   MDX (columns/callouts) and emoji shortcodes, and adds custom rules so the
   embeddable blocks (quiz / flashcards / mermaid / html-embed) round-trip through the
   existing fenced-code format used by the Go backend and the read-only renderer.
   ============================================================ */
import { MarkdownPlugin, remarkMdx } from '@platejs/markdown';
import remarkEmoji from 'remark-emoji';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import {
  type CustomBlockLang,
  customBlockCode,
  customBlockNode,
  HTML_EMBED_LANG,
  isCustomBlockLang,
} from './blocks/shared';

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyNode = any;

function serializeCustomBlock(lang: string) {
  return (node: AnyNode) => ({
    lang,
    type: 'code',
    value: customBlockCode(node),
  });
}

export const noteMarkdownPlugin = MarkdownPlugin.configure({
  options: {
    remarkPlugins: [remarkGfm, remarkMath, remarkMdx, remarkEmoji] as AnyNode,
    rules: {
      // Intercept fenced code: custom block fences become custom void nodes;
      // everything else falls back to the default code_block/code_line shape.
      // Rules are keyed by Plate type: mdast `code` maps to `code_block`,
      // while `code` is the inline code mark.
      code_block: {
        deserialize: (node: AnyNode) => {
          const lang = node.lang ?? undefined;
          if (isCustomBlockLang(lang)) {
            return customBlockNode(
              lang as CustomBlockLang,
              String(node.value ?? '')
            );
          }
          const lines = String(node.value ?? '').split('\n');
          return {
            children: lines.map((line: string) => ({
              children: [{ text: line }],
              type: 'code_line',
            })),
            lang,
            type: 'code_block',
          };
        },
      },
      flashcards: { serialize: serializeCustomBlock('flashcards') },
      html_embed: { serialize: serializeCustomBlock(HTML_EMBED_LANG) },
      // Export resolves references into inline blocks first
      // (documentAdapters); an unresolved one keeps its fence when pending.
      material_ref: {
        serialize: (node: AnyNode) =>
          node.pending
            ? { lang: node.refKind, type: 'code', value: node.pending }
            : { children: [], type: 'paragraph' },
      },
      mermaid: { serialize: serializeCustomBlock('mermaid') },
      quiz: { serialize: serializeCustomBlock('quiz') },
    } as AnyNode,
  },
});
