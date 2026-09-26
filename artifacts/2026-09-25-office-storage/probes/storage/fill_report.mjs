// Fill the report's @@placeholders@@ from tables.mjs output and the run records.
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const REPORT = '../storage-report.md';
const tables = execFileSync(process.execPath, ['tables.mjs'], { encoding: 'utf8' });
writeFileSync('tables_final.md', tables);
const section = (title) => {
  const start = tables.indexOf(`## ${title}`);
  const rest = tables.slice(start).split('\n').slice(1);
  const end = rest.findIndex((l, i) => i > 1 && l.startsWith('## '));
  return rest.slice(0, end < 0 ? undefined : end).join('\n').trim();
};
const read = (f) => readFileSync(`runs/${f}.jsonl`, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const MB = (n) => `${(n / 1e6).toFixed(1)} MB`;
const r100 = read('cells-100k.xlsx.yjs-cell-distinct');
const r50 = read('cells-50k.xlsx.yjs-cell-distinct');
const c100 = r100.find((r) => r.step === 'candidate');
const c50 = r50.find((r) => r.step === 'candidate');
const rb100 = r100.find((r) => r.step === 'published-rebased');
const s100 = r100.find((r) => r.step === 10000);
const summaryRows = section('Summary').split('\n').slice(2).join('\n').replace(/\| – \|/g, '| not run |').replace(/\| – \|/g, '| not run |');
// One publication row per file: the distinct-target model.
const pubAll = section('Refresh candidate and publication \\(after the last step\\)'.replace(/\\/g, '')).split('\n');
const pubHeader = pubAll.slice(0, 2);
const keep = new Set();
const pubRows = pubAll.slice(2).filter((l) => {
  const [, file, model] = l.split('|').map((s) => s.trim());
  const want = file.endsWith('.xlsx') ? ['yjs-cell-distinct', 'cell-distinct'] : ['replace-distinct'];
  if (!want.includes(model) || keep.has(file)) return false;
  keep.add(file);
  return true;
});
const replacements = {
  '@@SUMMARY_ROWS@@': summaryRows,
  '@@GROWTH_ROWS@@': section('Growth, compact'),
  '@@PUBLISH_ROWS@@': [...pubHeader, ...pubRows].join('\n'),
  '@@XLSX_HEADLINE@@': `A 0.8 MB workbook with 100k cells charges ${MB(r100[0].charged)} when first opened for editing, ${Math.round((r100[0].charged / 1e8) * 100)}% of the Free plan's 100 MB. While a refresh candidate exists it needs ${MB(c100.peak)}, more than the whole Free quota. The 50k-cell workbook charges ${MB(r50[0].charged)} and peaks at ${MB(c50.peak)}. After 10,000 cell commits the 100k workbook holds ${MB(s100.effects)} of pending effects and charges ${MB(s100.charged)}.`,
  '@@REBASE_100K@@': `, +${MB(rb100.rebasedState - rb100.seedB)} at 100k`,
  '@@REBASE_ROW_NOTE@@': `, +${MB(rb100.rebasedState - rb100.seedB)} at 100k (rebased ${MB(rb100.rebasedState)} against seed(B) ${MB(rb100.seedB)})`,
  '@@PEAK_100K_STATE@@': `-${MB(c100.capturedState)} of ${MB(c100.peak)}`,
  '@@PEAK_50K@@': `cells-50k peaks at ${MB(c50.peak)}, 88% of Free`,
  '@@PEAK_100K@@': `cells-100k at ${MB(c100.peak)}`,
};
let report = readFileSync(REPORT, 'utf8');
for (const [k, v] of Object.entries(replacements)) {
  if (!report.includes(k)) console.warn('missing placeholder', k);
  report = report.split(k).join(v);
}
writeFileSync(REPORT, report);
const left = report.match(/@@[A-Z0-9_]+@@/g);
console.log('filled; remaining placeholders:', left ?? 'none');
console.log(JSON.stringify({ first: r100[0].charged, peak100: c100.peak, peak50: c50.peak, rebased100: rb100, candidate100: c100 }, null, 1));
