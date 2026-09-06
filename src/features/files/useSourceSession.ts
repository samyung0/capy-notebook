import { HocuspocusProvider } from '@hocuspocus/provider';
import { useCallback, useEffect, useRef, useState } from 'react';
import * as Y from 'yjs';
import { api } from '@/api/client';
import { useMe } from '@/api/hooks';
import type { SourceCollaborationToken, SourceSession } from '@/api/types';
import { m } from '@/i18n';
import {
  clearSourceDrafts,
  readSourceDrafts,
  type SourceDraft,
  sourceRecoveryDrafts,
  writeSourceDraft,
} from './sourceDraft';

export type SourceSaveState =
  | 'connecting'
  | 'saving'
  | 'saved'
  | 'offline'
  | 'error'
  | 'recovery';
export const SOURCE_IFRAME_ORIGIN = Symbol('source-iframe');
const RESTORE_ORIGIN = Symbol('restore');

export function decodeSourceState(state: string): Uint8Array {
  return Uint8Array.from(atob(state), (character) => character.charCodeAt(0));
}

export function acknowledgeSourceCheckpoint(
  state: {
    pending: Map<string, number>;
    acknowledged: number;
    sequence: number;
  },
  checkpointIds: readonly string[]
): boolean {
  let matched = false;
  for (const id of checkpointIds) {
    const sequence = state.pending.get(id);
    if (sequence !== undefined) {
      matched = true;
      state.acknowledged = Math.max(state.acknowledged, sequence);
      state.pending.delete(id);
    }
  }
  return matched && state.acknowledged >= state.sequence;
}

