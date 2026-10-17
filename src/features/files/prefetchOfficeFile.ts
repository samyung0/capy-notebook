import type { QueryClient } from '@tanstack/react-query';
import { fileQuery, workspaceQuery } from '@/api/hooks';
import {
  parseDocumentModeSearch,
  readDocumentMode,
} from '@/features/materials/openItem';
import { officeFormatOf } from './fileUtils';
import { prefetchSourceOpen } from './sourceOpen';

const VIEW_CHUNKS = {
  docx: () => import('./DocxView'),
  pptx: () => import('./PptxView'),
  xlsx: () => import('./SheetView'),
};

/** What a route loader hands over (TanStack's loader context). */
interface RouteLoad {
  /** Aborted once the route's match is left. */
  abortController: AbortController;
  location: { search: Record<string, unknown> };
  /** A hover's preload, not a navigation. */
  preload: boolean;
}

/**
 * Starts an Office file's open from its route, as soon as GET /files/{id}
 * says it is one: the view's code, and the session and bytes (Edit: the
 * session and room token) for the mode it opens in (the URL's, else the
 * saved one, Edit only for an editor), so neither waits for the page to
 * render. The view takes them when it mounts (`takeSourceOpen`); a file a
 * view already shows starts nothing (`prefetchSourceOpen`). A hover's
 * preload stops at the file row, and a route left before the rows arrive
 * starts no open.
 */
export function prefetchOfficeFile(
  qc: QueryClient,
  fileId: string,
  { abortController: { signal }, location, preload }: RouteLoad
) {
  if (preload) return;
  const requested = parseDocumentModeSearch(location.search).mode;
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
    if (signal.aborted) return;
    prefetchSourceOpen(fileId, canEdit ? 'edit' : 'view');
  })().catch(() => {
    // The view reads them itself and reports what fails.
  });
}
