import { PptxEditor, type PptxEditorApi } from '@betteroffice/pptx-react';
import { useEffect, useRef, useState } from 'react';
import { m } from '@/i18n';
import { loadPptxFonts } from './pptxFonts';

export function PptxEditorHost({
  bytes,
  fileName,
  onDirty,
  onError,
  onSave,
}: {
  bytes: Uint8Array;
  fileName: string;
  onDirty: () => void;
  onError: (error: Error) => void;
  onSave: (bytes: Uint8Array) => void;
}) {
  const apiRef = useRef<PptxEditorApi | null>(null);
  const [fonts, setFonts] = useState<Awaited<
    ReturnType<typeof loadPptxFonts>
  > | null>(null);

  useEffect(() => {
    let cancelled = false;
    void loadPptxFonts().then(
      (loaded) => {
        if (!cancelled) setFonts(loaded);
      },
      (value: unknown) => {
        if (!cancelled)
          onError(value instanceof Error ? value : new Error(String(value)));
      }
    );
    return () => {
      cancelled = true;
      apiRef.current = null;
    };
  }, [onError]);

  if (!fonts)
    return (
      <div className="office-runtime-state">
        {m.files_office_runtime_loading_editor()}
      </div>
    );
  return (
    <div className="office-editor-host">
      <PptxEditor
        className="office-editor-host"
        file={bytes}
        fileName={fileName}
        fonts={fonts}
        onChange={onDirty}
        onError={onError}
        onReady={(api) => {
          apiRef.current = api;
        }}
        onSave={onSave}
      />
    </div>
  );
}
