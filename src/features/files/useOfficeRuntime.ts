import { useCallback, useEffect, useRef, useState } from 'react';
import type { SourceFile } from '@/api/types';
import {
  isOfficeRuntimeMessage,
  OFFICE_PROTOCOL_VERSION,
  type OfficeAnalysis,
  type OfficeFormat,
  type OfficeHostMessage,
  type OfficeMode,
} from './officeProtocol';

interface SavedOfficeFile {
  revision: number;
}

interface OfficeRuntimeOptions {
  canEdit: boolean;
  file: SourceFile;
  format: OfficeFormat;
  onSave?: (
    bytes: Uint8Array,
    expectedRevision: number
  ) => Promise<SavedOfficeFile>;
  revision: number;
}

export function useOfficeRuntime({
  canEdit,
  file,
  format,
  onSave,
  revision,
}: OfficeRuntimeOptions) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [frameLoaded, setFrameLoaded] = useState(false);
  const [sourceBytes, setSourceBytes] = useState<ArrayBuffer | null>(null);
  const [analysis, setAnalysis] = useState<OfficeAnalysis | null>(null);
  const [mode, setMode] = useState<OfficeMode>('view');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const post = useCallback(
    (message: OfficeHostMessage, transfer: Transferable[] = []) => {
      iframeRef.current?.contentWindow?.postMessage(
        message,
        window.location.origin,
        transfer
      );
    },
    []
  );

  useEffect(() => {
    if (!file.url) return;
    const controller = new AbortController();
    setAnalysis(null);
    setError(null);
    setMode('view');
    setDirty(false);
    setSourceBytes(null);
    void fetch(file.url, { signal: controller.signal }).then(
      async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        setSourceBytes(await response.arrayBuffer());
      },
      (value: unknown) => {
        if (!controller.signal.aborted) setError(toError(value).message);
      }
    );
    return () => controller.abort();
  }, [file.id, file.url]);

  useEffect(() => {
    const target = iframeRef.current?.contentWindow;
    if (!frameLoaded || !sourceBytes || !target) return;
    const message: OfficeHostMessage = {
      bytes: sourceBytes,
      canEdit,
      fileName: file.name,
      format,
      revision,
      type: 'load',
      version: OFFICE_PROTOCOL_VERSION,
    };
    target.postMessage(message, window.location.origin, [sourceBytes]);
    setSourceBytes(null);
  }, [canEdit, file.name, format, frameLoaded, revision, sourceBytes]);

  useEffect(() => {
    if (!dirty) return;
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warnBeforeUnload);
    return () => window.removeEventListener('beforeunload', warnBeforeUnload);
  }, [dirty]);

  useEffect(() => {
    const receive = (event: MessageEvent<unknown>) => {
      if (
        event.origin !== window.location.origin ||
        event.source !== iframeRef.current?.contentWindow ||
        !isOfficeRuntimeMessage(event.data)
      )
        return;
      const message = event.data;
      if (message.type === 'ready') {
        setAnalysis(message.analysis);
        setError(null);
        return;
      }
      if (message.type === 'mode') {
        setMode(message.mode);
        return;
      }
      if (message.type === 'dirty') {
        setDirty(message.dirty);
        return;
      }
      if (message.type === 'error') {
        setError(message.message);
        return;
      }
      if (!onSave || saving) return;
      const bytes = new Uint8Array(message.bytes);
      setSaving(true);
      void onSave(bytes, message.revision).then(
        (saved) => {
          const committed = bytes.slice().buffer;
          post(
            {
              bytes: committed,
              revision: saved.revision,
              type: 'save-committed',
              version: OFFICE_PROTOCOL_VERSION,
            },
            [committed]
          );
          setDirty(false);
          setSaving(false);
        },
        (value: unknown) => {
          setError(toError(value).message);
          setSaving(false);
        }
      );
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, [onSave, post, saving]);

  const setRuntimeMode = useCallback(
    (next: OfficeMode) => {
      post({ mode: next, type: 'set-mode', version: OFFICE_PROTOCOL_VERSION });
    },
    [post]
  );

  return {
    analysis,
    dirty,
    error,
    iframeRef,
    mode,
    saving,
    setFrameLoaded,
    setRuntimeMode,
  };
}

function toError(value: unknown) {
  return value instanceof Error ? value : new Error(String(value));
}
