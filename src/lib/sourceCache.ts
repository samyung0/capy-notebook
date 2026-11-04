import type { MaterialKind } from '@/api/types';

/**
 * What this device keeps of opened items, in the browser's Cache Storage, one
 * budget for both kinds: about 200 MB, least recently opened first out. The
 * store belongs to the account that filled it: signing out, or another account
 * signing in, deletes it. Private mode or a failing store reads as a miss and
 * the caller reads from the server, silently. Offline drafts come first in the
 * storage quota: storing skips what would leave under 100 MB free, and a draft
 * write the quota refuses deletes entries here, least recently opened first
 * (`evictOldestSource`, draftStore.ts).
 *
 * - Office and text source bytes (Epo 2026-10-17), keyed by the base SHA-256
 *   the source session names, so a reopen skips the whole-file download and a
 *   changed file (a new base) is never served stale. Bytes are hashed before
 *   they are stored and again when read, so nothing whose hash differs from
 *   its key is ever served.
 * - Device copies of items (Epo 2026-11-04, `deviceCopy.ts`): the Yjs state a
 *   room confirmed, so an item paints at once and only the difference
 *   downloads. Each row names the account it belongs to, and a read for any
 *   other deletes it.
 */
const NAME = 'capy-source-bytes';
const SOURCE_CACHE_LIMIT_BYTES = 200 * 2 ** 20;
/** Free quota a stored entry must leave for offline drafts. */
const DRAFT_RESERVE_BYTES = 100 * 2 ** 20;
// Cache keys are requests; these paths are never fetched.
const INDEX = '/capy-source-cache/index.json';
const SHA256 = /^[0-9a-f]{64}$/;
/** A row of another format is dropped as it is read. */
const COPY_FORMAT = 1;

/** A device copy's row beside its bytes. */
export interface DeviceCopyRow {
  /** A room's Yjs state (`content`, a quiz's `keys`), or the answer-free
   * material read itself (`read`): what an item paints from before anything
   * answers, a viewer's whole copy of a quiz (its lists arrive outside Yjs). */
  document: 'content' | 'keys' | 'read';
  format: number;
  /** For painting before the material read answers. */
  kind: MaterialKind;
  materialId: string;
  /** The account the copy belongs to. */
  owner: string;
  /** The room whose state it holds: another name means the state was thrown
   * away there, and the copy goes. */
  room: string;
  /** The bytes' length. */
  size: number;
  standalone: boolean;
  title: string;
  /** The stored version the state holds, which its JOIN names. */
  version: number;
}

interface Entry {
  /** A device copy's row; none for source bytes. */
  copy?: DeviceCopyRow;
  /** A file's SHA-256, or `copy/<material>/<document>`. */
  key: string;
  size: number;
  /** When the bytes were last stored or read. */
  used: number;
}

interface Index {
  entries: Entry[];
  /** The account the bytes were opened by. */
  owner?: string;
}

const ENTRY_PREFIX = '/capy-source-cache/';
const entryKey = (key: string) => `${ENTRY_PREFIX}${key}`;

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

/** Puts `entry` in the index, then drops the least recently used entries past
 * `limit` and any bytes no entry counts (dropped above, or another tab's write
 * lost in a race), so the store stays within the limit. A device copy written
 * as its page went has its row with its bytes and joins the index here. */
async function settle(
  cache: Cache,
  index: Index,
  entry: Omit<Entry, 'used'>,
  limit: number
) {
  const requests = await cache.keys();
  const known = new Set([entry.key, ...index.entries.map((item) => item.key)]);
  const orphans = await Promise.all(
    requests.map(async (request) => {
      const key = new URL(request.url).pathname.slice(ENTRY_PREFIX.length);
      return key.startsWith(COPY_PREFIX) && !known.has(key)
        ? copyEntry(key, await cache.match(request))
        : null;
    })
  );
  const entries = [
    ...index.entries.filter((item) => item.key !== entry.key),
    ...orphans.filter((item) => item !== null),
    { ...entry, used: Date.now() },
  ].sort((a, b) => b.used - a.used);
  let total = 0;
  const kept = entries.filter((item) => {
    total += item.size;
    return total <= limit;
  });
  const keep = new Set([INDEX, ...kept.map((item) => entryKey(item.key))]);
  for (const request of requests)
    if (!keep.has(new URL(request.url).pathname)) await cache.delete(request);
  await writeIndex(cache, { ...index, entries: kept });
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
      index.entries = index.entries.filter((item) => item.key !== key);
      await writeIndex(cache, index);
      return null;
    }
    const entry = index.entries.find((item) => item.key === key);
    if (entry) {
      entry.used = Date.now();
      await writeIndex(cache, index);
    }
    return bytes;
  } catch {
    return null;
  }
}

/** Stores downloaded bytes under `sha` when they hash to it. Only a store an
 * account claimed takes them: a download landing after sign-out stores
 * nothing. */
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
    await settle(cache, index, { key, size: bytes.byteLength }, limit);
  } catch {
    // Not stored: the next open downloads again.
  }
}

const COPY_PREFIX = 'copy/';
const copyKey = (materialId: string, document: DeviceCopyRow['document']) =>
  `${COPY_PREFIX}${encodeURIComponent(materialId)}/${document}`;
/** A copy's row beside its bytes, the same response: a write as the page goes
 * lands whole or not at all, and the index learns of it later. */
