import type { QueryClient } from '@tanstack/react-query';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  type ChatStreamBody,
  type ChatStreamHandlers,
  chatErrorMessage,
  resumeChat,
  streamChat,
} from '@/api/chatStream';
import { isApiError, qk } from '@/api/client';
import { updateConversationBodyTitleMax } from '@/api/gen/validators';
import { messagesQuery, useStopChatTurn } from '@/api/hooks';
import type {
  ActivityBlock,
  ChatMessage,
  ChatRole,
  ChatStatus,
  Conversation,
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

/** A new conversation's title, as the server sets it from the first message
 * (titleFrom in server/internal/httpapi/chat_stream.go). */
function titleFrom(text: string) {
  const chars = [...text.replaceAll('\n', ' ').trim()];
  if (chars.length <= updateConversationBodyTitleMax) return chars.join('');
  return `${chars
    .slice(0, updateConversationBodyTitleMax - 1)
    .join('')
    .trim()}…`;
}

/** Lists a started turn's conversation where the server now has it: first
 * among the unpinned (pinned ones sort by pin time and keep their place), a
 * new one (`title` given) added. One missing from the live list (archived)
 * stays out. The list refetches when the turn settles. */
function listTurn(
  qc: QueryClient,
  workspaceId: string | null,
  id: string,
  title: string | undefined
) {
  qc.setQueryData<Conversation[]>(qk.conversations(workspaceId), (list) => {
    if (!list) return list;
    const now = new Date().toISOString();
    const found = list.find((c) => c.id === id);
    // An account conversation's workspaceId is "".
    const row: Conversation | undefined = found
      ? { ...found, updatedAt: now }
      : title === undefined
        ? undefined
        : {
            createdAt: now,
            id,
            running: true,
            title,
            updatedAt: now,
            workspaceId: workspaceId ?? '',
          };
    if (!row) return list;
    if (row.pinnedAt) return list.map((c) => (c.id === id ? row : c));
    return [row, ...list.filter((c) => c.id !== id)];
  });
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

/** Resolves once the browser is online (at once unless it says it is
 * offline) or `signal` aborts. */
function online(signal: AbortSignal): Promise<void> {
  if (navigator.onLine !== false) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      window.removeEventListener('online', done);
      signal.removeEventListener('abort', done);
      resolve();
    };
    window.addEventListener('online', done);
    signal.addEventListener('abort', done);
  });
}

/** One conversation's live state. A turn keeps streaming into its own thread
 * after the learner starts or opens another conversation; a turn this tab
 * follows without having sent it (`resumed`) streams only while shown
 * (Epo 2026-10-27, T19). */
type Thread = {
  conversationId: string | null;
  messages: LiveMessage[];
  pendingSources: PendingSources | null;
  resumed?: boolean;
  streaming: boolean;
};

const emptyThread = (): Thread => ({
  conversationId: null,
  messages: [],
  pendingSources: null,
  streaming: false,
});

/** Opens one connection to a turn's events. */
type Connect = (
  handlers: ChatStreamHandlers,
  signal: AbortSignal
) => Promise<void>;

