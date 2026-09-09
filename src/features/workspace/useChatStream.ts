import type { QueryClient } from '@tanstack/react-query';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useRef, useState } from 'react';
import { streamChat } from '@/api/chatStream';
import { qk } from '@/api/client';
import type {
  ActivityBlock,
  ChatMessage,
  ChatRole,
  ChatStatus,
  ResourceEffect,
  WireMessage,
} from '@/api/types';
import { m } from '@/i18n';
import { track } from '@/lib/observability';

/** Map a persisted wire message onto the UI turn shape (narrowing role/status). */
export function toChatMessage(row: WireMessage): ChatMessage {
  return {
    activity: row.activity ?? undefined,
    citations: row.citations ?? undefined,
    content: row.content,
    conversationId: row.conversationId,
    createdAt: row.createdAt,
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
  workspaceId: string,
  effects: ResourceEffect[] | undefined
) {
  for (const effect of effects ?? []) {
    if (effect.resource.kind === 'material') {
      void qc.invalidateQueries({ queryKey: qk.materials(workspaceId) });
      void qc.invalidateQueries({ queryKey: qk.quizzes });
      void qc.invalidateQueries({ queryKey: qk.flashcardSets });
      if (effect.operation !== 'created') {
        void qc.invalidateQueries({
          queryKey: qk.material(effect.resource.id),
        });
      }
    } else {
      void qc.invalidateQueries({ queryKey: qk.files(workspaceId) });
      void qc.invalidateQueries({ queryKey: qk.allFiles });
      if (effect.operation !== 'created') {
        void qc.invalidateQueries({ queryKey: qk.file(effect.resource.id) });
      }
    }
    if (effect.operation === 'trashed' || effect.operation === 'restored') {
      void qc.invalidateQueries({ queryKey: qk.chapters(workspaceId) });
      void qc.invalidateQueries({ queryKey: qk.workspaceStats(workspaceId) });
    }
  }
}

const tempId = () =>
  `tmp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

/** Later citation events win. Equal versions still apply so a retry can replace. */
export function shouldApplyCitations(
  version: number,
  applied: number
): boolean {
  return version >= applied;
}

/**
 * Client state machine for a single active conversation. Holds the message list,
 * drives the SSE stream, and tracks the in-flight assistant turn so blocks land
 * on the right bubble. Abort propagates through the fetch signal to the gateway.
 */
export function useChatStream(workspaceId: string) {
  const qc = useQueryClient();
  const [pendingSources, setPendingSources] = useState<{
    fileIds: string[];
    omitted: boolean;
  } | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [streaming, setStreaming] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const patch = useCallback((id: string, up: Partial<ChatMessage>) => {
    setMessages((prev) =>
      prev.map((msg) => (msg.id === id ? { ...msg, ...up } : msg))
    );
  }, []);

  const hydrate = useCallback(
    (convId: string | null, history: ChatMessage[]) => {
      setPendingSources(null);
      setConversationId(convId);
      setMessages(history);
    },
    []
  );

  const startNew = useCallback(() => {
    abortRef.current?.abort();
    setPendingSources(null);
    setConversationId(null);
    setMessages([]);
  }, []);

  const stop = useCallback(() => abortRef.current?.abort(), []);

  /** Reflect a server-confirmed Undo on the card that offered it. */
  const markUndone = useCallback(
    (operationId: string, effects: ResourceEffect[] | undefined) => {
      invalidateForEffects(qc, workspaceId, effects);
      setMessages((prev) =>
        prev.map((msg) => ({
          ...msg,
          activity: msg.activity?.map((block) =>
            block.kind === 'tool'
              ? {
                  ...block,
                  effects: block.effects?.map((effect) =>
                    effect.undo?.operationId === operationId
                      ? {
                          ...effect,
                          undo: { ...effect.undo, status: 'undone' as const },
                        }
                      : effect
                  ),
                }
              : block
          ),
        }))
      );
    },
    [qc, workspaceId]
  );

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || streaming) return;

      const userMsg: ChatMessage = {
        content: trimmed,
        id: tempId(),
        role: 'user',
        status: 'complete',
      };
      const placeholderId = tempId();
      let currentId = placeholderId;
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
      setMessages((prev) => [
        ...prev,
        userMsg,
        {
          activity: [],
          content: '',
          id: placeholderId,
          phase: 'planning',
          role: 'assistant',
          status: 'streaming',
        },
      ]);
      setStreaming(true);

      const ac = new AbortController();
      abortRef.current = ac;

      const fail = (message: string) => {
        if (terminal || ac.signal.aborted) return;
        terminal = true;
        complete('error');
        setMessages((prev) =>
          prev.map((msg) =>
            msg.id === currentId
              ? { ...msg, error: message, status: 'error' }
              : msg
          )
        );
      };

      try {
        await streamChat(
          workspaceId,
          { conversationId: conversationId ?? undefined, text: trimmed },
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
              patch(currentId, {
                currentBlockId: blockId,
                currentBlockText: '',
              }),
            onCitations: (next, version) => {
              if (!shouldApplyCitations(version, citationVersion)) return;
              citationVersion = version;
              citations = next.length;
              patch(currentId, { citations: next });
            },
            onDone: ({ status }) => {
              if (terminal) return;
              terminal = true;
              complete(status);
              patch(currentId, {
                currentBlockId: undefined,
                currentBlockText: '',
                status,
              });
            },
            onError: fail,
            onPendingSources: setPendingSources,
            onPhase: (phase) => patch(currentId, { phase }),
            onStart: ({
              messageId,
              conversationId: cid,
              modelDisplayName,
              providerSlug,
              modelSlug,
              modelVersion,
            }) => {
              currentId = messageId;
              setConversationId(cid);
              setMessages((prev) =>
                prev.map((msg) =>
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
                )
              );
            },
            onToolEnd: (callId, result) => {
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
                            effects: result.effects,
                            error: result.error,
                            outcome: result.outcome,
                          }
                        : block
                    ),
                  };
                })
              );
            },
            onToolStart: (callId, name, detail) =>
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
                    activity.push({
                      callId,
                      detail,
                      id: callId,
                      kind: 'tool',
                      name,
                    });
                  }
                  return { ...msg, activity };
                })
              ),
          },
          ac.signal
        );
        if (!terminal && !ac.signal.aborted) {
          fail(m.chat_failed());
        }
      } catch (error) {
        fail(error instanceof Error ? error.message : m.chat_failed());
      } finally {
        if (ac.signal.aborted) {
          complete('aborted');
          patch(currentId, { status: 'aborted' });
        }
        setStreaming(false);
        if (abortRef.current === ac) abortRef.current = null;
        void qc.invalidateQueries({ queryKey: qk.conversations(workspaceId) });
      }
    },
    [conversationId, qc, patch, streaming, workspaceId]
  );

  return {
    conversationId,
    hydrate,
    markUndone,
    messages,
    pendingSources,
    send,
    startNew,
    stop,
    streaming,
  };
}
