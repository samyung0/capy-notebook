import { DocxEditor } from '@betteroffice/docx-react';

export function DocxEditorHost({
  bytes,
  onDirty,
  onError,
  onSave,
}: {
  bytes: Uint8Array;
  onDirty: () => void;
  onError: (error: Error) => void;
  onSave: (bytes: Uint8Array) => void;
}) {
  return (
    <div className="office-editor-host">
      <DocxEditor
        className="office-editor-host"
        disableFindReplaceShortcuts
        documentBuffer={bytes}
        onChange={onDirty}
        onError={onError}
        onSave={(buffer) => onSave(new Uint8Array(buffer))}
        readOnly={false}
        showFileOpen={false}
        showHelpMenu={false}
      />
    </div>
  );
}
