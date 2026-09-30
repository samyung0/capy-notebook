import { isApiError } from '@/api/client';
import {
  COLLABORATION_FORBIDDEN_REASON,
  COLLABORATION_NOT_FOUND_REASON,
  COLLABORATION_READ_ONLY_REASON,
} from './collaborationEvents';

/** What an editor does with a refused room connection. */
export type RoomRefusal = 'readOnly' | 'notFound' | 'forbidden' | 'retry';

/**
 * Classifies an authentication refusal by its reason, or by the token request
 * that failed before one could be sent (the provider then reports its own
 * "Failed to get token" text). Anything unnamed (an expired token, a room
 * being reset or compacted) is worth retrying with a fresh token.
 */
export function roomRefusal(reason: string, tokenError?: unknown): RoomRefusal {
  // A read token on reconnect is thrown by the token function itself, so the
  // provider wraps the reason in its own text.
  if (reason.includes(COLLABORATION_READ_ONLY_REASON)) return 'readOnly';
  const status = isApiError(tokenError) ? tokenError.status : undefined;
  if (reason === COLLABORATION_NOT_FOUND_REASON || status === 404)
    return 'notFound';
  if (reason === COLLABORATION_FORBIDDEN_REASON || status === 403)
    return 'forbidden';
  return 'retry';
}

const RETRY_BASE_MS = 500;
const RETRY_MAX_MS = 30_000;
const CLOSE_POLL_MS = 250;
/** How long a lost room connection may keep failing before the editor says it
 * cannot save. */
export const RECONNECT_GRACE_MS = 30_000;

interface ReconnectableProvider {
  connect(): unknown;
  disconnect(): void;
}

/**
 * Keeps an editor's room connection alive. The server can close one room on
 * an open socket (token expiry, eviction, an access recheck); the provider then
 * only emits `close`, never `disconnect`, and stays detached until its idle
 * check drops the socket about 30 s later. This reconnects at once instead,
 * fetching a fresh token, and backs off while refusals keep coming.
 */
export function roomReconnector({
  provider,
  onStuck,
}: {
  provider: () => ReconnectableProvider | null | undefined;
  /** Still not connected after RECONNECT_GRACE_MS while the browser is online. */
  onStuck: () => void;
}) {
  let attempts = 0;
  let disposed = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let stuck: ReturnType<typeof setTimeout> | undefined;
  const watch = () => {
    if (stuck || disposed) return;
    stuck = setTimeout(() => {
      stuck = undefined;
      if (disposed) return;
      // Offline has its own status; keep waiting for the network instead.
      if (navigator.onLine) onStuck();
      else watch();
    }, RECONNECT_GRACE_MS);
  };
  // `connect()` is a no-op until the old socket has finished closing, so it
  // waits for that instead of stranding the provider disconnected.
  const connectWhenClosed = (current: ReconnectableProvider) => {
    retry = undefined;
    if (disposed || provider() !== current) return;
    if (socketOpen(current))
      retry = setTimeout(() => connectWhenClosed(current), CLOSE_POLL_MS);
    else void current.connect();
  };
  const reconnect = () => {
    const current = provider();
    if (disposed || retry || !current) return;
    watch();
    current.disconnect();
    // Jittered, so a room's clients do not all return at the same instant.
    const delay =
      Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** attempts++) *
      (0.5 + Math.random());
    retry = setTimeout(() => connectWhenClosed(current), delay);
  };
  return {
    /** The provider's `close`. A socket close reconnects by itself. */
    closed(socketOpen: boolean) {
      if (socketOpen) reconnect();
      else watch();
    },
    /** Synced again. */
    connected() {
      attempts = 0;
      clearTimeout(stuck);
      stuck = undefined;
    },
    /** The socket dropped; the websocket provider retries by itself. */
    disconnected: watch,
    dispose() {
      disposed = true;
      clearTimeout(retry);
      clearTimeout(stuck);
    },
    /** A refusal worth retrying with a fresh token. */
    refused: reconnect,
  };
}

export type RoomReconnector = ReturnType<typeof roomReconnector>;

/** Whether a Hocuspocus provider's shared socket is still open, i.e. the
 * server closed only this room. */
export function socketOpen(provider: unknown): boolean {
  return (
    (
      provider as {
        configuration?: { websocketProvider?: { status?: string } };
      } | null
    )?.configuration?.websocketProvider?.status === 'connected'
  );
}
