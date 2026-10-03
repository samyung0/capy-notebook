import { configureDefaultFonts } from '@betteroffice/docx/layout';
import { setGoogleFontsEnabled } from '@betteroffice/docx/utils';
import {
  DocxEditor,
  type DocxEditorRef,
  type DocxMenuModel,
} from '@betteroffice/docx-react';
import { useCallback, useEffect, useRef } from 'react';
import { DOCUMENT_COLORS } from '@/components/ui/ColorPicker';
import type { OfficeLocale } from '@/features/files/officeProtocol';
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
  onExporter,
  onMenus,
  onRenderer,
  onFlusher,
  onError,
  onPendingChange,
  onSave,
}: {
  bytes: Uint8Array;
  collaboration: OfficeCollaboration;
  colorMode: 'light' | 'dark';
  locale: OfficeLocale;
  /** Below lg: no zoom (as the PDF toolbar), font picker or size box. */
  narrow: boolean;
  onExporter: (exporter: OfficeExporter | null) => void;
  onFlusher: (flusher: OfficeFlusher | null) => void;
  onMenus: OfficeMenuReporter;
  onRenderer: (renderer: OfficeRenderer | null) => void;
  onError: (error: Error) => void;
  onPendingChange: (pending: boolean) => void;
  onSave: () => void;
}) {
  const editorRef = useRef<DocxEditorRef>(null);
  useEffect(() => onOfficeFontFailure(onError), [onError]);
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
    <div className="office-editor-host">
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
        readOnly={false}
        ref={editorRef}
        showFileOpen={false}
        showFontPicker={!narrow}
        showFontSizePicker={!narrow}
        showHelpMenu={false}
        showZoomControl={!narrow}
        singleRowToolbar
      />
    </div>
  );
}
