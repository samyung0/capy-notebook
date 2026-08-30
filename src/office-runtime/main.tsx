import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
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
import './office-runtime.css';
import '../../vendor/betteroffice/packages/docx-react/src/styles/editor.css';

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
  fileName: string;
  format: OfficeFormat;
  revision: number;
}

function OfficeRuntime() {
  const [file, setFile] = useState<LoadedFile | null>(null);
  const [mode, setMode] = useState<OfficeMode>('view');
  const [error, setError] = useState<string | null>(null);
  const revisionRef = useRef<number | null>(null);

  useEffect(() => {
    const receive = (event: MessageEvent<unknown>) => {
      if (
        event.source !== window.parent ||
        !parentOrigin ||
        event.origin !== parentOrigin
      )
        return;
      if (!isOfficeHostMessage(event.data)) return;
      handleHostMessage(event.data);
    };
    const handleHostMessage = (message: OfficeHostMessage) => {
      if (message.type === 'load') {
        const nextMode =
          message.mode === 'edit' && message.canEdit ? 'edit' : 'view';
        revisionRef.current = message.revision;
        setError(null);
        setMode(nextMode);
        setFile({
          bytes: new Uint8Array(message.bytes),
          fileName: message.fileName,
          format: message.format,
          revision: message.revision,
        });
        post({ mode: nextMode, revision: message.revision, type: 'mode' });
        return;
      }
      if (message.type === 'set-capabilities' && !message.canEdit) {
        setMode('view');
        const revision = revisionRef.current;
        if (revision !== null) post({ mode: 'view', revision, type: 'mode' });
      }
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
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
  const reportDirty = useCallback(() => {
    if (runtimeRevision === undefined) return;
    post({ dirty: true, revision: runtimeRevision, type: 'dirty' });
  }, [runtimeRevision]);

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

  const save = (bytes: Uint8Array) => {
    const transferable = bytes.slice().buffer;
    post({ bytes: transferable, revision: file.revision, type: 'save' }, [
      transferable,
    ]);
  };

  return (
    <Suspense
      fallback={
        <div className="office-runtime-state">
          {m.files_office_runtime_loading()}
        </div>
      }
    >
      {mode === 'edit' ? (
        file.format === 'docx' ? (
          <DocxEditorHost
            bytes={file.bytes}
            onDirty={reportDirty}
            onError={reportError}
            onSave={save}
          />
        ) : file.format === 'xlsx' ? (
          <XlsxEditorHost
            bytes={file.bytes}
            fileName={file.fileName}
            onDirty={reportDirty}
            onSave={save}
          />
        ) : (
          <PptxEditorHost
            bytes={file.bytes}
            fileName={file.fileName}
            onDirty={reportDirty}
            onError={reportError}
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
