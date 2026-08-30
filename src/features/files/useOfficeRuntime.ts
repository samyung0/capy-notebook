import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import type { SourceFile } from '@/api/types';
import {
  isOfficeRuntimeMessage,
  OFFICE_PROTOCOL_VERSION,
  type OfficeAnalysis,
  type OfficeFormat,
  type OfficeHostMessage,
  type OfficeMode,
} from './officeProtocol';
import { getOfficeRuntimeConfig } from './officeRuntimeConfig';

interface SavedOfficeFile {
  revision: number;
}

interface OfficeRuntimeOptions {
  canEdit: boolean;
  file: SourceFile;
  format: OfficeFormat;
  initialMode?: OfficeMode;
  onSave?: (
    bytes: Uint8Array,
    expectedRevision: number
  ) => Promise<SavedOfficeFile>;
  revision: number;
}

export function officeRuntimeKey(
  file: Pick<SourceFile, 'id' | 'url'>,
  revision: number
): string {
  return JSON.stringify([file.id, file.url ?? '', revision]);
}

export function isCurrentOfficeSave(
  startedGeneration: number,
  currentGeneration: number,
  mounted: boolean
): boolean {
  return mounted && startedGeneration === currentGeneration;
}

export function isCurrentOfficeRuntimeMessage(
  messageRevision: number,
  currentRevision: number
): boolean {
  return messageRevision === currentRevision;
}

export function resolveInitialOfficeMode(
  requested: OfficeMode,
  canEdit: boolean,
  canSave: boolean
): OfficeMode {
  return requested === 'edit' && canEdit && canSave ? 'edit' : 'view';
}

export async function runOfficeSave({
  bytes,
  expectedRevision,
  isCurrent,
  onCommitted,
  onRejected,
  onSave,
}: {
  bytes: Uint8Array;
  expectedRevision: number;
  isCurrent: () => boolean;
  onCommitted: (saved: SavedOfficeFile) => void;
  onRejected: (error: Error) => void;
  onSave: NonNullable<OfficeRuntimeOptions['onSave']>;
}): Promise<void> {
  let saved: SavedOfficeFile;
  try {
    saved = await onSave(bytes, expectedRevision);
  } catch (value) {
    if (isCurrent()) onRejected(toError(value));
    return;
  }
  if (isCurrent()) onCommitted(saved);
}

