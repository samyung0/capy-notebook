import { PptxEditor, type PptxEditorApi } from '@betteroffice/pptx-react';
import { useEffect, useRef, useState } from 'react';
import { m } from '@/i18n';
import type {
  OfficeCollaboration,
  OfficeExporter,
} from './officeCollaboration';
import { loadPptxFonts } from './pptxFonts';

export function PptxEditorHost({
  bytes,
  collaboration,
  onExporter,
  fileName,
  onError,
  onSave,
}: {
  bytes: Uint8Array;
  collaboration: OfficeCollaboration;
  onExporter: (exporter: OfficeExporter | null) => void;
  fileName: string;
  onError: (error: Error) => void;
  onSave: (bytes: Uint8Array) => void;
}) {
  const apiRef = useRef<PptxEditorApi | null>(null);
  useEffect(() => {
    onExporter(async () => {
      const api = apiRef.current;
      if (!api) throw new Error('Editor is still loading');
      return api.save();
    });
    return () => onExporter(null);
  }, [onExporter]);
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
        collaboration={collaboration}
        file={bytes}
        fileName={fileName}
        fonts={fonts}
        onError={onError}
        onReady={(api) => {
          apiRef.current = api;
        }}
        onSave={onSave}
      />
    </div>
  );
}
