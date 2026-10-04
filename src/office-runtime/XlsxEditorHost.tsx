import {
  type XlsxCommandState,
  XlsxEditor,
  type XlsxEditorApi,
} from '@betteroffice/xlsx-react';
import { useEffect, useRef, useState } from 'react';
import type { OfficeLocale } from '@/features/files/officeProtocol';
import type {
  OfficeCollaboration,
  OfficeExporter,
  OfficeFlusher,
} from './officeCollaboration';
import type { OfficeMenuReporter, OfficeRenderer } from './runtimeMenus';
import { xlsxIcons } from './xlsxIcons';
import { runXlsxMenuItem, xlsxEditMenus, xlsxStrings } from './xlsxMenus';
import { sheetPages, viewportPage } from './xlsxRender';
import './xlsx-runtime.css';

export function XlsxEditorHost({
  bytes,
  collaboration,
  locale,
  onExporter,
  onFlusher,
  onMenus,
  onRenderer,
  narrow,
  onPendingChange,
  fileName,
  onSave,
  readOnly,
}: {
  bytes: Uint8Array;
  collaboration: OfficeCollaboration;
  locale: OfficeLocale;
  /** Below lg: no zoom (as the PDF toolbar), font picker or size box. */
  narrow: boolean;
  onExporter: (exporter: OfficeExporter | null) => void;
  onFlusher: (flusher: OfficeFlusher | null) => void;
  onMenus: OfficeMenuReporter;
  onRenderer: (renderer: OfficeRenderer | null) => void;
  onPendingChange: (pending: boolean) => void;
  fileName: string;
  onSave: () => void;
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
    onFlusher(() => {
      if (!apiRef.current) throw new Error('Editor is still loading');
      apiRef.current.flush();
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
  useEffect(() => {
    onRenderer(async (kind) => {
      const api = apiRef.current;
      if (!api) throw new Error('Editor is still loading');
      const draw = api.handle.displayList.bind(api.handle);
      if (kind === 'print') return sheetPages(draw, api.handle.sheetInfo());
      const viewport = api.visibleViewport();
      if (!viewport) throw new Error('Nothing to render');
      return [await viewportPage(draw, viewport)];
    });
    return () => onRenderer(null);
  }, [onRenderer]);

  return (
    <div className="office-editor-host">
      <XlsxEditor
        className="office-editor-host"
        collaboration={collaboration}
        file={bytes}
        fileName={fileName}
        i18n={xlsxStrings(locale)}
        icons={xlsxIcons}
        onCommandStateChange={setCommandState}
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
