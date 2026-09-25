// Option sizing: slimmer XLSX baseline, effects without `before`, gzip CPU.
import { readFile } from 'node:fs/promises';
import { gzipSync, gunzipSync } from 'node:zlib';
import { office, formatOf, baselineBytes, effectsBytes, checkpoint } from './lib.mjs';
const path = process.argv[2];
const format = formatOf(path);
const bytes = new Uint8Array(await readFile(path));
const seed = await office.seedOffice(format, bytes);
const entries = await office.officeBaseline(bytes, seed);
const full = baselineBytes(entries, format);
const out = { file: path.split('/').pop(), baseline: full };
if (format === 'xlsx') {
  // (1) no per-cell ':format' entries (keep sheet layout), (2) plus compact ids/positions, no labels.
  const cellFormat = (e) => e.kind === 'visual' && e.id.endsWith(':format') && e.id.includes(':[');
  const noFormat = entries.filter((e) => !cellFormat(e));
  out.withoutCellFormatEntries = baselineBytes(noFormat, format);
  const compact = noFormat.map((e) => {
    const m = /^(sheet:\d+):\[\{"run":"base","offset":(\d+)\},\{"run":"base","offset":(\d+)\}\]$/.exec(e.id);
    return m ? { id: `${m[1]}:${m[2]}:${m[3]}`, kind: e.kind, value: e.value } : e;
  });
  out.compactIdsNoLabels = baselineBytes(compact, format);
  const defaultHash = (() => {
    const counts = new Map();
    for (const e of entries) if (cellFormat(e)) counts.set(e.value, (counts.get(e.value) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  })();
  out.mostCommonCellFormatShare = +(defaultHash[1] / entries.filter(cellFormat).length).toFixed(3);
}
// Effects after editing ~100 distinct targets: share of `before`.
const editable = await office.inspectOffice(bytes, seed);
const commands = format === 'xlsx'
  ? editable.filter((e) => /!E\d+$/.test(e.label) && !/!E1$/.test(e.label)).slice(0, 100).map((e) => ({ type: 'set_cell', sheet: e.label.split('!')[0], cell: e.label.split('!')[1], expectedValue: e.value, value: String(Number(e.value) + 1) }))
  : editable.filter((e) => e.value.split(' ').length > 3 && !/[\n\v\r]/.test(e.value)).slice(0, 100).map((e) => ({ type: 'replace_text', targetId: e.id, expectedText: e.value, text: e.value.replace(/\b(\w+)\b/, 'zebra') }));
const applied = await office.applyOfficeCommands(bytes, seed, commands);
const effects = office.compareBaselines(entries, await office.officeBaseline(bytes, checkpoint(format, bytes, applied.state)));
out.effects100 = effectsBytes(effects);
out.effects100WithoutBefore = effectsBytes(effects.map(({ before: _b, ...rest }) => rest));
// gzip CPU on the state
const state = Buffer.from(seed.state);
let t = performance.now();
const gz = gzipSync(state, { level: 6 });
out.gzipMs = Math.round(performance.now() - t);
t = performance.now();
gunzipSync(gz);
out.gunzipMs = Math.round(performance.now() - t);
out.state = state.length;
out.stateGzip = gz.length;
console.log(JSON.stringify(out));
