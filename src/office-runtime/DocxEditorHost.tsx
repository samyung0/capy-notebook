import { DocxEditor, type DocxEditorRef } from '@betteroffice/docx-react';
import { useEffect, useRef } from 'react';
import type {
  OfficeCollaboration,
  OfficeExporter,
} from './officeCollaboration';

export function DocxEditorHost({
  bytes,
  collaboration,
  onExporter,
  onError,
  onSave,
}: {
  bytes: Uint8Array;
  collaboration: OfficeCollaboration;
  onExporter: (exporter: OfficeExporter | null) => void;
  onError: (error: Error) => void;
  onSave: (bytes: Uint8Array) => void;
}) {
  const editorRef = useRef<DocxEditorRef>(null);
  useEffect(() => {
    onExporter(async () => {
      const bytes = await editorRef.current?.save();
      if (!bytes) throw new Error('Document export failed');
      return new Uint8Array(bytes);
    });
    return () => onExporter(null);
  }, [onExporter]);
  return (
    <div className="office-editor-host">
      <DocxEditor
        className="office-editor-host"
        collaboration={collaboration}
        disableFindReplaceShortcuts
        documentBuffer={bytes}
        onError={onError}
        onSave={(buffer) => onSave(new Uint8Array(buffer))}
        readOnly={false}
        ref={editorRef}
        showFileOpen={false}
        showHelpMenu={false}
      />
    </div>
  );
}
