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
import { m } from '@/i18n';
import './office-runtime.css';

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

interface LoadedFile {
  bytes: Uint8Array;
  canEdit: boolean;
  fileName: string;
  format: OfficeFormat;
  revision: number;
}

function OfficeRuntime() {
  const [file, setFile] = useState<LoadedFile | null>(null);
  const [mode, setMode] = useState<OfficeMode>('view');
  const [error, setError] = useState<string | null>(null);
  const canEditRef = useRef(false);

  useEffect(() => {
    const receive = (event: MessageEvent<unknown>) => {
      if (
        event.source !== window.parent ||
        event.origin !== window.location.origin
      )
        return;
      if (!isOfficeHostMessage(event.data)) return;
      handleHostMessage(event.data);
    };
    const handleHostMessage = (message: OfficeHostMessage) => {
      if (message.type === 'load') {
        canEditRef.current = message.canEdit;
        setError(null);
        setMode('view');
        setFile({
          bytes: new Uint8Array(message.bytes),
          canEdit: message.canEdit,
          fileName: message.fileName,
          format: message.format,
          revision: message.revision,
        });
        post({ mode: 'view', type: 'mode' });
        return;
      }
      if (message.type === 'set-mode') {
        if (message.mode === 'edit' && !canEditRef.current) return;
        setMode(message.mode);
        post({ mode: message.mode, type: 'mode' });
        return;
      }
      setFile((current) =>
        current
          ? {
              ...current,
              bytes: new Uint8Array(message.bytes),
              revision: message.revision,
            }
          : current
      );
      setMode('view');
      post({ dirty: false, type: 'dirty' });
      post({ mode: 'view', type: 'mode' });
    };
    window.addEventListener('message', receive);
    window.parent.postMessage(
      { mode: 'view', type: 'mode', version: OFFICE_PROTOCOL_VERSION },
      window.location.origin
    );
    return () => window.removeEventListener('message', receive);
  }, []);

  const reportError = useCallback((value: Error) => {
    setError(value.message);
    post({ message: value.message, type: 'error' });
  }, []);
  const reportAnalysis = useCallback((analysis: OfficeAnalysis) => {
    post({ analysis, type: 'ready' });
  }, []);
  const reportDirty = useCallback(
    () => post({ dirty: true, type: 'dirty' }),
    []
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
        file.format === 'xlsx' ? (
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
  window.parent.postMessage(
    { ...message, version: OFFICE_PROTOCOL_VERSION },
    window.location.origin,
    transfer
  );
}

createRoot(document.getElementById('root')!).render(<OfficeRuntime />);
