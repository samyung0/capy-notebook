/* The collaboration service's markdown converter: the editor's markdown
   import on the read-only plugin set, so it runs without a DOM.
   collaboration-rs/crates/notes/markdown/build.mjs bundles this file for the
   server's V8. */
import { createSlateEditor, type SlateEditor } from 'platejs';
import {
  type EmbeddedDraft,
  parseEmbeddedFence,
} from '@/features/materials/blocks';
import {
  HTML_EMBED_MAX_COUNT,
  type MaterialDocument,
  type MaterialNode,
  type MaterialRefKind,
  type MaterialValue,
} from '@/features/materials/document';
import { StaticMaterialKit } from '@/features/materials/staticPlugins';
import { noteMarkdownPlugin } from './markdown';
import { importMarkdownValue } from './markdownImport';

let editor: SlateEditor | undefined;

export function markdownToDocument(
  source: string,
  options?: {
    plain?: boolean;
    transform?: (value: MaterialValue) => MaterialValue;
  }
): MaterialDocument {
  editor ??= createSlateEditor({
    plugins: [...StaticMaterialKit, noteMarkdownPlugin],
  });
  return importMarkdownValue(editor, source, options);
}

/** A library figure the agent placed: `![caption](figure:<figure id>)`. */
const FIGURE_REF = /^figure:[\w-]+$/;

/** The width a figure titled "small" takes; no title or "normal" keeps the
 * full width (Epo 2026-10-25). */
const SMALL_FIGURE_WIDTH = '50%';

/** A note holds asset images only (Epo 2026-10-10). An agent's
 * `figure:<id>` image keeps that reference as its assetId: the server stores
 * the rendered figure as the note's own asset and puts the asset's id in its
 * place. Any other image becomes a link to its URL. */
function agentImages(nodes: MaterialValue): MaterialValue {
  const walk = (node: MaterialNode): MaterialNode => {
    if ('text' in node) return node;
    if (node.type !== 'img')
      return { ...node, children: node.children.map(walk) };
    const url = typeof node.url === 'string' ? node.url.trim() : '';
    const caption = Array.isArray(node.caption)
      ? (node.caption as { text?: unknown }[])
      : [];
    if (FIGURE_REF.test(url))
      return {
        assetId: url,
        caption,
        children: [{ text: '' }],
        type: 'img',
        ...(node.title === 'small' && { width: SMALL_FIGURE_WIDTH }),
      };
    const label = caption.map((leaf) => String(leaf.text ?? '')).join('');
    return {
      children: [{ children: [{ text: label || url }], type: 'a', url }],
      type: 'p',
    };
  };
  return nodes.map(walk) as MaterialValue;
}

/** Agent markdown: the document, and a draft for each quiz or flashcards
 * fence in depth-first document order. Read as plain Markdown, without MDX,
 * so html-embed snippets and prose keep every character the agent wrote. A
 * fence that does not parse throws, so the agent can fix it (a paste drops
 * that block and says so, pendingRefs.ts). */
export function convertAgentMarkdown(source: string): {
  document: MaterialDocument;
  embedded: EmbeddedDraft[];
} {
  // The document check refuses more without saying why; name the rule here.
  const embeds = source.match(/^\s*`{3,}html-embed\b/gm)?.length ?? 0;
  if (embeds > HTML_EMBED_MAX_COUNT)
    throw new Error(
      `A note holds at most ${HTML_EMBED_MAX_COUNT} html-embed fences, not ${embeds}.`
    );
  const document = markdownToDocument(source, {
    plain: true,
    transform: agentImages,
  });
  const embedded: EmbeddedDraft[] = [];
  const walk = (node: MaterialNode) => {
    if ('text' in node) return;
    if (node.type === 'material_ref' && typeof node.pending === 'string') {
      const kind = node.refKind as MaterialRefKind;
      try {
        embedded.push(parseEmbeddedFence(kind, node.pending));
      } catch (error) {
        throw new Error(
          `fence ${embedded.length + 1} (${kind}) ${(error as Error).message}`,
          { cause: error }
        );
      }
    }
    node.children.forEach(walk);
  };
  document.value.forEach(walk);
  return { document, embedded };
}
