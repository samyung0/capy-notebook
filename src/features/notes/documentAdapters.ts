import type { QueryClient } from '@tanstack/react-query';
import type { PlateEditor } from 'platejs/react';
import { resolveEditorAsset } from '@/api/editorAssets';
import { cardsQuery, quizQuery } from '@/api/hooks';
import {
  assertMaterialDocument,
  createMaterialDocument,
  flashcardsNode,
  isCustomMaterialElement,
  isMaterialRefElement,
  type MaterialDocument,
  type MaterialNode,
  type MaterialValue,
  quizNode,
} from '@/features/materials/document';
import { questionAssetIds } from '@/features/questions/types';
import type { ExportFormat } from './export/render';
import { importMarkdownValue, sanitizeLinks } from './markdownImport';

/** Loaded only when the user imports/exports a .docx — keeps mammoth/jszip/xml
 * out of the initial editor chunk. */
function loadDocxIo() {
  return import('@platejs/docx-io');
}

export function importMarkdownDocument(
  editor: PlateEditor,
  source: string
): MaterialDocument {
  return importMarkdownValue(editor, source);
}

export function importJsonDocument(
  editor: PlateEditor,
  source: string
): MaterialDocument {
  return sanitizeLinks(editor, assertMaterialDocument(source));
}

/** Resolve a snapshot once for both formats. A failed read must not result in
 * a successful but incomplete document download. */
async function resolveMaterialRefs(
  value: MaterialValue,
  queryClient: QueryClient
): Promise<MaterialValue> {
  return Promise.all(
    value.map(async (node) => {
      if (!isMaterialRefElement(node) || !node.materialId) return node;
      if (node.refKind === 'quiz') {
        const quiz = await queryClient.fetchQuery({
          ...quizQuery(node.materialId),
          retry: false,
          staleTime: 0,
        });
        return quizNode({
          questions: quiz.questions,
        });
      }
      const cards = await queryClient.fetchQuery({
        ...cardsQuery(node.materialId),
        retry: false,
        staleTime: 0,
      });
      return flashcardsNode(
        cards.map((card) => ({
          back: card.back,
          front: card.front,
          id: card.id,
        }))
      );
    })
  );
}

export async function exportNoteDocument(
  editor: PlateEditor,
  queryClient: QueryClient,
  format: ExportFormat,
  signal?: AbortSignal
) {
  const value = await resolveMaterialRefs(
    structuredClone(editor.children) as MaterialValue,
    queryClient
  );
  const ids = new Set<string>();
  const visit = (nodes: MaterialNode[]) =>
    nodes.forEach((node) => {
      if ('text' in node) return;
      if (typeof node.assetId === 'string') ids.add(node.assetId);
      if (isCustomMaterialElement(node) && node.type === 'quiz_question')
        for (const id of questionAssetIds(node.question)) ids.add(id);
      visit(node.children);
    });
  visit(value);
  const assetUrls: Record<string, string> = {};
  for (const id of ids)
    assetUrls[id] = (await resolveEditorAsset(id, signal)).url;
  const { runExportWorker } = await import('./export/client');
  const current = new URL(location.href);
  const noteUrl = new URL(current.pathname, current.origin);
  if (current.searchParams.has('material'))
    noteUrl.searchParams.set('material', current.searchParams.get('material')!);
  noteUrl.searchParams.set('mode', 'view');
  return runExportWorker(
    {
      assetUrls,
      format,
      noteUrl: noteUrl.href,
      value,
    },
    signal
  );
}

export async function importDocxDocument(
  editor: PlateEditor,
  buffer: ArrayBuffer
): Promise<MaterialDocument> {
  const { importDocx } = await loadDocxIo();
  const result = await importDocx(editor, buffer);
  return sanitizeLinks(
    editor,
    createMaterialDocument(result.nodes as MaterialValue)
  );
}

export function downloadEditorFile(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadEditorText(
  text: string,
  filename: string,
  type: string
) {
  downloadEditorFile(new Blob([text], { type }), filename);
}
