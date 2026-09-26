import { XlsxEditor, type XlsxEditorApi } from '@betteroffice/xlsx-react';
import { useEffect, useRef } from 'react';
import type {
  OfficeCollaboration,
  OfficeExporter,
  OfficeFlusher,
} from './officeCollaboration';

export function XlsxEditorHost({
  bytes,
  collaboration,
  onExporter,
  onFlusher,
  onPendingChange,
  fileName,
  onSave,
}: {
  bytes: Uint8Array;
  collaboration: OfficeCollaboration;
  onExporter: (exporter: OfficeExporter | null) => void;
  onFlusher: (flusher: OfficeFlusher | null) => void;
  onPendingChange: (pending: boolean) => void;
  fileName: string;
  onSave: () => void;
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
  return (
    <div className="office-editor-host">
      <XlsxEditor
        className="office-editor-host"
        collaboration={collaboration}
        file={bytes}
        fileName={fileName}
        onPendingChange={onPendingChange}
        onReady={(api) => {
          apiRef.current = api;
          return () => {
            apiRef.current = null;
          };
        }}
        onSave={onSave}
      />
    </div>
  );
}
