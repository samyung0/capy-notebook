import type { CollaborationContext } from './auth.js';

// A connection asks its client for a fresh token this long before the current
// one expires; onTokenSync verifies it and re-arms both timers. A client that
// cannot answer is closed at expiry and reconnects with a new token.
const TOKEN_REFRESH_LEAD_MS = 60_000;
const timers = new WeakMap<object, ReturnType<typeof setTimeout>[]>();

interface ExpiringConnection {
  close(event?: CloseEvent): void;
  context: unknown;
  requestToken(): void;
}

export function clearTokenExpiry(connection: object) {
  for (const timer of timers.get(connection) ?? []) clearTimeout(timer);
  timers.delete(connection);
}

/** (Re)arms the refresh request and the expiry close from the connection's
 * current token. */
export function armTokenExpiry(
  connection: ExpiringConnection,
  leadMs = TOKEN_REFRESH_LEAD_MS
) {
  clearTokenExpiry(connection);
  const { expiresAt } = connection.context as CollaborationContext;
  const left = Math.max(0, expiresAt * 1000 - Date.now());
  timers.set(connection, [
    setTimeout(() => connection.requestToken(), Math.max(0, left - leadMs)),
    setTimeout(() => {
      connection.close({
        code: 4401,
        reason: 'collaboration token expired',
      } as CloseEvent);
    }, left),
  ]);
}