export function useOfficeRuntime({
  canEdit,
  file,
  format,
  initialMode = 'view',
  onSave,
  revision,
}: OfficeRuntimeOptions) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const runtimeConfigRef = useRef(getOfficeRuntimeConfig());
  const runtimeConfig = runtimeConfigRef.current;
  const fetchAbortRef = useRef<AbortController | null>(null);
  const initializedRef = useRef(false);
  const loadedRuntimeKeyRef = useRef<string | null>(null);
  const mountedRef = useRef(false);
  const initialModeRef = useRef(
    resolveInitialOfficeMode(initialMode, canEdit, Boolean(onSave))
  );
  const runtimeKey = officeRuntimeKey(file, revision);
  const runtimeGenerationRef = useRef(0);
  const revisionRef = useRef(revision);
  const modeRef = useRef<OfficeMode>(initialModeRef.current);
  const onSaveRef = useRef(onSave);
  const savingRef = useRef(false);
  const [frameGeneration, setFrameGeneration] = useState(0);
  const [frameLoaded, setFrameLoaded] = useState(false);
  const [sourceBytes, setSourceBytes] = useState<ArrayBuffer | null>(null);
  const [analysis, setAnalysis] = useState<OfficeAnalysis | null>(null);
  const [mode, setMode] = useState<OfficeMode>(initialModeRef.current);
  const [requestedMode, setRequestedMode] = useState<OfficeMode>(
    initialModeRef.current
  );
  const [runtimeRevision, setRuntimeRevision] = useState(revision);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(runtimeConfig.error);

  useLayoutEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      fetchAbortRef.current?.abort();
      runtimeGenerationRef.current += 1;
    };
  }, []);

  useLayoutEffect(() => {
    onSaveRef.current = onSave;
  }, [onSave]);

  const post = useCallback(
    (message: OfficeHostMessage, transfer: Transferable[] = []) => {
      iframeRef.current?.contentWindow?.postMessage(
        message,
        runtimeConfig.origin,
        transfer
      );
    },
    [runtimeConfig.origin]
  );

  const replaceRuntime = useCallback(
    ({
      bytes,
      nextMode,
      nextRevision,
      preserveAnalysis,
    }: {
      bytes?: ArrayBuffer;
      nextMode: OfficeMode;
      nextRevision: number;
      preserveAnalysis: boolean;
    }) => {
      fetchAbortRef.current?.abort();
      const generation = runtimeGenerationRef.current + 1;
      runtimeGenerationRef.current = generation;
      revisionRef.current = nextRevision;
      loadedRuntimeKeyRef.current = officeRuntimeKey(file, nextRevision);
      modeRef.current = nextMode;
      savingRef.current = false;
      setFrameLoaded(false);
      setFrameGeneration(generation);
      setRequestedMode(nextMode);
      setRuntimeRevision(nextRevision);
      setMode(nextMode);
      setDirty(false);
      setSaving(false);
      setError(runtimeConfig.error);
      setSourceBytes(bytes ?? null);
      if (!preserveAnalysis) setAnalysis(null);

      if (bytes || !file.url || runtimeConfig.error) return;
      const controller = new AbortController();
      fetchAbortRef.current = controller;
      void fetch(file.url, { signal: controller.signal })
        .then(async (response) => {
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          return response.arrayBuffer();
        })
        .then(
          (loadedBytes) => {
            if (
              !controller.signal.aborted &&
              runtimeGenerationRef.current === generation
            ) {
              setSourceBytes(loadedBytes);
            }
          },
          (value: unknown) => {
            if (
              !controller.signal.aborted &&
              runtimeGenerationRef.current === generation
            ) {
              setError(toError(value).message);
            }
          }
        );
    },
    [file.id, file.url, runtimeConfig.error]
  );

  useEffect(() => {
    if (initializedRef.current && loadedRuntimeKeyRef.current === runtimeKey) {
      return;
    }
    const nextMode = initializedRef.current ? 'view' : initialModeRef.current;
    initializedRef.current = true;
    replaceRuntime({
      nextMode,
      nextRevision: revision,
      preserveAnalysis: false,
    });
  }, [file.id, replaceRuntime, revision, runtimeKey]);

  useEffect(() => {
    if (!canEdit && modeRef.current === 'edit') {
      replaceRuntime({
        nextMode: 'view',
        nextRevision: revisionRef.current,
        preserveAnalysis: false,
      });
      return;
    }
    if (!frameLoaded) return;
    post({
      canEdit,
      type: 'set-capabilities',
      version: OFFICE_PROTOCOL_VERSION,
    });
  }, [canEdit, frameLoaded, post, replaceRuntime]);

  useEffect(() => {
    const target = iframeRef.current?.contentWindow;
    if (!frameLoaded || !sourceBytes || !target) return;
    const message: OfficeHostMessage = {
      bytes: sourceBytes,
      canEdit,
      fileName: file.name,
      format,
      mode: requestedMode,
      revision: runtimeRevision,
      type: 'load',
      version: OFFICE_PROTOCOL_VERSION,
    };
    target.postMessage(message, runtimeConfig.origin, [sourceBytes]);
    setSourceBytes(null);
  }, [
    canEdit,
    file.name,
    format,
    frameLoaded,
    requestedMode,
    runtimeConfig.origin,
    runtimeRevision,
    sourceBytes,
  ]);

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
        event.origin !== runtimeConfig.origin ||
        event.source !== iframeRef.current?.contentWindow ||
        !isOfficeRuntimeMessage(event.data)
      )
        return;
      const message = event.data;
      if (
        !isCurrentOfficeRuntimeMessage(message.revision, revisionRef.current)
      ) {
        return;
      }
      if (message.type === 'ready') {
        setAnalysis(message.analysis);
        setError(null);
        return;
      }
      if (message.type === 'mode') {
        modeRef.current = message.mode;
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
      const save = onSaveRef.current;
      if (!save || savingRef.current) return;
      const bytes = new Uint8Array(message.bytes);
      const startedGeneration = runtimeGenerationRef.current;
      savingRef.current = true;
      setSaving(true);
      void runOfficeSave({
        bytes,
        expectedRevision: message.revision,
        isCurrent: () =>
          isCurrentOfficeSave(
            startedGeneration,
            runtimeGenerationRef.current,
            mountedRef.current
          ),
        onCommitted: (saved) => {
          revisionRef.current = saved.revision;
          replaceRuntime({
            bytes: bytes.slice().buffer,
            nextMode: 'view',
            nextRevision: saved.revision,
            preserveAnalysis: false,
          });
        },
        onRejected: (saveError) => {
          setError(saveError.message);
          savingRef.current = false;
          setSaving(false);
        },
        onSave: save,
      });
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, [replaceRuntime, runtimeConfig.origin]);

  const setRuntimeMode = useCallback(
    (next: OfficeMode) => {
      if (next === modeRef.current || (next === 'edit' && !canEdit)) return;
      replaceRuntime({
        nextMode: next,
        nextRevision: revisionRef.current,
        preserveAnalysis: next === 'edit',
      });
    },
    [canEdit, replaceRuntime]
  );

  return {
    analysis,
    dirty,
    error,
    iframeKey: `${file.id}:${frameGeneration}`,
    iframeRef,
    iframeSandbox: runtimeConfig.sandbox,
    iframeUrl: runtimeConfig.url,
    mode,
    saving,
    setFrameLoaded,
    setRuntimeMode,
  };
}

function toError(value: unknown) {
  return value instanceof Error ? value : new Error(String(value));
}
