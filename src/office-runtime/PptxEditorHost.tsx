import { PptxEditor, type PptxEditorApi } from '@betteroffice/pptx-react';
import { useEffect, useRef, useState } from 'react';
import { m } from '@/i18n';
import type {
  OfficeCollaboration,
  OfficeExporter,
  OfficeFlusher,
} from './officeCollaboration';
import { loadPptxFonts } from './pptxFonts';

export function PptxEditorHost({
  bytes,
  collaboration,
  onExporter,
  onFlusher,
  fileName,
  onError,
  onSave,
}: {
  bytes: Uint8Array;
  collaboration: OfficeCollaboration;
  onExporter: (exporter: OfficeExporter | null) => void;
  onFlusher: (flusher: OfficeFlusher | null) => void;
  fileName: string;
  onError: (error: Error) => void;
  onSave: () => void;
}) {
  const apiRef = useRef<PptxEditorApi | null>(null);
  useEffect(() => {
    onExporter(async () => {
      const api = apiRef.current;
      if (!api) throw new Error('Editor is still loading');
      // save() refuses while accepted input is still pending.
      await api.flushPendingInput();
      return api.save();
    });
    onFlusher(async () => {
      if (!apiRef.current) throw new Error('Editor is still loading');
      await apiRef.current.flushPendingInput();
    });
    return () => {
      onExporter(null);
      onFlusher(null);
    };
  }, [onExporter, onFlusher]);
  useEffect(() => {
    if (!(import.meta.env.DEV && import.meta.env.VITE_USE_MSW !== 'false'))
      return;
    // The canvas requires trusted pointer capture. Use the same native text
    // command for this developer journey, then its ordinary replica broadcast.
    const editScenario = (event: Event) => {
      const api = apiRef.current;
      const text: unknown = (event as CustomEvent).detail;
      const story = api?.handle
        .snapshot()
        .slides[0]?.shapes.flatMap((shape) => shape.textStories)[0];
      if (!api || !story || typeof text !== 'string') return;
      api.handle.insertText(story.id, 0, text);
      api.refresh();
    };
    window.addEventListener('capy-scenario-edit-slide', editScenario);
    return () =>
      window.removeEventListener('capy-scenario-edit-slide', editScenario);
  }, []);
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
        // The save button and Ctrl/Cmd+S request the checkpoint; nothing serializes.
        onSaveRequest={() => {
          onSave();
        }}
      />
    </div>
  );
}
