import { authHeaders } from './auth';
import { API_BASE } from './client';
import { consumeSSE } from './sse';
import type { AppNotification } from './types';

export interface NotificationStreamEvent {
  ids?: string[];
  notification?: AppNotification;
  type: 'created' | 'read' | 'removed';
}

function parseEvent(chunk: string): NotificationStreamEvent | null {
  const data = chunk
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .join('\n');
  if (!data) return null;
  try {
    return JSON.parse(data) as NotificationStreamEvent;
  } catch {
    return null;
  }
}

export async function readNotificationStream(
  onEvent: (event: NotificationStreamEvent) => void,
  signal: AbortSignal,
  onOpen?: () => void
): Promise<void> {
  const auth = await authHeaders();
  const response = await fetch(`${API_BASE}/notifications/stream`, {
    headers: {
      Accept: 'text/event-stream',
      ...auth,
    },
    method: 'GET',
    signal,
  });
  if (!response.ok || !response.body) {
    throw new Error(`${response.status} ${response.statusText}`);
  }

  onOpen?.();
  await consumeSSE(response.body, (chunk) => {
    const event = parseEvent(chunk);
    if (event) onEvent(event);
  });
}