/**
 * Client state machine for the shown conversation plus any turns still
 * streaming in conversations the learner left. Holds each message list,
 * drives the SSE streams, and tracks each in-flight assistant turn so blocks
 * land on the right bubble. Stop asks the server to end the turn, then stops
 * reading; leaving a conversation, or the page, does not end its turn. A
 * conversation whose history ends in a turn still running follows it again,
 * and a dropped connection reconnects once online (Epo 2026-10-27, T19).
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
  // Each streaming thread's Stop, and each resumed thread's way to stop
  // reading when it is no longer shown.
  const stopRefs = useRef(new Map<string, () => void>());
  const leaveRefs = useRef(new Map<string, () => void>());
  const shown = threads[active] ?? emptyThread();

  useEffect(() => {
    const leaving = leaveRefs.current;
    return () => {
      for (const leave of leaving.values()) leave();
    };
  }, []);

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

  /** Shows `key`, dropping every other thread that has finished streaming
   * or that follows a turn this tab did not send. */
  const show = useCallback((key: string, thread?: Thread) => {
    activeRef.current = key;
    setActive(key);
    for (const [k, leave] of leaveRefs.current) if (k !== key) leave();
    setThreads((prev) => {
      const next: Record<string, Thread> = {};
      for (const [k, t] of Object.entries(prev))
        if (t.streaming && !t.resumed) next[k] = t;
      next[key] = thread ?? prev[key] ?? emptyThread();
      return next;
    });
  }, []);

  /** Streams one turn into message `rowId` of thread `key`: `connect` opens
   * the first connection, and `named` is a turn the server already named (one
   * this tab follows again), and `newTitle` a sent turn's new conversation's
   * title for the list. A drop after the server named the turn reconnects
   * once the browser is online, and the replay rebuilds the message. */
  const follow = useCallback(
    async (
      key: string,
      rowId: string,
      connect: Connect,
      named: TurnIds | null,
      newTitle?: string
    ) => {
      const setMessages = (up: (prev: LiveMessage[]) => LiveMessage[]) =>
        setMessagesIn(key, up);
      const resumed = named !== null;
      let ids = named;
      let currentId = rowId;
      let conversationId = ids?.conversationId ?? null;
      let terminal = false;
      let citationVersion = -1;
      let citations = 0;
      let completed = false;
      let left = false;
      // A turn followed again was sent, and is counted, by its own tab.
      const complete = (status: string) => {
        if (completed || resumed) return;
        completed = true;
        track('chat_turn_completed', {
          citations,
          status,
          workspaceId,
        });
      };

      const ac = new AbortController();
      const stopper = turnStopper(stopTurn, () => ac.abort());
      if (ids) stopper.named(ids);
      stopRefs.current.set(key, stopper.stop);
      const leave = () => {
        left = true;
        ac.abort();
      };
      if (resumed) leaveRefs.current.set(key, leave);

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

      // What the current connection did: started (the turn is named),
      // dropped, or found the turn over.
      const conn = {
        dropped: null as { error?: unknown } | null,
        gone: false,
        started: false,
      };
      // Each call's tool, for what its end refreshes.
      const toolNames = new Map<string, string>();
      const handlers: ChatStreamHandlers = {
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
        onDrop: (error) => {
          conn.dropped = { error };
        },
        onError: fail,
        onGone: () => {
          conn.gone = true;
        },
        onPendingSources: (sources) =>
          update(key, (t) => ({ ...t, pendingSources: sources })),
        onPhase: (phase) => patch(key, currentId, { phase }),
        // Every connection starts with the turn's first event, and the
        // message is rebuilt from there.
        onStart: ({
          messageId,
          conversationId: cid,
          modelDisplayName,
          providerSlug,
          modelSlug,
          modelVersion,
        }) => {
          conn.started = true;
          currentId = messageId;
          conversationId = cid;
          citationVersion = -1;
          if (!ids) {
            ids = { conversationId: cid, messageId };
            stopper.named(ids);
            // The server saved the message before this first event, so the
            // list moves now rather than at the turn's end.
            listTurn(qc, workspaceId, cid, newTitle);
          }
          update(key, (t) => ({
            ...t,
            conversationId: cid,
            messages: t.messages.map((msg) =>
              msg.id === rowId || msg.id === messageId
                ? {
                    ...msg,
                    activity: [],
                    citations: undefined,
                    content: '',
                    conversationId: cid,
                    currentBlockId: undefined,
                    currentBlockText: '',
                    error: undefined,
                    id: messageId,
                    modelDisplayName,
                    modelSlug,
                    modelVersion,
                    phase: 'planning',
                    providerSlug,
                    status: 'streaming',
                  }
                : msg
            ),
          }));
        },
        // Server times when the event carries them, else this clock.
        onToolEnd: (callId, result) => {
          const endedAt = result.endedAt ?? new Date().toISOString();
          invalidateForEffects(qc, workspaceId, result.effects);
          // A workspace account chat made has no effect (no Undo, Epo
          // 2026-10-28): its lists refetch as after the New workspace
          // dialog.
          if (
            toolNames.get(callId) === 'create_workspace' &&
            result.outcome === 'succeeded'
          ) {
            void qc.invalidateQueries({ queryKey: ['workspaces'] });
            void qc.invalidateQueries({ queryKey: ['tags'] });
          }
          // A chapter chat made has no effect either (Epo 2026-10-29); the
          // account chat's names no workspace, so every chapter list refetches.
          if (
            toolNames.get(callId) === 'create_chapter' &&
            result.outcome === 'succeeded'
          ) {
            void qc.invalidateQueries({
              predicate: ({ queryKey }) =>
                queryKey[0] === 'workspace' && queryKey[2] === 'chapters',
            });
          }
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
          toolNames.set(callId, name);
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
                  (block) => block.kind === 'tool' && block.callId === callId
                )
              ) {
                activity.push(tool);
              }
              return { ...msg, activity };
            })
          );
        },
      };

      try {
        let open = connect;
        for (;;) {
          Object.assign(conn, { dropped: null, gone: false, started: false });
          await open(handlers, ac.signal);
          if (ac.signal.aborted) break;
          if (conn.gone && ids) {
            // The turn ended since its row was read: show the row as saved.
            const rows = await qc.fetchQuery({
              ...messagesQuery(ids.conversationId),
              staleTime: 0,
            });
            const row = rows.find(({ id }) => id === currentId);
            terminal = true;
            if (row)
              patch(key, currentId, {
                ...toChatMessage(row),
                currentBlockId: undefined,
                currentBlockText: '',
              });
            break;
          }
          if (!conn.dropped) break;
          // A connection that never started has no turn to come back to.
          if (!(conn.started && ids)) {
            fail(errorCopy(conn.dropped.error, m.chat_failed()));
            break;
          }
          await online(ac.signal);
          const { conversationId: cid, messageId } = ids;
          open = (h, signal) => resumeChat(cid, messageId, h, signal);
        }
      } catch (error) {
        fail(errorCopy(error, m.chat_failed()));
      } finally {
        if (ac.signal.aborted && !left) {
          complete('aborted');
          patch(key, currentId, { status: 'aborted' });
        }
        if (stopRefs.current.get(key) === stopper.stop)
          stopRefs.current.delete(key);
        if (leaveRefs.current.get(key) === leave) leaveRefs.current.delete(key);
        // A turn that finished after the learner left its conversation drops
        // its thread; reopening it reads the history.
        setThreads((prev) => {
          if (!prev[key]) return prev;
          if (key === activeRef.current)
            return {
              ...prev,
              [key]: { ...prev[key], resumed: false, streaming: false },
            };
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
      const key = tempId();
      const last = history.at(-1);
      const running =
        convId && last?.role === 'assistant' && last.status === 'streaming'
          ? { conversationId: convId, messageId: last.id }
          : null;
      show(key, {
        ...emptyThread(),
        conversationId: convId,
        messages: history,
        resumed: !!running,
        streaming: !!running,
      });
      if (running)
        void follow(
          key,
          running.messageId,
          (handlers, signal) =>
            resumeChat(
              running.conversationId,
              running.messageId,
              handlers,
              signal
            ),
          running
        );
    },
    [follow, show]
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
      const userMsg: ChatMessage = {
        content: trimmed,
        id: tempId(),
        role: 'user',
        status: 'complete',
      };
      const placeholderId = tempId();
      const newTitle = thread?.conversationId ? undefined : titleFrom(trimmed);
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
      const body: ChatStreamBody = {
        conversationId: thread?.conversationId ?? undefined,
        ...turn,
        text: trimmed,
      };
      await follow(
        key,
        placeholderId,
        (handlers, signal) => streamChat(workspaceId, body, handlers, signal),
        null,
        newTitle
      );
    },
    [follow, workspaceId]
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
