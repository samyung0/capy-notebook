/**
 * Low-level SSE consumer for the note AI completion endpoint. Mirrors
 * chatStream.ts but is stateless (no conversation/citations) — it streams a
 * plain token completion the editor inserts inline. Used for both the AI command
 * menu and Copilot-style "continue writing".
 */

import { authHeaders } from './auth';
import { API_BASE } from './client';

export interface CompleteStreamBody {
  context?: string;
  /** 'command' runs an instruction over optional context; 'continue' extends the
   * given prefix. */
  mode: 'command' | 'continue';
  prompt?: string;
}

export interface CompleteStreamHandlers {
  onDone?: () => void;
  onError?: (message: string) => void;
  onToken?: (text: string) => void;
}

/** POST to the workspace completion stream and dispatch parsed SSE token events.
 * Resolves when the stream ends (naturally, on error, or on abort). */
export async function streamComplete(
  workspaceId: string,
  body: CompleteStreamBody,
  handlers: CompleteStreamHandlers,
  signal?: AbortSignal
): Promise<void> {
  const auth = await authHeaders();
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/workspaces/${workspaceId}/complete/stream`, {
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
    const payload = (await res.json().catch(() => null)) as {
      error?: { message?: string };
    } | null;
    handlers.onError?.(
      payload?.error?.message || `${res.status} ${res.statusText}`
    );
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const dispatch = (raw: string) => {
    const data = raw
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trim())
      .join('\n');
    if (!data) return;
    let ev: { type: string; text?: string; message?: string };
    try {
      ev = JSON.parse(data);
    } catch {
      return;
    }
    switch (ev.type) {
      case 'token':
        handlers.onToken?.(ev.text ?? '');
        break;
      case 'done':
        handlers.onDone?.();
        break;
      case 'error':
        handlers.onError?.(ev.message ?? 'stream error');
        break;
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep = buffer.indexOf('\n\n');
      while (sep !== -1) {
        const chunk = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        dispatch(chunk);
        sep = buffer.indexOf('\n\n');
      }
    }
    if (buffer.trim()) dispatch(buffer);
  } catch (e) {
    if ((e as Error).name !== 'AbortError')
      handlers.onError?.((e as Error).message);
  }
}
