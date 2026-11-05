import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cacheSource,
  claimSourceCache,
  deviceCopyMaterials,
  dropDeviceCopies,
  evictOldestSource,
  holdsNoteCopy,
  prepareDeviceCopies,
  readCachedSource,
  readDeviceCopy,
  storeDeviceCopy,
} from './sourceCache';

/** Cache Storage as the browser keeps it, in memory: requests by URL. */
class MemoryCache {
  readonly entries = new Map<string, Response>();
  private url(request: RequestInfo | URL) {
    return new URL(
      request instanceof Request ? request.url : String(request),
      'https://app.test'
    ).href;
  }
  async match(request: RequestInfo | URL) {
    return this.entries.get(this.url(request))?.clone();
  }
  async put(request: RequestInfo | URL, response: Response) {
    this.entries.set(this.url(request), response);
  }
  async delete(request: RequestInfo | URL) {
    return this.entries.delete(this.url(request));
  }
  async keys() {
    return [...this.entries.keys()].map((url) => new Request(url));
  }
}

class MemoryStorage {
  readonly caches = new Map<string, MemoryCache>();
  async open(name: string) {
    let cache = this.caches.get(name);
    if (!cache) {
      cache = new MemoryCache();
      this.caches.set(name, cache);
    }
    return cache;
  }
  async delete(name: string) {
    return this.caches.delete(name);
  }
}

let storage: MemoryStorage;
const MB = 2 ** 20;
/** The origin's quota as `navigator.storage.estimate` reports it. */
function quota(estimate: StorageEstimate | undefined) {
  vi.stubGlobal('navigator', {
    storage: estimate && { estimate: async () => estimate },
  });
}

