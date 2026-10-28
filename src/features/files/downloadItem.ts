import type { QueryClient } from '@tanstack/react-query';
import * as Y from 'yjs';
import { fileLinksQuery, materialQuery } from '@/api/hooks';
import type { SourceFile } from '@/api/types';
import { parseMaterialDocument } from '@/features/materials/document';
import {
  downloadEditorFile,
  exportNoteValue,
} from '@/features/notes/documentAdapters';
import type { ExportFormat } from '@/features/notes/export/render';
import { trackDownload } from '@/features/workspace/sourceTransfers';
import { isSourceText, officeFormatOf } from './fileUtils';
import { takeSourceOpen } from './sourceOpen';
import { applySavedSource, savedSourceUpdate } from './sourceState';

/** Download from an item menu (Epo 2026-10-27/28): a file's latest saved
 * state under its own name, shown as Preparing download until it saves. An
 * Office or text file reads view mode's source session: the published file
 * when nothing saved is past it, else its saved edits merged over the base
 * in the browser, with view mode's export worker for Office. Any other file
 * is its stored bytes. */
export function downloadFile(
  file: Pick<SourceFile, 'id' | 'kind' | 'name' | 'workspaceId'>,
  queryClient: QueryClient
) {
  return trackDownload(
    { kind: file.kind, name: file.name, workspaceId: file.workspaceId || null },
    async () => downloadEditorFile(await fileBlob(file, queryClient), file.name)
  );
}

async function fileBlob(
  file: Pick<SourceFile, 'id' | 'kind' | 'name'>,
  queryClient: QueryClient
): Promise<Blob> {
  const office = officeFormatOf(file);
  if (!office && !isSourceText(file)) {
    const { url } = await queryClient.fetchQuery(fileLinksQuery(file.id));
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.blob();
  }
  const { base, session } = await takeSourceOpen(file.id, 'view');
  const bytes = await base;
  if (session.checkpoint === session.indexedCheckpoint)
    return new Blob([bytes]);
  if (!office) {
    const doc = new Y.Doc();
    applySavedSource(doc, session);
    const text = doc.getText('source').toString();
    doc.destroy();
    return new Blob([text], { type: 'text/plain;charset=utf-8' });
  }
  const saved = savedSourceUpdate(session);
  if (!saved) return new Blob([bytes]);
  const { exportCheckpoint } = await import(
    '@/office-runtime/exportCheckpoint'
  );
  const exported = await exportCheckpoint(
    office,
    bytes.slice().buffer,
    saved.slice().buffer,
    session.stateSeedSHA256 ?? undefined
  );
  return new Blob([exported.slice()]);
}

/** A note as Markdown or DOCX from its stored document, with no editor
 * open, named after its title. */
export function downloadNote(
  note: { id: string; title: string; workspaceId: string | null },
  format: ExportFormat,
  queryClient: QueryClient
) {
  const noteUrl = note.workspaceId
    ? new URL(`/workspaces/${note.workspaceId}`, location.origin)
    : new URL(`/materials/${note.id}`, location.origin);
  if (note.workspaceId) noteUrl.searchParams.set('material', note.id);
  return trackDownload(
    {
      kind: format === 'docx' ? 'doc' : 'md',
      name: note.title,
      workspaceId: note.workspaceId,
    },
    async () => {
      const material = await queryClient.fetchQuery(materialQuery(note.id));
      const value =
        parseMaterialDocument(material.content)?.value ??
        material.content.value;
      const result = await exportNoteValue(value, noteUrl, queryClient, format);
      downloadEditorFile(result.blob, `${note.title}.${result.extension}`);
    }
  );
}
