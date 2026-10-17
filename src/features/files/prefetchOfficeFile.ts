import type { QueryClient } from '@tanstack/react-query';
import { fileQuery, workspaceQuery } from '@/api/hooks';
import type { MaterialMode } from '@/features/materials/modePolicy';
import { readDocumentMode } from '@/features/materials/openItem';
import { officeFormatOf } from './fileUtils';
import { prefetchSourceOpen } from './sourceOpen';

const VIEW_CHUNKS = {
  docx: () => import('./DocxView'),
  pptx: () => import('./PptxView'),
  xlsx: () => import('./SheetView'),
};

/**
 * Starts an Office file's open from its route, as soon as GET /files/{id}
 * says it is one: the view's code, and the session and bytes (Edit: the
 * session and room token) for the mode it opens in (the URL's, else the
 * saved one, Edit only for an editor), so neither waits for the page to
 * render. The view takes them when it mounts (`takeSourceOpen`); a file a
 * view already shows starts nothing (`prefetchSourceOpen`).
 */
export function prefetchOfficeFile(
  qc: QueryClient,
  fileId: string,
  requested: MaterialMode | undefined
) {
  void (async () => {
    const file = await qc.ensureQueryData(fileQuery(fileId));
    const format = file.hasBytes ? officeFormatOf(file) : null;
    if (!format) return;
    void VIEW_CHUNKS[format]();
    // The view mounts once the capability that picks its mode is known.
    void qc.prefetchQuery(workspaceQuery(file.workspaceId));
    const mode = requested ?? readDocumentMode({ id: fileId, kind: 'file' });
    const canEdit =
      mode === 'edit' &&
      (await qc.ensureQueryData(workspaceQuery(file.workspaceId))).capabilities
        .canEditContent;
    prefetchSourceOpen(fileId, canEdit ? 'edit' : 'view');
  })().catch(() => {
    // The view reads them itself and reports what fails.
  });
}
