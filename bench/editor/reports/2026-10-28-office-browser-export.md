# Office export in the browser

Run 2026-10-28 on an Apple M1 MacBook, headless Chromium 151, against this
worktree's MSW dev server (unminified JS; the export itself runs in
WebAssembly). Question (Epo 2026-10-28): could Download build an Office file
with unpublished edits in the browser, as view mode already does, instead of
a server export?

Each case is the file plus its seeded editing state
([`office-export-prep.ts`](../scripts/office-export-prep.ts)), exported by the
app's own worker (`src/office-runtime/exportCheckpoint.ts`): four runs on a
fresh page, the first cold. Memory is the peak resident size of the
browser's renderer processes, sampled every 50 ms
([`office-export.mjs`](../scripts/office-export.mjs)). A seeded state holds no
edits; a real download adds its edits' share.

| File | File | State | Time cold | Time warm | Peak memory | Added by the export |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| long-handbook.docx (62 pages) | 0.04 MiB | 1.2 MiB | 0.52 s | 0.43 s | 287 MiB | 96–195 MiB |
| docx-text-192.docx (496 pages) | 0.12 MiB | 9.6 MiB | 2.71 s | 2.72 s | 596 MiB | 316–496 MiB |
| docx-table-96.docx | 0.17 MiB | 23.7 MiB | 5.27 s | 5.19 s | 757 MiB | 505–611 MiB |
| docx-picture-24.docx | 10.6 MiB | 0.2 MiB | 0.86 s | 0.87 s | 814 MiB | 550–666 MiB |
| docx-picture-64.docx | 28.2 MiB | 0.5 MiB | 2.31 s | 2.25 s | 1,496 MiB | 1,012–1,146 MiB |
| large-gradebook.xlsx (224k cells) | 1.3 MiB | 0.01 MiB | 1.61 s | 1.60 s | 405 MiB | 233–311 MiB |
| rows-50k.xlsx | 3.1 MiB | 0.00 MiB | 2.66 s | 2.67 s | 594 MiB | 410–484 MiB |
| xlsx-formula-8000.xlsx (8 × 8,000 rows) | 5.2 MiB | 0.01 MiB | 6.38 s | 6.25 s | 1,029 MiB | 847–933 MiB |
| xlsx-style-8000.xlsx | 5.4 MiB | 0.3 MiB | 3.63 s | 5.70 s | 688 MiB | 312–613 MiB |
| pptx-text-400.pptx | 0.6 MiB | 2.7 MiB | 0.29 s | 0.27 s | 260 MiB | 93–148 MiB |
| jp_llm2.pptx (84 slides) | 23.3 MiB | 0.7 MiB | 0.45 s | 0.41 s | 458 MiB | 209–345 MiB |
| pptx-picture-40.pptx | 29.8 MiB | 0.1 MiB | 0.44 s | 0.41 s | 517 MiB | 253–347 MiB |

The page never blocked: the worst timer delay on the page was 3 ms in every
run, since the work runs in a worker. The engine download comes on top on a
first use (brotli: DOCX 2.4 MB, XLSX 1.5 MB, PPTX 1.1 MB).

## Findings

1. **PPTX is cheap at any size**: under half a second and about 0.3 GiB for a
   30 MiB deck. Pictures pass through.
2. **DOCX and XLSX cost grows with content, not bytes.** A text or table
   heavy DOCX's editing state is 60 to 140 times its file (23.7 MiB of state
   for a 0.17 MiB file), and its time follows the state (5 s at 24 MiB).
   Formula-heavy workbooks are the slowest (6.4 s, about 0.9 GiB added).
   Picture-heavy DOCX is the memory peak: about 1 GiB added for 28 MiB of
   pictures.
3. **Desktop is fine; phones are the risk.** A mid-range phone runs a single
   thread three to four times slower than an M1, so the worst cases above
   take 20–25 s, and 1 GiB in one tab can get it killed on a 3–4 GB phone.
4. **It is the cost view mode already pays.** Opening a file with
   unpublished edits in view mode runs this same worker on the same bytes, so
   a browser Download adds no case the viewer does not already meet.
5. **The editing-state ceiling decides the worst case.** The tables case
   holds 24 MiB of state; at the 100 MiB ceiling a DOCX would take about four
   times as long and more memory. A lower ceiling bounds both.

## Reproduce

1. `python3 bench/editor/scripts/gen_office_ladder.py`
2. `pnpm exec tsx bench/editor/scripts/office-export-prep.ts` (needs the
   BetterOffice WASM built, `pnpm office:prepare`)
3. Start the MSW dev server (preview config `clone-download`, or set
   `OFFICE_EXPORT_URL`), then `node bench/editor/scripts/office-export.mjs`.
   Raw records: `bench/editor/.results/office-export/results.json`.
