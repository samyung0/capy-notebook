// Bytes a refresh candidate holds: captured state (copy of current state),
// exported source, seed of the export and its semantic baseline JSON.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
const runtime = await import('file:///C:/WEB/capy-notebook/vendor/betteroffice/shared/office-checkpoint.mjs');
const input = process.argv[2];
const format = input.split('.').pop();
const bytes = new Uint8Array(await readFile(input));
const seed = await runtime.seedOffice(format, bytes);
const cp = { baseSha256: seed.baseSha256, format, schemaVersion: 1, state: seed.state };
const exported = await runtime.exportOffice(bytes, cp, { now: '2000-01-01T00:00:00.000Z', seed: createHash('sha256').update('j').digest('hex') });
const seed2 = await runtime.seedOffice(format, exported);
const entries = await runtime.officeBaseline(exported, { baseSha256: createHash('sha256').update(exported).digest('hex'), format, schemaVersion: 1, state: seed2.state });
const baselineBytes = Buffer.byteLength(JSON.stringify({ entries, format, version: 1 }));
console.log(JSON.stringify({ file: input.split('/').pop(), sourceBytes: bytes.byteLength, stateBytes: seed.state.byteLength, exportBytes: exported.byteLength, seedBytes: seed2.state.byteLength, baselineBytes }));
