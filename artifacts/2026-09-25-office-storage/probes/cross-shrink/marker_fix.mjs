// Contributor markers: today's tracker (collaboration/src/contributors.ts) vs a
// fix that keeps the marker in the edit's transaction but restores the room's
// client id when only the marker advanced it. Checks growth, atomicity and the
// collision guard. Usage: node marker_fix.mjs [pptxFile]
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { office, Y, storeSnapshot, connectionOrigin } from '../storage/lib.mjs';

const ROOT = '__capy_pending_contributors';
function marker(doc, tr) {
  const ctx = tr.origin?.source === 'connection' ? tr.origin.connection?.context : undefined;
  if (!ctx) return false;
  const key = `instance:${ctx.access}:${Buffer.from(ctx.userId).toString('base64url')}`;
  doc.getMap(ROOT).set(key, { access: ctx.access, nonce: randomUUID(), userId: ctx.userId });
  return true;
}
// Today: marker written inside the remote transaction; Yjs then rotates clientID.
function attachToday(doc) {
  doc.on('beforeTransaction', (tr) => marker(doc, tr));
}
// Fix: same write, same transaction; afterwards keep the id unless something
// other than the marker advanced it (a genuine client-id collision).
function attachFixed(doc) {
  const written = new WeakMap();
  doc.on('beforeTransaction', (tr) => {
    if (marker(doc, tr)) written.set(tr, { client: doc.clientID, clock: Y.getState(doc.store, doc.clientID) });
  });
  doc.on('afterTransactionCleanup', (tr) => {
    const mark = written.get(tr);
    if (mark && doc.clientID !== mark.client && tr.afterState.get(mark.client) === mark.clock) doc.clientID = mark.client;
  });
}

// Fix, variant 2: write the marker under a dedicated per-room client id, so
// Yjs never sees the room's own id advance in a remote transaction (no rotation,
// no "[yjs] Changed the client-id" log). A write by anyone else under the
// marker id picks a new one.
function attachMarkerClient(doc) {
  const fresh = () => {
    let id;
    do id = (Math.random() * 0xffffffff) >>> 0; while (id === doc.clientID);
    return id;
  };
  let markerClient = fresh();
  const expected = new WeakMap();
  doc.on('beforeTransaction', (tr) => {
    const own = doc.clientID;
    doc.clientID = markerClient;
    let wrote = false;
    try {
      wrote = marker(doc, tr);
    } finally {
      doc.clientID = own;
    }
    if (wrote) expected.set(tr, Y.getState(doc.store, markerClient));
  });
  doc.on('afterTransactionCleanup', (tr) => {
    const clock = expected.get(tr);
    if (clock !== undefined && tr.afterState.get(markerClient) !== clock) markerClient = fresh();
  });
}

async function initialState(path) {
  if (!path) {
    const d = new Y.Doc();
    d.getText('t').insert(0, 'x'.repeat(2000));
    return Y.encodeStateAsUpdate(d);
  }
  const bytes = new Uint8Array(await readFile(path));
  return (await office.seedOffice('pptx', bytes)).state;
}

function run(mode, seed, keystrokes, saveEvery) {
  const room = new Y.Doc({ gc: true });
  if (mode === 'today') attachToday(room);
  if (mode === 'fixed') attachFixed(room);
  if (mode === 'markerClient') attachMarkerClient(room);
  Y.applyUpdate(room, seed);
  const startId = room.clientID;
  let stored = seed;
  let ids = new Set([room.clientID]);
  let updatesWithMarker = 0;
  let updatesSeen = 0;
  room.on('update', (u, origin) => {
    if (origin?.source !== 'connection') return;
    updatesSeen++;
    const decoded = Y.decodeUpdate(u);
    if (decoded.structs.some((s) => s.content?.arr?.some((v) => v && typeof v === 'object' && 'nonce' in v))) updatesWithMarker++;
  });
  const browser = new Y.Doc();
  Y.applyUpdate(browser, seed);
  const text = browser.share.has('t') ? browser.getText('t') : browser.getMap('pptx:stories').values().next().value;
  browser.on('update', (u) => {
    Y.applyUpdate(room, u, connectionOrigin());
    ids.add(room.clientID);
  });
  for (let i = 0; i < keystrokes; i++) {
    text.insert(text.length, 'a');
    if ((i + 1) % saveEvery === 0) stored = storeSnapshot(room, stored);
  }
  stored = storeSnapshot(room, stored);
  return { mode, keystrokes, growth: stored.length - seed.length, perKeystroke: +((stored.length - seed.length) / keystrokes).toFixed(2), roomClientIds: ids.size, clientIdUnchanged: room.clientID === startId, updatesSeen, updatesWithMarker };
}

// Collision guard: a remote update that carries structs under the room's own
// client id must still rotate it.
function collision() {
  const room = new Y.Doc();
  attachFixed(room);
  const other = new Y.Doc();
  other.clientID = room.clientID; // same id elsewhere
  other.getText('t').insert(0, 'hello');
  const id = room.clientID;
  Y.applyUpdate(room, Y.encodeStateAsUpdate(other), connectionOrigin());
  return { rotatedOnCollision: room.clientID !== id };
}

const path = process.argv[2];
const seed = await initialState(path);
for (const mode of ['none', 'today', 'fixed', 'markerClient']) console.log(JSON.stringify({ file: path ?? 'Y.Text', ...run(mode, seed, 1000, 100) }));
console.log(JSON.stringify(collision()));
