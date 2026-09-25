// First-publication growth by component: seed(A) vs seed(B) where B is the
// unedited export of A, both as the engine seeds them and with the
// needed-only boundary rule applied (simulated). Usage: node roundtrip_weigh.mjs file.docx
import { readFile } from 'node:fs/promises';
import { office, load, weigh, rebuild } from './weigh.mjs';
import { checkpoint, DETERMINISM, baselineBytes } from '../storage/lib.mjs';

const needs = (r) => (r.propertyChanges?.length ?? 0) > 0 || (r.noteMarks?.length ?? 0) > 0 || r.text === '' || (r.breaks?.length ?? 0) > 0;
const needed = (op) => {
  if (op.embed && op.insert._kind === 'pilcrow' && op.insert._originalRunBoundaries) {
    const b = op.insert._originalRunBoundaries;
    if (!b.some(needs)) delete op.insert._originalRunBoundaries;
    else op.insert._originalRunBoundaries = b.map(({ formatting, ...rest }) => (rest.text === '' ? { ...rest, formatting } : rest));
  }
  return op;
};

const path = process.argv[2];
const A = new Uint8Array(await readFile(path));
const seedA = await office.seedOffice('docx', A);
const B = await office.exportOffice(A, checkpoint('docx', A, seedA.state), DETERMINISM('job-rt'));
const seedB = await office.seedOffice('docx', B);
const describe = (bytes, seed) => {
  const doc = load(seed.state);
  const w = weigh(doc);
  return {
    source: bytes.length,
    state: seed.state.length,
    control: rebuild(doc).length,
    neededRule: rebuild(doc, needed).length,
    keys: Object.fromEntries(Object.entries(w.embedKeys).sort((a, b) => b[1] - a[1]).slice(0, 6)),
    boundary: w.boundary,
    formatBytes: w.formatBytes,
  };
};
const a = describe(A, seedA);
const b = describe(B, seedB);
const baseA = baselineBytes(await office.officeBaseline(A, seedA), 'docx');
const baseB = baselineBytes(await office.officeBaseline(B, seedB), 'docx');
console.log(JSON.stringify({
  file: path.split(/[\\/]/).pop(),
  A: { ...a, baseline: baseA },
  B: { ...b, baseline: baseB },
  growth: {
    state: +(b.state / a.state - 1).toFixed(3),
    neededRule: +(b.neededRule / a.neededRule - 1).toFixed(3),
    source: +(b.source / a.source - 1).toFixed(3),
  },
}, null, 1));
