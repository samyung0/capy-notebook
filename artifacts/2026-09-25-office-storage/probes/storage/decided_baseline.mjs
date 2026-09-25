// The 2026-09-25 decision: omit ':format' entries for default-styled cells and use short
// cell ids (labels kept). The most common cell-format hash stands in for "default".
import { readFile } from 'node:fs/promises';
import { office, formatOf, baselineBytes } from './lib.mjs';
for (const path of process.argv.slice(2)) {
  const bytes = new Uint8Array(await readFile(path));
  const seed = await office.seedOffice('xlsx', bytes);
  const entries = await office.officeBaseline(bytes, seed);
  const isCellFormat = (e) => e.kind === 'visual' && e.id.endsWith(':format') && e.id.includes(':[');
  const counts = new Map();
  for (const e of entries) if (isCellFormat(e)) counts.set(e.value, (counts.get(e.value) ?? 0) + 1);
  const [defaultHash, defaultCount] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  const shortId = (id) => id.replace(/^(sheet:\d+):\[\{"run":"base","offset":(\d+)\},\{"run":"base","offset":(\d+)\}\]/, '$1:$2:$3');
  const noDefault = entries.filter((e) => !(isCellFormat(e) && e.value === defaultHash));
  const decided = noDefault.map((e) => ({ ...e, id: shortId(e.id) }));
  const full = baselineBytes(entries, 'xlsx');
  const out = { file: path.split('/').pop(), cells: counts.size && [...counts.values()].reduce((a, b) => a + b, 0), defaultShare: +(defaultCount / [...counts.values()].reduce((a, b) => a + b, 0)).toFixed(3), baseline: full, withoutDefaultFormatEntries: baselineBytes(noDefault, 'xlsx'), decidedShortIds: baselineBytes(decided, 'xlsx') };
  out.decidedSaving = +(1 - out.decidedShortIds / full).toFixed(3);
  out.firstOpenNow = bytes.length + seed.state.length + full + 2;
  out.firstOpenDecided = bytes.length + seed.state.length + out.decidedShortIds + 2;
  console.log(JSON.stringify(out));
}
