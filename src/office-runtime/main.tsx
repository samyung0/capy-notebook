import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createRoot } from 'react-dom/client';
import {
  isOfficeHostMessage,
  OFFICE_PROTOCOL_VERSION,
  type OfficeAnalysis,
  type OfficeCitation,
  type OfficeFormat,
  type OfficeHostMessage,
  type OfficeLocale,
  type OfficeMode,
  type OfficeRuntimePayload,
} from '@/features/files/officeProtocol';
import {
  parentOriginFromRuntimeUrl,
  presenterTokenFromUrl,
} from '@/features/files/officeRuntimeConfig';
import { m, setLocale } from '@/i18n';
import { THEMES } from '@/theme/theme';
import { exportCheckpoint } from './exportCheckpoint';
import type {
  OfficeExporter,
  OfficeFlusher,
  OfficeReplica,
} from './officeCollaboration';
import { handOverPresenterWindow, PRESENTER_VIEW } from './presenterWindow';
import {
  type OfficeMenuSource,
  type OfficeRenderer,
  pausedMenus,
  runsWhilePaused,
} from './runtimeMenus';
import '../../vendor/betteroffice/packages/docx-react/dist/styles.css';
// After docx-react's styles: its variables are overridden with Capy's.
import './office-runtime.css';

const parentOrigin = parentOriginFromRuntimeUrl();

const DocxViewer = lazy(() =>
  import('./DocxViewer').then((module) => ({ default: module.DocxViewer }))
);

const XlsxViewer = lazy(() =>
  import('./XlsxViewer').then((module) => ({ default: module.XlsxViewer }))
);
const PptxViewer = lazy(() =>
  import('./PptxViewer').then((module) => ({ default: module.PptxViewer }))
);
const XlsxEditorHost = lazy(() =>
  import('./XlsxEditorHost').then((module) => ({
    default: module.XlsxEditorHost,
  }))
);
const PptxEditorHost = lazy(() =>
  import('./PptxEditorHost').then((module) => ({
    default: module.PptxEditorHost,
  }))
);
const DocxEditorHost = lazy(() =>
  import('./DocxEditorHost').then((module) => ({
    default: module.DocxEditorHost,
  }))
);

interface LoadedFile {
  bytes: Uint8Array;
  epoch?: number;
  fileName: string;
  format: OfficeFormat;
  initialUpdate?: Uint8Array;
  revision: number;
}

