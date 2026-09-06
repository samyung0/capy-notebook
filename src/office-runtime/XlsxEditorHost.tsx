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
  onSave: (bytes: Uint8Array) => void;
}) {
  const apiRef = useRef<XlsxEditorApi | null>(null);
  useEffect(() => {
    onExporter(async () => {
      const api = apiRef.current;
      if (!api) throw new Error('Editor is still loading');
      api.flush();
      return api.handle.save();
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
