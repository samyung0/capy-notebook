import type { QueryClient } from '@tanstack/react-query';
import { fileQuery, meQuery, workspaceQuery } from '@/api/hooks';
import { AccountState } from '@/api/types';
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
  /** A hover's preload, not a navigation. */
  preload: boolean;
}

/**
 * Starts an Office file's open from its route, as soon as GET /files/{id}
 * says it is one: the view's code, the View read and, for an editor, the edit
 * session and room token beside it (Q608 A), whichever mode the view then
 * shows, so none waits for the page to render. The view and the editor take
 * their parts when they mount (`takeSourceOpen`); a file a view already shows
 * starts nothing (`prefetchSourceOpen`). A hover's preload stops at the file
 * row, and a route left before the rows arrive starts no open.
 */
export function prefetchOfficeFile(
  qc: QueryClient,
  fileId: string,
  { abortController: { signal }, preload }: RouteLoad
) {
  if (preload) return;
  void (async () => {
    const file = await qc.ensureQueryData(fileQuery(fileId));
    const format = file.hasBytes ? officeFormatOf(file) : null;
    if (!format) return;
    void VIEW_CHUNKS[format]();
    // The view mounts once the capability that decides Edit is known. A
    // standalone file (no workspace) is its owner's, who edits it unless
    // their account is frozen (Epo 2026-10-27); one opened from the Trash
    // takes no edits, and no file does while /me says files are view-only
    // (Q853 A).
    if (file.workspaceId)
      void qc.prefetchQuery(workspaceQuery(file.workspaceId));
    const me = await qc.ensureQueryData(meQuery());
    const canEdit =
      !file.trash &&
      me.filesEditable &&
      (file.workspaceId
        ? (await qc.ensureQueryData(workspaceQuery(file.workspaceId)))
            .capabilities.canEditContent
        : me.account?.state !== AccountState.over_quota_frozen);
    if (signal.aborted) return;
    prefetchSourceOpen(fileId, canEdit);
  })().catch(() => {
    // The view reads them itself and reports what fails.
  });
}
