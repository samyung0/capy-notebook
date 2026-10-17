import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cacheSource, claimSourceCache, readCachedSource } from './sourceCache';

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
beforeEach(() => {
  storage = new MemoryStorage();
  vi.stubGlobal('caches', storage);
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
  const { entries } = (await index!.json()) as { entries: { sha: string }[] };
  return entries.map((entry) => entry.sha);
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
