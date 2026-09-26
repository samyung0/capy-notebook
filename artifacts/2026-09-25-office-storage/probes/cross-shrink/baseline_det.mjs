// Is officeBaseline(bytes, seed(bytes)) a pure function of the bytes?
// Seeds twice (fresh random client ids), compares baselines, times both steps.
// Usage: node baseline_det.mjs file...
import { readFile } from 'node:fs/promises';
import { office, formatOf, baselineBytes, timed } from '../storage/lib.mjs';

for (const path of process.argv.slice(2)) {
  const format = formatOf(path);
  const bytes = new Uint8Array(await readFile(path));
  const runs = [];
  for (let i = 0; i < 2; i++) {
    const [seed, tSeed] = await timed(() => office.seedOffice(format, bytes));
    const [entries, tBase] = await timed(() => office.officeBaseline(bytes, seed));
    runs.push({ seed, entries, tSeed, tBase });
  }
  const a = JSON.stringify(runs[0].entries);
  const b = JSON.stringify(runs[1].entries);
  const seedsEqual = Buffer.compare(Buffer.from(runs[0].seed.state), Buffer.from(runs[1].seed.state)) === 0;
  let firstDiff = null;
  if (a !== b) {
    const ea = runs[0].entries, eb = runs[1].entries;
    for (let i = 0; i < Math.max(ea.length, eb.length); i++) {
      if (JSON.stringify(ea[i]) !== JSON.stringify(eb[i])) { firstDiff = { i, a: ea[i], b: eb[i] }; break; }
    }
  }
  console.log(JSON.stringify({
    file: path.split(/[\\/]/).pop(), entries: runs[0].entries.length,
    baselineBytes: baselineBytes(runs[0].entries, format),
    baselineIdentical: a === b, seedBytesIdentical: seedsEqual,
    seedMs: runs.map((r) => r.tSeed), baselineMs: runs.map((r) => r.tBase), firstDiff,
  }));
}
