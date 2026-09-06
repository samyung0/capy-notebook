import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createRoot } from 'react-dom/client';
import {
  isOfficeHostMessage,
  OFFICE_PROTOCOL_VERSION,
  type OfficeAnalysis,
  type OfficeFormat,
  type OfficeHostMessage,
  type OfficeMode,
  type OfficeRuntimePayload,
} from '@/features/files/officeProtocol';
import { parentOriginFromRuntimeUrl } from '@/features/files/officeRuntimeConfig';
import { m } from '@/i18n';
import type {
  OfficeExporter,
  OfficeFlusher,
  OfficeReplica,
} from './officeCollaboration';
import './office-runtime.css';
import '../../vendor/betteroffice/packages/docx-react/dist/styles.css';

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
  const [mode, setMode] = useState<OfficeMode>('view');
  const [error, setError] = useState<string | null>(null);
  const revisionRef = useRef<number | null>(null);
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
  const [canEdit, setCanEdit] = useState(false);
  const hostRef = useRef<HTMLDivElement>(null);
  const reportExporter = useCallback((exporter: OfficeExporter | null) => {
    exporterRef.current = exporter;
  }, []);
  const reportReplica = useCallback((replica: OfficeReplica | null) => {
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
  }, []);
  const collaboration = useMemo(
    () =>
      file?.initialUpdate
        ? {
            clientId: crypto.getRandomValues(new Uint32Array(1))[0],
            initialUpdate: file.initialUpdate,
            onReplica: reportReplica,
          }
        : null,
    [file?.initialUpdate, reportReplica]
  );

  useEffect(() => {
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
      if (message.type === 'load') {
        const nextMode =
          message.mode === 'edit' && message.canEdit ? 'edit' : 'view';
        if (revisionRef.current !== null) return;
        revisionRef.current = message.revision;
        epochRef.current = message.collaboration?.epoch ?? null;
        setCanEdit(message.canEdit);
        setError(null);
        setMode(nextMode);
        setFile({
          bytes: new Uint8Array(message.bytes),
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
      if (message.type === 'set-capabilities') {
        pausedRef.current = !message.canEdit;
        if (!message.canEdit) await flush();
        if (pausedRef.current !== !message.canEdit) return;
        if (hostRef.current) hostRef.current.inert = !message.canEdit;
        setCanEdit(message.canEdit);
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
      if (
        message.type === 'export' &&
        exporterRef.current &&
        revisionRef.current !== null
      ) {
        await flush();
        const revision = revisionRef.current;
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
      unsubscribeRef.current?.();
    };
  }, []);

  const runtimeRevision = file?.revision;
  const reportError = useCallback(
    (value: Error) => {
      if (runtimeRevision === undefined) return;
      setError(value.message);
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
      post({ analysis, revision: runtimeRevision, type: 'ready' });
    },
    [runtimeRevision]
  );

  if (!file)
    return (
      <div className="office-runtime-state">
        {m.files_office_runtime_loading_file()}
      </div>
    );
  if (error)
    return (
      <div className="office-runtime-state">
        {m.files_office_runtime_open_failed()}
      </div>
    );

  const save = () => post({ revision: file.revision, type: 'checkpoint' });

  return (
    <div
      className="office-editor-host"
      inert={mode === 'edit' && !canEdit}
      onBeforeInputCapture={(event) => {
        if (pausedRef.current && !composingRef.current) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
      onCompositionEndCapture={() => {
        composingRef.current = false;
        finishInteraction();
      }}
      onCompositionStartCapture={() => {
        composingRef.current = true;
        reportPending();
      }}
      onKeyDownCapture={(event) => {
        if (pausedRef.current && !composingRef.current) {
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
        if (pausedRef.current) {
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
      ref={hostRef}
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
              onError={reportError}
              onExporter={reportExporter}
              onSave={save}
            />
          ) : file.format === 'xlsx' ? (
            <XlsxEditorHost
              bytes={file.bytes}
              collaboration={collaboration}
              fileName={file.fileName}
              onExporter={reportExporter}
              onFlusher={reportFlusher}
              onPendingChange={reportHostPending}
              onSave={save}
            />
          ) : (
            <PptxEditorHost
              bytes={file.bytes}
              collaboration={collaboration}
              fileName={file.fileName}
              onError={reportError}
              onExporter={reportExporter}
              onSave={save}
            />
          )
        ) : file.format === 'docx' ? (
          <DocxViewer
            bytes={file.bytes}
            onAnalysis={reportAnalysis}
            onError={reportError}
          />
        ) : file.format === 'xlsx' ? (
          <XlsxViewer
            bytes={file.bytes}
            onAnalysis={reportAnalysis}
            onError={reportError}
          />
        ) : (
          <PptxViewer
            bytes={file.bytes}
            onAnalysis={reportAnalysis}
            onError={reportError}
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

createRoot(document.getElementById('root')!).render(<OfficeRuntime />);
