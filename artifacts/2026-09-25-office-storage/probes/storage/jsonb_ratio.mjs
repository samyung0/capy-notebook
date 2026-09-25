import { readFile } from 'node:fs/promises';
import { office, formatOf, effectsBytes, checkpoint, jsonbText } from './lib.mjs';
for (const path of process.argv.slice(2)) {
  const format = formatOf(path);
  const bytes = new Uint8Array(await readFile(path));
  const seed = await office.seedOffice(format, bytes);
  const entries = await office.officeBaseline(bytes, seed);
  const editable = await office.inspectOffice(bytes, seed);
  const commands = format === 'xlsx'
    ? editable.filter((e) => /!E\d+$/.test(e.label) && !/!E1$/.test(e.label)).slice(0, 50).map((e) => ({ type: 'set_cell', sheet: 'Sheet1', cell: e.label.split('!')[1], expectedValue: e.value, value: String(Number(e.value) + 1) }))
    : editable.filter((e) => e.value.split(' ').length > 3).slice(0, 50).map((e) => ({ type: 'replace_text', targetId: e.id, expectedText: e.value, text: e.value + ' x' }));
  const applied = await office.applyOfficeCommands(bytes, seed, commands);
  const fx = office.compareBaselines(entries, await office.officeBaseline(bytes, checkpoint(format, bytes, applied.state)));
  const compact = Buffer.byteLength(JSON.stringify(fx));
  console.log(JSON.stringify({ file: path.split('/').pop(), effects: fx.length, compactJson: compact, jsonbText: effectsBytes(fx), ratio: +(effectsBytes(fx) / compact).toFixed(3), sample: jsonbText(fx.slice(0, 1)).slice(0, 300) }));
}
