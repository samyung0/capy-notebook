import { configureDefaultFonts } from '@betteroffice/docx/layout';
import { DocxEditor, type DocxEditorRef } from '@betteroffice/docx-react';
import { useEffect, useRef } from 'react';
import type {
  OfficeCollaboration,
  OfficeExporter,
  OfficeFlusher,
} from './officeCollaboration';
import { officeFonts, onOfficeFontFailure } from './officeFonts';

// Before any editor mounts: the engine measures with the bundled faces.
configureDefaultFonts({ fonts: officeFonts });

export function DocxEditorHost({
  bytes,
  collaboration,
  onExporter,
  onFlusher,
  onError,
  onSave,
}: {
  bytes: Uint8Array;
  collaboration: OfficeCollaboration;
  onExporter: (exporter: OfficeExporter | null) => void;
  onFlusher: (flusher: OfficeFlusher | null) => void;
  onError: (error: Error) => void;
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
        disableFindReplaceShortcuts
        documentBuffer={bytes}
        onError={onError}
        // File > Save and Ctrl/Cmd+S request the checkpoint; nothing serializes.
        onSaveRequest={() => {
          onSave();
        }}
        readOnly={false}
        ref={editorRef}
        showFileOpen={false}
        showHelpMenu={false}
      />
    </div>
  );
}