export function useSourceSession(fileId: string, enabled: boolean) {
  const { data: me } = useMe({ errorBoundary: false });
  const actorId = me?.id;
  const [loaded, setLoaded] = useState<{
    session: SourceSession;
    doc: Y.Doc;
    bytes: Uint8Array;
  } | null>(null);
  const [status, setStatus] = useState<SourceSaveState>('connecting');
  const [error, setError] = useState<string | null>(null);
  const discardHandler = useRef<(() => Promise<void>) | null>(null);
  const [discarding, setDiscarding] = useState(false);
  const discardDraft = useCallback(async () => {
    if (!discardHandler.current) return;
    setDiscarding(true);
    try {
      await discardHandler.current();
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setDiscarding(false);
    }
  }, []);
  const [generation, setGeneration] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [bufferDirty, setBufferDirty] = useState(false);
  const bufferDirtyRef = useRef(false);
  const pendingInput = useCallback((pending: boolean) => {
    bufferDirtyRef.current = pending;
    setBufferDirty(pending);
  }, []);
  const [handoff, setHandoff] = useState(false);
  const flushHandler = useRef<((pause?: boolean) => Promise<void>) | null>(
    null
  );
  const [synced, setSynced] = useState(false);
  const runtime = useRef<{
    provider: HocuspocusProvider;
    checkpoint: () => void;
    sequence: number;
    acknowledged: number;
    pending: Map<string, number>;
    recovery: boolean;
  } | null>(null);
  const flushWaiters = useRef<
    { sequence: number; resolve: () => void; reject: (error: Error) => void }[]
  >([]);
  const save = useCallback(async (): Promise<void> => {
    await flushHandler.current?.();
    const active = runtime.current;
    if (!active || active.recovery)
      return Promise.reject(new Error(m.source_edit_recovery()));
    if (active.acknowledged >= active.sequence && !bufferDirtyRef.current)
      return Promise.resolve();
    if (!active.provider.isAuthenticated)
      return Promise.reject(new Error(m.source_edit_offline()));
    return new Promise((resolve, reject) => {
      flushWaiters.current.push({ reject, resolve, sequence: active.sequence });
      active.checkpoint();
    });
  }, []);

  useEffect(() => {
    if (!enabled || !fileId || !actorId) return;
    const draftKey = `${actorId}:${fileId}`;
    const draftId = crypto.randomUUID();
    let restoredDrafts: SourceDraft[] = [];
    let latestDraft: SourceDraft | undefined;
    let recoveryDrafts: SourceDraft[] | null = null;
    let cancelled = false;
    let provider: HocuspocusProvider | null = null;
    let doc: Y.Doc | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let draftWrites = Promise.resolve();
    const queueDraftWrite = (write: () => Promise<void>) => {
      const previous = draftWrites;
      draftWrites = (async () => {
        await previous;
        try {
          await write();
        } catch (error) {
          fail(error);
        }
      })();
    };
    const fail = (value: unknown) => {
      if (cancelled) return;
      const next = value instanceof Error ? value : new Error(String(value));
      setError(next.message);
      setStatus('error');
      for (const waiter of flushWaiters.current.splice(0)) waiter.reject(next);
    };
    discardHandler.current = async () => {
      const presented = recoveryDrafts ?? [
        ...restoredDrafts,
        ...(latestDraft ? [latestDraft] : []),
      ];
      await draftWrites;
      await clearSourceDrafts(presented);
      if (!cancelled) {
        pendingInput(false);
        setGeneration((value) => value + 1);
      }
    };
    setStatus('connecting');
    setDirty(false);
    setHandoff(false);
    setSynced(false);
    setError(null);
    setLoaded(null);
    void (async () => {
      const [session, credentials, drafts] = await Promise.all([
        api.get<SourceSession>(`/files/${fileId}/source-session`),
        api.post<SourceCollaborationToken>(
          `/files/${fileId}/collaboration-token`,
          {}
        ),
        readSourceDrafts(draftKey),
      ]);
      if (cancelled) return;
      if (
        session.epoch !== credentials.epoch ||
        session.room !== credentials.room
      )
        throw new Error(m.source_edit_session_changed());
      const response = await fetch(session.sourceURL);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (cancelled) return;
      const shared = new Y.Doc();
      doc = shared;
      if (session.state)
        Y.applyUpdate(shared, decodeSourceState(session.state), RESTORE_ORIGIN);
      recoveryDrafts = sourceRecoveryDrafts(drafts, session);
      const draft = recoveryDrafts[0];
      if (draft) {
        shared.destroy();
        const recovered = new Y.Doc();
        doc = recovered;
        for (const snapshot of recoveryDrafts)
          Y.applyUpdate(recovered, snapshot.state, RESTORE_ORIGIN);
        setLoaded({
          bytes: draft.base,
          doc: recovered,
          session: {
            ...session,
            baseSourceSHA256: draft.baseSourceSHA256,
            epoch: draft.epoch,
          },
        });
        setStatus('recovery');
        setDirty(true);
        setError(m.source_edit_recovery());
        return;
      }
      recoveryDrafts = null;
      restoredDrafts = drafts;
      for (const restored of restoredDrafts)
        Y.applyUpdate(shared, restored.state, RESTORE_ORIGIN);
      if (restoredDrafts.length) setDirty(true);
      setLoaded({ bytes, doc: shared, session });
      let initialToken: SourceCollaborationToken | null = credentials;
      const pending = new Map<string, number>();
      const active = {
        acknowledged: -1,
        checkpoint: () => {},
        pending,
        provider: null as unknown as HocuspocusProvider,
        recovery: false,
        sequence: restoredDrafts.length ? 1 : 0,
      };
      const checkpoint = () => {
        if (!provider?.isAuthenticated || active.recovery) return;
        clearTimeout(timer);
        const id = crypto.randomUUID();
        pending.set(id, active.sequence);
        provider.sendStateless(
          JSON.stringify({ id, type: 'checkpoint-request' })
        );
      };
      active.checkpoint = checkpoint;
      provider = new HocuspocusProvider({
        document: shared,
        name: session.room,
        onAuthenticationFailed: ({ reason }) => {
          if (!active.recovery) fail(new Error(reason));
        },
        onDisconnect: () => {
          if (!cancelled) setHandoff(false);
          if (!cancelled && !active.recovery) {
            setStatus('offline');
            setSynced(false);
          }
        },
        onStateless: ({ payload }) => {
          let event: {
            type?: string;
            fileId?: string;
            epoch?: number;
            newEpoch?: number;
            id?: string;
            checkpoint?: number;
            checkpointIds?: string[];
            message?: string;
            recoverable?: boolean;
          };
          try {
            event = JSON.parse(payload);
          } catch {
            return;
          }
          if (event.fileId !== fileId || cancelled) return;
          if (event.type === 'source-handoff-cancel') {
            setHandoff(false);
            return;
          }
          if (
            event.type === 'source-handoff-prepare' &&
            event.epoch === session.epoch &&
            event.id
          ) {
            setHandoff(true);
            const handoffEvent = event;
            const prepare = async () => {
              try {
                await flushHandler.current?.(true);
                await save();
                if (
                  cancelled ||
                  active.recovery ||
                  active.acknowledged < active.sequence ||
                  bufferDirtyRef.current
                )
                  return;
                provider?.sendStateless(
                  JSON.stringify({
                    checkpoint: handoffEvent.checkpoint,
                    clean: true,
                    epoch: session.epoch,
                    id: handoffEvent.id,
                    type: 'source-handoff-ready',
                  })
                );
              } catch (error) {
                fail(error);
              }
            };
            void prepare();
            return;
          }
          if (event.type === 'source-epoch-changed') {
            provider?.disconnect();
            if (
              active.acknowledged >= active.sequence &&
              !bufferDirtyRef.current
            ) {
              setGeneration((value) => value + 1);
            } else {
              active.recovery = true;
              setStatus('recovery');
              setError(m.source_edit_recovery());
            }
            return;
          }
          if (
            event.type === 'source-checkpoint-failed' &&
            event.epoch === session.epoch
          ) {
            fail(new Error(event.message ?? m.source_edit_save_failed()));
            for (const id of event.checkpointIds ?? [])
              active.pending.delete(id);
            if (event.recoverable === false) {
              active.recovery = true;
              provider?.disconnect();
              setStatus('recovery');
            }
            return;
          }
          if (event.type === 'document-rejected') {
            fail(new Error(event.message ?? m.source_edit_save_failed()));
            return;
          }
          if (
            event.type !== 'checkpoint-persisted' ||
            event.epoch !== session.epoch ||
            !Array.isArray(event.checkpointIds)
          )
            return;
          if (acknowledgeSourceCheckpoint(active, event.checkpointIds)) {
            setStatus('saved');
            setDirty(false);
            setError(null);
            const acknowledgedDrafts = [
              ...restoredDrafts,
              ...(latestDraft ? [latestDraft] : []),
            ];
            restoredDrafts = [];
            queueDraftWrite(() => clearSourceDrafts(acknowledgedDrafts));
          }
          flushWaiters.current = flushWaiters.current.filter((waiter) => {
            if (waiter.sequence <= active.acknowledged) {
              waiter.resolve();
              return false;
            }
            return true;
          });
        },
        onSynced: ({ state }) => {
          if (state && !cancelled && !active.recovery) {
            setSynced(true);
            checkpoint();
          }
        },
        token: async () => {
          const token =
            initialToken ??
            (await api.post<SourceCollaborationToken>(
              `/files/${fileId}/collaboration-token`,
              {}
            ));
          initialToken = null;
          if (token.epoch !== session.epoch || token.room !== session.room) {
            if (
              active.acknowledged >= active.sequence &&
              !bufferDirtyRef.current
            ) {
              cancelled = true;
              provider?.disconnect();
              setGeneration((value) => value + 1);
              throw new Error(m.source_edit_session_changed());
            }
            active.recovery = true;
            setStatus('recovery');
            setError(m.source_edit_recovery());
            setSynced(false);
            throw new Error(m.source_edit_recovery());
          }
          return token.token;
        },
        url: credentials.url,
      });
      active.provider = provider;
      runtime.current = active;
      shared.on('update', (_update: Uint8Array, origin: unknown) => {
        if (origin === provider || origin === RESTORE_ORIGIN) return;
        active.sequence++;
        setDirty(true);
        setStatus(active.recovery ? 'recovery' : 'saving');
        const snapshot = {
          base: bytes,
          baseSourceSHA256: session.baseSourceSHA256,
          epoch: session.epoch,
          fileId: draftKey,
          id: draftId,
          state: Y.encodeStateAsUpdate(shared),
          version: crypto.randomUUID(),
        };
        latestDraft = snapshot;
        queueDraftWrite(() => writeSourceDraft(snapshot));
        clearTimeout(timer);
        timer = setTimeout(checkpoint, 1000);
      });
    })().catch(fail);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      runtime.current = null;
      discardHandler.current = null;
      provider?.destroy();
      doc?.destroy();
      for (const waiter of flushWaiters.current.splice(0))
        waiter.reject(new Error(m.source_edit_save_failed()));
    };
  }, [fileId, actorId, enabled, generation, save, pendingInput]);

  useEffect(() => {
    if (!dirty && !bufferDirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty, bufferDirty]);

  return {
    ...loaded,
    dirty: dirty || bufferDirty,
    discardDraft,
    discarding,
    error,
    flushHandler,
    handoff,
    pendingInput,
    save,
    status: status === 'saved' && bufferDirty ? ('saving' as const) : status,
    synced,
  };
}
