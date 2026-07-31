import { encodeUrlIfNeeded, validateUrl } from '@platejs/link';
import { MarkdownPlugin, serializeMd } from '@platejs/markdown';
import { KEYS, type SlatePlugin } from 'platejs';
import type { PlateEditor } from 'platejs/react';
import {
  assertMaterialDocument,
  createMaterialDocument,
  type MaterialDocument,
  type MaterialElement,
  type MaterialNode,
  type MaterialValue,
} from '@/features/materials/document';

type MarkdownEditor = PlateEditor & {
  getApi: (plugin: typeof MarkdownPlugin) => {
    markdown: {
      deserialize: (source: string) => MaterialValue;
      serialize: () => string;
    };
  };
};

/** Loaded only when the user imports/exports a .docx — keeps mammoth/jszip/xml
 * out of the initial editor chunk. */
function loadDocxIo() {
  return import('@platejs/docx-io');
}

function sanitizeImportedDocument(
  editor: PlateEditor,
  document: MaterialDocument
): MaterialDocument {
  const sanitizeNode = (node: MaterialNode): MaterialNode => {
    if ('text' in node) return { ...node };

    const sanitized = {
      ...node,
      children: node.children.map(sanitizeNode),
    };
    if (node.type !== editor.getType(KEYS.link)) return sanitized;

    const url =
      typeof node.url === 'string' ? encodeUrlIfNeeded(node.url.trim()) : '';
    return {
      ...sanitized,
      url: url && validateUrl(editor, url) ? url : '',
    };
  };

  return createMaterialDocument(
    document.value.map((node) => sanitizeNode(node) as MaterialElement)
  );
}

export function importMarkdownDocument(
  editor: PlateEditor,
  source: string
): MaterialDocument {
  const value = (editor as MarkdownEditor)
    .getApi(MarkdownPlugin)
    .markdown.deserialize(source);
  return sanitizeImportedDocument(editor, createMaterialDocument(value));
}

export function importJsonDocument(
  editor: PlateEditor,
  source: string
): MaterialDocument {
  return sanitizeImportedDocument(editor, assertMaterialDocument(source));
}

export function exportMarkdownDocument(editor: PlateEditor): string {
  return serializeMd(editor, {
    value: editor.children as MaterialValue,
  });
}

export async function importDocxDocument(
  editor: PlateEditor,
  buffer: ArrayBuffer
): Promise<MaterialDocument> {
  const { importDocx } = await loadDocxIo();
  const result = await importDocx(editor, buffer);
  return sanitizeImportedDocument(
    editor,
    createMaterialDocument(result.nodes as MaterialValue)
  );
}

export async function exportDocxDocument(
  editor: PlateEditor,
  plugins: SlatePlugin[]
): Promise<Blob> {
  const { exportToDocx } = await loadDocxIo();
  return exportToDocx(editor.children as MaterialValue, {
    editorPlugins: plugins,
  });
}

export function downloadEditorFile(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export function downloadEditorText(
  text: string,
  filename: string,
  type: string
) {
  downloadEditorFile(new Blob([text], { type }), filename);
}
