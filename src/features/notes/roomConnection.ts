import { isAccountForbiddenError, isApiError } from '@/api/client';
import {
  COLLABORATION_FORBIDDEN_REASON,
  COLLABORATION_NOT_FOUND_REASON,
  COLLABORATION_OUTDATED_REASON,
  COLLABORATION_READ_ONLY_REASON,
  COLLABORATION_UNASSIGNED_ID_REASON,
} from './collaborationEvents';

/** What an editor does with a refused room connection. */
export type RoomRefusal =
  | 'readOnly'
  | 'notFound'
  | 'forbidden'
  | 'outdated'
  | 'unassigned'
  | 'retry';

/**
 * Classifies an authentication refusal by its reason, or by the token request
 * that failed before one could be sent (the provider then reports its own
 * "Failed to get token" text). `outdated`: this build's client protocol is
 * refused, so only a page reload helps. Anything unnamed (an expired token, a
 * room being reset or compacted) is worth retrying with a fresh token.
 */
export function roomRefusal(reason: string, tokenError?: unknown): RoomRefusal {
  if (reason === COLLABORATION_OUTDATED_REASON) return 'outdated';
  if (reason === COLLABORATION_UNASSIGNED_ID_REASON) return 'unassigned';
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

/**
 * Whether a refusal means this user no longer has the document, so its stored
 * edits go: a missing or trashed document, or the gateway's 403 for the
 * document itself. An account-level 403 (suspended, deletion pending) keeps
 * them, and so does the collaboration service's forbidden reason alone, which
 * an account lock gives too; the load-time sweep settles that case.
 */
export function refusalDropsDrafts(
  refusal: RoomRefusal,
  tokenError?: unknown
): boolean {
  if (refusal === 'notFound') return true;
  return (
    refusal === 'forbidden' &&
    isApiError(tokenError) &&
    tokenError.status === 403 &&
    !isAccountForbiddenError(tokenError)
  );
}

/**
 * Sends a checkpoint request only once the room synced. The server handles a
 * connection's messages in order and answers the client's step 1 with its own
 * step 1 first, so a request sent at `synced` follows the step 2 carrying this
 * client's offline or restored edits. Sent earlier (once authenticated, say),
 * a store could answer it without them, and the receipt would claim edits the
 * server never saved. Returns whether it was sent; an unsent request goes out
 * when the room syncs.
 */
export function sendCheckpointRequest(
  room: { synced: boolean; send: (payload: string) => void },
  request: { id: string; flush?: boolean }
): boolean {
  if (!room.synced) return false;
  room.send(
    JSON.stringify({
      id: request.id,
      type: 'checkpoint-request',
      ...(request.flush && { flush: true }),
    })
  );
  return true;
}

const RETRY_BASE_MS = 500;
const RETRY_MAX_MS = 30_000;
/** How long a room join, or a lost room connection, may keep failing before
 * the editor says it cannot save. */
export const RECONNECT_GRACE_MS = 30_000;

interface ReconnectableProvider {
  connect(): unknown;
  disconnect(): void;
}

/**
 * Keeps an editor's room connection alive. The server can close one room on
 * the tab's shared socket (token expiry, eviction, an access recheck); the
 * provider then only emits `close`, never `disconnect`. This rejoins on that
 * socket with a fresh token, and backs off while refusals keep coming.
 */
export function roomReconnector({
  provider,
  onStuck,
}: {
  provider: () => ReconnectableProvider | null | undefined;
  /** Still not connected after RECONNECT_GRACE_MS while the browser is
   * online: from the join's start (`started`) or a lost connection. */
  onStuck: () => void;
}) {
  let attempts = 0;
  let disposed = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let stuck: ReturnType<typeof setTimeout> | undefined;
  // `from`: when the wait began, earlier than now for a note's join (its
  // token request came before the editor).
  const watch = (from = Date.now()) => {
    if (stuck || disposed) return;
    stuck = setTimeout(
      () => {
        stuck = undefined;
        if (disposed) return;
        // Offline has its own status; keep waiting for the network instead.
        if (navigator.onLine) onStuck();
        else watch();
      },
      Math.max(0, from + RECONNECT_GRACE_MS - Date.now())
    );
  };
  const rejoin = (current: ReconnectableProvider) => {
    retry = undefined;
    if (disposed || provider() !== current) return;
    void current.connect();
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
    retry = setTimeout(() => rejoin(current), delay);
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
    disconnected: () => watch(),
    dispose() {
      disposed = true;
      clearTimeout(retry);
      clearTimeout(stuck);
    },
    /** A refusal worth retrying with a fresh token. */
    refused: reconnect,
    /** Joined, and the room's answer waits on the user's open budget: the
     * room is reachable, so the wait never counts as stuck. */
    slowed() {
      clearTimeout(stuck);
      stuck = undefined;
    },
    /** A join started (at `at`, now by default), first or after a reload
     * (Epo 2026-10-23): one watch over all of it (a note's token request, a
     * JOIN never answered, a hung session request, a view never ready),
     * ended by `connected`; a slowed open clears it and offline keeps
     * waiting. */
    started: (at?: number) => watch(at),
  };
}

export type RoomReconnector = ReturnType<typeof roomReconnector>;

/** Whether the room provider's shared socket is still open, i.e. the server
 * closed only this room. */
export function socketOpen(provider: unknown): boolean {
  return (
    (provider as { socketStatus?: string } | null)?.socketStatus === 'connected'
  );
}
