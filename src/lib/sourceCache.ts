/**
 * Office and text source bytes kept on this device (Epo 2026-10-17): the
 * browser's Cache Storage, keyed by the base SHA-256 the source session
 * names, so a reopen skips the whole-file download and a changed file (a new
 * base) is never served stale. Bytes are hashed before they are stored and
 * again when read, so nothing whose hash differs from its key is ever
 * served. About 200 MB, least recently opened first out. The store belongs
 * to the account that filled it: signing out, or another account signing in,
 * deletes it. Private mode or a failing store reads as a miss and the caller
 * downloads, silently. Offline drafts come first in the storage quota:
 * caching skips a file that would leave under 100 MB free, and a draft write
 * the quota refuses deletes copies here, least recently opened first
 * (`evictOldestSource`, draftStore.ts).
 */
const NAME = 'capy-source-bytes';
const SOURCE_CACHE_LIMIT_BYTES = 200 * 2 ** 20;
/** Free quota a cached file must leave for offline drafts. */
const DRAFT_RESERVE_BYTES = 100 * 2 ** 20;
// Cache keys are requests; these paths are never fetched.
const INDEX = '/capy-source-cache/index.json';
const SHA256 = /^[0-9a-f]{64}$/;

interface Entry {
  sha: string;
  size: number;
  /** When the bytes were last stored or read. */
  used: number;
}

interface Index {
  entries: Entry[];
  /** The account the bytes were opened by. */
  owner?: string;
}

const entryKey = (sha: string) => `/capy-source-cache/${sha}`;

async function open(): Promise<Cache | null> {
  try {
    return (await globalThis.caches?.open(NAME)) ?? null;
  } catch {
    return null;
  }
}

async function readIndex(cache: Cache): Promise<Index> {
  try {
    const stored = await cache.match(INDEX);
    const index = stored ? ((await stored.json()) as Index) : null;
    return index && Array.isArray(index.entries) ? index : { entries: [] };
  } catch {
    return { entries: [] };
  }
}

function writeIndex(cache: Cache, index: Index) {
  return cache.put(INDEX, Response.json(index));
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join(
    ''
  );
}

/** Whether storing `bytes` more leaves offline drafts their reserve. Without
 * an estimate (a browser or context without one) nothing is cached, as in
 * private mode. */
async function leavesDraftReserve(bytes: number): Promise<boolean> {
  try {
    const { quota, usage } = await navigator.storage.estimate();
    return (
      quota !== undefined &&
      usage !== undefined &&
      quota - usage - bytes >= DRAFT_RESERVE_BYTES
    );
  } catch {
    return false;
  }
}

/** The bytes stored under `sha`, or null (a miss, a session naming no SHA,
 * or bytes that no longer hash to it, which are dropped with their index
 * entry). */
export async function readCachedSource(
  sha: string
): Promise<Uint8Array<ArrayBuffer> | null> {
  try {
    const key = sha.toLowerCase();
    if (!SHA256.test(key)) return null;
    const cache = await open();
    if (!cache) return null;
    const stored = await cache.match(entryKey(key));
    if (!stored) return null;
    const bytes = new Uint8Array(await stored.arrayBuffer());
    const index = await readIndex(cache);
    if ((await sha256Hex(bytes)) !== key) {
      await cache.delete(entryKey(key));
      index.entries = index.entries.filter((item) => item.sha !== key);
      await writeIndex(cache, index);
      return null;
    }
    const entry = index.entries.find((item) => item.sha === key);
    if (entry) {
      entry.used = Date.now();
      await writeIndex(cache, index);
    }
    return bytes;
  } catch {
    return null;
  }
}

/** Stores downloaded bytes under `sha` when they hash to it, then drops the
 * least recently used entries past `limit`. Only a store an account claimed
 * takes them: a download landing after sign-out stores nothing. */
export async function cacheSource(
  sha: string,
  bytes: Uint8Array<ArrayBuffer>,
  limit = SOURCE_CACHE_LIMIT_BYTES
): Promise<void> {
  try {
    const key = sha.toLowerCase();
    if (!SHA256.test(key) || bytes.byteLength > limit) return;
    if (!(await leavesDraftReserve(bytes.byteLength))) return;
    const cache = await open();
    if (!cache) return;
    const index = await readIndex(cache);
    if (!index.owner || (await sha256Hex(bytes)) !== key) return;
    await cache.put(entryKey(key), new Response(bytes));
    const entries = [
      ...index.entries.filter((item) => item.sha !== key),
      { sha: key, size: bytes.byteLength, used: Date.now() },
    ].sort((a, b) => b.used - a.used);
    let total = 0;
    const kept = entries.filter((item) => {
      total += item.size;
      return total <= limit;
    });
    // Bytes no index entry counts (dropped above, or another tab's write
    // lost in a race) go too, so the store stays within the limit.
    const keep = new Set([INDEX, ...kept.map((item) => entryKey(item.sha))]);
    for (const request of await cache.keys())
      if (!keep.has(new URL(request.url).pathname)) await cache.delete(request);
    await writeIndex(cache, { ...index, entries: kept });
  } catch {
    // Not stored: the next open downloads again.
  }
}

/**
 * Deletes the least recently opened file kept here, for a draft write the
 * storage quota refused: offline drafts come first (Epo 2026-10-17), and the
 * drafts worker calls this once per refusal until its write lands. False
 * when nothing is left to delete (or no store is reachable).
 */
export async function evictOldestSource(): Promise<boolean> {
  try {
    const cache = await open();
    if (!cache) return false;
    const index = await readIndex(cache);
    let evicted = false;
    // A row whose bytes are already gone is dropped on the way.
    for (const entry of [...index.entries].sort((a, b) => a.used - b.used)) {
      index.entries = index.entries.filter((item) => item !== entry);
      if (await cache.delete(entryKey(entry.sha))) {
        evicted = true;
        break;
      }
    }
    await writeIndex(cache, index).catch(() => undefined);
    return evicted;
  } catch {
    return false;
  }
}

/**
 * Runs when the signed-in account is known, before any read: a store filled
 * by another account (or any store once signed out, `null`) is deleted.
 */
export async function claimSourceCache(owner: string | null): Promise<void> {
  try {
    const cache = owner ? await open() : null;
    if (cache && (await readIndex(cache)).owner === owner) return;
    await globalThis.caches?.delete(NAME);
    if (!owner) return;
    const fresh = await open();
    if (fresh) await writeIndex(fresh, { entries: [], owner });
  } catch {
    // Without Cache Storage nothing was stored.
  }
}
