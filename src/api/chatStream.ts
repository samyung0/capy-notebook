/**
 * Low-level SSE consumer for the chat streaming endpoint.
 *
 * The Go gateway streams `data: {json}\n\n` events (type: start | token |
 * citations | done | error). We use fetch + ReadableStream (not EventSource,
 * which can't POST) so the request carries a JSON body and can be aborted via an
 * AbortController — the abort propagates all the way to the LLM provider.
 */

import { m } from '@/i18n';
import { authHeaders } from './auth';
import { API_BASE } from './client';
import { consumeSSE } from './sse';
import type { ChatStatus, Citation } from './types';

export interface StreamStart {
  conversationId: string;
  messageId: string;
  modelDisplayName?: string;
  modelKey?: string;
  modelVersion?: number;
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
  text: string;
}

function errorMessage(payload: unknown, fallback: string): string {
  if (!payload || typeof payload !== 'object') return fallback;
  const body = payload as {
    code?: unknown;
    detail?: unknown;
    error?: { message?: unknown };
    message?: unknown;
  };
  if (body.code === 'model_unavailable') return m.chat_model_unavailable();
  if (body.code === 'invalid_llm_key' || body.code === 'invalid_key') {
    return m.settings_llm_key_invalid();
  }
  if (body.code === 'llm_key_failed' || body.code === 'key_failed') {
    return m.settings_llm_key_failed();
  }
  if (typeof body.error?.message === 'string') return body.error.message;
  if (typeof body.message === 'string') return body.message;
  if (typeof body.detail === 'string') return body.detail;
  return fallback;
}

/** POST to the workspace chat stream and dispatch parsed SSE events. Resolves
 * when the stream ends (naturally, on error, or on abort). */
export async function streamChat(
  workspaceId: string,
  body: ChatStreamBody,
  handlers: ChatStreamHandlers,
  signal?: AbortSignal
): Promise<void> {
  let terminal = false;
  const reportError = (message: string) => {
    if (terminal || signal?.aborted) return;
    terminal = true;
    handlers.onError?.(message);
  };
  let res: Response;
  try {
    const auth = await authHeaders();
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
    reportError((e as Error).message);
    return;
  }

  if (!res.ok || !res.body) {
    const fallback = res.ok
      ? 'The chat connection could not be opened.'
      : `${res.status} ${res.statusText}`;
    const payload = res.ok ? null : await res.json().catch(() => null);
    reportError(errorMessage(payload, fallback));
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
      code?: string;
      modelKey?: string;
      modelVersion?: number;
      modelDisplayName?: string;
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
          modelDisplayName: ev.modelDisplayName,
          modelKey: ev.modelKey,
          modelVersion: ev.modelVersion,
        });
        break;
      case 'token':
        handlers.onToken?.(ev.text ?? '');
        break;
      case 'citations':
        handlers.onCitations?.(ev.citations ?? []);
        break;
      case 'done':
        if (terminal) break;
        terminal = true;
        handlers.onDone?.({
          generationId: ev.generationId,
          status: ev.status ?? 'complete',
          tokenCount: ev.tokenCount,
        });
        break;
      case 'error':
        reportError(errorMessage(ev, ev.message ?? 'stream error'));
        break;
    }
  };

  try {
    await consumeSSE(res.body, dispatch);
  } catch (e) {
    if ((e as Error).name !== 'AbortError') reportError((e as Error).message);
    return;
  }
  if (!terminal && !signal?.aborted) {
    reportError('The chat connection closed before the response finished.');
  }
}
