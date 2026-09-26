// Reproduce the XLSX open failure after many browser-style cell commits and
// print the engine's own error (the bundle's catch path hides it behind free()).
import { readFile } from 'node:fs/promises';
import { randomInt } from 'node:crypto';
import { office, Y, checkpoint, newRoom, connectionOrigin, storeSnapshot } from './lib.mjs';
const init = (await import('file:///C:/WEB/capy-notebook/vendor/betteroffice/packages/xlsx/src/wasm/generated/xlsx_wasm.js'));
await init.default({ module_or_path: await readFile('C:/WEB/capy-notebook/vendor/betteroffice/shared/office-runtime/xlsx.wasm') });
const bytes = new Uint8Array(await readFile(process.argv[2]));
const n = Number(process.argv[3]);
const withMarkers = process.argv[4] !== 'nomarkers';
const seed = await office.seedOffice('xlsx', bytes);
const editable = await office.inspectOffice(bytes, seed);
const cells = editable.filter((e) => /!E\d+$/.test(e.label) && !/!E1$/.test(e.label));
const room = newRoom(seed.state);
const replica = new Y.Doc();
replica.clientID = randomInt(1, 0xffffffff);
Y.applyUpdate(replica, seed.state);
replica.on('update', (u) => (withMarkers ? Y.applyUpdate(room, u, connectionOrigin()) : Y.applyUpdate(room, u)));
for (let i = 0; i < n; i++) {
  const e = cells[i % cells.length];
  const marker = e.id.indexOf(':[');
  replica.getMap('xlsx:sheets').get(e.id.slice(0, marker)).get('contents').set(e.id.slice(marker + 1), JSON.stringify({ value: { kind: 'number', value: 0 }, formula: null }).replace('"value":0', `"value":${i}.0`));
}
const stored = storeSnapshot(room, seed.state);
const decoded = Y.decodeUpdate(stored);
console.log(JSON.stringify({ n, withMarkers, state: stored.length, clients: new Set(decoded.structs.map((s) => s.id.client)).size }));
const doc = init.XlsxDocument.openCollaborative(bytes, 12345);
try {
  const r = doc.applyUpdateJson(stored);
  console.log('applyUpdateJson ok', String(r).slice(0, 200));
} catch (error) {
  console.log('applyUpdateJson failed:', String(error?.message ?? error).slice(0, 500));
}