const ROW_HEADER = 'x-capy-copy';

function rowOf(stored: Response | undefined): DeviceCopyRow | null {
  try {
    const row = stored?.headers.get(ROW_HEADER);
    return row ? (JSON.parse(decodeURIComponent(row)) as DeviceCopyRow) : null;
  } catch {
    return null;
  }
}

function copyEntry(key: string, stored: Response | undefined): Entry | null {
  const copy = rowOf(stored);
  return copy && { copy, key, size: copy.size, used: 0 };
}

/** A device copy of a room's state for `owner`, or null. A row of another
 * account or format goes as it is read. */
export async function readDeviceCopy(
  owner: string,
  materialId: string,
  document: DeviceCopyRow['document'] = 'content'
): Promise<(DeviceCopyRow & { state: Uint8Array<ArrayBuffer> }) | null> {
  try {
    const cache = await open();
    if (!cache) return null;
    const key = copyKey(materialId, document);
    const stored = await cache.match(entryKey(key));
    if (!stored) return null;
    const row = rowOf(stored);
    if (row?.owner !== owner || row.format !== COPY_FORMAT) {
      await removeEntries(cache, [key]);
      return null;
    }
    const state = new Uint8Array(await stored.arrayBuffer());
    // Not waited for: this read is on its way to the first paint.
    void touch(cache, key).catch(() => undefined);
    return { ...row, state };
  } catch {
    return null;
  }
}

async function touch(cache: Cache, key: string) {
  const index = await readIndex(cache);
  const entry = index.entries.find((item) => item.key === key);
  if (!entry) return;
  entry.used = Date.now();
  await writeIndex(cache, index);
}

async function removeEntries(cache: Cache, keys: string[]) {
  for (const key of keys) await cache.delete(entryKey(key));
  const index = await readIndex(cache);
  index.entries = index.entries.filter((item) => !keys.includes(item.key));
  await writeIndex(cache, index);
}

/** The open store, its account and its free quota, kept ready: a write as the
 * page goes lands only when `Cache.put` is issued in the event's own task, with
 * no await before it (measured in Chromium on reload, navigation and close). */
let prepared: { cache: Cache; free: number; owner: string } | null = null;

/** Readies this account's writes; a store of another account takes none. */
export async function prepareDeviceCopies(owner: string): Promise<void> {
  try {
    const cache = await open();
    const { quota, usage } = await navigator.storage.estimate();
    prepared =
      cache &&
      quota !== undefined &&
      usage !== undefined &&
      (await readIndex(cache)).owner === owner
        ? { cache, free: quota - usage, owner }
        : null;
  } catch {
    prepared = null;
  }
}

/** Stores a room's confirmed state as its device copy, in the store's budget,
 * when the store is `row.owner`'s: one written after sign-out stores nothing.
 * Issued at once when the store is ready (`prepared`). */
export async function storeDeviceCopy(
  row: Omit<DeviceCopyRow, 'format' | 'size'>,
  state: Uint8Array<ArrayBuffer>,
  limit = SOURCE_CACHE_LIMIT_BYTES
): Promise<void> {
  try {
    if (prepared?.owner !== row.owner) await prepareDeviceCopies(row.owner);
    const ready = prepared;
    const size = state.byteLength;
    if (
      ready?.owner !== row.owner ||
      size > limit ||
      ready.free - size < DRAFT_RESERVE_BYTES
    )
      return;
    const key = copyKey(row.materialId, row.document);
    const copy: DeviceCopyRow = { ...row, format: COPY_FORMAT, size };
    await ready.cache.put(
      entryKey(key),
      new Response(state, {
        headers: { [ROW_HEADER]: encodeURIComponent(JSON.stringify(copy)) },
      })
    );
    const index = await readIndex(ready.cache);
    // Signed out meanwhile: the claim deleted the store under this handle.
    if (index.owner !== row.owner) return;
    await settle(ready.cache, index, { copy, key, size }, limit);
    await prepareDeviceCopies(row.owner);
  } catch {
    // Not stored: the next open reads the whole document from its room.
  }
}

/** Deletes a material's device copies, or only one document's. */
export async function dropDeviceCopies(
  materialId: string,
  document?: DeviceCopyRow['document']
): Promise<void> {
  try {
    const cache = await open();
    if (!cache) return;
    await removeEntries(
      cache,
      document
        ? [copyKey(materialId, document)]
        : [
            copyKey(materialId, 'content'),
            copyKey(materialId, 'keys'),
            copyKey(materialId, 'read'),
          ]
    );
  } catch {
    // Left to the sweep at the next page load.
  }
}

/** The materials `owner` keeps a device copy of. */
export async function deviceCopyMaterials(owner: string): Promise<string[]> {
  try {
    const cache = await open();
    if (!cache) return [];
    const copies = await Promise.all(
      (await cache.keys())
        .filter((request) =>
          new URL(request.url).pathname.startsWith(
            `${ENTRY_PREFIX}${COPY_PREFIX}`
          )
        )
        .map(async (request) => rowOf(await cache.match(request)))
    );
    return [
      ...new Set(
        copies.flatMap((row) => (row?.owner === owner ? [row.materialId] : []))
      ),
    ];
  } catch {
    return [];
  }
}

/**
 * Deletes the least recently opened entry kept here, for a draft write the
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
      if (await cache.delete(entryKey(entry.key))) {
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
    prepared = null;
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
