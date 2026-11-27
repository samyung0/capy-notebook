import type { QueryClient } from '@tanstack/react-query';

/** An Office file's open (its view's code, the source session and the room's
 * socket), its code loaded by the first route that opens a file, so Yjs and the
 * room code stay out of the app's entry (Q908). The route loaders start it
 * first and never await it; a hover's preload loads the code too (the prefetch
 * itself skips a preload), and a failed load leaves the view to read the file
 * itself, as a failed prefetch does. */
export function prefetchOffice(
  qc: QueryClient,
  fileId: string,
  load: { abortController: AbortController; preload: boolean }
) {
  import('./prefetchOfficeFile')
    .then(({ prefetchOfficeFile }) => prefetchOfficeFile(qc, fileId, load))
    .catch(() => undefined);
}
