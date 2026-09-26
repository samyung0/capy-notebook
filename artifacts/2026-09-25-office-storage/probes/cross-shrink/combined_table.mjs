// Part 3: charged bytes per file today, after the decided changes, and after the
// recommended set plus sibling assumptions. Inputs are measured values (storage
// report runs, this investigation's dumps and prototype); `E` marks estimates.
const MB = (n) => (n / 1e6).toFixed(2) + ' MB';

// Measured today (storage/runs/*.jsonl, step 0 and step 100; candidate step).
const today = {
  'cells-100k.xlsx': { A: 819394, s0: 27019546, s100: 27022912, base: 43071623, fx100: 25554, B: 1054292, seedB: 27027281, baseB: 43053587 },
  'book-300p.docx': { A: 358686, s0: 4505210, s100: 4507943, base: 1406440, fx100: 131360, B: 378896, seedB: 4918543, baseB: 1407298 },
  'images-10.docx': { A: 4191049, s0: 5669857, s100: 5672414, base: 41184, fx100: 54927, B: 4156164, seedB: 5681634, baseB: 42014 },
  'deck-50.pptx': { A: 94214, s0: 518674, s100: 521369, base: 204388, fx100: 30593, B: 91078, seedB: 520496, baseB: 205276 },
  'jp_llm2.pptx': { A: 24390706, s0: 22708897, s100: 22711580, base: 461341, fx100: 38961, B: 23744083, seedB: 22657765, baseB: 457091 },
};

// Decided 2026-09-25: XLSX baseline without default-format entries and with short
// ids (measured ratio on cells-10k: 2,177,672 / 4,255,767); PPTX media out of Yjs
// (jp_llm2 seed without pptx:meta.media measured at 1,753,694 B).
const XLSX_DECIDED = 2177672 / 4255767; // E when applied to 100k cells
const JP_MEDIA = 22708897 - 1753694;

// Recommended set: PPTX packageJson out (prototype seeds, measured), baseline derived
// from the published base (0 stored), captured state copy-on-write (0 when no edit
// lands during the refresh). Sibling assumptions: XLSX state ~2 KB + 10.6 B per
// edited cell (browser commit without marker tombstone), baseline derived; DOCX
// images out of state (images-10 state without base64: 110,733 B, storage report).
const proto = { 'deck-50.pptx': 157934, 'jp_llm2.pptx': 674852 };
const DOCX_IMAGES_OUT = 110733;
// gzip-6 of the remaining state (encodings.jsonl); XLSX/DOCX-images: E.
const gzipState = { 'cells-100k.xlsx': 1500, 'book-300p.docx': 899367, 'images-10.docx': 23000, 'deck-50.pptx': 34637, 'jp_llm2.pptx': 125248 };
// pglz on-disk size of today's stored values (scratch PG16, pg_column_size).
const pglzToday = {
  'cells-100k.xlsx': { state: 238250 * 10, base: 574757 * 10, E: true },
  'book-300p.docx': { state: 1356830, base: 666928 },
  'images-10.docx': { state: 5669857, base: 19565 },
  'deck-50.pptx': { state: 100714, base: 73592 },
  'jp_llm2.pptx': { state: 22708897, base: 161564 },
};
const pglzAfter = { 'cells-100k.xlsx': 2000, 'book-300p.docx': 1356830, 'images-10.docx': 30000, 'deck-50.pptx': 46253, 'jp_llm2.pptx': 178685 };

const rows = [];
for (const [file, t] of Object.entries(today)) {
  const growth100 = t.s100 - t.s0;
  // S0 today
  const s0 = {
    first: t.A + t.s0 + t.base + 2,
    at100: t.A + t.s100 + t.base + t.fx100,
  };
  s0.peak = s0.at100 + t.s100 + t.B + t.seedB + t.baseB;
  // S1 decided
  let st0 = t.s0, base = t.base, seedB = t.seedB, baseB = t.baseB;
  if (file.endsWith('.xlsx')) { base = Math.round(base * XLSX_DECIDED); baseB = Math.round(baseB * XLSX_DECIDED); }
  if (file === 'jp_llm2.pptx') { st0 -= JP_MEDIA; seedB -= JP_MEDIA; }
  const s1 = { first: t.A + st0 + base + 2, at100: t.A + st0 + growth100 + base + t.fx100 };
  s1.peak = s1.at100 + st0 + growth100 + t.B + seedB + baseB;
  // S2 recommended + siblings
  let st = st0;
  if (proto[file]) st = proto[file];
  if (file === 'images-10.docx') st = DOCX_IMAGES_OUT;
  let g100 = growth100;
  if (file.endsWith('.xlsx')) { st = 2000; g100 = 100 * 10.6; }
  const seedB2 = st + (t.seedB - t.s0) * (file.endsWith('.xlsx') || proto[file] || file === 'images-10.docx' ? 0 : 1);
  const cur = t.A + st + g100 + t.fx100; // no stored baseline
  const s2 = {
    first: t.A + st + 2,
    at100: cur,
    peakSum: cur + t.B + seedB2, // COW: no captured copy when no edit lands during the refresh
    peakSumEdited: cur + t.B + seedB2 + st + g100,
    peakMax: Math.max(cur, t.B + seedB2),
    storedGzip100: t.A + gzipState[file] + t.fx100,
    sourcePlusPending100: t.A + t.fx100,
    disk100: pglzAfter[file],
  };
  rows.push({ file, A: t.A, s0, s1, s2, diskToday: pglzToday[file] });
}

const x = (n, A) => `${MB(n)} (${(n / A).toFixed(1)}x)`;
console.log('| File | Source | Today: first open | Today: 100 edits | Today: refresh peak | Decided: first open | Decided: 100 edits | Decided: peak | Rec.: first open | Rec.: 100 edits | Rec.: peak, sum | Rec.: peak, sum, edits during refresh | Rec.: peak, max | Rec.: 100 edits, stored gzip | Rec.: 100 edits, source + pending |');
console.log('|' + ' --- |'.repeat(15));
for (const r of rows) {
  console.log(`| ${r.file} | ${MB(r.A)} | ${x(r.s0.first, r.A)} | ${x(r.s0.at100, r.A)} | ${x(r.s0.peak, r.A)} | ${x(r.s1.first, r.A)} | ${x(r.s1.at100, r.A)} | ${x(r.s1.peak, r.A)} | ${x(r.s2.first, r.A)} | ${x(r.s2.at100, r.A)} | ${x(r.s2.peakSum, r.A)} | ${x(r.s2.peakSumEdited, r.A)} | ${x(r.s2.peakMax, r.A)} | ${x(r.s2.storedGzip100, r.A)} | ${x(r.s2.sourcePlusPending100, r.A)} |`);
}
console.log();
console.log('| File | Postgres on disk today (pglz state + baseline) | Postgres on disk after (pglz state) |');
for (const r of rows) console.log(`| ${r.file} | ${MB(r.diskToday.state + r.diskToday.base)}${r.diskToday.E ? ' E' : ''} | ${MB(r.s2.disk100)} |`);
