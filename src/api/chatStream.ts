/**
 * Low-level SSE consumer for the chat streaming endpoint.
 *
 * The Go gateway streams `data: {json}\n\n` events (type: start | token |
 * citations | done | error). We use fetch + ReadableStream (not EventSource,
 * which can't POST) so the request carries a JSON body and can be aborted via an
 * AbortController — the abort propagates all the way to the LLM provider.
 */

import { authHeaders } from './auth';
import { API_BASE } from './client';
import { consumeSSE } from './sse';
import type { ChatStatus, Citation } from './types';

export interface StreamStart {
  conversationId: string;
  messageId: string;
}
export interface StreamDone {
  generationId?: string;
  status: ChatStatus;
  tokenCount?: number;
}
export interface ChatStreamHandlers {
  onCitations?: (citations: Citation[]) => void;
  onDone?: (e: StreamDone) => void;
  onError?: (message: string) => void;
  onStart?: (e: StreamStart) => void;
  onToken?: (text: string) => void;
}

export interface ChatStreamBody {
  conversationId?: string;
  model?: string;
  text: string;
}

/** POST to the workspace chat stream and dispatch parsed SSE events. Resolves
 * when the stream ends (naturally, on error, or on abort). */
export async function streamChat(
  workspaceId: string,
  body: ChatStreamBody,
  handlers: ChatStreamHandlers,
  signal?: AbortSignal
): Promise<void> {
  const auth = await authHeaders();
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/workspaces/${workspaceId}/chat/stream`, {
      body: JSON.stringify(body),
      headers: {
        Accept: 'text/event-stream',
        'Content-Type': 'application/json',
        ...auth,
      },
      method: 'POST',
      signal,
    });
  } catch (e) {
    if ((e as Error).name === 'AbortError') return;
    handlers.onError?.((e as Error).message);
    return;
  }

  if (!res.ok || !res.body) {
    handlers.onError?.(`${res.status} ${res.statusText}`);
    return;
  }

  const dispatch = (raw: string) => {
    // An SSE event may span multiple `data:` lines; join their payloads.
    const data = raw
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trim())
      .join('\n');
    if (!data) return;
    let ev: {
      type: string;
      messageId?: string;
      conversationId?: string;
      text?: string;
      citations?: Citation[];
      status?: ChatStatus;
      tokenCount?: number;
      generationId?: string;
      message?: string;
    };
    try {
      ev = JSON.parse(data);
    } catch {
      return;
    }
    switch (ev.type) {
      case 'start':
        handlers.onStart?.({
          conversationId: ev.conversationId!,
          messageId: ev.messageId!,
        });
        break;
      case 'token':
        handlers.onToken?.(ev.text ?? '');
        break;
      case 'citations':
        handlers.onCitations?.(ev.citations ?? []);
        break;
      case 'done':
        handlers.onDone?.({
          generationId: ev.generationId,
          status: ev.status ?? 'complete',
          tokenCount: ev.tokenCount,
        });
        break;
      case 'error':
        handlers.onError?.(ev.message ?? 'stream error');
        break;
    }
  };

  try {
    await consumeSSE(res.body, dispatch);
  } catch (e) {
    if ((e as Error).name !== 'AbortError')
      handlers.onError?.((e as Error).message);
  }
}
