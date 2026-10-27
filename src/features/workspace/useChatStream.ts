import type { QueryClient } from '@tanstack/react-query';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useRef, useState } from 'react';
import {
  type ChatStreamBody,
  chatErrorMessage,
  streamChat,
} from '@/api/chatStream';
import { isApiError, qk } from '@/api/client';
import { useStopChatTurn } from '@/api/hooks';
import type {
  ActivityBlock,
  ChatMessage,
  ChatRole,
  ChatStatus,
  ResourceEffect,
  UndoRef,
  WireMessage,
} from '@/api/types';
import { markGettingStarted } from '@/features/guide/gettingStarted';
import { m } from '@/i18n';
import { track } from '@/lib/analytics';
import { errorCopy } from '@/lib/errors';
import type { ToolBlock } from './chat/trace';

/** Map a persisted wire message onto the UI turn shape (narrowing role/status). */
export function toChatMessage(row: WireMessage): ChatMessage {
  return {
    activity: row.activity ?? undefined,
    citations: row.citations ?? undefined,
    content: row.content,
    conversationId: row.conversationId,
    createdAt: row.createdAt,
    error: row.errorCode
      ? chatErrorMessage({ code: row.errorCode }, m.chat_failed())
      : undefined,
    id: row.id,
    modelDisplayName: row.modelDisplayName ?? undefined,
    modelSlug: row.modelSlug ?? undefined,
    modelVersion: row.modelVersion ?? undefined,
    providerSlug: row.providerSlug ?? undefined,
    role: row.role as ChatRole,
    status: row.status as ChatStatus,
  };
}

/** Refresh only the caches a committed effect touched. Runs for live tool
 * results, never for hydrated history, so reopening a conversation does not
 * refetch or replace a mounted editor. */
export function invalidateForEffects(
  qc: QueryClient,
  chatWorkspaceId: string | null,
  effects: ResourceEffect[] | undefined
) {
  for (const effect of effects ?? []) {
    // The account chat's effects name their workspace ("" or none: No
    // workspace, whose lists are the owned roots below).
    const workspaceId = chatWorkspaceId ?? effect.resource.workspaceId ?? '';
    if (effect.resource.kind === 'material') {
      if (workspaceId)
        void qc.invalidateQueries({ queryKey: qk.materials(workspaceId) });
      void qc.invalidateQueries({ queryKey: qk.ownedMaterialsRoot });
      void qc.invalidateQueries({ queryKey: qk.recent });
      if (effect.operation !== 'created') {
        void qc.invalidateQueries({
          queryKey: qk.material(effect.resource.id),
        });
      }
    } else {
      if (workspaceId)
        void qc.invalidateQueries({ queryKey: qk.files(workspaceId) });
      void qc.invalidateQueries({ queryKey: qk.ownedFilesRoot });
      void qc.invalidateQueries({ queryKey: qk.recent });
      if (effect.operation !== 'created') {
        void qc.invalidateQueries({ queryKey: qk.file(effect.resource.id) });
      }
    }
    if (
      workspaceId &&
      (effect.operation === 'trashed' || effect.operation === 'restored')
    ) {
      void qc.invalidateQueries({ queryKey: qk.chapters(workspaceId) });
      void qc.invalidateQueries({ queryKey: qk.workspaceStats(workspaceId) });
    }
  }
}

/** A turn in this panel. `key` stays the placeholder's id after the server
 * names the message, so the bubble (and its timers) does not remount. */
export type LiveMessage = ChatMessage & { key?: string };

