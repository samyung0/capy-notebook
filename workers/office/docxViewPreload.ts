/** The preload office-runtime.html carries for the DOCX view engine, so its
 * 2 MB start with the page instead of after the runtime's scripts and its
 * worker (vite.config.ts writes it into the build). */
export const docxViewPreload = (href: string) =>
  `<link as="fetch" crossorigin data-docx-view-wasm href="${href}" rel="preload" type="application/wasm">`;

const DOCX_VIEW_PRELOAD = /<link [^>]*data-docx-view-wasm[^>]*>\s*/;

/** The runtime page for a frame opened with `search`: only a DOCX view keeps
 * the engine's preload, so an XLSX or PPTX open downloads nothing it will not
 * use. */
export function runtimePageFor(html: string, search: URLSearchParams) {
  return search.get('format') === 'docx' && search.get('mode') === 'view'
    ? html
    : html.replace(DOCX_VIEW_PRELOAD, '');
}
