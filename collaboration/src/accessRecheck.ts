import { CollaborationReadOnlyError } from './persistence.js';
import { SourceRequestError } from './sourceDocuments.js';

/**
 * Runs an access check for a key (a connection) at most once per interval.
 * A check that throws is not remembered, so the next call checks again.
 */
export function accessRecheck(intervalMs: number, now = Date.now) {
  const checked = new WeakMap<object, number>();
  return async (key: object, check: () => Promise<unknown>) => {
    const at = checked.get(key);
    if (at !== undefined && now() - at < intervalMs) return;
    await check();
    checked.set(key, now());
  };
}

/** The room turned read-only for this writer: a frozen writer or owner, an
 * owner at its storage limit (or a suspended material owner). The editor
 * discards its unsaved edits and drops to view. */
export function readOnlyRefusal(error: unknown): boolean {
  return (
    error instanceof CollaborationReadOnlyError ||
    (error instanceof SourceRequestError &&
      (error.code === 'account_over_quota' ||
        error.code === 'storage_quota_exceeded'))
  );
}

/**
 * The per-update writer recheck (see accessRecheck). Frozen and the storage
 * limit are enforced here and at authentication only: a writer whose room
 * turned read-only hears `room-read-only` before its update is refused, and
 * the refusal closes only that connection. Co-editors whose own access still
 * holds stay connected; an owner at its limit refuses them all on their next
 * update.
 */
export function writerRecheck(intervalMs: number, now = Date.now) {
  const recheck = accessRecheck(intervalMs, now);
  return async (
    connection: { sendStateless: (payload: string) => void },
    room: string,
    check: () => Promise<unknown>
  ) => {
    try {
      await recheck(connection, check);
    } catch (error) {
      if (readOnlyRefusal(error))
        connection.sendStateless(
          JSON.stringify({ room, type: 'room-read-only' })
        );
      throw error;
    }
  };
}
