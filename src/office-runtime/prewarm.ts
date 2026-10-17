import type { OfficeFormat, OfficeMode } from '@/features/files/officeProtocol';
import xlsxEditWasmUrl from '../../vendor/betteroffice/packages/xlsx/src/wasm/generated/xlsx_wasm_bg.wasm?url';
import { prewarmDocxViewerWorker } from './docxViewerWorker';

type RuntimeKey = `${OfficeFormat}:${OfficeMode}`;

/** `load` once; a failure is forgotten, so the next caller loads again (a
 * boot head start that failed costs nothing). */
function once<T>(load: () => Promise<T>) {
  let loading: Promise<T> | undefined;
  return () => {
    if (!loading) {
      const started = load();
      loading = started;
      started.catch(() => {
        if (loading === started) loading = undefined;
      });
    }
    return loading;
  };
}

/** Each viewer's and editor's module, imported once. */
export const runtimeChunks = {
  'docx:edit': once(() => import('./DocxEditorHost')),
  'docx:view': once(() => import('./DocxViewer')),
  'pptx:edit': once(() => import('./PptxEditorHost')),
  'pptx:view': once(() => import('./PptxViewer')),
  'xlsx:edit': once(() => import('./XlsxEditorHost')),
  'xlsx:view': once(() => import('./XlsxViewer')),
} satisfies Record<RuntimeKey, () => Promise<unknown>>;

/** The engines Capy starts itself (the same instances the viewers and
 * editors then use); the DOCX viewer's runs in its worker, and the XLSX
 * editor's in its workbook worker, which reads it from the HTTP cache. */
export const runtimeEngines = {
  'docx:edit': once(() =>
    import('@betteroffice/docx/wasm/edit').then((module) =>
      module.preloadEditWasm()
    )
  ),
  'docx:view': async () => prewarmDocxViewerWorker(),
  'pptx:edit': once(() =>
    import('@betteroffice/pptx').then((module) => module.initWasm())
  ),
  'pptx:view': once(() =>
    import('@betteroffice/pptx/viewer').then((module) => module.initWasm())
  ),
  'xlsx:edit': once(() =>
    fetch(xlsxEditWasmUrl).then((response) => response.arrayBuffer())
  ),
  'xlsx:view': once(() =>
    import('@betteroffice/xlsx/viewer').then((module) => module.initWasm())
  ),
} satisfies Record<RuntimeKey, () => Promise<unknown>>;

/**
 * The frame was opened for `format` in `mode`: its module and engine load
 * now, while Capy still reads the file and the room. Nothing here waits; the
 * `load` message decides what opens.
 */
export function prewarmRuntime(format: OfficeFormat, mode: OfficeMode) {
  const key: RuntimeKey = `${format}:${mode}`;
  void runtimeChunks[key]().catch(() => {});
  void runtimeEngines[key]().catch(() => {});
  // An editor takes every face; a viewer the ones any deck needs, the rest
  // once it reads the deck.
  if (format === 'pptx')
    void import('./pptxFonts')
      .then((fonts) =>
        mode === 'edit'
          ? fonts.loadPptxFonts()
          : Promise.all(fonts.pptxDeckFaces([]).map(fonts.loadPptxFace))
      )
      .catch(() => {});
}
