// Repeated publication without edits: does source/state/baseline stabilize?
import { readFile } from 'node:fs/promises';
import { office, formatOf, baselineBytes, DETERMINISM } from './lib.mjs';
const path = process.argv[2];
const rounds = Number(process.argv[3] ?? 3);
const format = formatOf(path);
let bytes = new Uint8Array(await readFile(path));
const row = [];
for (let r = 0; r <= rounds; r++) {
  const seed = await office.seedOffice(format, bytes);
  const base = baselineBytes(await office.officeBaseline(bytes, seed), format);
  row.push({ round: r, source: bytes.length, state: seed.state.length, baseline: base, charged: bytes.length + seed.state.length + base + 2 });
  if (r < rounds) bytes = await office.exportOffice(bytes, seed, DETERMINISM(`job-${r}`));
}
console.log(JSON.stringify({ file: path.split('/').pop(), rounds: row }));
