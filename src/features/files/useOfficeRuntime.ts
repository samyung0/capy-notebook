import { useCallback, useEffect, useRef, useState } from 'react';
import * as Y from 'yjs';
import type { SourceFile } from '@/api/types';
import { m } from '@/i18n';
import {
  isOfficeRuntimeMessage,
  OFFICE_PROTOCOL_VERSION,
  type OfficeAnalysis,
  type OfficeFormat,
  type OfficeHostMessage,
  type OfficeMode,
} from './officeProtocol';
import { getOfficeRuntimeConfig } from './officeRuntimeConfig';
import { SOURCE_IFRAME_ORIGIN, useSourceSession } from './useSourceSession';

interface OfficeRuntimeOptions {
  canEdit: boolean;
  file: SourceFile;
  format: OfficeFormat;
  initialMode?: OfficeMode;
  revision: number;
}

export function officeRuntimeKey(
  file: Pick<SourceFile, 'id' | 'url'>,
  revision: number
): string {
  void revision;
  return file.id;
}

export function isCurrentOfficeRuntimeMessage(
  messageRevision: number,
  currentRevision: number
): boolean {
  return messageRevision === currentRevision;
}

export function useOfficeRuntime({
  canEdit,
  file,
  format,
  initialMode = 'view',
  revision,
}: OfficeRuntimeOptions) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const config = useRef(getOfficeRuntimeConfig()).current;
  const [mode, setMode] = useState<OfficeMode>(canEdit ? initialMode : 'view');
  const [joined, setJoined] = useState(canEdit && initialMode === 'edit');
  const [frameGeneration, setFrameGeneration] = useState(0);
  const [frameLoaded, setFrameLoaded] = useState(false);
  const [frameBoot, setFrameBoot] = useState(0);
  const [viewBytes, setViewBytes] = useState<ArrayBuffer | null>(null);
  const [analysis, setAnalysis] = useState<OfficeAnalysis | null>(null);
  const [error, setError] = useState<string | null>(config.error);
  const [replicaReady, setReplicaReady] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const source = useSourceSession(file.id, joined);
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const revisionRef = useRef(revision);
  const publishedRevision = useRef(revision);
  const initializedFrame = useRef(-1);
  const sourceDocument = useRef<Y.Doc | undefined>(undefined);
  const frameRequests = useRef(
    new Map<
      string,
      { resolve: (bytes: ArrayBuffer) => void; reject: (error: Error) => void }
    >()
  );
  const post = useCallback(
    (message: OfficeHostMessage, transfer: Transferable[] = []) =>
      iframeRef.current?.contentWindow?.postMessage(
        message,
        config.origin,
        transfer
      ),
    [config.origin]
  );
  const request = useCallback(
    (kind: 'flush' | 'export') =>
      new Promise<ArrayBuffer>((resolve, reject) => {
        const id = crypto.randomUUID();
        const timeout = setTimeout(() => {
          frameRequests.current.delete(id);
          reject(new Error(m.source_edit_save_failed()));
        }, 30_000);
        frameRequests.current.set(id, {
          reject: (error) => {
            clearTimeout(timeout);
            reject(error);
          },
          resolve: (bytes) => {
            clearTimeout(timeout);
            resolve(bytes);
          },
        });
        if (kind === 'flush') {
          const epoch = sourceRef.current.session?.epoch;
          if (epoch === undefined) {
            frameRequests.current.delete(id);
            reject(new Error(m.source_edit_session_changed()));
            return;
          }
          post({ epoch, id, type: 'flush', version: OFFICE_PROTOCOL_VERSION });
        } else post({ id, type: 'export', version: OFFICE_PROTOCOL_VERSION });
      }),
    [post]
  );
  const checkpoint = useCallback(async () => {
    await sourceRef.current.save();
  }, [request]);

  useEffect(() => {
    source.flushHandler.current =
      mode === 'edit'
        ? async (pause = false) => {
            if (pause)
              post({
                canEdit: false,
                type: 'set-capabilities',
                version: OFFICE_PROTOCOL_VERSION,
              });
            await request('flush');
          }
        : async () => {};
    return () => {
      source.flushHandler.current = null;
    };
  }, [mode, request, source.flushHandler, post]);

  useEffect(() => {
    const doc = source.doc;
    if (!doc) return;
    if (sourceDocument.current && sourceDocument.current !== doc) {
      setFrameLoaded(false);
      setFrameGeneration((value) => value + 1);
      setAnalysis(null);
      setError(null);
    }
    sourceDocument.current = doc;
  }, [source.doc]);

  useEffect(() => {
    const changed = publishedRevision.current !== revision;
    publishedRevision.current = revision;
    if (!changed || mode !== 'view') return;
    revisionRef.current = revision;
    setFrameLoaded(false);
    setFrameGeneration((value) => value + 1);
    setViewBytes(null);
    setAnalysis(null);
    setError(config.error);
  }, [revision, mode, config.error]);

  useEffect(() => {
    if (mode !== 'view' || viewBytes || config.error) return;
    const controller = new AbortController();
    void fetch(file.url ?? '', { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.arrayBuffer();
      })
      .then((bytes) => {
        if (!controller.signal.aborted) setViewBytes(bytes);
      })
      .catch((value: unknown) => {
        if (!controller.signal.aborted) setError(toError(value).message);
      });
    return () => controller.abort();
  }, [file.id, file.url, revision, mode, config.error, viewBytes]);

  useEffect(() => {
    if (!frameLoaded || initializedFrame.current === frameGeneration) return;
    if (
      mode === 'edit' &&
      (!source.doc ||
        !source.session ||
        !source.bytes ||
        (!source.synced && source.status !== 'recovery'))
    )
      return;
    if (mode === 'view' && !viewBytes) return;
    const bytes =
      mode === 'edit' ? source.bytes!.slice().buffer : viewBytes!.slice(0);
    const collaboration =
      mode === 'edit'
        ? {
            epoch: source.session!.epoch,
            initialUpdate: Y.encodeStateAsUpdate(source.doc!).slice().buffer,
          }
        : undefined;
    initializedFrame.current = frameGeneration;
    post(
      {
        bytes,
        canEdit,
        collaboration,
        fileName: file.name,
        format,
        mode,
        revision: revisionRef.current,
        type: 'load',
        version: OFFICE_PROTOCOL_VERSION,
      },
      collaboration ? [bytes, collaboration.initialUpdate] : [bytes]
    );
  }, [
    frameLoaded,
    frameGeneration,
    frameBoot,
    mode,
    source.doc,
    source.session,
    source.bytes,
    source.synced,
    source.status,
    viewBytes,
    canEdit,
    file.name,
    format,
    post,
  ]);

  useEffect(() => {
    if (frameLoaded)
      post({
        canEdit:
          canEdit &&
          !source.handoff &&
          source.status !== 'recovery' &&
          (mode !== 'edit' ||
            (!!source.doc &&
              !source.discarding &&
              source.status !== 'connecting')),
        type: 'set-capabilities',
        version: OFFICE_PROTOCOL_VERSION,
      });
  }, [
    canEdit,
    frameLoaded,
    mode,
    source.doc,
    source.discarding,
    source.handoff,
    source.status,
    post,
  ]);

  useEffect(() => {
    const doc = source.doc;
    if (!doc || mode !== 'edit' || !source.session) return;
    const epoch = source.session.epoch;
    const send = (update: Uint8Array, origin: unknown) => {
      if (origin === SOURCE_IFRAME_ORIGIN) return;
      const bytes = update.slice().buffer;
      post({ bytes, epoch, type: 'update', version: OFFICE_PROTOCOL_VERSION }, [
        bytes,
      ]);
    };
    doc.on('update', send);
    return () => doc.off('update', send);
  }, [source.doc, source.session, mode, post]);

  useEffect(() => {
    const receive = (event: MessageEvent<unknown>) => {
      if (
        event.origin !== config.origin ||
        event.source !== iframeRef.current?.contentWindow ||
        !isOfficeRuntimeMessage(event.data)
      )
        return;
      const message = event.data,
        active = sourceRef.current;
      if (message.type === 'initialized') {
        setReplicaReady(false);
        initializedFrame.current = -1;
        setFrameLoaded(true);
        setFrameBoot((value) => value + 1);
        return;
      }
      if (!isCurrentOfficeRuntimeMessage(message.revision, revisionRef.current))
        return;
      if (message.type === 'dirty') {
        active.pendingInput(message.dirty);
        return;
      }
      if (message.type === 'ready') {
        setAnalysis(message.analysis);
        setError(null);
        return;
      }
      if (message.type === 'error') {
        setError(message.message);
        for (const waiter of frameRequests.current.values())
          waiter.reject(new Error(message.message));
        frameRequests.current.clear();
        return;
      }
      if (message.type === 'collaboration-ready') setReplicaReady(true);
      if (
        message.type === 'update' ||
        message.type === 'collaboration-ready' ||
        message.type === 'flushed'
      ) {
        if (
          !active.doc ||
          message.epoch !== active.session?.epoch ||
          active.status === 'recovery'
        )
          return;
        Y.applyUpdate(
          active.doc,
          new Uint8Array(message.bytes),
          SOURCE_IFRAME_ORIGIN
        );
        if (message.type === 'collaboration-ready') {
          const bytes = Y.encodeStateAsUpdate(active.doc).slice().buffer;
          post(
            {
              bytes,
              epoch: message.epoch,
              type: 'update',
              version: OFFICE_PROTOCOL_VERSION,
            },
            [bytes]
          );
        }
        if (message.type === 'flushed') {
          frameRequests.current.get(message.id)?.resolve(message.bytes);
          frameRequests.current.delete(message.id);
        }
        return;
      }
      if (message.type === 'exported') {
        frameRequests.current.get(message.id)?.resolve(message.bytes);
        frameRequests.current.delete(message.id);
        return;
      }
      if (message.type === 'checkpoint' || message.type === 'save')
        void checkpoint().catch((value: unknown) =>
          setError(toError(value).message)
        );
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, [config.origin, post, checkpoint]);

  const downloadDraft = useCallback(async () => {
    const bytes = await request('export');
    const url = URL.createObjectURL(new Blob([bytes]));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = file.name;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, [file.name, request]);

  const setRuntimeMode = useCallback(
    async (next: OfficeMode) => {
      if (next === mode || (next === 'edit' && !canEdit)) return;
      if (next === 'view') {
        setLeaving(true);
        try {
          await checkpoint();
          const bytes = await request('export');
          setViewBytes(bytes);
        } catch (value) {
          setError(toError(value).message);
          setLeaving(false);
          return;
        }
        setLeaving(false);
      } else setJoined(true);
      initializedFrame.current = -1;
      setFrameLoaded(false);
      setFrameGeneration((value) => value + 1);
      setMode(next);
    },
    [canEdit, mode, checkpoint, request]
  );

  useEffect(
    () => () => {
      for (const waiter of frameRequests.current.values())
        waiter.reject(new Error(m.source_edit_save_failed()));
      frameRequests.current.clear();
    },
    []
  );

  return {
    analysis,
    dirty: source.dirty,
    discardDraft: source.discardDraft,
    discarding: source.discarding,
    downloadDraft,
    error: error ?? source.error,
    handoff: source.handoff,
    iframeKey: `${file.id}:${frameGeneration}`,
    iframeRef,
    iframeSandbox: config.sandbox,
    iframeUrl: config.url,
    mode,
    ready: mode === 'view' ? !!analysis : replicaReady,
    save: checkpoint,
    saving: leaving || source.status === 'saving',
    setFrameLoaded,
    setRuntimeMode,
    status: source.status,
  };
}

function toError(value: unknown) {
  return value instanceof Error ? value : new Error(String(value));
}
