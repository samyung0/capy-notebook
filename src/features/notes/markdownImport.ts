/* Markdown to a material document, shared by the editor's import and the
   collaboration service's converter (markdownConvert.ts), so pasted and agent
   markdown give the same nodes. */
import { encodeUrlIfNeeded, validateUrl } from '@platejs/link';
import { MarkdownPlugin } from '@platejs/markdown';
import { KEYS, type SlateEditor } from 'platejs';
import {
  createMaterialDocument,
  type MaterialDocument,
  type MaterialElement,
  type MaterialNode,
  type MaterialValue,
} from '@/features/materials/document';

type MarkdownApi = {
  markdown: { deserialize: (source: string) => MaterialValue };
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

/** Deserialize with the editor's markdown rules, then sanitize links. */
export function importMarkdownValue(
  editor: SlateEditor,
  source: string
): MaterialDocument {
  const api = (
    editor.getApi as unknown as (plugin: typeof MarkdownPlugin) => MarkdownApi
  )(MarkdownPlugin);
  return sanitizeLinks(
    editor,
    createMaterialDocument(api.markdown.deserialize(source))
  );
}
