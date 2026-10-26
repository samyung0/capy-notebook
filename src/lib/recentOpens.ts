import { PREF_KEYS, readPref, writePref } from './localPrefs';

/** The files and materials this browser opened, newest first: the order of
 * the phone's quick open. Only ids and times
 * are kept; the rows themselves come from the lists' `ids` filter, so names,
 * thumbnails and access stay current. */
export interface RecentOpen {
  id: string;
  kind: 'file' | 'material';
  openedAt: string;
}

/** The opens with the account they belong to (`claimRecentOpens`). */
interface StoredOpens {
  opens: RecentOpen[];
  owner: string | null;
}

export const RECENT_OPENS_MAX = 20;

function isStoredOpens(value: unknown): value is StoredOpens {
  if (typeof value !== 'object' || value === null) return false;
  const { owner, opens } = value as Partial<StoredOpens>;
  return (
    (owner === null || typeof owner === 'string') &&
    Array.isArray(opens) &&
    opens.every(
      (open) =>
        (open?.kind === 'file' || open?.kind === 'material') &&
        typeof open.id === 'string' &&
        typeof open.openedAt === 'string'
    )
  );
}

function readStored(): StoredOpens | null {
  return readPref(PREF_KEYS.recentOpens, null, isStoredOpens);
}

/**
 * Runs when the signed-in account is known, before any read, as
 * `claimSourceCache` does: another account's opens (or any once signed out,
 * `null`) are dropped, so one browser never shows one account what another
 * opened.
 */
export function claimRecentOpens(owner: string | null): void {
  if (readStored()?.owner === owner) return;
  try {
    localStorage.removeItem(PREF_KEYS.recentOpens);
  } catch {
    // Blocked storage held nothing.
  }
  if (owner) writePref(PREF_KEYS.recentOpens, { opens: [], owner });
}

export function readRecentOpens(): RecentOpen[] {
  return readStored()?.opens ?? [];
}

function writeOpens(opens: RecentOpen[]): void {
  writePref(PREF_KEYS.recentOpens, {
    opens,
    owner: readStored()?.owner ?? null,
  });
}

/** Moves the item to the front, keeping the newest `RECENT_OPENS_MAX`. */
export function recordRecentOpen(kind: RecentOpen['kind'], id: string): void {
  writeOpens(
    [
      { id, kind, openedAt: new Date().toISOString() },
      ...readRecentOpens().filter((open) => open.id !== id),
    ].slice(0, RECENT_OPENS_MAX)
  );
}

/** Drops opens of `kind` a list was asked for and left out (deleted, trashed,
 * access lost), so they stop taking places. */
export function pruneRecentOpens(
  kind: RecentOpen['kind'],
  requested: readonly string[],
  listed: readonly string[]
): void {
  const gone = new Set(requested.filter((id) => !listed.includes(id)));
  if (!gone.size) return;
  writeOpens(
    readRecentOpens().filter((open) => open.kind !== kind || !gone.has(open.id))
  );
}