function OfficeRuntime() {
  const [file, setFile] = useState<LoadedFile | null>(null);
  const [citation, setCitation] = useState<OfficeCitation | null>(null);
  const [mode, setMode] = useState<OfficeMode>('view');
  const [dark, setDark] = useState(false);
  const [narrow, setNarrow] = useState(false);
  const [locale, setLocaleState] = useState<OfficeLocale>('en');
  const menuSourceRef = useRef<OfficeMenuSource | null>(null);
  const rendererRef = useRef<OfficeRenderer | null>(null);
  const revisionRef = useRef<number | null>(null);
  // PPTX Presenter view: Capy opens the notes window, even from a click here.
  const askPresenter = useCallback(() => {
    if (revisionRef.current !== null)
      post({
        id: PRESENTER_VIEW,
        revision: revisionRef.current,
        type: 'open-presenter',
      });
  }, []);
  const reportPresenting = useCallback((presenting: boolean) => {
    if (revisionRef.current !== null)
      post({ presenting, revision: revisionRef.current, type: 'presenting' });
  }, []);
  // When `load` arrived, for the ready timings.
  const loadedAtRef = useRef(0);
  const epochRef = useRef<number | null>(null);
  const replicaRef = useRef<OfficeReplica | null>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);
  const pendingUpdates = useRef<Uint8Array[]>([]);
  const exporterRef = useRef<OfficeExporter | null>(null);
  const flusherRef = useRef<OfficeFlusher | null>(null);
  const pausedRef = useRef(false);
  const composingRef = useRef(false);
  const pointersRef = useRef(new Set<number>());
  const hostPendingRef = useRef(false);
  const interactionWaiters = useRef<(() => void)[]>([]);
  const reportPending = useCallback(() => {
    const revision = revisionRef.current;
    if (revision !== null)
      post({
        dirty:
          hostPendingRef.current ||
          composingRef.current ||
          pointersRef.current.size > 0,
        revision,
        type: 'dirty',
      });
  }, []);
  const reportHostPending = useCallback(
    (pending: boolean) => {
      hostPendingRef.current = pending;
      reportPending();
    },
    [reportPending]
  );
  const reportFlusher = useCallback((flusher: OfficeFlusher | null) => {
    flusherRef.current = flusher;
  }, []);
  const finishInteraction = useCallback(() => {
    queueMicrotask(() =>
      queueMicrotask(() => {
        reportPending();
        if (!composingRef.current && !pointersRef.current.size) {
          for (const resolve of interactionWaiters.current.splice(0)) resolve();
        }
      })
    );
  }, [reportPending]);
  const flush = useCallback(async () => {
    if (composingRef.current || pointersRef.current.size) {
      await new Promise<void>((resolve) =>
        interactionWaiters.current.push(resolve)
      );
    }
    await flusherRef.current?.();
  }, []);
  // Every pause (handoff, replaced, recovery, connecting, discarding) puts
  // the editor in its read-only mode: selecting and copying work, nothing
  // edits. Until that mode reaches the editor, the gates below hold input.
  const [readOnly, setReadOnly] = useState(false);
  const readOnlyRef = useRef(false);
  useLayoutEffect(() => {
    readOnlyRef.current = readOnly;
  }, [readOnly]);
  const holding = () => pausedRef.current && !readOnlyRef.current;
  // The host's narrowed canEdit, kept for a `load` that comes after it (a
  // runtime that boots before the source loads gets set-capabilities first).
  const canEditRef = useRef<boolean | null>(null);
  // Only an editor pauses; a viewer has nothing to edit.
  const pausedFor = (canEdit: boolean) => epochRef.current !== null && !canEdit;
  const reportExporter = useCallback((exporter: OfficeExporter | null) => {
    exporterRef.current = exporter;
  }, []);
  const reportRenderer = useCallback((renderer: OfficeRenderer | null) => {
    rendererRef.current = renderer;
  }, []);
  // Editors re-report their menus as selection state changes: the host gets
  // the latest once things settle, and only when it differs.
  const menusSent = useRef('');
  const menusTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // An editor's menus wait for its replica, as the old Save button did:
  // anything in them (File › Save first) can then reach the room.
  const sendMenus = useCallback(() => {
    if (menusTimer.current) clearTimeout(menusTimer.current);
    menusTimer.current = setTimeout(() => {
      const revision = revisionRef.current;
      const current = menuSourceRef.current;
      if (
        revision === null ||
        (epochRef.current !== null && !replicaRef.current)
      )
        return;
      const menus = current?.menus ?? [];
      // A paused editor lists its editing items disabled (File › Save too).
      const editing = epochRef.current !== null;
      const payload = {
        actions: current?.actions ?? [],
        menus: editing && pausedRef.current ? pausedMenus(menus) : menus,
      };
      const text = JSON.stringify(payload);
      if (text === menusSent.current) return;
      menusSent.current = text;
      post({ ...payload, revision, type: 'menus' });
    }, 50);
  }, []);
  const reportMenus = useCallback(
    (source: OfficeMenuSource | null) => {
      menuSourceRef.current = source;
      sendMenus();
    },
    [sendMenus]
  );
  const reportReplica = useCallback(
    (replica: OfficeReplica | null) => {
      unsubscribeRef.current?.();
      replicaRef.current = replica;
      if (!replica) return;
      for (const update of pendingUpdates.current.splice(0))
        replica.applyUpdate(update);
      const revision = revisionRef.current,
        epoch = epochRef.current;
      if (revision === null || epoch === null) return;
      unsubscribeRef.current = replica.onUpdate((update, origin) => {
        if (origin !== 'local') return;
        const bytes = update.slice().buffer;
        post({ bytes, epoch, revision, type: 'update' }, [bytes]);
      });
      const bytes = replica.encodeStateAsUpdate().slice().buffer;
      post({ bytes, epoch, revision, type: 'collaboration-ready' }, [bytes]);
      sendMenus();
    },
    [sendMenus]
  );
  const collaboration = useMemo(
    () =>
      file?.initialUpdate
        ? {
            // Never 0, the client the DOCX seed is written under (Yrs does
            // not move a colliding id).
            clientId: crypto.getRandomValues(new Uint32Array(1))[0] || 1,
            initialUpdate: file.initialUpdate,
            onReplica: reportReplica,
          }
        : null,
    [file?.initialUpdate, reportReplica]
  );

  useEffect(() => {
    let failScenarioExport = false;
    const armScenarioExport = () => {
      failScenarioExport = true;
    };
    if (import.meta.env.DEV && import.meta.env.VITE_USE_MSW !== 'false')
      window.addEventListener(
        'capy-scenario-export-failure',
        armScenarioExport
      );
    const receive = (event: MessageEvent<unknown>) => {
      if (
        event.source !== window.parent ||
        !parentOrigin ||
        event.origin !== parentOrigin
      )
        return;
      if (!isOfficeHostMessage(event.data)) return;
      void handleHostMessage(event.data).catch((error: unknown) => {
        if (revisionRef.current !== null)
          post({
            message: error instanceof Error ? error.message : String(error),
            revision: revisionRef.current,
            type: 'error',
          });
      });
    };
    const handleHostMessage = async (message: OfficeHostMessage) => {
      if (message.type === 'set-appearance') {
        // Selects Capy's role tokens imported in office-runtime.css.
        document.documentElement.dataset.style = message.style;
        document.documentElement.dataset.theme = message.theme;
        document.documentElement.lang = message.locale;
        // The runtime's own copy and the editors' labels follow Capy's locale.
        setLocale(message.locale, { reload: false });
        setLocaleState(message.locale);
        setDark(
          THEMES.some((theme) => theme.value === message.theme && theme.isDark)
        );
        setNarrow(message.narrow);
        // Below lg, for CSS that keeps clear of Capy's floating tools button.
        document.documentElement.toggleAttribute('data-narrow', message.narrow);
        return;
      }
      if (message.type === 'load') {
        const nextMode =
          message.mode === 'edit' && message.canEdit ? 'edit' : 'view';
        if (revisionRef.current !== null) return;
        loadedAtRef.current = performance.now();
        revisionRef.current = message.revision;
        epochRef.current = message.collaboration?.epoch ?? null;
        pausedRef.current = pausedFor(canEditRef.current ?? message.canEdit);
        setReadOnly(pausedRef.current);
        setMode(nextMode);
        setCitation(nextMode === 'view' ? (message.citation ?? null) : null);
        const bytes =
          nextMode === 'view' && message.checkpoint
            ? await exportCheckpoint(
                message.format,
                message.bytes,
                message.checkpoint,
                message.checkpointSeedSHA256
              )
            : new Uint8Array(message.bytes);
        setFile({
          bytes,
          epoch: message.collaboration?.epoch,
          fileName: message.fileName,
          format: message.format,
          initialUpdate: message.collaboration
            ? new Uint8Array(message.collaboration.initialUpdate)
            : undefined,
          revision: message.revision,
        });
        post({ mode: nextMode, revision: message.revision, type: 'mode' });
        return;
      }
      if (message.type === 'set-citation') {
        setCitation(message.citation);
        return;
      }
      if (
        (message.type === 'menu-command' || message.type === 'menu-file') &&
        epochRef.current !== null &&
        pausedRef.current &&
        !runsWhilePaused(menuSourceRef.current, message.id)
      )
        return;
      if (message.type === 'menu-command') {
        menuSourceRef.current?.run(message.id, message.value);
        return;
      }
      if (message.type === 'menu-file') {
        const file = new File([message.bytes], message.name, {
          type: message.mimeType,
        });
        menuSourceRef.current?.run(message.id, undefined, file);
        return;
      }
      if (message.type === 'render' && revisionRef.current !== null) {
        const revision = revisionRef.current;
        // A failed print is its own reply: the document stays open and usable.
        let rendered: Awaited<ReturnType<OfficeRenderer>>;
        try {
          const renderer = rendererRef.current;
          if (!renderer) throw new Error('Nothing to render yet');
          // As export: what is being typed reaches the pages first.
          await flush();
          rendered = await renderer(message.kind);
        } catch {
          post({ id: message.id, revision, type: 'render-failed' });
          return;
        }
        const { pages, truncated } = Array.isArray(rendered)
          ? { pages: rendered, truncated: false }
          : rendered;
        post(
          { id: message.id, pages, revision, truncated, type: 'rendered' },
          pages.map((page) => page.bytes)
        );
        return;
      }
      if (message.type === 'set-capabilities') {
        canEditRef.current = message.canEdit;
        pausedRef.current = pausedFor(message.canEdit);
        sendMenus();
        if (pausedRef.current) await flush();
        // The latest pause state: a message that came during the flush set it.
        setReadOnly(pausedRef.current);
        return;
      }
      if (message.type === 'update' && message.epoch === epochRef.current) {
        const update = new Uint8Array(message.bytes);
        if (replicaRef.current) replicaRef.current.applyUpdate(update);
        else pendingUpdates.current.push(update);
        return;
      }
      if (
        message.type === 'flush' &&
        message.epoch === epochRef.current &&
        replicaRef.current &&
        revisionRef.current !== null
      ) {
        await flush();
        const bytes = replicaRef.current.encodeStateAsUpdate().slice().buffer;
        post(
          {
            bytes,
            epoch: message.epoch,
            id: message.id,
            revision: revisionRef.current,
            type: 'flushed',
          },
          [bytes]
        );
        return;
      }
      // Pending input lands, as a press elsewhere in the editor lands it; an
      // editor still loading has none. Nobody asked to save here: input the
      // editor refuses stays its own error (a real Save still reports it).
      if (message.type === 'focus-left') {
        if (replicaRef.current) await flush().catch(() => {});
        return;
      }
      if (
        message.type === 'export' &&
        exporterRef.current &&
        revisionRef.current !== null
      ) {
        await flush();
        const revision = revisionRef.current;
        if (failScenarioExport) {
          failScenarioExport = false;
          throw new Error(
            'The document could not be exported. Your edits are still here.'
          );
        }
        void exporterRef
          .current()
          .then((exported) => {
            const bytes = exported.slice().buffer;
            post({ bytes, id: message.id, revision, type: 'exported' }, [
              bytes,
            ]);
          })
          .catch((error: unknown) =>
            post({
              message: error instanceof Error ? error.message : String(error),
              revision,
              type: 'error',
            })
          );
      }
    };
    const finishPointer = (event: PointerEvent) => {
      pointersRef.current.delete(event.pointerId);
      finishInteraction();
    };
    window.addEventListener('pointerup', finishPointer);
    window.addEventListener('pointercancel', finishPointer);
    window.addEventListener('message', receive);
    post({ type: 'initialized' });
    return () => {
      window.removeEventListener('pointerup', finishPointer);
      window.removeEventListener('pointercancel', finishPointer);
      window.removeEventListener('message', receive);
      window.removeEventListener(
        'capy-scenario-export-failure',
        armScenarioExport
      );
      unsubscribeRef.current?.();
    };
  }, []);

  const runtimeRevision = file?.revision;
  const reportError = useCallback(
    (value: Error) => {
      if (runtimeRevision === undefined) return;
      post({
        message: value.message,
        revision: runtimeRevision,
        type: 'error',
      });
    },
    [runtimeRevision]
  );
  const reportAnalysis = useCallback(
    (analysis: OfficeAnalysis) => {
      if (runtimeRevision === undefined) return;
      // Every caller reports once its first paint is done, so the timings end there.
      const timings = {
        loadMs: Math.round(loadedAtRef.current),
        paintMs: Math.round(performance.now() - loadedAtRef.current),
      };
      post({ analysis, revision: runtimeRevision, timings, type: 'ready' });
    },
    [runtimeRevision]
  );

  // View mode downloads what it shows: the saved state it opened.
  useEffect(() => {
    if (mode !== 'view' || !file) return;
    const bytes = file.bytes;
    exporterRef.current = async () => bytes;
    return () => {
      exporterRef.current = null;
    };
  }, [file, mode]);

  if (!file)
    return (
      <div className="office-runtime-state">
        {m.files_office_runtime_loading_file()}
      </div>
    );

  // Ctrl/Cmd+S and the editors' own Save; a paused editor saves nothing, as
  // its File › Save is disabled.
  const save = () => {
    if (!pausedRef.current)
      post({ revision: file.revision, type: 'checkpoint' });
  };

  return (
    <div
      className="office-editor-host"
      onBeforeInputCapture={(event) => {
        // Held until the editor is read-only (a composition begun before the
        // pause may finish: the pause flush waits for it). Then the editor
        // refuses text itself, and Find's field and the like take it.
        if (holding() && !composingRef.current) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
      onCompositionEndCapture={() => {
        composingRef.current = false;
        finishInteraction();
      }}
      onCompositionStartCapture={() => {
        if (pausedRef.current) return;
        composingRef.current = true;
        reportPending();
      }}
      onKeyDownCapture={(event) => {
        // A read-only editor takes its own keys (Tab and Escape included).
        if (holding() && !composingRef.current) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        if (
          (event.ctrlKey || event.metaKey) &&
          event.key.toLowerCase() === 's'
        ) {
          event.preventDefault();
          event.stopPropagation();
          save();
        }
      }}
      onPointerCancelCapture={(event) => {
        pointersRef.current.delete(event.pointerId);
        finishInteraction();
      }}
      onPointerDownCapture={(event) => {
        if (holding()) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        pointersRef.current.add(event.pointerId);
        reportPending();
      }}
      onPointerUpCapture={(event) => {
        pointersRef.current.delete(event.pointerId);
        finishInteraction();
      }}
    >
      <Suspense
        fallback={
          <div className="office-runtime-state">
            {m.files_office_runtime_loading()}
          </div>
        }
      >
        {mode === 'edit' && collaboration ? (
          file.format === 'docx' ? (
            <DocxEditorHost
              bytes={file.bytes}
              collaboration={collaboration}
              colorMode={dark ? 'dark' : 'light'}
              locale={locale}
              narrow={narrow}
              onAnalysis={reportAnalysis}
              onError={reportError}
              onExporter={reportExporter}
              onFlusher={reportFlusher}
              onMenus={reportMenus}
              onPendingChange={reportHostPending}
              onRenderer={reportRenderer}
              onSave={save}
              readOnly={readOnly}
            />
          ) : file.format === 'xlsx' ? (
            <XlsxEditorHost
              bytes={file.bytes}
              collaboration={collaboration}
              fileName={file.fileName}
              locale={locale}
              narrow={narrow}
              onAnalysis={reportAnalysis}
              onExporter={reportExporter}
              onFlusher={reportFlusher}
              onMenus={reportMenus}
              onPendingChange={reportHostPending}
              onRenderer={reportRenderer}
              onSave={save}
              readOnly={readOnly}
            />
          ) : (
            <PptxEditorHost
              bytes={file.bytes}
              collaboration={collaboration}
              fileName={file.fileName}
              locale={locale}
              narrow={narrow}
              onAnalysis={reportAnalysis}
              onAskPresenter={askPresenter}
              onError={reportError}
              onExporter={reportExporter}
              onFlusher={reportFlusher}
              onMenus={reportMenus}
              onPendingChange={reportHostPending}
              onPresentingChange={reportPresenting}
              onRenderer={reportRenderer}
              onSave={save}
              readOnly={readOnly}
            />
          )
        ) : file.format === 'docx' ? (
          <DocxViewer
            bytes={file.bytes}
            citation={citation}
            locale={locale}
            onAnalysis={reportAnalysis}
            onError={reportError}
            onMenus={reportMenus}
            onRenderer={reportRenderer}
          />
        ) : file.format === 'xlsx' ? (
          <XlsxViewer
            bytes={file.bytes}
            citation={citation}
            locale={locale}
            onAnalysis={reportAnalysis}
            onError={reportError}
            onMenus={reportMenus}
            onRenderer={reportRenderer}
          />
        ) : (
          <PptxViewer
            bytes={file.bytes}
            citation={citation}
            locale={locale}
            onAnalysis={reportAnalysis}
            onAskPresenter={askPresenter}
            onError={reportError}
            onMenus={reportMenus}
            onPresentingChange={reportPresenting}
            onRenderer={reportRenderer}
          />
        )}
      </Suspense>
    </div>
  );
}

function post(message: OfficeRuntimePayload, transfer: Transferable[] = []) {
  if (!parentOrigin) return;
  window.parent.postMessage(
    { ...message, version: OFFICE_PROTOCOL_VERSION },
    parentOrigin,
    transfer
  );
}

// The same page, opened by Capy as a PPTX presenter window, only hands itself over.
const presenterToken = presenterTokenFromUrl();
if (presenterToken) handOverPresenterWindow(presenterToken);
else createRoot(document.getElementById('root')!).render(<OfficeRuntime />);
