// Shared helpers: the real headless engine, the collaboration service's Yjs,
// and byte accounting that mirrors what Postgres stores.
import { createHash, randomUUID } from 'node:crypto';

export const office = await import(
  'file:///C:/WEB/capy-notebook/vendor/betteroffice/shared/office-checkpoint.mjs'
);
export const Y = await import(
  'file:///C:/WEB/capy-notebook/collaboration/node_modules/yjs/dist/yjs.mjs'
);

export const sha = (b) => createHash('sha256').update(b).digest('hex');

export const formatOf = (path) => path.toLowerCase().split('.').pop();

// indexed_baseline bytea = UTF-8 of JSON.stringify({entries, format, version})
// (sourceDocuments.ts encodeBaseline -> base64 -> Go []byte -> bytea).
export function baselineBytes(entries, format) {
  return Buffer.byteLength(JSON.stringify({ entries, format, version: 1 }));
}

// octet_length(pending_effects::text): jsonb text output uses ", " and ": ".
export function jsonbText(value) {
  if (value === null) return 'null';
  if (Array.isArray(value))
    return `[${value.map((v) => jsonbText(v === undefined ? null : v)).join(', ')}]`;
  if (typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${JSON.stringify(k)}: ${jsonbText(v)}`)
      .join(', ')}}`;
  return JSON.stringify(value);
}
export const effectsBytes = (effects) => Buffer.byteLength(jsonbText(effects));

// Verbatim logic of collaboration/src/contributors.ts (marker per applied
// connection update, removed from the stored snapshot, cleared after save).
const ROOT = '__capy_pending_contributors';
export function attachTracker(doc, instanceId = 'instance-probe') {
  doc.on('beforeTransaction', (tr) => {
    const ctx = tr.origin?.source === 'connection' ? tr.origin.connection?.context : undefined;
    if (!ctx) return;
    const key = `${instanceId}:${ctx.access}:${Buffer.from(ctx.userId).toString('base64url')}`;
    doc.getMap(ROOT).set(key, { access: ctx.access, nonce: randomUUID(), userId: ctx.userId });
  });
}
export const connectionOrigin = (userId = 'user_probe_0001') => ({
  source: 'connection',
  connection: { context: { userId, access: 'write' } },
});
function contributors(doc) {
  return [...doc.getMap(ROOT).entries()].map(([key, v]) => ({ key, ...v }));
}

// persistSource + SourceDocumentStore.storeSnapshot, minus HTTP and CAS.
export function storeSnapshot(room, storedState) {
  const snapshot = new Y.Doc();
  Y.applyUpdate(snapshot, Y.encodeStateAsUpdate(room));
  const claimed = contributors(snapshot);
  const markers = snapshot.getMap(ROOT);
  for (const c of claimed) markers.delete(c.key);
  const merged = new Y.Doc();
  Y.applyUpdate(merged, storedState);
  Y.applyUpdate(merged, Y.encodeStateAsUpdate(snapshot));
  const state = Y.encodeStateAsUpdate(merged);
  merged.destroy();
  snapshot.destroy();
  // clearDocumentContributors on the live room
  room.transact(() => {
    const live = room.getMap(ROOT);
    for (const c of claimed) if (live.get(c.key)?.nonce === c.nonce) live.delete(c.key);
  }, { source: 'local', skipStoreHooks: true });
  return state;
}

export function newRoom(state) {
  const room = new Y.Doc({ gc: true, gcFilter: () => true });
  attachTracker(room);
  Y.applyUpdate(room, state); // onLoadDocument: no connection origin
  return room;
}

export const checkpoint = (format, bytes, state) => ({
  format,
  schemaVersion: 1,
  baseSha256: sha(bytes),
  state,
});

export const DETERMINISM = (jobId) => ({
  now: '2000-01-01T00:00:00.000Z',
  seed: sha(jobId),
});

export async function timed(fn) {
  const t = performance.now();
  const value = await fn();
  return [value, Math.round(performance.now() - t)];
}

// Count bytes of a substring pattern inside a binary state (e.g. data URLs).
export function findAll(buf, needle) {
  const n = Buffer.from(needle);
  let at = 0;
  const hits = [];
  while ((at = buf.indexOf(n, at)) >= 0) {
    hits.push(at);
    at += n.length;
  }
  return hits;
}
