import { SheetGoneError } from '@betteroffice/xlsx/editor';
import { analyzeOpenWorkbook } from '@betteroffice/xlsx/viewer';
import {
  type XlsxCommandState,
  XlsxEditor,
  type XlsxEditorApi,
} from '@betteroffice/xlsx-react';
import {
  type PointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import type {
  OfficeAnalysis,
  OfficeLocale,
  OfficeRenderedPage,
} from '@/features/files/officeProtocol';
import type {
  OfficeCollaboration,
  OfficeExporter,
  OfficeFlusher,
} from './officeCollaboration';
import type {
  OfficeCaptureScope,
  OfficeMenuReporter,
  OfficeRenderer,
  OfficeThumbnailer,
} from './runtimeMenus';
import { xlsxIcons } from './xlsxIcons';
import { runXlsxMenuItem, xlsxEditMenus, xlsxStrings } from './xlsxMenus';
import {
  sheetPages,
  sheetThumbnail,
  THUMBNAIL_AREA,
  viewportPage,
} from './xlsxRender';
import './xlsx-runtime.css';

export function XlsxEditorHost({
  bytes,
  collaboration,
  locale,
  onAnalysis,
  onExporter,
  onFlusher,
  onMenus,
  onRenderer,
  narrow,
  onPendingChange,
  fileName,
  initialZoom,
  onSave,
  onThumbnailer,
  onZoomChange,
  readOnly,
}: {
  bytes: Uint8Array;
  collaboration: OfficeCollaboration;
  /** 1 = 100%, the level the file was last shown at. */
  initialZoom?: number;
  locale: OfficeLocale;
  /** Below lg: no zoom (as the PDF toolbar), font picker or size box. */
  narrow: boolean;
  /** Once the first grid is painted. */
  onAnalysis: (analysis: OfficeAnalysis) => void;
  onExporter: (exporter: OfficeExporter | null) => void;
  onFlusher: (flusher: OfficeFlusher | null) => void;
  onMenus: OfficeMenuReporter;
  onRenderer: (renderer: OfficeRenderer | null) => void;
  onPendingChange: (pending: boolean) => void;
  fileName: string;
  onSave: () => void;
  onThumbnailer: (
    thumbnailer: OfficeThumbnailer | null,
    scope?: OfficeCaptureScope
  ) => void;
  onZoomChange: (zoom: number) => void;
  /** Recovery: selection and copy only. */
  readOnly: boolean;
}) {
  const apiRef = useRef<XlsxEditorApi | null>(null);
  useEffect(() => {
    onExporter(async () => {
      if (!apiRef.current) throw new Error('Editor is still loading');
      // Settles pending input first, or throws.
      return apiRef.current.save();
    });
    onFlusher(async () => {
      if (!apiRef.current) throw new Error('Editor is still loading');
      await apiRef.current.flush();
    });
    return () => {
      onExporter(null);
      onFlusher(null);
    };
  }, [onExporter, onFlusher]);

  // Capy draws the menus and prints or saves the images: the frame has no
  // print dialog or downloads.
  const [commandState, setCommandState] = useState<XlsxCommandState | null>(
    null
  );
  useEffect(() => {
    if (!commandState) return;
    onMenus({
      menus: xlsxEditMenus(commandState, locale),
      run: (id) => runXlsxMenuItem(id, apiRef.current),
    });
  }, [commandState, locale, onMenus]);
  useEffect(() => () => onMenus(null), [onMenus]);
  const zoom = commandState?.zoom;
  useEffect(() => {
    if (zoom) onZoomChange(zoom);
  }, [onZoomChange, zoom]);
  useEffect(() => {
    onRenderer(async (kind) => {
      const api = apiRef.current;
      if (!api) throw new Error('Editor is still loading');
      const draw = api.handle.displayList;
      if (kind === 'print')
        return sheetPages(draw, await api.handle.sheetInfo());
      const viewport = api.visibleViewport();
      if (!viewport) throw new Error('Nothing to render');
      return [await viewportPage(draw, viewport)];
    });
    return () => onRenderer(null);
  }, [onRenderer]);
  // The list cards show the first sheet's top-left, so only edits made on
  // that sheet count. The workbook worker draws the active sheet alone: a
  // click on a sheet tab with first-sheet edits not drawn yet draws them
  // before the switch, and the next capture on another sheet takes that
  // drawing (once: its bytes move to Capy).
  const undrawnRef = useRef(false);
  const leftWithRef = useRef<Promise<OfficeRenderedPage | null> | null>(null);
  const onFirstSheet = () => apiRef.current?.sheetInfo()?.activeSheet === 0;
  const drawFirstSheet = useCallback(async () => {
    const api = apiRef.current;
    const first = api?.sheetInfo()?.sheetIds[0];
    if (!(api && first)) throw new Error('Editor is still loading');
    undrawnRef.current = false;
    try {
      return await sheetThumbnail(
        await api.handle.onSheet(first, 'displayList', THUMBNAIL_AREA)
      );
    } catch (error) {
      if (error instanceof SheetGoneError) return null;
      throw error;
    }
  }, []);
  useEffect(() => {
    onThumbnailer(
      () => {
        const leftWith = leftWithRef.current;
        leftWithRef.current = null;
        if (!onFirstSheet()) return leftWith ?? Promise.resolve(null);
        return drawFirstSheet();
      },
      () => {
        if (!onFirstSheet()) return false;
        undrawnRef.current = true;
        return true;
      }
    );
    return () => onThumbnailer(null);
  }, [drawFirstSheet, onThumbnailer]);
  const leavingFirstSheet = (event: PointerEvent<HTMLDivElement>) => {
    if (
      !undrawnRef.current ||
      !onFirstSheet() ||
      !(event.target instanceof Element) ||
      !event.target.closest('[role="tab"]')
    )
      return;
    const drawing = drawFirstSheet();
    // Its failure reaches the capture that sends it, if any.
    drawing.catch(() => undefined);
    leftWithRef.current = drawing;
  };

  return (
    <div
      className="office-editor-host"
      onPointerDownCapture={leavingFirstSheet}
    >
      <XlsxEditor
        className="office-editor-host"
        collaboration={collaboration}
        file={bytes}
        fileName={fileName}
        i18n={xlsxStrings(locale)}
        icons={xlsxIcons}
        initialZoom={initialZoom}
        onCommandStateChange={setCommandState}
        onFirstPaint={() => {
          const info = apiRef.current?.sheetInfo();
          if (info) onAnalysis(analyzeOpenWorkbook({ sheetInfo: () => info }));
        }}
        onPendingChange={onPendingChange}
        onReady={(api) => {
          apiRef.current = api;
          return () => {
            apiRef.current = null;
          };
        }}
        onSave={onSave}
        readOnly={readOnly}
        showCustomNumberFormat={false}
        showFontPicker={!narrow}
        showFontSizePicker={!narrow}
        showProposals={false}
        showSearchMenus={false}
        showZoomControl={!narrow}
        singleRowToolbar
      />
    </div>
  );
}
