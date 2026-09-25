// Dump the values Capy stores for one source (as the collaboration service
// writes them) plus variants, for compression and TOAST measurements.
// Usage: node dump_values.mjs <outDir> <edits|0> file...
//   state.bin            seed state (source_documents.state at first open)
//   baseline.json        indexed_baseline bytes (encodeBaseline JSON)
//   baseline-decided.json  XLSX only: decided 2026-09-25 form (short ids, no default-format entries)
//   effects*.json        pending_effects as jsonb text after N distinct edits:
//                        full, without `before`, and span-trimmed (40 chars of context)
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { office, formatOf, jsonbText, checkpoint, timed } from '../storage/lib.mjs';

const [outDir, editsArg, ...files] = process.argv.slice(2);
const EDITS = Number(editsArg);
const WORDS = ['river', 'signal', 'garden', 'copper', 'lantern', 'harbor', 'meadow', 'silver', 'canyon', 'orchard'];
const encode = (entries, format) => JSON.stringify({ entries, format, version: 1 });

function trimSpan(before, after, context = 40) {
  let p = 0;
  while (p < before.length && p < after.length && before[p] === after[p]) p++;
  let s = 0;
  while (s < before.length - p && s < after.length - p && before[before.length - 1 - s] === after[after.length - 1 - s]) s++;
  const cut = (text) => {
    const from = Math.max(0, p - context);
    const to = text.length - Math.max(0, s - context);
    return (from > 0 ? '…' : '') + text.slice(from, to) + (to < text.length ? '…' : '');
  };
  return [cut(before), cut(after)];
}

for (const path of files) {
  const format = formatOf(path);
  const name = path.split(/[\\/]/).pop();
  const dir = `${outDir}/${name}`;
  await mkdir(dir, { recursive: true });
  const bytes = new Uint8Array(await readFile(path));
  const [seed, tSeed] = await timed(() => office.seedOffice(format, bytes));
  await writeFile(`${dir}/state.bin`, seed.state);
  const [entries, tBase] = await timed(() => office.officeBaseline(bytes, seed));
  await writeFile(`${dir}/baseline.json`, encode(entries, format));
  const row = { file: name, format, source: bytes.length, state: seed.state.length, baseline: Buffer.byteLength(encode(entries, format)), ms: { seed: tSeed, baseline: tBase } };
  if (format === 'xlsx') {
    const isCellFormat = (e) => e.kind === 'visual' && e.id.endsWith(':format') && e.id.includes(':[');
    const counts = new Map();
    for (const e of entries) if (isCellFormat(e)) counts.set(e.value, (counts.get(e.value) ?? 0) + 1);
    const [defaultHash] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    const shortId = (id) => id.replace(/^(sheet:\d+):\[\{"run":"base","offset":(\d+)\},\{"run":"base","offset":(\d+)\}\]/, '$1:$2:$3');
    const decided = entries.filter((e) => !(isCellFormat(e) && e.value === defaultHash)).map((e) => ({ ...e, id: shortId(e.id) }));
    await writeFile(`${dir}/baseline-decided.json`, encode(decided, format));
    row.baselineDecided = Buffer.byteLength(encode(decided, format));
  }
  // Baseline composition: bytes of each field across entries.
  const fields = {};
  for (const e of entries) for (const [k, v] of Object.entries(e)) fields[`${e.kind}.${k}`] = (fields[`${e.kind}.${k}`] ?? 0) + Buffer.byteLength(JSON.stringify(v)) + k.length + 3;
  row.baselineFields = fields;
  row.entryKinds = entries.reduce((m, e) => ((m[e.kind] = (m[e.kind] ?? 0) + 1), m), {});
  if (EDITS > 0) {
    const editable = await office.inspectOffice(bytes, seed);
    const commands = format === 'xlsx'
      ? editable
          .filter((e) => /!E\d+$/.test(e.label) && !/!E1$/.test(e.label) && e.value !== '')
          .slice(0, EDITS)
          .map((e) => ({ type: 'set_cell', sheet: e.label.split('!')[0], cell: e.label.split('!')[1], expectedValue: e.value, value: String(Number(e.value) + 1) }))
      : editable
          .filter((e) => e.value.split(' ').length > 3 && !/[\n\v\r]/.test(e.value))
          .slice(0, EDITS)
          .map((e, i) => {
            const words = e.value.split(' ');
            words[Math.floor(words.length / 2)] = WORDS[i % WORDS.length];
            return { type: 'replace_text', targetId: e.id, expectedText: e.value, text: words.join(' ') };
          });
    const [applied, tApply] = await timed(() => office.applyOfficeCommands(bytes, seed, commands));
    const current = await office.officeBaseline(bytes, checkpoint(format, bytes, applied.state));
    const effects = office.compareBaselines(entries, current);
    const noBefore = effects.map(({ before: _b, ...rest }) => rest);
    const span = effects.map((e) => {
      if (typeof e.before !== 'string' || typeof e.after !== 'string') return e;
      const [before, after] = trimSpan(e.before, e.after);
      return { ...e, before, after };
    });
    await writeFile(`${dir}/effects.json`, jsonbText(effects));
    await writeFile(`${dir}/effects-nobefore.json`, jsonbText(noBefore));
    await writeFile(`${dir}/effects-span.json`, jsonbText(span));
    Object.assign(row, {
      edits: commands.length,
      effectCount: effects.length,
      effects: Buffer.byteLength(jsonbText(effects)),
      effectsNoBefore: Buffer.byteLength(jsonbText(noBefore)),
      effectsSpan: Buffer.byteLength(jsonbText(span)),
      applyMs: tApply,
    });
  }
  console.log(JSON.stringify(row));
}
