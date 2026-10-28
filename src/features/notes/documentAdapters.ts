import type { QueryClient } from '@tanstack/react-query';
import type { Descendant } from 'platejs';
import type { PlateEditor } from 'platejs/react';
import { resolveEditorAsset } from '@/api/editorAssets';
import { cardsQuery, quizEditQuery } from '@/api/hooks';
import {
  assertMaterialDocument,
  clampIndents,
  createMaterialDocument,
  flashcardsNode,
  isMaterialRefElement,
  type MaterialDocument,
  type MaterialNode,
  type MaterialValue,
  type QuizQuestionElement,
  quizNode,
} from '@/features/materials/document';
import { questionAssetIds } from '@/features/questions/types';
import type { ExportFormat } from './export/render';
import {
  importMarkdownValue,
  replaceUrlImages,
  sanitizeLinks,
} from './markdownImport';
import { uploadOrLink } from './pastedImages';

/** Loaded only when the user imports/exports a .docx — keeps mammoth/jszip/xml
 * out of the initial editor chunk. */
function loadDocxIo() {
  return import('@platejs/docx-io');
}

/** Markdown images upload like pasted ones, or are links without asset
 * uploads (pastedImages.ts). */
export function importMarkdownDocument(
  editor: PlateEditor,
  source: string,
  allowExternalAssets: boolean
): MaterialDocument {
  return importMarkdownValue(editor, source, {
    replaceImage: uploadOrLink(editor, allowExternalAssets),
  });
}

/** A block indented past LIST_INDENT_MAX clamps on entry (Epo 2026-10-19);
 * anything else invalid refuses the file. */
export function importJsonDocument(
  editor: PlateEditor,
  source: string
): MaterialDocument {
  let input: unknown = source;
  try {
    input = JSON.parse(source);
  } catch {
    // Not JSON: assertMaterialDocument refuses it.
  }
  if (
    typeof input === 'object' &&
    input !== null &&
    'value' in input &&
    Array.isArray(input.value)
  )
    input = { ...input, value: clampIndents(input.value) };
  return sanitizeLinks(editor, assertMaterialDocument(input));
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
      // Export sits in the note's edit mode and writes the answer key, so it
      // reads the quiz the way its editor does.
      if (node.refKind === 'quiz') {
        const quiz = await queryClient.fetchQuery({
          ...quizEditQuery(node.materialId),
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

export function exportNoteDocument(
  editor: PlateEditor,
  queryClient: QueryClient,
  format: ExportFormat,
  signal?: AbortSignal
) {
  const current = new URL(location.href);
  const noteUrl = new URL(current.pathname, current.origin);
  if (current.searchParams.has('material'))
    noteUrl.searchParams.set('material', current.searchParams.get('material')!);
  return exportNoteValue(
    editor.children as MaterialValue,
    noteUrl,
    queryClient,
    format,
    signal
  );
}

/** A note's value as Markdown or DOCX, with no editor open: the editor's
 * export and Download from an item menu alike. noteUrl is where the note's
 * links back to itself point (opened in view mode). */
export async function exportNoteValue(
  stored: MaterialValue,
  noteUrl: URL,
  queryClient: QueryClient,
  format: ExportFormat,
  signal?: AbortSignal
) {
  const value = await resolveMaterialRefs(structuredClone(stored), queryClient);
  const ids = new Set<string>();
  const visit = (nodes: MaterialNode[]) =>
    nodes.forEach((node) => {
      if ('text' in node) return;
      if (typeof node.assetId === 'string') ids.add(node.assetId);
      if (node.type === 'quiz_question')
        for (const id of questionAssetIds(
          (node as QuizQuestionElement).question
        ))
          ids.add(id);
      visit(node.children);
    });
  visit(value);
  const assetUrls: Record<string, string> = {};
  for (const id of ids)
    assetUrls[id] = (await resolveEditorAsset(id, signal)).url;
  const { runExportWorker } = await import('./export/client');
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

/** A DOCX's pictures, which mammoth gives as `data:` URL images, upload like
 * pasted ones (Epo, 2026-10-10, main 1be046ea), or are left out without asset
 * uploads, so its text and pictures both land; a list nested past
 * LIST_INDENT_MAX clamps on entry (Epo 2026-10-19). */
export async function importDocxDocument(
  editor: PlateEditor,
  buffer: ArrayBuffer,
  allowExternalAssets: boolean
): Promise<MaterialDocument> {
  const { importDocx } = await loadDocxIo();
  const result = await importDocx(editor, buffer);
  const value = replaceUrlImages(
    editor,
    clampIndents(result.nodes as Descendant[]),
    uploadOrLink(editor, allowExternalAssets)
  );
  return sanitizeLinks(editor, createMaterialDocument(value as MaterialValue));
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
