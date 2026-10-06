import { analyzeOpenPresentation } from '@betteroffice/pptx/viewer';
import {
  type PptxCommandState,
  PptxEditor,
  type PptxEditorApi,
} from '@betteroffice/pptx-react';
import { useEffect, useRef, useState } from 'react';
import type {
  OfficeAnalysis,
  OfficeLocale,
} from '@/features/files/officeProtocol';
import { m } from '@/i18n';
import { PRESENTER_VIEW, type RuntimeNotesWindow } from './notesWindow';
import type {
  OfficeCollaboration,
  OfficeExporter,
  OfficeFlusher,
} from './officeCollaboration';
import { editorMenus, splitCommand } from './pptxEditorMenus';
import { loadPptxFonts } from './pptxFonts';
import { pptxIcons } from './pptxIcons';
import { pptxStrings, presentAction } from './pptxMenus';
import { renderSlides } from './pptxRender';
import type { OfficeMenuReporter, OfficeRenderer } from './runtimeMenus';
import {
  readNotesSize,
  readViewToggle,
  writeNotesSize,
  writeViewToggle,
} from './viewToggles';
import './pptx-runtime.css';

export function PptxEditorHost({
  bytes,
  collaboration,
  onExporter,
  onFlusher,
  fileName,
  locale,
  narrow,
  onAnalysis,
  onError,
  onMenus,
  onPendingChange,
  onPresentingChange,
  onRenderer,
  onSave,
  presenter,
  readOnly,
}: {
  bytes: Uint8Array;
  collaboration: OfficeCollaboration;
  onExporter: (exporter: OfficeExporter | null) => void;
  onFlusher: (flusher: OfficeFlusher | null) => void;
  fileName: string;
  locale: OfficeLocale;
  /** Below lg: no zoom (as the PDF toolbar), font picker or size box. */
  narrow: boolean;
  /** Once the first slide is painted, pictures included. */
  onAnalysis: (analysis: OfficeAnalysis) => void;
  onError: (error: Error) => void;
  onMenus: OfficeMenuReporter;
  onPendingChange: (pending: boolean) => void;
  onPresentingChange: (presenting: boolean) => void;
  onRenderer: (renderer: OfficeRenderer | null) => void;
  onSave: () => void;
  /** Presenter view's notes window, which Capy opens. */
  presenter: RuntimeNotesWindow;
  /** Recovery: selection and copy only. */
  readOnly: boolean;
}) {
  const apiRef = useRef<PptxEditorApi | null>(null);
  const [commandState, setCommandState] = useState<PptxCommandState | null>(
    null
  );
  // Read once: the editor only takes them as its starting state.
  const [speakerNotes] = useState(() => readViewToggle('speakerNotes'));
  const [notesSize] = useState(readNotesSize);
  // The header's menus and Present run the editor's commands; Insert › Image
  // arrives with the file Capy's picker chose.
  useEffect(() => {
    if (!commandState) return;
    onMenus({
      actions: [presentAction(locale)],
      menus: editorMenus(commandState, locale),
      run: (id, value, file) => {
        const api = apiRef.current;
        if (!api) return;
        // Capy opened the notes window: the show starts (or keeps going) here.
        if (id === PRESENTER_VIEW) {
          presenter.expect(value ?? '');
          api.runCommand('view.present');
          return;
        }
        if (file) {
          if (id === 'insert.image')
            void file
              .arrayBuffer()
              .then((buffer) =>
                api.insertImage(new Uint8Array(buffer), file.name)
              )
              // The editor reports its own insert failures.
              .catch(() => {});
          return;
        }
        api.runCommand(...splitCommand(id));
      },
    });
  }, [commandState, locale, onMenus, presenter]);
  useEffect(() => () => onMenus(null), [onMenus]);
  // Capy prints the slides and saves the PNG: the sandboxed frame can do neither.
  useEffect(() => {
    onRenderer(async (kind) => {
      const api = apiRef.current;
      if (!(api && commandState)) throw new Error('Editor is still loading');
      const count = api.handle.snapshot().slides.length;
      return renderSlides(
        api.handle,
        kind === 'png'
          ? [commandState.slideIndex]
          : Array.from({ length: count }, (_, index) => index)
      );
    });
    return () => onRenderer(null);
  }, [commandState, onRenderer]);
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
        defaultPresenterNotesSize={notesSize}
        defaultSpeakerNotes={speakerNotes}
        file={bytes}
        fileName={fileName}
        fonts={fonts}
        i18n={pptxStrings(locale)}
        icons={pptxIcons}
        notesWindow={presenter.notes}
        onCommandState={setCommandState}
        onError={onError}
        // The deck the editor already holds: no second snapshot from the engine.
        onFirstPaint={(snapshot) =>
          onAnalysis(analyzeOpenPresentation({ snapshot: () => snapshot }))
        }
        onPendingChange={onPendingChange}
        onPresenterNotesSizeChange={writeNotesSize}
        onPresentingChange={onPresentingChange}
        onReady={(api) => {
          apiRef.current = api;
        }}
        // The save button and Ctrl/Cmd+S request the checkpoint; nothing serializes.
        onSaveRequest={() => {
          onSave();
        }}
        onSpeakerNotesChange={(visible) =>
          writeViewToggle('speakerNotes', visible)
        }
        readOnly={readOnly}
        // Present is a header action and Capy has no PPTX agent proposals.
        showFontPicker={!narrow}
        showFontSizePicker={!narrow}
        showPresentButton={false}
        showProposals={false}
        showZoomControl={!narrow}
        singleRowToolbar
      />
    </div>
  );
}
