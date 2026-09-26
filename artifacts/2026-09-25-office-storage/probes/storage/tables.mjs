// Markdown tables for the report from seed_*.jsonl and runs/*.jsonl.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
const read = (f) => (existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l)) : []);
const seeds = [...read('seed_small.jsonl'), ...read('seed_generated.jsonl')];
const runs = {};
for (const f of readdirSync('runs').filter((f) => f.endsWith('.jsonl'))) runs[f.replace('.jsonl', '')] = read(`runs/${f}`);
const B = (n) => (n === undefined || n === null ? '–' : n >= 1e6 ? `${(n / 1e6).toFixed(2)} MB` : n >= 1e3 ? `${(n / 1e3).toFixed(1)} KB` : `${n} B`);
const x = (n) => (n === undefined ? '–' : `${n.toFixed(n >= 10 ? 1 : 2)}x`);
const step = (key, n) => runs[key]?.find((r) => r.step === n);
const delta = (key, n) => {
  const a = step(key, 0), b = step(key, n);
  return a && b ? b.charged - a.charged : undefined;
};
const order = ['lesson.docx', 'feature-rich.docx', 'book-30p.docx', 'book-300p.docx', 'images-10.docx', 'opaque-objects.docx', 'grades.xlsx', 'feature-rich.xlsx', 'cells-1k.xlsx', 'cells-10k.xlsx', 'cells-50k.xlsx', 'cells-100k.xlsx', 'lesson.pptx', 'feature-rich.pptx', 'deck-50.pptx', 'jp_llm2.pptx'];
const bySeed = Object.fromEntries(seeds.map((s) => [s.file, s]));

console.log('## Summary\n');
console.log('| Format | File | Source | State | Baseline | Charged after first Edit open | Multiplier | +Charged per 100 edits, distinct targets | +Charged per 100 edits, one target | Export / source | Peak while a refresh runs (x source) |');
console.log('| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
for (const file of order) {
  const s = bySeed[file];
  if (!s) continue;
  const distinctKey = s.format === 'xlsx' ? (runs[`${file}.yjs-cell-distinct`] ? `${file}.yjs-cell-distinct` : `${file}.cell-distinct`) : `${file}.replace-distinct`;
  const oneKey = s.format === 'xlsx' ? [`${file}.yjs-cell-repeat`, `${file}.yjs-cell-repeat.nopub`, `${file}.cell-repeat`].find((k) => runs[k]) : `${file}.yjs-typing`;
  const cand = runs[distinctKey]?.find((r) => r.step === 'candidate');
  console.log(`| ${s.format.toUpperCase()} | ${file} | ${B(s.source)} | ${B(s.state)} | ${B(s.baseline)} | ${B(s.chargedFirstOpen)} | ${x(s.multiplier)} | ${B(delta(distinctKey, 100))} | ${B(delta(oneKey, 100))} | ${cand ? cand.exportRatio.toFixed(2) : (s.exportRatio?.toFixed(2) ?? '–')} | ${cand ? `${B(cand.peak)} (${x(cand.peakMultiplier)})` : '–'} |`);
}

console.log('\n## Growth steps\n');
console.log('| File | Model | Edits | Client updates | State (+Δ) | State w/o markers (+Δ) | Without GC | Pending effects | Charged | Multiplier |');
console.log('| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
const models = ['replace-distinct', 'replace-typing', 'yjs-typing', 'yjs-typing.pinned', 'ai-distinct', 'cell-distinct', 'cell-repeat', 'yjs-cell-distinct', 'yjs-cell-distinct.pinned.nopub', 'yjs-cell-repeat', 'yjs-cell-repeat.nopub', 'cell-distinct.nopub'];
for (const file of order)
  for (const m of models) {
    const rows = runs[`${file}.${m}`];
    if (!rows?.length) continue;
    const base = rows[0];
    for (const r of rows.filter((r) => typeof r.step === 'number' && r.step > 0)) {
      const updates = m.startsWith('yjs') ? r.edits : m === 'ai-distinct' ? r.edits : r.clients;
      console.log(`| ${file} | ${m} | ${r.edits} | ${updates} | ${B(r.state)} (+${B(r.state - base.state)}) | +${B(r.stateNoMarkers - base.state)} | ${B(r.stateNoGC)} | ${B(r.effects)} (${r.effectCount}) | ${B(r.charged)} | ${x(r.multiplier)} |`);
    }
  }

console.log('\n## Refresh candidate and publication (after the last step)\n');
console.log('| File | Model | Source A | Export B (B/A) | Captured state | seed(B) | baseline(B) | Candidate row | Peak charged (x A) | After publish (x A) | After publish with 10 later edits (rebased state) |');
console.log('| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
for (const file of order)
  for (const m of models) {
    const rows = runs[`${file}.${m}`];
    const c = rows?.find((r) => r.step === 'candidate');
    if (!c) continue;
    const p = rows.find((r) => r.step === 'published');
    const rb = rows.find((r) => r.step === 'published-rebased');
    console.log(`| ${file} | ${m} | ${B(rows[0].source)} | ${B(c.exported)} (${c.exportRatio}) | ${B(c.capturedState)} | ${B(c.seedB)} | ${B(c.baselineB)} | ${B(c.candidateRow)} | ${B(c.peak)} (${x(c.peakMultiplier)}) | ${B(p.charged)} (${x(p.multiplierVsOriginal)}) | ${rb ? `${B(rb.charged)} (state ${B(rb.rebasedState)})` : '–'} |`);
  }

console.log('\n## GC evidence (stored state after the last step)\n');
console.log('| File | Model | Structs | Tombstone items | Deleted units | Delete-set ranges | Clients in state |');
console.log('| --- | --- | ---: | ---: | ---: | ---: | ---: |');
for (const file of order)
  for (const m of models) {
    const g = runs[`${file}.${m}`]?.find((r) => r.step === 'gc');
    if (g) console.log(`| ${file} | ${m} | ${g.structs} | ${g.tombstoneItems} | ${g.tombstoneUnits} | ${g.deleteSetRanges} | ${g.clientsInState} |`);
  }

console.log('\n## Growth, compact\n');
console.log('| File | Model | State growth at 10 / 100 / 1k / 10k edits | Same without markers, last step | Pending effects at 10 / 100 / 1k / 10k | Charged at last step |');
console.log('| --- | --- | --- | ---: | --- | ---: |');
for (const file of order)
  for (const m of models) {
    const rows = runs[`${file}.${m}`];
    if (!rows?.length) continue;
    const base = rows[0];
    const steps = rows.filter((r) => typeof r.step === 'number' && r.step > 0);
    if (!steps.length) continue;
    const last = steps[steps.length - 1];
    const cell = (r) => (r ? B(r.state - base.state) : '–');
    const fx = (r) => (r ? B(r.effects) : '–');
    const at = (n) => steps.find((r) => r.edits === n);
    console.log(`| ${file} | ${m} | ${[10, 100, 1000, 10000].map((n) => cell(at(n))).join(' / ')} | ${B(last.stateNoMarkers - base.state)} | ${[10, 100, 1000, 10000].map((n) => fx(at(n))).join(' / ')} | ${B(last.charged)} (${x(last.multiplier)}) |`);
  }
