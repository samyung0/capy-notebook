/* Markdown to a material document, shared by the editor's import and the
   collaboration service's converter (markdownConvert.ts), so pasted and agent
   markdown give the same nodes. */
import { encodeUrlIfNeeded, validateUrl } from '@platejs/link';
import { type DeserializeMdOptions, MarkdownPlugin } from '@platejs/markdown';
import { KEYS, type SlateEditor } from 'platejs';
import {
  createMaterialDocument,
  type MaterialDocument,
  type MaterialElement,
  type MaterialNode,
  type MaterialValue,
} from '@/features/materials/document';

type MarkdownApi = {
  markdown: {
    deserialize: (
      source: string,
      options?: DeserializeMdOptions
    ) => MaterialValue;
  };
};

/** Plain Markdown: no MDX. Plate's MDX pass rewrites every `<tag …>` in the
 * text, fenced code included (`class=` becomes `className=`, `i<n;…>` in a
 * script gets quoted), drops `{…}` from prose, and when the MDX parse fails
 * keeps only the text before the first `<` intact. Without MDX Plate has no
 * fallback and would return nothing on an error, so the error is thrown. */
const PLAIN: DeserializeMdOptions = {
  onError: (error) => {
    throw error;
  },
  withoutMdx: true,
};

/** Clears link URLs that fail the link plugin's validation. */
export function sanitizeLinks(
  editor: SlateEditor,
  document: MaterialDocument
): MaterialDocument {
  const sanitize = (node: MaterialNode): MaterialNode => {
    if ('text' in node) return { ...node };
    const sanitized = { ...node, children: node.children.map(sanitize) };
    if (node.type !== editor.getType(KEYS.link)) return sanitized;
    const url =
      typeof node.url === 'string' ? encodeUrlIfNeeded(node.url.trim()) : '';
    return { ...sanitized, url: url && validateUrl(editor, url) ? url : '' };
  };
  return createMaterialDocument(
    document.value.map((node) => sanitize(node) as MaterialElement)
  );
}

/** Deserialize with the editor's markdown rules, then sanitize links. `plain`
 * reads `source` as Markdown without MDX and throws what a fence rule throws. */
export function importMarkdownValue(
  editor: SlateEditor,
  source: string,
  { plain = false } = {}
): MaterialDocument {
  const api = (
    editor.getApi as unknown as (plugin: typeof MarkdownPlugin) => MarkdownApi
  )(MarkdownPlugin);
  return sanitizeLinks(
    editor,
    createMaterialDocument(
      api.markdown.deserialize(source, plain ? PLAIN : undefined)
    )
  );
}
