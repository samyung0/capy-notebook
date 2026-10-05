import { configureDefaultFonts } from '@betteroffice/docx/layout';
import { setGoogleFontsEnabled } from '@betteroffice/docx/utils';
import {
  DOCX_PAGES_PRESENTED_EVENT,
  DocxEditor,
  type DocxEditorRef,
  type DocxMenuModel,
  type DocxPagesPresentedDetail,
} from '@betteroffice/docx-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { DOCUMENT_COLORS } from '@/components/ui/ColorPicker';
import type {
  OfficeAnalysis,
  OfficeLocale,
} from '@/features/files/officeProtocol';
import { docxIcons } from './docxIcons';
import { docxStrings, editorMenus } from './docxMenus';
import type {
  OfficeCollaboration,
  OfficeExporter,
  OfficeFlusher,
} from './officeCollaboration';
import { officeFonts, onOfficeFontFailure } from './officeFonts';
import {
  canvasPage,
  type OfficeMenuReporter,
  type OfficeRenderer,
} from './runtimeMenus';
import { readViewToggle, writeViewToggle } from './viewToggles';

// Before any editor mounts: the engine measures with the bundled faces.
configureDefaultFonts({ fonts: officeFonts });
// Fonts come only from Capy's own assets: no fonts.googleapis.com lookup.
setGoogleFontsEnabled(false);

export function DocxEditorHost({
  bytes,
  collaboration,
  colorMode,
  locale,
  narrow,
  onAnalysis,
  onExporter,
  onMenus,
  onRenderer,
  onFlusher,
  onError,
  onPendingChange,
  onSave,
  readOnly,
}: {
  bytes: Uint8Array;
  collaboration: OfficeCollaboration;
  colorMode: 'light' | 'dark';
  locale: OfficeLocale;
  /** Below lg: no zoom (as the PDF toolbar), font picker or size box. */
  narrow: boolean;
  /** Once the first pages are painted. */
  onAnalysis: (analysis: OfficeAnalysis) => void;
  onExporter: (exporter: OfficeExporter | null) => void;
  onFlusher: (flusher: OfficeFlusher | null) => void;
  onMenus: OfficeMenuReporter;
  onRenderer: (renderer: OfficeRenderer | null) => void;
  onError: (error: Error) => void;
  onPendingChange: (pending: boolean) => void;
  onSave: () => void;
  /** Recovery: selection and copy only. */
  readOnly: boolean;
}) {
  const editorRef = useRef<DocxEditorRef>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  // View › Show ruler, one choice per person for every DOCX file.
  const [ruler, setRuler] = useState(() => readViewToggle('docxRuler'));
  const showRuler = useCallback((shown: boolean) => {
    setRuler(shown);
    writeViewToggle('docxRuler', shown);
  }, []);
  useEffect(() => onOfficeFontFailure(onError), [onError]);
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const painted = (event: Event) =>
      onAnalysis({
        format: 'docx',
        pageCount: (event as CustomEvent<DocxPagesPresentedDetail>).detail
          .pageCount,
      });
    host.addEventListener(DOCX_PAGES_PRESENTED_EVENT, painted, { once: true });
    return () => host.removeEventListener(DOCX_PAGES_PRESENTED_EVENT, painted);
  }, [onAnalysis]);
  useEffect(() => {
    onExporter(async () => {
      const bytes = await editorRef.current?.save();
      if (!bytes) throw new Error('Document export failed');
      return new Uint8Array(bytes);
    });
    onFlusher(async () => {
      if (!editorRef.current) throw new Error('Editor is still loading');
      await editorRef.current.flushPendingInput();
    });
    return () => {
      onExporter(null);
      onFlusher(null);
    };
  }, [onExporter, onFlusher]);
  // Capy prints the pages: the sandboxed frame has no print dialog.
  useEffect(() => {
    onRenderer(async (kind) => {
      const editor = editorRef.current;
      if (kind !== 'print' || !editor) throw new Error('Nothing to render');
      // One page drawn and encoded at a time, as pptxRender does.
      return editor.renderPages((page) =>
        canvasPage(page.canvas, page.width, page.height)
      );
    });
    return () => onRenderer(null);
  }, [onRenderer]);
  const reportMenus = useCallback(
    (model: DocxMenuModel | null) =>
      onMenus(
        model && { menus: editorMenus(model.menus, locale), run: model.run }
      ),
    [locale, onMenus]
  );
  return (
    <div className="office-editor-host" ref={hostRef}>
      <DocxEditor
        className="office-editor-host"
        collaboration={collaboration}
        colorMode={colorMode}
        // The note toolbar's palette, as PPTX and the notes pick colours.
        colorPalette={DOCUMENT_COLORS}
        documentBuffer={bytes}
        i18n={docxStrings(locale)}
        icons={docxIcons}
        onError={onError}
        onMenus={reportMenus}
        onPendingChange={onPendingChange}
        // File > Save and Ctrl/Cmd+S request the checkpoint; nothing serializes.
        onSaveRequest={() => {
          onSave();
        }}
        onShowRulerChange={showRuler}
        readOnly={readOnly}
        ref={editorRef}
        showFileOpen={false}
        showFontPicker={!narrow}
        showFontSizePicker={!narrow}
        showHelpMenu={false}
        showRuler={ruler}
        showZoomControl={!narrow}
        singleRowToolbar
      />
    </div>
  );
}
