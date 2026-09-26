// Time the collaboration service's per-refresh Office work on one file:
// exportOffice, seedOffice of the export, officeBaseline of that seed.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
const runtime = await import('file:///C:/WEB/capy-notebook/vendor/betteroffice/shared/office-checkpoint.mjs');
const input = process.argv[2];
const format = input.split('.').pop();
const bytes = new Uint8Array(await readFile(input));
const seed = await runtime.seedOffice(format, bytes);
const cp = { baseSha256: seed.baseSha256, format, schemaVersion: 1, state: seed.state };
const times = {};
let t = Date.now();
const exported = await runtime.exportOffice(bytes, cp, { now: '2000-01-01T00:00:00.000Z', seed: createHash('sha256').update('j').digest('hex') });
times.export = Date.now() - t; t = Date.now();
const seed2 = await runtime.seedOffice(format, exported);
times.seedExport = Date.now() - t; t = Date.now();
await runtime.officeBaseline(exported, { baseSha256: createHash('sha256').update(exported).digest('hex'), format, schemaVersion: 1, state: seed2.state });
times.baseline = Date.now() - t;
console.log(JSON.stringify({ file: input.split('/').pop(), bytes: bytes.byteLength, stateBytes: seed.state.byteLength, ...times }));
