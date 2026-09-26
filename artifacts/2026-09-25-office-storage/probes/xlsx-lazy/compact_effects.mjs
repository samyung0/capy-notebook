// Pending-effects size with the current shape vs compact ids and plain cell text.
import { readFileSync } from 'node:fs';
import { jsonbText } from '../storage/lib.mjs';
for (const f of process.argv.slice(2)) {
  const e = JSON.parse(readFileSync(f, 'utf8'));
  const plain = (t) => { if (t === undefined) return undefined; if (t.startsWith('=')) return t; const v = JSON.parse(t); return v.value === undefined ? '' : String(v.value); };
  const short = (id) => id.replace(/^(sheet:\d+):\[\{"run":"base","offset":(\d+)\},\{"run":"base","offset":(\d+)\}\]/, '$1:$2:$3');
  const compact = e.map((x) => ({ ...x, id: short(x.id), before: plain(x.before), after: plain(x.after) }));
  const noBefore = compact.map(({ before, ...x }) => x);
  const size = (v) => Buffer.byteLength(jsonbText(v));
  console.log(JSON.stringify({ f, n: e.length, jsonb: size(e), perEffect: Math.round(size(e) / e.length), compactJsonb: size(compact), compactPerEffect: Math.round(size(compact) / e.length), compactNoBeforeJsonb: size(noBefore), sample: compact[0] }));
}
