// First-open accounting: seed state, baseline, Yjs re-encode, unedited export.
// Usage: node seed_probe.mjs file... > out.jsonl
import { readFile } from 'node:fs/promises';
import {
  office, Y, sha, formatOf, baselineBytes, checkpoint, DETERMINISM, timed, findAll,
} from './lib.mjs';

for (const path of process.argv.slice(2)) {
  const format = formatOf(path);
  const bytes = new Uint8Array(await readFile(path));
  const S = bytes.length;
  const [seed, tSeed] = await timed(() => office.seedOffice(format, bytes));
  const state0 = seed.state;
  const [entries, tBaseline] = await timed(() => office.officeBaseline(bytes, seed));
  const B0 = baselineBytes(entries, format);
  // What the first save writes back: Yjs re-encode of a gc:true doc.
  const doc = new Y.Doc();
  Y.applyUpdate(doc, state0);
  const reencoded = Y.encodeStateAsUpdate(doc).length;
  const clients = Y.decodeStateVector(Y.encodeStateVector(doc)).size;
  doc.destroy();
  const [exported, tExport] = await timed(() =>
    office.exportOffice(bytes, checkpoint(format, bytes, state0), DETERMINISM('job-probe'))
  );
  const kinds = {};
  for (const e of entries) kinds[e.kind] = (kinds[e.kind] ?? 0) + 1;
  const buf = Buffer.from(state0);
  const dataUrls = findAll(buf, 'data:image/').length;
  const row = {
    file: path.split(/[\\/]/).pop(),
    format,
    source: S,
    state: state0.length,
    stateYjsReencoded: reencoded,
    stateClients: clients,
    baseline: B0,
    entries: entries.length,
    kinds,
    pendingEffects: 2,
    chargedFirstOpen: S + state0.length + B0 + 2,
    multiplier: +((S + state0.length + B0 + 2) / S).toFixed(3),
    exportedUnedited: exported.length,
    exportRatio: +(exported.length / S).toFixed(3),
    dataUrlsInState: dataUrls,
    ms: { seed: tSeed, baseline: tBaseline, export: tExport },
  };
  console.log(JSON.stringify(row));
}
