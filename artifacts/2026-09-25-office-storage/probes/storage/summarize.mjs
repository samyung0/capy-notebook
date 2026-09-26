// Tabulate runs/*.jsonl: per file+mode, the growth steps and publication rows.
import { readFileSync, readdirSync } from 'node:fs';
const only = process.argv[2];
const kb = (n) => (n === undefined ? '' : n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : (n / 1e3).toFixed(1) + 'k');
for (const f of readdirSync('runs').filter((f) => f.endsWith('.jsonl')).sort()) {
  if (only && !f.includes(only)) continue;
  const rows = readFileSync(`runs/${f}`, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  if (!rows.length) { console.log(`${f}: (empty)`); continue; }
  const base = rows[0];
  const parts = [];
  for (const r of rows) {
    if (typeof r.step === 'number' && r.step > 0)
      parts.push(`${r.edits}: st ${kb(r.state)} (+${r.state - base.state}${r.stateNoMarkers ? `, nomark +${r.stateNoMarkers - base.state}` : ''}) fx ${kb(r.effects)} chg ${kb(r.charged)} x${r.multiplier}${r.typingOk === false ? ' TYPING-FAIL' : ''}`);
  }
  const gc = rows.find((r) => r.step === 'gc');
  const cand = rows.find((r) => r.step === 'candidate');
  const pub = rows.find((r) => r.step === 'published');
  const reb = rows.find((r) => r.step === 'published-rebased');
  console.log(`${f}\n  S ${kb(base.source)} st0 ${kb(base.state)} base ${kb(base.baseline)} chg0 ${kb(base.charged)}\n  ${parts.join('\n  ')}`);
  if (gc) console.log(`  gc: tombstones ${gc.tombstoneItems} items / ${gc.tombstoneUnits} units, ds ranges ${gc.deleteSetRanges}, clients ${gc.clientsInState}`);
  if (cand) console.log(`  candidate: B ${kb(cand.exported)} (x${cand.exportRatio}) seedB ${kb(cand.seedB)} baseB ${kb(cand.baselineB)} candRow ${kb(cand.candidateRow)} docRow ${kb(cand.sourceDocRow)} PEAK ${kb(cand.peak)} x${cand.peakMultiplier}`);
  if (pub) console.log(`  published: ${kb(pub.charged)} x${pub.multiplierVsOriginal} (vs export x${pub.multiplierVsExport})`);
  if (reb) console.log(`  rebased: state ${kb(reb.rebasedState)} (latest ${kb(reb.latestState)}, seedB ${kb(reb.seedB)}) fx ${kb(reb.effects)} charged ${kb(reb.charged)}`);
}
