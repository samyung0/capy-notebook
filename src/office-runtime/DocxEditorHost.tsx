import { configureDefaultFonts } from '@betteroffice/docx/layout';
import { setGoogleFontsEnabled } from '@betteroffice/docx/utils';
import { DocxEditor, type DocxEditorRef } from '@betteroffice/docx-react';
import { useEffect, useRef } from 'react';
import { docxIcons } from './docxIcons';
import type {
  OfficeCollaboration,
  OfficeExporter,
  OfficeFlusher,
} from './officeCollaboration';
import { officeFonts, onOfficeFontFailure } from './officeFonts';

// Before any editor mounts: the engine measures with the bundled faces.
configureDefaultFonts({ fonts: officeFonts });
// Fonts come only from Capy's own assets: no fonts.googleapis.com lookup.
setGoogleFontsEnabled(false);

export function DocxEditorHost({
  bytes,
  collaboration,
  colorMode,
  narrow,
  onExporter,
  onFlusher,
  onError,
  onPendingChange,
  onSave,
}: {
  bytes: Uint8Array;
  collaboration: OfficeCollaboration;
  colorMode: 'light' | 'dark';
  /** Below lg: no zoom (as the PDF toolbar), font picker or size box. */
  narrow: boolean;
  onExporter: (exporter: OfficeExporter | null) => void;
  onFlusher: (flusher: OfficeFlusher | null) => void;
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
  return (
    <div className="office-editor-host">
      <DocxEditor
        className="office-editor-host"
        collaboration={collaboration}
        colorMode={colorMode}
        disableFindReplaceShortcuts
        documentBuffer={bytes}
        icons={docxIcons}
        onError={onError}
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
