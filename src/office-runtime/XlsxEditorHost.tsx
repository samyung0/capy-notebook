import { XlsxEditor, type XlsxEditorApi } from '@betteroffice/xlsx-react';
import { useRef } from 'react';

export function XlsxEditorHost({
  bytes,
  fileName,
  onDirty,
  onSave,
}: {
  bytes: Uint8Array;
  fileName: string;
  onDirty: () => void;
  onSave: (bytes: Uint8Array) => void;
}) {
  const apiRef = useRef<XlsxEditorApi | null>(null);
  return (
    <div className="office-editor-host">
      <XlsxEditor
        className="office-editor-host"
        file={bytes}
        fileName={fileName}
        onChange={onDirty}
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