beforeEach(async () => {
  storage = new MemoryStorage();
  vi.stubGlobal('caches', storage);
  quota({ quota: 10_000 * MB, usage: 0 });
  await claimSourceCache('user_a');
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function source(text: string) {
  const bytes = new TextEncoder().encode(text);
  return { bytes, sha: createHash('sha256').update(bytes).digest('hex') };
}

const stored = () => [
  ...(storage.caches.get('capy-source-bytes')?.entries.keys() ?? []),
];

/** The SHAs the store's index counts. */
async function indexed() {
  const cache = await storage.open('capy-source-bytes');
  const index = await cache.match('/capy-source-cache/index.json');
  const { entries } = (await index!.json()) as { entries: { key: string }[] };
  return entries.map((entry) => entry.key);
}

describe('source bytes kept on the device', () => {
  it('serves bytes back only under the SHA-256 they hash to', async () => {
    const deck = source('deck bytes');
    await cacheSource(deck.sha, deck.bytes);
    expect(await readCachedSource(deck.sha)).toEqual(deck.bytes);
    expect(await readCachedSource(deck.sha.toUpperCase())).toEqual(deck.bytes);
    // Downloaded bytes that are not the base the session names are not kept.
    const other = source('other bytes');
    await cacheSource(other.sha, deck.bytes);
    expect(await readCachedSource(other.sha)).toBeNull();
  });

  it('drops stored bytes that no longer hash to their key', async () => {
    const deck = source('deck bytes');
    await cacheSource(deck.sha, deck.bytes);
    const cache = await storage.open('capy-source-bytes');
    const entry = stored().find((url) => url.endsWith(deck.sha))!;
    await cache.put(entry, new Response(new TextEncoder().encode('changed')));
    expect(await readCachedSource(deck.sha)).toBeNull();
    expect(stored().some((url) => url.endsWith(deck.sha))).toBe(false);
    // Its index entry goes too, so it no longer counts toward the limit.
    expect(await indexed()).toEqual([]);
  });

  it('reads as a miss for a session naming no SHA', async () => {
    const missing = undefined as unknown as string;
    await expect(readCachedSource(missing)).resolves.toBeNull();
    await expect(
      cacheSource(missing, source('deck').bytes)
    ).resolves.toBeUndefined();
    expect(await readCachedSource('')).toBeNull();
  });

  it('drops the least recently opened past the limit', async () => {
    vi.useFakeTimers();
    const [a, b, c] = ['aaaa', 'bbbb', 'cccc'].map(source) as [
      ReturnType<typeof source>,
      ReturnType<typeof source>,
      ReturnType<typeof source>,
    ];
    vi.setSystemTime(1000);
    await cacheSource(a.sha, a.bytes, 8);
    vi.setSystemTime(2000);
    await cacheSource(b.sha, b.bytes, 8);
    // Reading `a` makes `b` the least recently opened.
    vi.setSystemTime(3000);
    expect(await readCachedSource(a.sha)).toEqual(a.bytes);
    vi.setSystemTime(4000);
    await cacheSource(c.sha, c.bytes, 8);
    expect(await readCachedSource(b.sha)).toBeNull();
    expect(await readCachedSource(a.sha)).toEqual(a.bytes);
    expect(await readCachedSource(c.sha)).toEqual(c.bytes);
    // Bytes over the limit on their own are never stored.
    const big = source('much too large');
    await cacheSource(big.sha, big.bytes, 8);
    expect(await readCachedSource(big.sha)).toBeNull();
  });

  it('leaves offline drafts 100 MB of free quota, and caches nothing without an estimate', async () => {
    const deck = source('deck bytes');
    const size = deck.bytes.byteLength;
    quota({ quota: 1000 * MB, usage: 900 * MB - size + 1 });
    await cacheSource(deck.sha, deck.bytes);
    expect(await readCachedSource(deck.sha)).toBeNull();
    quota(undefined);
    await cacheSource(deck.sha, deck.bytes);
    expect(await readCachedSource(deck.sha)).toBeNull();
    quota({ quota: 1000 * MB, usage: 900 * MB - size });
    await cacheSource(deck.sha, deck.bytes);
    expect(await readCachedSource(deck.sha)).toEqual(deck.bytes);
  });

  it('frees space for a draft one file at a time, least recently opened first', async () => {
    vi.useFakeTimers();
    const [a, b] = ['aaaa', 'bbbb'].map(source) as [
      ReturnType<typeof source>,
      ReturnType<typeof source>,
    ];
    vi.setSystemTime(1000);
    await cacheSource(a.sha, a.bytes);
    vi.setSystemTime(2000);
    await cacheSource(b.sha, b.bytes);
    // Reading `a` makes `b` the least recently opened.
    vi.setSystemTime(3000);
    await readCachedSource(a.sha);
    expect(await evictOldestSource()).toBe(true);
    expect(stored().some((url) => url.endsWith(b.sha))).toBe(false);
    expect(await indexed()).toEqual([a.sha]);
    expect(await evictOldestSource()).toBe(true);
    expect(await indexed()).toEqual([]);
    expect(await evictOldestSource()).toBe(false);
  });

  it('belongs to the account that filled it: signing out or another account deletes it', async () => {
    const deck = source('deck bytes');
    await claimSourceCache('user_a');
    await cacheSource(deck.sha, deck.bytes);
    await claimSourceCache('user_a');
    expect(await readCachedSource(deck.sha)).toEqual(deck.bytes);
    await claimSourceCache('user_b');
    expect(await readCachedSource(deck.sha)).toBeNull();
    await cacheSource(deck.sha, deck.bytes);
    await claimSourceCache(null);
    expect(storage.caches.has('capy-source-bytes')).toBe(false);
    // A download landing after sign-out stores nothing.
    await cacheSource(deck.sha, deck.bytes);
    expect(stored()).toEqual([]);
  });

  it('reads as a miss without Cache Storage (private mode, a failing store)', async () => {
    const deck = source('deck bytes');
    vi.stubGlobal('caches', undefined);
    await cacheSource(deck.sha, deck.bytes);
    expect(await readCachedSource(deck.sha)).toBeNull();
    vi.stubGlobal('caches', {
      open: () => Promise.reject(new Error('SecurityError')),
    });
    await cacheSource(deck.sha, deck.bytes);
    expect(await readCachedSource(deck.sha)).toBeNull();
    await expect(claimSourceCache('user_a')).resolves.toBeUndefined();
  });
});

describe('device copies', () => {
  const row = (
    materialId: string,
    document: 'content' | 'keys' = 'content'
  ) => ({
    canEditContent: true,
    document,
    kind: 'note' as const,
    materialId,
    owner: 'user_a',
    room: `material:${materialId}:schema:1`,
    standalone: false,
    title: 'A note',
    version: 3,
  });
  const state = (bytes = 8) => new Uint8Array(bytes).fill(7);

  it('reads back the state and its row for its owner', async () => {
    await storeDeviceCopy(row('n1'), state());
    const copy = await readDeviceCopy('user_a', 'n1');
    expect(copy).toMatchObject({ room: 'material:n1:schema:1', version: 3 });
    expect(copy?.state).toEqual(state());
    expect(await deviceCopyMaterials('user_a')).toEqual(['n1']);
  });

  it('knows at once which notes it holds, from the claim on', async () => {
    await storeDeviceCopy(row('n1'), state());
    expect(holdsNoteCopy('n1')).toBe(true);
    expect(holdsNoteCopy('n2')).toBe(false);
    await storeDeviceCopy(row('n1', 'keys'), state());
    await dropDeviceCopies('n1', 'keys');
    expect(holdsNoteCopy('n1')).toBe(true);
    await claimSourceCache('user_a');
    expect(holdsNoteCopy('n1')).toBe(true);
    await dropDeviceCopies('n1');
    expect(holdsNoteCopy('n1')).toBe(false);
  });

  it('drops a copy whose bytes are not the size its row says', async () => {
    await storeDeviceCopy(row('n1'), state());
    const store = await caches.open('capy-source-bytes');
    const [key] = (await store.keys()).filter((request) =>
      request.url.includes('copy/n1/content')
    );
    const { headers } = (await store.match(key)) as Response;
    await store.put(key, new Response(state(2), { headers }));
    expect(await readDeviceCopy('user_a', 'n1')).toBeNull();
    expect(holdsNoteCopy('n1')).toBe(false);
  });

  it('never hands a row to another signed-in user, and it goes', async () => {
    await storeDeviceCopy(row('n1'), state());
    expect(await readDeviceCopy('user_b', 'n1')).toBeNull();
    expect(await readDeviceCopy('user_a', 'n1')).toBeNull();
  });

  it('stores nothing for a store another account claimed', async () => {
    await claimSourceCache('user_b');
    await storeDeviceCopy(row('n1'), state());
    expect(await deviceCopyMaterials('user_a')).toEqual([]);
  });

  it('issues the write with no await once the store is ready, for a page going', async () => {
    await prepareDeviceCopies('user_a');
    const cache = await storage.open('capy-source-bytes');
    const put = vi.spyOn(cache, 'put');
    void storeDeviceCopy(row('n1'), state());
    expect(put).toHaveBeenCalledOnce();
  });

  it('counts a copy whose page went before the index heard of it', async () => {
    await prepareDeviceCopies('user_a');
    const cache = await storage.open('capy-source-bytes');
    void storeDeviceCopy(row('n1'), state());
    // The page died here: its bytes landed, the index never did.
    await vi.waitFor(async () =>
      expect(await readDeviceCopy('user_a', 'n1')).not.toBeNull()
    );
    await cache.put(
      '/capy-source-cache/index.json',
      Response.json({ entries: [], owner: 'user_a' })
    );
    expect(await deviceCopyMaterials('user_a')).toEqual(['n1']);
    await storeDeviceCopy(row('n2'), state());
    expect(await indexed()).toEqual(
      expect.arrayContaining(['copy/n1/content', 'copy/n2/content'])
    );
  });

  it('is wiped when signing out', async () => {
    await storeDeviceCopy(row('n1'), state());
    await claimSourceCache(null);
    await claimSourceCache('user_a');
    expect(await readDeviceCopy('user_a', 'n1')).toBeNull();
  });

  it('shares the budget with source bytes, least recently opened out first', async () => {
    vi.useFakeTimers();
    await storeDeviceCopy(row('n1'), state(100 * MB));
    vi.advanceTimersByTime(1000);
    const file = source('a file');
    await cacheSource(file.sha, file.bytes);
    vi.advanceTimersByTime(1000);
    await storeDeviceCopy(row('n2'), state(101 * MB));
    expect(await deviceCopyMaterials('user_a')).toEqual(['n2']);
    expect(await readCachedSource(file.sha)).toEqual(file.bytes);
  });

  it('leaves offline drafts their reserve', async () => {
    quota({ quota: 150 * MB, usage: 0 });
    await storeDeviceCopy(row('n1'), state(60 * MB));
    expect(await deviceCopyMaterials('user_a')).toEqual([]);
  });

  it('makes way for a draft the quota refused', async () => {
    await storeDeviceCopy(row('n1'), state());
    expect(await evictOldestSource()).toBe(true);
    expect(await readDeviceCopy('user_a', 'n1')).toBeNull();
  });

  it("drops one document's copy or all of a material's", async () => {
    await storeDeviceCopy(row('q1'), state());
    await storeDeviceCopy(row('q1', 'keys'), state());
    await dropDeviceCopies('q1', 'keys');
    expect(await readDeviceCopy('user_a', 'q1', 'keys')).toBeNull();
    expect(await readDeviceCopy('user_a', 'q1')).not.toBeNull();
    await dropDeviceCopies('q1');
    expect(await readDeviceCopy('user_a', 'q1')).toBeNull();
  });
});
