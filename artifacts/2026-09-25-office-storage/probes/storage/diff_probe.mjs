// What one engine edit writes into the Yjs state, and how long one call takes.
// Usage: node diff_probe.mjs file
import { readFile } from 'node:fs/promises';
import { office, Y, formatOf, checkpoint, timed } from './lib.mjs';

const path = process.argv[2];
const format = formatOf(path);
const bytes = new Uint8Array(await readFile(path));
const seed = await office.seedOffice(format, bytes);
const [editable, tInspect] = await timed(() => office.inspectOffice(bytes, seed));
let command;
if (format === 'xlsx') {
  const cell = editable.find((e) => /!E3$/.test(e.label)) ?? editable.find((e) => e.value && !e.value.startsWith('='));
  const [sheet, addr] = cell.label.split('!');
  command = { type: 'set_cell', sheet, cell: addr, expectedValue: cell.value, value: String(Number(cell.value) + 1 || 'x') };
} else {
  const para = editable.filter((e) => e.value.length > 40)[3];
  const words = para.value.split(' ');
  words[Math.floor(words.length / 2)] = 'zebra';
  command = { type: 'replace_text', targetId: para.id, expectedText: para.value, text: words.join(' ') };
}
const [applied, tApply] = await timed(() => office.applyOfficeCommands(bytes, seed, [command]));
const before = new Y.Doc();
Y.applyUpdate(before, seed.state);
const after = new Y.Doc();
Y.applyUpdate(after, applied.state);
const diff = Y.encodeStateAsUpdate(after, Y.encodeStateVector(before));
const decoded = Y.decodeUpdate(diff);
const show = (v) => String(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? Number(x) : x))).slice(0, 300);
console.log(JSON.stringify({ file: path.split('/').pop(), command: { ...command, text: command.text?.slice(0, 60), expectedText: undefined }, ms: { inspect: tInspect, apply: tApply }, stateBefore: seed.state.length, stateAfter: applied.state.length, diffBytes: diff.length }));
for (const s of decoded.structs) {
  const c = s.content;
  console.log(' ', s.constructor.name, s.id.client, s.id.clock, 'len', s.length, s.parentSub ?? '', c?.constructor.name ?? '', show(c?.str ?? c?.arr ?? c?.value ?? c?.embed ?? c?.key ?? ''));
}
console.log('  deleteSet', show([...decoded.ds.clients.entries()].map(([k, v]) => [k, v.length, v.slice(0, 5)])));
// GC check: re-encode after through a gc:true doc versus gc:false.
const keep = new Y.Doc({ gc: false });
Y.applyUpdate(keep, seed.state);
Y.applyUpdate(keep, applied.state);
const gcd = new Y.Doc();
Y.applyUpdate(gcd, seed.state);
Y.applyUpdate(gcd, applied.state);
console.log('  stored(gc:true)', Y.encodeStateAsUpdate(gcd).length, 'gc:false', Y.encodeStateAsUpdate(keep).length);
