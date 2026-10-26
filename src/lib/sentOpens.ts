import { PREF_KEYS, readPref, writePref } from './localPrefs';

/** At most one open per workspace, file or material per window, the
 * server's own window (store/opens.go): recent lists sort to within it. */
export const OPEN_WINDOW_MS = 5 * 60_000;

/** What an open points at: `workspace:<id>`, `file:<id>`, `material:<id>`. */
export type OpenKey = `${'workspace' | 'file' | 'material'}:${string}`;

/** When this browser last sent each open, with the account it belongs to
 * (`claimSentOpens`). */
interface StoredOpens {
  owner: string | null;
  sent: Record<string, number>;
}

function isStoredOpens(value: unknown): value is StoredOpens {
  if (typeof value !== 'object' || value === null) return false;
  const { owner, sent } = value as Partial<StoredOpens>;
  return (
    (owner === null || typeof owner === 'string') &&
    typeof sent === 'object' &&
    sent !== null &&
    Object.values(sent).every((at) => typeof at === 'number')
  );
}

function readStored(): StoredOpens | null {
  return readPref(PREF_KEYS.sentOpens, null, isStoredOpens);
}

/** Runs when the signed-in account is known (AuthProvider): another
 * account's record is dropped, so its sends never hold back this one's. */
export function claimSentOpens(owner: string | null): void {
  if (readStored()?.owner === owner) return;
  writePref(PREF_KEYS.sentOpens, { owner, sent: {} });
}

/** Whether an open of `key` is due, and if so records it as sent now. Sends
 * past the window are dropped, so the record stays small. Without a claimed
 * record (MSW, blocked storage) every open is due. */
export function takeOpen(key: OpenKey, now = Date.now()): boolean {
  const stored = readStored();
  if (!stored) return true;
  const last = stored.sent[key];
  if (last !== undefined && now - last < OPEN_WINDOW_MS) return false;
  const sent = Object.fromEntries(
    Object.entries(stored.sent).filter(([, at]) => now - at < OPEN_WINDOW_MS)
  );
  writePref(PREF_KEYS.sentOpens, {
    owner: stored.owner,
    sent: { ...sent, [key]: now },
  });
  return true;
}

/** Forgets the send, so the next open of `key` records again at once (after
 * Forget, or a send that failed). */
export function dropOpen(key: OpenKey): void {
  const stored = readStored();
  if (!stored || !(key in stored.sent)) return;
  const { [key]: _, ...sent } = stored.sent;
  writePref(PREF_KEYS.sentOpens, { owner: stored.owner, sent });
}
