import { authHeaders } from './auth';
import { API_BASE } from './client';
import { consumeSSE, sseData, sseEvent } from './sse';
import type { AppNotification, ChatStatus, FileStatus } from './types';

export interface IngestEvent {
  fileId: string;
  indexed?: boolean;
  message?: string;
  pct: number;
  stage?: string;
  status: FileStatus;
}

export type NotificationStreamEvent =
  | {
      ids?: string[];
      notification?: AppNotification;
      /** `billing` and `customization` carry nothing: they ask the tab to
       * refetch billing, or /api/me and adopt the look another device synced. */
      type: 'billing' | 'created' | 'customization' | 'read' | 'removed';
    }
  /** A standalone file's ingest progress: it has no workspace channel, so it
   * rides the owner's notifications. */
  | (IngestEvent & { type: 'ingest' })
  /** A conversation's turn started (`streaming`) or saved its ending, for
   * the running mark in the conversation lists (Epo 2026-10-27, T19). */
  | { conversationId: string; status: ChatStatus; type: 'chat_turn' };

export type StreamEvent =
  | { data: NotificationStreamEvent; name: 'notification' }
  | { data: IngestEvent; name: 'ingest' }
  | { data: { kind: 'files' | 'materials' }; name: 'tree' };

const FILE_STATUSES: readonly string[] = [
  'pending',
  'processing',
  'ready',
  'failed',
];

function isIngestEvent(value: Record<string, unknown>) {
  return (
    typeof value.fileId === 'string' &&
    typeof value.pct === 'number' &&
    Number.isFinite(value.pct) &&
    FILE_STATUSES.includes(String(value.status))
  );
}

function parseEvent(chunk: string): StreamEvent | null {
  const raw = sseData(chunk);
  if (!raw) return null;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== 'object' || data === null) return null;
  const value = data as Record<string, unknown>;
  switch (sseEvent(chunk)) {
    case 'notification':
      if (value.type === 'ingest' && !isIngestEvent(value)) return null;
      if (
        value.type === 'chat_turn' &&
        (typeof value.conversationId !== 'string' ||
          typeof value.status !== 'string')
      )
        return null;
      return {
        data: value as unknown as NotificationStreamEvent,
        name: 'notification',
      };
    case 'ingest':
      if (!isIngestEvent(value)) return null;
      return { data: value as unknown as IngestEvent, name: 'ingest' };
    case 'tree':
      if (value.kind !== 'files' && value.kind !== 'materials') return null;
      return { data: { kind: value.kind }, name: 'tree' };
    default:
      return null;
  }
}

/** Hold the one SSE connection open until the server ends it or `signal`
 * aborts. Uses fetch rather than EventSource: the Clerk session token only
 * travels in an Authorization header, which EventSource cannot set, and each
 * reconnect mints a fresh token. */
export async function readEventStream(
  workspaceId: string,
  onEvent: (event: StreamEvent) => void,
  signal: AbortSignal,
  onOpen?: () => void
): Promise<void> {
  const auth = await authHeaders();
  const query = workspaceId
    ? `?workspace=${encodeURIComponent(workspaceId)}`
    : '';
  const response = await fetch(`${API_BASE}/stream${query}`, {
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