const tempId = () =>
  `tmp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

/** Later citation events win. Equal versions still apply so a retry can replace. */
export function shouldApplyCitations(
  version: number,
  applied: number
): boolean {
  return version >= applied;
}

type PendingSources = { fileIds: string[]; omitted: boolean };

type TurnIds = { conversationId: string; messageId: string };

/** One turn's Stop: a request to the server, which saves the turn and starts
 * nothing further, then `abort` stops reading the stream. Pressed before the
 * server names the turn (`named`), the request goes once it does. A refused
 * request leaves the stream running (its toast says so) for another press;
 * one that cannot reach the server stops reading anyway, since the server
 * finishes a turn whose browser left. */
export function turnStopper(
  request: (ids: TurnIds) => Promise<unknown>,
  abort: () => void
) {
  let ids: TurnIds | null = null;
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    if (!ids) return;
    try {
      await request(ids);
    } catch (error) {
      if (isApiError(error)) {
        stopping = false;
        return;
      }
    }
    abort();
  };
  return {
    named(next: TurnIds) {
      ids = next;
      if (!stopping) return;
      stopping = false;
      void stop();
    },
    stop: () => void stop(),
  };
}

/** One conversation's live state. A turn keeps streaming into its own thread
 * after the learner starts or opens another conversation. */
type Thread = {
  conversationId: string | null;
  messages: LiveMessage[];
  pendingSources: PendingSources | null;
  streaming: boolean;
};

const emptyThread = (): Thread => ({
  conversationId: null,
  messages: [],
  pendingSources: null,
  streaming: false,
});

/**
 * Client state machine for the shown conversation plus any turns still
 * streaming in conversations the learner left. Holds each message list,
 * drives the SSE streams, and tracks each in-flight assistant turn so blocks
 * land on the right bubble. Stop asks the server to end the turn, then stops
 * reading; leaving a conversation, or the page, does not end its turn.
 * A null `workspaceId` is the account chat.
 */
export function useChatStream(workspaceId: string | null) {
  const qc = useQueryClient();
  const [initialKey] = useState(tempId);
  const [threads, setThreads] = useState<Record<string, Thread>>(() => ({
    [initialKey]: emptyThread(),
  }));
  const [active, setActive] = useState(initialKey);
  // Read by send, so a send right after startNew lands in the new thread.
  const activeRef = useRef(initialKey);
  const threadsRef = useRef(threads);
  threadsRef.current = threads;
  const { mutateAsync: stopTurn } = useStopChatTurn();
  // Each streaming thread's Stop.
  const stopRefs = useRef(new Map<string, () => void>());
  const shown = threads[active] ?? emptyThread();

  const update = useCallback((key: string, up: (t: Thread) => Thread) => {
    setThreads((prev) =>
      prev[key] ? { ...prev, [key]: up(prev[key]) } : prev
    );
  }, []);

  const setMessagesIn = useCallback(
    (key: string, up: (prev: LiveMessage[]) => LiveMessage[]) =>
      update(key, (t) => ({ ...t, messages: up(t.messages) })),
    [update]
  );

  const patch = useCallback(
    (key: string, id: string, up: Partial<ChatMessage>) =>
      setMessagesIn(key, (prev) =>
        prev.map((msg) => (msg.id === id ? { ...msg, ...up } : msg))
      ),
    [setMessagesIn]
  );

  /** Shows `key`, dropping every other thread that has finished streaming. */
  const show = useCallback((key: string, thread?: Thread) => {
    activeRef.current = key;
    setActive(key);
    setThreads((prev) => {
      const next: Record<string, Thread> = {};
      for (const [k, t] of Object.entries(prev)) if (t.streaming) next[k] = t;
      next[key] = thread ?? prev[key] ?? emptyThread();
      return next;
    });
  }, []);

  const hydrate = useCallback(
    (convId: string | null, history: ChatMessage[]) => {
      // A conversation still streaming here is fresher than its history.
      const live = Object.entries(threadsRef.current).find(
        ([, t]) => t.streaming && convId && t.conversationId === convId
      );
      if (live) {
        show(live[0]);
        return;
      }
      show(tempId(), {
        ...emptyThread(),
        conversationId: convId,
        messages: history,
      });
    },
    [show]
  );

  const startNew = useCallback(() => show(tempId()), [show]);

  const stop = useCallback(
    () => stopRefs.current.get(activeRef.current)?.(),
    []
  );

  /** Swap one undoable effect in place: the Undo or Redo receipt's effect
   * (carrying the next step's undo ref), or the same effect with its undo
   * marked unavailable after a refusal, which disables the button. */
  const replaceEffect = useCallback(
    (operationId: string, next: ResourceEffect) => {
      const swap = (msg: LiveMessage): LiveMessage => ({
        ...msg,
        activity: msg.activity?.map((block) =>
          block.kind === 'tool'
            ? {
                ...block,
                effects: block.effects?.map((effect) =>
                  effect.undo?.operationId === operationId ? next : effect
                ),
              }
            : block
        ),
      });
      setThreads((prev) =>
        Object.fromEntries(
          Object.entries(prev).map(([k, t]) => [
            k,
            { ...t, messages: t.messages.map(swap) },
          ])
        )
      );
    },
    []
  );

  /** A confirmed Undo or Redo: refresh what it touched and show its receipt. */
  const applyUndo = useCallback(
    (operationId: string, effect: ResourceEffect) => {
      invalidateForEffects(qc, workspaceId, [effect]);
      replaceEffect(operationId, effect);
    },
    [qc, replaceEffect, workspaceId]
  );

  const refuseUndo = useCallback(
    (effect: ResourceEffect & { undo: UndoRef }) =>
      replaceEffect(effect.undo.operationId, {
        ...effect,
        undo: { ...effect.undo, status: 'unavailable' },
      }),
    [replaceEffect]
  );

  const send = useCallback(
    async (
      text: string,
      turn: Pick<ChatStreamBody, 'workspaceOnly' | 'openResource'>
    ) => {
      const trimmed = text.trim();
      const key = activeRef.current;
      const thread = threadsRef.current[key];
      if (!trimmed || thread?.streaming) return;
      const setMessages = (up: (prev: LiveMessage[]) => LiveMessage[]) =>
        setMessagesIn(key, up);

      const userMsg: ChatMessage = {
        content: trimmed,
        id: tempId(),
        role: 'user',
        status: 'complete',
      };
      const placeholderId = tempId();
      let currentId = placeholderId;
      let conversationId = thread?.conversationId ?? null;
      let terminal = false;
      let citationVersion = -1;
      let citations = 0;
      let completed = false;
      const complete = (status: string) => {
        if (completed) return;
        completed = true;
        track('chat_turn_completed', {
          citations,
          status,
          workspaceId,
        });
      };
      track('chat_turn_sent', { hasScope: false, workspaceId });
      markGettingStarted('chat');
      setThreads((prev) => ({
        ...prev,
        [key]: {
          ...(prev[key] ?? emptyThread()),
          messages: [
            ...(prev[key]?.messages ?? []),
            userMsg,
            {
              activity: [],
              content: '',
              // The turn's start for step timings; history has the server's.
              createdAt: new Date().toISOString(),
              id: placeholderId,
              key: placeholderId,
              phase: 'planning',
              role: 'assistant',
              status: 'streaming',
            },
          ],
          streaming: true,
        },
      }));

      const ac = new AbortController();
      const stopper = turnStopper(stopTurn, () => ac.abort());
      stopRefs.current.set(key, stopper.stop);

      const fail = (message: string, code?: string) => {
        if (terminal || ac.signal.aborted) return;
        terminal = true;
        complete('error');
        setMessages((prev) =>
          prev.map((msg) =>
            msg.id === currentId
              ? {
                  ...msg,
                  ...(code === 'response_flagged'
                    ? {
                        citations: [],
                        content: '',
                        currentBlockId: undefined,
                        currentBlockText: '',
                      }
                    : {}),
                  error: message,
                  status: 'error',
                }
              : msg
          )
        );
      };

      try {
        await streamChat(
          workspaceId,
          {
            conversationId: thread?.conversationId ?? undefined,
            ...turn,
            text: trimmed,
          },
          {
            onBlockDelta: (blockId, delta) =>
              setMessages((prev) =>
                prev.map((msg) =>
                  msg.id === currentId && msg.currentBlockId === blockId
                    ? {
                        ...msg,
                        currentBlockText: (msg.currentBlockText ?? '') + delta,
                      }
                    : msg
                )
              ),
            onBlockEnd: (blockId, kind) =>
              setMessages((prev) =>
                prev.map((msg) => {
                  if (msg.id !== currentId || msg.currentBlockId !== blockId) {
                    return msg;
                  }
                  const text = msg.currentBlockText ?? '';
                  if (kind === 'answer') {
                    return {
                      ...msg,
                      content: text,
                      currentBlockId: undefined,
                      currentBlockText: '',
                    };
                  }
                  const activity: ActivityBlock[] = [
                    ...(msg.activity ?? []),
                    { id: blockId, kind: 'narration', text },
                  ];
                  return {
                    ...msg,
                    activity,
                    currentBlockId: undefined,
                    currentBlockText: '',
                  };
                })
              ),
            onBlockStart: (blockId) =>
              patch(key, currentId, {
                currentBlockId: blockId,
                currentBlockText: '',
              }),
            onCitations: (next, version) => {
              if (!shouldApplyCitations(version, citationVersion)) return;
              citationVersion = version;
              citations = next.length;
              patch(key, currentId, { citations: next });
            },
            onDone: ({ status }) => {
              if (terminal) return;
              terminal = true;
              complete(status);
              patch(key, currentId, {
                currentBlockId: undefined,
                currentBlockText: '',
                status,
              });
            },
            onError: fail,
            onPendingSources: (sources) =>
              update(key, (t) => ({ ...t, pendingSources: sources })),
            onPhase: (phase) => patch(key, currentId, { phase }),
            onStart: ({
              messageId,
              conversationId: cid,
              modelDisplayName,
              providerSlug,
              modelSlug,
              modelVersion,
            }) => {
              currentId = messageId;
              conversationId = cid;
              stopper.named({ conversationId: cid, messageId });
              update(key, (t) => ({
                ...t,
                conversationId: cid,
                messages: t.messages.map((msg) =>
                  msg.id === placeholderId
                    ? {
                        ...msg,
                        conversationId: cid,
                        id: messageId,
                        modelDisplayName,
                        modelSlug,
                        modelVersion,
                        providerSlug,
                      }
                    : msg
                ),
              }));
            },
            // Server times when the event carries them, else this clock.
            onToolEnd: (callId, result) => {
              const endedAt = result.endedAt ?? new Date().toISOString();
              invalidateForEffects(qc, workspaceId, result.effects);
              setMessages((prev) =>
                prev.map((msg) => {
                  if (msg.id !== currentId) return msg;
                  return {
                    ...msg,
                    activity: (msg.activity ?? []).map((block) =>
                      block.kind === 'tool' && block.callId === callId
                        ? {
                            ...block,
                            applied: result.applied,
                            effects: result.effects,
                            endedAt,
                            error: result.error,
                            outcome: result.outcome,
                            total: result.total,
                          }
                        : block
                    ),
                  };
                })
              );
            },
            onToolProgress: (callId, { applied, total }) =>
              setMessages((prev) =>
                prev.map((msg) =>
                  msg.id === currentId
                    ? {
                        ...msg,
                        activity: (msg.activity ?? []).map((block) =>
                          block.kind === 'tool' && block.callId === callId
                            ? { ...block, applied, total }
                            : block
                        ),
                      }
                    : msg
                )
              ),
            onToolStart: (callId, name, detail, startedAt) => {
              const tool: ToolBlock = {
                callId,
                detail,
                id: callId,
                kind: 'tool',
                name,
                startedAt: startedAt ?? new Date().toISOString(),
              };
              setMessages((prev) =>
                prev.map((msg) => {
                  if (msg.id !== currentId) return msg;
                  const activity = [...(msg.activity ?? [])];
                  if (
                    !activity.some(
                      (block) =>
                        block.kind === 'tool' && block.callId === callId
                    )
                  ) {
                    activity.push(tool);
                  }
                  return { ...msg, activity };
                })
              );
            },
          },
          ac.signal
        );
        if (!terminal && !ac.signal.aborted) {
          fail(m.chat_failed());
        }
      } catch (error) {
        fail(errorCopy(error, m.chat_failed()));
      } finally {
        if (ac.signal.aborted) {
          complete('aborted');
          patch(key, currentId, { status: 'aborted' });
        }
        if (stopRefs.current.get(key) === stopper.stop)
          stopRefs.current.delete(key);
        // A turn that finished after the learner left its conversation drops
        // its thread; reopening it reads the history.
        setThreads((prev) => {
          if (!prev[key]) return prev;
          if (key === activeRef.current)
            return { ...prev, [key]: { ...prev[key], streaming: false } };
          const rest = { ...prev };
          delete rest[key];
          return rest;
        });
        void qc.invalidateQueries({ queryKey: qk.conversations(workspaceId) });
        if (conversationId)
          void qc.invalidateQueries({ queryKey: qk.messages(conversationId) });
      }
    },
    [qc, patch, setMessagesIn, stopTurn, update, workspaceId]
  );

  return {
    applyUndo,
    conversationId: shown.conversationId,
    hydrate,
    messages: shown.messages,
    pendingSources: shown.pendingSources,
    refuseUndo,
    send,
    startNew,
    stop,
    streaming: shown.streaming,
  };
}
