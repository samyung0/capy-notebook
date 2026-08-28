/**
 * Low-level SSE consumer for the chat streaming endpoint.
 *
 * The Go gateway streams `data: {json}\n\n` events. We use fetch +
 * ReadableStream (not EventSource, which can't POST) so the request carries a
 * JSON body and can be aborted via an AbortController.
 */

import { m } from '@/i18n';
import { authHeaders } from './auth';
import { API_BASE } from './client';
import { consumeSSE } from './sse';
import type { ChatPhase, ChatStatus, Citation } from './types';

export interface StreamStart {
  conversationId: string;
  messageId: string;
  modelDisplayName?: string;
  modelSlug?: string;
  modelVersion?: number;
  providerSlug?: string;
}
export interface StreamDone {
  generationId?: string;
  status: ChatStatus;
  tokenCount?: number;
}
export interface ChatStreamHandlers {
  onBlockDelta?: (blockId: string, text: string) => void;
  onBlockEnd?: (blockId: string, kind: 'narration' | 'answer') => void;
  onBlockStart?: (blockId: string) => void;
  onCitations?: (citations: Citation[], version: number) => void;
  onDone?: (e: StreamDone) => void;
  onError?: (message: string) => void;
  onPhase?: (phase: ChatPhase) => void;
  onStart?: (e: StreamStart) => void;
  onToolEnd?: (callId: string, status: 'success' | 'refused') => void;
  onToolStart?: (callId: string, name: string, detail: string) => void;
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
  if (body.code === 'agent_failed') return m.chat_failed();
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
    const data = raw
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trim())
      .join('\n');
    if (!data) return;
    let ev: {
      blockId?: string;
      callId?: string;
      citations?: Citation[];
      code?: string;
      conversationId?: string;
      detail?: string;
      generationId?: string;
      kind?: string;
      message?: string;
      messageId?: string;
      modelDisplayName?: string;
      providerSlug?: string;
      modelSlug?: string;
      modelVersion?: number;
      name?: string;
      phase?: ChatPhase;
      status?: ChatStatus | 'success' | 'refused';
      text?: string;
      tokenCount?: number;
      type: string;
      version?: number;
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
          modelSlug: ev.modelSlug,
          modelVersion: ev.modelVersion,
          providerSlug: ev.providerSlug,
        });
        break;
      case 'phase':
        if (ev.phase) handlers.onPhase?.(ev.phase);
        break;
      case 'block_start':
        if (ev.blockId) handlers.onBlockStart?.(ev.blockId);
        break;
      case 'block_delta':
        if (ev.blockId) handlers.onBlockDelta?.(ev.blockId, ev.text ?? '');
        break;
      case 'block_end':
        if (ev.blockId && (ev.kind === 'narration' || ev.kind === 'answer')) {
          handlers.onBlockEnd?.(ev.blockId, ev.kind);
        }
        break;
      case 'tool_start':
        if (ev.callId) {
          handlers.onToolStart?.(ev.callId, ev.name ?? '', ev.detail ?? '');
        }
        break;
      case 'tool_end':
        if (ev.callId && (ev.status === 'success' || ev.status === 'refused')) {
          handlers.onToolEnd?.(ev.callId, ev.status);
        }
        break;
      case 'citations':
        handlers.onCitations?.(ev.citations ?? [], ev.version ?? 0);
        break;
      case 'done':
        if (terminal) break;
        terminal = true;
        handlers.onDone?.({
          generationId: ev.generationId,
          status: (ev.status as ChatStatus) ?? 'complete',
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
