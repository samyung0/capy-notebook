import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useRef, useState } from 'react';
import { streamChat } from '@/api/chatStream';
import { qk } from '@/api/client';
import type {
  ChatMessage,
  ChatRole,
  ChatStatus,
  WireMessage,
} from '@/api/types';
import { m } from '@/i18n';

/** Map a persisted wire message onto the UI turn shape (narrowing role/status). */
export function toChatMessage(m: WireMessage): ChatMessage {
  return {
    citations: m.citations ?? undefined,
    content: m.content,
    conversationId: m.conversationId,
    createdAt: m.createdAt,
    id: m.id,
    modelDisplayName: m.modelDisplayName ?? undefined,
    modelKey: m.modelKey ?? undefined,
    modelVersion: m.modelVersion ?? undefined,
    role: m.role as ChatRole,
    status: m.status as ChatStatus,
  };
}

const tempId = () =>
  `tmp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

/**
 * Client state machine for a single active conversation. Holds the message list,
 * drives the SSE stream, and tracks the in-flight assistant turn so tokens land
 * on the right bubble. Abort propagates through the fetch signal to the gateway.
 */
export function useChatStream(workspaceId: string) {
  const qc = useQueryClient();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [streaming, setStreaming] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const patch = useCallback((id: string, up: Partial<ChatMessage>) => {
    setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, ...up } : m)));
  }, []);

  /** Replace local state with a loaded conversation (history) or a blank thread. */
  const hydrate = useCallback(
    (convId: string | null, history: ChatMessage[]) => {
      setConversationId(convId);
      setMessages(history);
    },
    []
  );

  const startNew = useCallback(() => {
    abortRef.current?.abort();
    setConversationId(null);
    setMessages([]);
  }, []);

  const stop = useCallback(() => abortRef.current?.abort(), []);

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
      setMessages((prev) => [
        ...prev,
        userMsg,
        {
          content: '',
          id: placeholderId,
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
        setMessages((prev) =>
          prev.map((m) =>
            m.id === currentId ? { ...m, error: message, status: 'error' } : m
          )
        );
      };

      try {
        await streamChat(
          workspaceId,
          { conversationId: conversationId ?? undefined, text: trimmed },
          {
            onCitations: (c) => patch(currentId, { citations: c }),
            onDone: ({ status }) => {
              if (terminal) return;
              terminal = true;
              patch(currentId, { status });
            },
            onError: fail,
            onStart: ({
              messageId,
              conversationId: cid,
              modelDisplayName,
              modelKey,
              modelVersion,
            }) => {
              currentId = messageId;
              setConversationId(cid);
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === placeholderId
                    ? {
                        ...m,
                        conversationId: cid,
                        id: messageId,
                        modelDisplayName,
                        modelKey,
                        modelVersion,
                      }
                    : m
                )
              );
            },
            onToken: (t) =>
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === currentId ? { ...m, content: m.content + t } : m
                )
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
        // Aborted streams finalize server-side as 'aborted'; reflect it locally.
        if (ac.signal.aborted) patch(currentId, { status: 'aborted' });
        setStreaming(false);
        if (abortRef.current === ac) abortRef.current = null;
        void qc.invalidateQueries({ queryKey: qk.conversations(workspaceId) });
      }
    },
    [conversationId, qc, patch, streaming, workspaceId]
  );

  return { conversationId, hydrate, messages, send, startNew, stop, streaming };
}
