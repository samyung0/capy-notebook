/**
 * Low-level SSE consumer for the chat streaming endpoint.
 *
 * The Go gateway streams `data: {json}\n\n` events. We use fetch +
 * ReadableStream (not EventSource, which can't POST) so the request carries a
 * JSON body and can be aborted via an AbortController.
 */

import { m } from '@/i18n';
import { errorCopy } from '@/lib/errors';
import { authHeaders } from './auth';
import { API_BASE, ApiError, parseErrorBody } from './client';
import { consumeSSE } from './sse';
import type {
  ChatPhase,
  ChatStatus,
  Citation,
  ResourceEffect,
  ToolError,
  ToolOutcome,
} from './types';

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
  onError?: (message: string, code?: string) => void;
  onPendingSources?: (event: { fileIds: string[]; omitted: boolean }) => void;
  onPhase?: (phase: ChatPhase) => void;
  onStart?: (e: StreamStart) => void;
  onToolEnd?: (callId: string, result: ToolEndEvent) => void;
  onToolStart?: (callId: string, name: string, detail: string) => void;
}

/** Terminal result of one tool call, in the shared agent-tool contract shape. */
export interface ToolEndEvent {
  effects?: ResourceEffect[];
  error?: ToolError;
  outcome: ToolOutcome;
}

const TOOL_OUTCOMES: readonly ToolOutcome[] = [
  'succeeded',
  'refused',
  'failed',
  'cancelled',
  'outcome_unknown',
];

export interface ChatStreamBody {
  conversationId?: string;
  /** The per-turn Library switch: the shared knowledge library is a source. */
  library: boolean;
  /** What the learner has open; the server looks up its title. */
  openResource?: { id: string; kind: 'file' | 'material' };
  text: string;
}

/** The Library switch starts on in every chat panel. */
export const LIBRARY_DEFAULT = true;

/** One turn's switches. Only the open item's id and kind leave the browser;
 * the server looks up its title. */
export function chatTurn(
  library: boolean,
  open: { id: string; kind: 'file' | 'material' } | null | undefined
): Pick<ChatStreamBody, 'library' | 'openResource'> {
  return {
    library,
    openResource: open ? { id: open.id, kind: open.kind } : undefined,
  };
}

/** Chat failure copy chosen by error code; server and pipeline text never
 * renders. */
export function chatErrorMessage(payload: unknown, fallback: string): string {
  switch (parseErrorBody(payload)?.code) {
    case 'source_changed':
      return m.error_source_changed_body();
    case 'response_flagged':
      return m.chat_response_flagged();
    case 'agent_failed':
    case 'invalid_answer':
      return m.chat_failed();
    case 'model_unavailable':
      return m.chat_model_unavailable();
    case 'provider_busy':
      return m.error_provider_busy_body();
    case 'invalid_llm_key':
    case 'invalid_key':
      return m.settings_llm_key_invalid();
    case 'llm_key_failed':
    case 'key_failed':
      return m.settings_llm_key_failed();
    case 'context_too_large':
      return m.chat_context_too_large();
    case 'compaction_failed':
      return m.chat_compaction_failed();
    case 'query_too_long':
      return m.chat_query_too_long();
    case 'invalid_scope':
      return m.chat_invalid_scope();
    case 'ai_unavailable':
      return m.error_ai_unavailable_body();
    case 'too_many_streams':
      return m.error_too_many_streams_body();
    case 'llm_credits_exhausted':
      return m.error_credits_body();
    default:
      return fallback;
  }
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
  const reportError = (message: string, code?: string) => {
    if (terminal || signal?.aborted) return;
    terminal = true;
    handlers.onError?.(message, code);
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
    reportError(errorCopy(e, m.chat_failed()));
    return;
  }

  if (!res.ok || !res.body) {
    const payload = res.ok ? null : await res.json().catch(() => null);
    const fallback = res.ok
      ? m.chat_failed()
      : errorCopy(
          new ApiError(
            res.status,
            res.statusText,
            undefined,
            parseErrorBody(payload)
          ),
          m.chat_failed()
        );
    reportError(chatErrorMessage(payload, fallback));
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
      fileIds?: string[];
      omitted?: boolean;
      blockId?: string;
      callId?: string;
      citations?: Citation[];
      code?: string;
      conversationId?: string;
      detail?: string;
      effects?: ResourceEffect[];
      error?: ToolError;
      generationId?: string;
      kind?: string;
      message?: string;
      messageId?: string;
      modelDisplayName?: string;
      providerSlug?: string;
      modelSlug?: string;
      modelVersion?: number;
      name?: string;
      outcome?: string;
      phase?: ChatPhase;
      status?: ChatStatus;
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
      case 'pending_sources':
        if (
          Array.isArray(ev.fileIds) &&
          ev.fileIds.every((id) => typeof id === 'string') &&
          typeof ev.omitted === 'boolean'
        )
          handlers.onPendingSources?.({
            fileIds: ev.fileIds,
            omitted: ev.omitted,
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
        if (ev.callId && TOOL_OUTCOMES.includes(ev.outcome as ToolOutcome)) {
          handlers.onToolEnd?.(ev.callId, {
            effects: Array.isArray(ev.effects) ? ev.effects : undefined,
            error: ev.error,
            outcome: ev.outcome as ToolOutcome,
          });
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
        reportError(chatErrorMessage(ev, m.chat_failed()), ev.code);
        break;
    }
  };

  try {
    await consumeSSE(res.body, dispatch);
  } catch (e) {
    if ((e as Error).name !== 'AbortError')
      reportError(errorCopy(e, m.chat_failed()));
    return;
  }
  if (!terminal && !signal?.aborted) {
    reportError(m.chat_failed());
  }
}
