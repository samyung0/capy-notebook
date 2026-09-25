# Office source storage in Capy: measured multipliers

Date: 2026-09-25. Engine: `vendor/betteroffice` at `dfa3f05e`, headless bundle
`shared/office-checkpoint.mjs` (runtime manifest docx `72246663…`, xlsx `c4ade1d3…`,
pptx `cc540c53…`). Yjs 13.6.31 from `collaboration/node_modules`. The probes replay the
collaboration service's seed, save, refresh and publication paths in a scratch Node script.
No server, database or container was started. Scripts, generated files and raw run records
are in
`<session scratchpad>/storage/`
(`storage/` below).

## 1. Summary

"Charged after first Edit open" is `files.size_bytes + source_documents.storage_bytes`,
that is source + state + baseline + 2 bytes for the empty `[]` of pending effects. Before
the first Edit open only the source counts.

| Format | File | Source | State | Baseline | Charged after first Edit open | Multiplier | +Charged per 100 edits, distinct targets | +Charged per 100 edits, one target | Export / source | Peak while a refresh runs (x source) |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| DOCX | lesson.docx | 37.4 KB | 11.8 KB | 3.6 KB | 52.8 KB | 1.41x | 3.4 KB | 3.1 KB | 1.03 | 164.7 KB (4.40x) |
| DOCX | feature-rich.docx | 39.2 KB | 57.6 KB | 13.0 KB | 109.8 KB | 2.80x | 8.1 KB | 3.2 KB | 1.02 | 336.7 KB (8.59x) |
| DOCX | book-30p.docx | 48.0 KB | 443.8 KB | 144.3 KB | 636.1 KB | 13.3x | 140.6 KB | 5.1 KB | 1.03 | 2.03 MB (42.4x) |
| DOCX | book-300p.docx | 358.7 KB | 4.51 MB | 1.41 MB | 6.27 MB | 17.5x | 134.1 KB | 5.1 KB | 1.06 | 18.81 MB (52.4x) |
| DOCX | images-10.docx | 4.19 MB | 5.67 MB | 41.2 KB | 9.90 MB | 2.36x | 57.5 KB | 6.7 KB | 0.99 | 25.55 MB (6.10x) |
| DOCX | opaque-objects.docx | 66.7 KB | 92.9 KB | 15.0 KB | 174.6 KB | 2.62x | 20.7 KB | 5.8 KB | 0.97 | 503.4 KB (7.55x) |
| XLSX | grades.xlsx | 5.5 KB | 3.2 KB | 5.2 KB | 13.9 KB | 2.51x | 2.8 KB | 454 B | 1.03 | 54.6 KB (9.85x) |
| XLSX | feature-rich.xlsx | 7.3 KB | 36.9 KB | 29.5 KB | 73.7 KB | 10.1x | 10.0 KB | 2.7 KB | 0.97 | 215.2 KB (29.6x) |
| XLSX | cells-1k.xlsx | 14.3 KB | 269.2 KB | 420.9 KB | 704.4 KB | 49.2x | 29.0 KB | 2.6 KB | 1.10 | 1.97 MB (137.7x) |
| XLSX | cells-10k.xlsx | 87.6 KB | 2.67 MB | 4.26 MB | 7.01 MB | 80.0x | 28.8 KB | 2.6 KB | 1.12 | 19.65 MB (224.4x) |
| XLSX | cells-50k.xlsx | 412.7 KB | 13.50 MB | 21.51 MB | 35.42 MB | 85.8x | 28.9 KB | 2.6 KB | 1.26 | 87.62 MB (212.3x) |
| XLSX | cells-100k.xlsx | 819.4 KB | 27.02 MB | 43.07 MB | 70.91 MB | 86.5x | 28.9 KB | not run | 1.29 | 172.34 MB (210.3x) |
| PPTX | lesson.pptx | 29.3 KB | 106.2 KB | 3.3 KB | 138.8 KB | 4.73x | 3.2 KB | 2.8 KB | 1.00 | 428.0 KB (14.6x) |
| PPTX | feature-rich.pptx | 16.6 KB | 54.8 KB | 11.1 KB | 82.5 KB | 4.99x | 4.8 KB | 2.9 KB | 0.97 | 265.2 KB (16.0x) |
| PPTX | deck-50.pptx | 94.2 KB | 518.7 KB | 204.4 KB | 817.3 KB | 8.68x | 33.3 KB | 3.0 KB | 0.97 | 2.33 MB (24.7x) |
| PPTX | jp_llm2.pptx | 24.39 MB | 22.71 MB | 461.3 KB | 47.56 MB | 1.95x | 41.6 KB | 3.5 KB | 0.97 | 117.22 MB (4.81x) |

How to read the growth columns. Distinct targets: DOCX/PPTX 100 `replace_text` edits on
different paragraphs; XLSX 100 cell commits on different cells. One target: 100 keystrokes
into one paragraph (DOCX/PPTX) or 100 commits to one cell (XLSX), each sent as its own Yjs
update, as the browser does. The growth is not linear: most of it is pending effects, and a
target costs its full before and after text the first time it changes, then only its text
delta (section 4). "Export / source" and "Peak" come from the distinct-target run, after
its last step (1,000 edits; 10,000 for the 10k-100k sheets). "Not run" marks models skipped
for that file. Seed sizes vary by about 1% between runs because the engine's random 45-bit
client id changes varint widths.

Findings:

1. The multiplier depends on content, not file size. Media-heavy files land at 1.9-2.4x
   because the media is copied into the Yjs state (DOCX images as base64 at 1.33x, PPTX
   media as binary at 1.0x). Text DOCX with real content is 13-17x (the 30- and 300-page
   books). PPTX without much media is 4.7-8.7x, and spreadsheets are 49-87x at 1k-100k
   cells. Tiny fixtures sit lower (lesson.docx 1.4x, grades.xlsx 2.5x) because a large
   template dwarfs the content: lesson.docx is 829 KB of XML, 788 KB of it styles. A
   spreadsheet costs about 270 bytes of state and 430 bytes of baseline per cell, against
   about 8 bytes per cell in the zipped source.
2. XLSX is the outlier. A 0.8 MB workbook with 100k cells charges 70.9 MB when first
   opened for editing, 71% of the Free plan's 100 MB. While a refresh candidate exists it
   needs 172.3 MB, 1.7x the whole Free quota, so on Free it can never publish. The 50k-cell
   workbook charges 35.4 MB and peaks at 87.6 MB. After 10,000 cell commits the 100k
   workbook holds 2.6 MB of pending effects and charges 73.8 MB. The baseline change decided
   today removes 49% of the baseline, measured at 10k cells. Scaled to 100k cells that is
   about 50 MB at first open and about 130 MB at the peak, still above the Free quota
   (estimate).
3. Edit growth is mostly pending effects, not Yjs state. Each changed paragraph adds its
   full before and after text (about 1.3 KB for a 90-word paragraph, 300 B for a slide
   bullet), each changed cell about 255 B. Effects are capped by what changed and cleared by
   publication. With every paragraph changed, book-30p holds 234 KB of effects, about 2.5x
   its text. With every cell changed, cells-10k holds about 260 B per cell.
4. Yjs GC works for content. Deleted text and overwritten cell values leave the stored
   state: 1,000 whole-paragraph replacements deleted 1.6 M characters and added 1.3 KB.
   What stays is a tombstone per operation: about 20-26 B per `replace_text` on a new
   paragraph and about 23 B per incoming client update. The per-update part comes from the
   contributor marker. It is written inside the remote transaction, so Yjs rotates the
   room's client id after every update (`yjs.mjs:3342-3345`), and each marker leaves a
   tombstone from a fresh client. Typing 1,000 characters adds 23.9 KB of state; with a
   fixed room client id it adds 1.1 KB. Source rooms have no compaction. A publication that
   re-seeds from the export drops the tombstones, and so do XLSX and PPTX rebases. A DOCX
   rebase (edits saved after the capture) keeps the old lineage, tombstones included.
5. While a refresh candidate exists, the captured state is charged a second time, plus the
   exported file, its seed and its baseline. The peak is 2.0-2.6x the charge just before the
   refresh: book-300p 7.6 → 18.8 MB, cells-10k 9.7 → 19.7 MB, jp_llm2 47.6 → 117.2 MB.
6. After publication the charge is export + seed(export) + baseline(export). Exports are
   0.97-1.07x the source for DOCX and PPTX, and 0.97-1.30x for XLSX (1.10-1.30x for the
   generated sheets). The first DOCX publication re-seeds larger because the exporter writes
   resolved formatting onto every run: +14% for the books, +23% feature-rich.docx, +31%
   lesson.docx, flat for the image and object files. Repeated publications are then stable.
   A publication with edits saved after the capture keeps a rebased state instead. For XLSX
   it carries the whole uncompressed XML of each changed worksheet (+0.5 MB at 10k cells,
   +2.6 MB at 50k, +5.2 MB at 100k). For PPTX it carries the changed parts as binary
   (+4.4 KB on deck-50, +30.5 KB on feature-rich.pptx).
7. What fits in the Free plan's 100 MB once each file has been opened for editing
   (first-open charge only, no refresh headroom): 157 × book-30p, 15 × book-300p,
   10 × images-10, 122 × deck-50, 14 × cells-10k, 2 × cells-50k, 1 × cells-100k. The
   100-files-per-workspace cap binds first only for the small text files.
8. Question 1: yes. The DOCX state holds each image as a base64 data URL in the image
   embed's `src`. For the 10-image file, the base64 is 5.56 MB of the 5.67 MB state, 1.36x
   the 4.17 MB of image bytes, with no second binary copy.
9. Question 2: storing the run XML costs roughly its own size: in the generated fixture,
   414 B per inline chart run, 3.9 KB per text box (`mc:AlternateContent`, which repeats the
   text in the VML fallback), 567 B for a `w:pict`, 1.0 KB for a `w:object`. None of the
   five DOCX files in the repository contains any of these elements. The chart parts,
   embedded workbooks, OLE payloads and preview images do not need to enter the state: the
   current exporter already keeps them, with their original relationship ids, even when the
   body no longer references them.

## 2. What is stored and how it is counted

Confirmed in code. Every Office value below reaches Postgres as raw bytes. Between the
collaboration service and Go, byte fields travel as base64 inside JSON because Go
`[]byte` fields decode base64, but they are written to `bytea` unencoded.

| Row | Column | Holds | Serialized as | Counted as |
| --- | --- | --- | --- | --- |
| `files` | `size_bytes` | published source in B2 | object bytes | `size_bytes` |
| `source_documents` | `state bytea` | Yjs update v1 of the current document | engine seed (Yrs) at first open; after the first save, `Y.encodeStateAsUpdate` of a gc:true Yjs doc (`collaboration/src/sourceDocuments.ts:536-540`) | `octet_length(state)` |
| | `indexed_baseline bytea` (renamed from `indexed_state` in 0015) | semantic baseline of the indexed checkpoint | UTF-8 of `JSON.stringify({entries, format, version: 1})` (`encodeBaseline`, `sourceDocuments.ts:68-70`) | `octet_length` |
| | `pending_effects jsonb` | net effects against the baseline | JSON array, stored as jsonb | `octet_length(pending_effects::text)`: jsonb text with `", "` and `": "` separators, 2-5% larger than compact JSON for these effects |
| `source_refresh_candidates` | `state bytea` | copy of the captured state | raw | `octet_length` |
| | `size_bytes` | exported source B in B2 | object bytes | value |
| | `seed bytea` | engine seed of B | raw Yrs update | `octet_length` |
| | `baseline bytea` | baseline of seed(B) | UTF-8 JSON | `octet_length` |
| browser IndexedDB | drafts | base bytes plus state per actor and session | | not charged |

Formulas: `source_documents.storage_bytes` (`server/migrations/0001_init.sql:1510`, the
generated expression follows the 0015 rename) and candidate `storage_bytes`
(`0015_source_semantic_baseline.sql:12-14`, adds `baseline`). The AFTER triggers
`account_source_storage` (`0001_init.sql:3909-3927`) append the deltas, and reconciliation
sums both tables (`server/internal/store/storage.go:609-610`).

When each part starts counting:

- View never creates a row (`ViewSourceSession`). The locking session read inserts an empty
  row worth 2 bytes (`source_documents.go:169`).
- The first room load seeds the state and posts an `initialize` checkpoint with the
  baseline. The quota gate admits state + baseline (`source_documents.go:287-307`). The
  same `load` runs for the agent's `inspect` and `applyEdit` (`sourceDocuments.ts:578-583,
  643`), so an AI read of a never-opened Office source also seeds and charges it. The
  comment there says "seeded in memory", but the seed is persisted.
- Each save replaces state and pending effects; positive growth is gated.
- Refresh request: candidate row with a copy of the state, gated on `len(state)`
  (`source_documents.go:451,463`). Export finalize adds B + seed + baseline, gated
  (`source_refresh.go:180,196`). Publication deletes the candidate and gates only net growth
  (`source_refresh.go:290,321,336`).

## 3. First open: what the state and baseline are made of

Payload breakdowns from walking the seeded Yjs document (`analyze_state.mjs`):

- **Text DOCX** (book-30p, state 443.8 KB). 180 KB (40%) is `_originalRunBoundaries` on
  each paragraph mark, which repeats every run's text plus a serialized formatting key.
  95 KB is the text itself, 52 KB is resolved `defaultTextFormatting` per paragraph, 52 KB
  is run format markers (`fontFamily` alone is 34 KB), and 56 KB is Yjs item overhead. So
  the text is stored twice, with resolved formatting around it. The baseline (144 KB) holds
  one text entry per paragraph with the full paragraph text (113 KB) and one
  formatting-hash entry (31 KB).
- **DOCX with images** (images-10). Base64 `src` data URLs are 5.56 MB of the 5.67 MB
  state. The baseline keeps only SHA-256 hashes (41 KB).
- **XLSX** (cells-1k). About 270 B of state per cell: one canonical JSON value string per
  cell (`{"value":{"kind":"number","value":219.0},"formula":null}`) under a long map key
  (`[{"run":"base","offset":R},{"run":"base","offset":C}]`). About 420 B of baseline per
  cell: a text entry (193 B) and a `:format` hash entry (228 B), both carrying the
  62-character cell id, JSON-escaped, plus a label.
- **PPTX.** `pptx:meta.packageJson` dominates text decks: 102 KB of lesson.pptx's 106 KB
  (the python-pptx template's 11 layouts), 361 KB of deck-50's 519 KB. In jp_llm2 the
  binary `pptx:meta.media` is 20.96 MB, 1.0x the 20.95 MB of `ppt/media`, plus a 1.08 MB
  `packageJson`.

Stored values compress well except media. gzip -6, measured (`compress_probe.mjs`, a
separate seed run, so sizes differ from section 1 by up to 1%):

| File | State → gzip | Baseline → gzip | Charged now → if state and baseline were gzipped |
| --- | ---: | ---: | ---: |
| lesson.docx | 11.8 KB → 1.8 KB | 3.6 KB → 1.0 KB | 52.8 KB → 40.2 KB |
| book-30p.docx | 443.8 KB → 95.0 KB | 144.3 KB → 48.4 KB | 636 KB → 191 KB |
| book-300p.docx | 4.46 MB → 0.90 MB | 1.41 MB → 0.46 MB | 6.22 MB → 1.72 MB |
| images-10.docx | 5.67 MB → 4.19 MB | 41 KB → 13 KB | 9.90 MB → 8.39 MB |
| cells-1k.xlsx | 269 KB → 17.5 KB | 421 KB → 22.6 KB | 704 KB → 54 KB |
| cells-10k.xlsx | 2.67 MB → 0.16 MB | 4.26 MB → 0.22 MB | 7.01 MB → 0.46 MB |
| lesson.pptx | 106 KB → 5.7 KB | 3.3 KB → 1.0 KB | 139 KB → 36 KB |
| deck-50.pptx | 519 KB → 57 KB | 204 KB → 44 KB | 817 KB → 196 KB |

gzip of a 2.7 MB state took 21 ms and gunzip 5 ms.

## 4. Editing growth

### Models

- `replace-distinct`: the engine's `replace_text` on different paragraphs, one engine
  session (one Yjs client) per step. Cycles when a file has fewer paragraphs than edits.
- `replace-typing`: `replace_text` appending one character at a time to one paragraph, one
  engine session per step.
- `yjs-typing`: browser-like typing. A separate replica with a uint32 client id, as
  `src/office-runtime/main.tsx:151` uses, inserts one character per transaction at the
  paragraph end, and each update is applied to the room with a connection origin. Checked
  after every save: the engine's baseline shows the typed text in that paragraph, and the
  export succeeds.
- `ai-distinct`: one engine call per edit, a fresh client each time, as the agent's
  `applyEdit` does.
- `cell-distinct` / `cell-repeat`: the engine's `set_cell` batched per step.
  `yjs-cell-*`: browser-like cell commits written into the room map with the same payload
  shape as the engine's `editCellJson`, one update per commit. At 100 edits the two agree:
  270,378 vs 270,477 bytes without markers (cells-1k), 999 vs 1,098 bytes of content
  growth (cells-10k), identical effects. The engine path costs 0.8 s per `set_cell` at 10k
  cells and 5 s at 50k, so 10,000-edit steps use the emulation.

Each step runs the service's save: contributor markers as in `contributors.ts`, the snapshot
merge, `Y.encodeStateAsUpdate` on a gc:true doc, `officeBaseline` plus `compareBaselines`
for effects, and jsonb-text accounting. Two controls run alongside, with the same updates: a
gc:false doc ("Without GC") and a gc:true doc without markers ("w/o markers").

### Steps

Per-step rows, the gc:false sizes and GC counts are in `storage/tables_final.md`.

| File | Model | State growth at 10 / 100 / 1k / 10k edits | Same without markers, last step | Pending effects at 10 / 100 / 1k / 10k | Charged at last step |
| --- | --- | --- | ---: | --- | ---: |
| lesson.docx | replace-distinct | 328 B / 2.2 KB / 20.7 KB / – | 20.7 KB | 1.5 KB / 1.3 KB / 1.3 KB / – | 74.8 KB (2.00x) |
| lesson.docx | replace-typing | 162 B / 317 B / 1.3 KB / – | 1.3 KB | 492 B / 582 B / 1.5 KB / – | 55.5 KB (1.49x) |
| lesson.docx | yjs-typing | 321 B / 2.5 KB / 23.9 KB / – | 1.0 KB | 492 B / 582 B / 1.5 KB / – | 78.0 KB (2.08x) |
| feature-rich.docx | replace-distinct | 122 B / 2.0 KB / 19.7 KB / – | 19.7 KB | 4.0 KB / 6.2 KB / 6.0 KB / – | 135.6 KB (3.46x) |
| feature-rich.docx | yjs-typing | 332 B / 2.5 KB / 23.9 KB / – | 1.0 KB | 651 B / 741 B / 1.6 KB / – | 135.3 KB (3.45x) |
| book-30p.docx | replace-distinct | 347 B / 2.7 KB / 24.4 KB / – | 24.4 KB | 7.9 KB / 137.9 KB / 233.8 KB / – | 894.3 KB (18.6x) |
| book-30p.docx | replace-typing | 168 B / 326 B / 1.3 KB / – | 1.3 KB | 2.5 KB / 2.6 KB / 3.5 KB / – | 640.9 KB (13.4x) |
| book-30p.docx | yjs-typing | 334 B / 2.5 KB / 23.9 KB / – | 1.0 KB | 2.5 KB / 2.6 KB / 3.5 KB / – | 663.5 KB (13.8x) |
| book-30p.docx | yjs-typing.pinned | 127 B / 217 B / 1.1 KB / – | 1.0 KB | 2.5 KB / 2.6 KB / 3.5 KB / – | 640.8 KB (13.4x) |
| book-30p.docx | ai-distinct | 632 B / 5.8 KB / – / – | 5.9 KB | 7.9 KB / 137.9 KB / – / – | 779.8 KB (16.3x) |
| book-300p.docx | replace-distinct | 321 B / 2.7 KB / 26.5 KB / – | 26.4 KB | 10.9 KB / 131.4 KB / 1.28 MB / – | 7.58 MB (21.1x) |
| book-300p.docx | replace-typing | 165 B / 320 B / 1.3 KB / – | 1.3 KB | 2.5 KB / 2.6 KB / 3.5 KB / – | 6.23 MB (17.4x) |
| book-300p.docx | yjs-typing | 334 B / 2.5 KB / 23.9 KB / – | 1.0 KB | 2.5 KB / 2.6 KB / 3.5 KB / – | 6.30 MB (17.6x) |
| images-10.docx | replace-distinct | 331 B / 2.6 KB / 22.9 KB / – | 22.9 KB | 11.7 KB / 54.9 KB / 56.0 KB / – | 9.98 MB (2.38x) |
| images-10.docx | yjs-typing | 324 B / 2.5 KB / 23.9 KB / – | 1.0 KB | 4.2 KB / 4.3 KB / 5.2 KB / – | 9.93 MB (2.37x) |
| opaque-objects.docx | replace-distinct | 309 B / 2.3 KB / 22.6 KB / – | 22.6 KB | 14.4 KB / 18.4 KB / 19.0 KB / – | 216.7 KB (3.25x) |
| opaque-objects.docx | yjs-typing | 329 B / 2.5 KB / 23.9 KB / – | 1.0 KB | 3.2 KB / 3.3 KB / 4.2 KB / – | 203.2 KB (3.05x) |
| grades.xlsx | cell-distinct | 207 B / 1.1 KB / 11.0 KB / – | 10.9 KB | 1.6 KB / 1.6 KB / 1.6 KB / – | 26.5 KB (4.77x) |
| grades.xlsx | cell-repeat | 147 B / 196 B / 251 B / – | 228 B | 260 B / 260 B / 260 B / – | 14.4 KB (2.60x) |
| feature-rich.xlsx | cell-distinct | 283 B / 1.4 KB / 11.1 KB / – | 11.1 KB | 2.5 KB / 8.6 KB / 8.6 KB / – | 93.5 KB (12.9x) |
| feature-rich.xlsx | yjs-cell-repeat | 347 B / 2.4 KB / 22.9 KB / – | 58 B | 261 B / 261 B / 261 B / – | 96.9 KB (13.3x) |
| cells-1k.xlsx | cell-distinct | 208 B / 1.3 KB / 11.3 KB / – | 11.3 KB | 2.5 KB / 25.5 KB / 228.6 KB / – | 944.4 KB (65.9x) |
| cells-1k.xlsx | cell-repeat | 139 B / 191 B / 247 B / – | 224 B | 244 B / 244 B / 245 B / – | 704.9 KB (49.2x) |
| cells-1k.xlsx | yjs-cell-distinct | 410 B / 3.5 KB / 33.8 KB / – | 10.9 KB | 2.5 KB / 25.5 KB / 228.6 KB / – | 966.9 KB (67.5x) |
| cells-1k.xlsx | yjs-cell-repeat | 340 B / 2.4 KB / 23.0 KB / – | 49 B | 244 B / 244 B / 245 B / – | 727.7 KB (50.8x) |
| cells-10k.xlsx | yjs-cell-distinct | 407 B / 3.3 KB / 33.6 KB / 331.6 KB | 103.2 KB | 2.5 KB / 25.5 KB / 256.5 KB / 2.32 MB | 9.66 MB (110.3x) |
| cells-10k.xlsx | yjs-cell-distinct.pinned.nopub | 201 B / 1.1 KB / 10.7 KB / 102.3 KB | 102.2 KB | 2.5 KB / 25.5 KB / 256.5 KB / 2.32 MB | 9.44 MB (107.7x) |
| cells-10k.xlsx | yjs-cell-repeat | 338 B / 2.4 KB / 23.0 KB / – | 47 B | 244 B / 244 B / 245 B / – | 7.03 MB (80.3x) |
| cells-10k.xlsx | cell-distinct.nopub | 204 B / 1.1 KB / – / – | 1.1 KB | 2.5 KB / 25.5 KB / – / – | 7.04 MB (80.3x) |
| cells-50k.xlsx | yjs-cell-distinct | 414 B / 3.5 KB / 34.5 KB / 344.2 KB | 116.0 KB | 2.5 KB / 25.4 KB / 256.4 KB / 2.59 MB | 38.35 MB (92.9x) |
| cells-50k.xlsx | yjs-cell-repeat.nopub | 337 B / 2.4 KB / 22.9 KB / – | 49 B | 244 B / 244 B / 245 B / – | 35.44 MB (85.9x) |
| cells-100k.xlsx | yjs-cell-distinct | 426 B / 3.4 KB / 34.2 KB / 343.7 KB | 115.5 KB | 2.5 KB / 25.6 KB / 256.8 KB / 2.59 MB | 73.84 MB (90.1x) |
| lesson.pptx | replace-distinct | 340 B / 2.2 KB / 21.5 KB / – | 21.5 KB | 996 B / 990 B / 990 B / – | 161.3 KB (5.50x) |
| lesson.pptx | replace-typing | 164 B / 317 B / 1.3 KB / – | 1.3 KB | 264 B / 354 B / 1.3 KB / – | 141.3 KB (4.82x) |
| lesson.pptx | yjs-typing | 331 B / 2.5 KB / 23.9 KB / – | 1.0 KB | 264 B / 354 B / 1.3 KB / – | 164.0 KB (5.59x) |
| feature-rich.pptx | replace-distinct | 361 B / 2.3 KB / 21.6 KB / – | 21.6 KB | 2.1 KB / 2.5 KB / 2.5 KB / – | 106.6 KB (6.44x) |
| feature-rich.pptx | yjs-typing | 331 B / 2.5 KB / 23.9 KB / – | 1.0 KB | 327 B / 417 B / 1.3 KB / – | 107.7 KB (6.51x) |
| deck-50.pptx | replace-distinct | 359 B / 2.7 KB / 24.8 KB / – | 24.8 KB | 3.0 KB / 30.6 KB / 124.0 KB / – | 966.1 KB (10.3x) |
| deck-50.pptx | replace-typing | 166 B / 321 B / 1.3 KB / – | 1.3 KB | 418 B / 508 B / 1.4 KB / – | 820.0 KB (8.70x) |
| deck-50.pptx | yjs-typing | 329 B / 2.5 KB / 23.9 KB / – | 1.0 KB | 418 B / 508 B / 1.4 KB / – | 842.6 KB (8.94x) |
| deck-50.pptx | yjs-typing.pinned | 127 B / 217 B / 1.1 KB / – | 1.0 KB | 418 B / 508 B / 1.4 KB / – | 819.8 KB (8.70x) |
| deck-50.pptx | ai-distinct | 646 B / 5.8 KB / – / – | 5.9 KB | 3.0 KB / 30.6 KB / – / – | 853.7 KB (9.06x) |
| jp_llm2.pptx | replace-distinct | 501 B / 2.7 KB / 19.4 KB / – | 19.4 KB | 4.2 KB / 39.0 KB / 56.8 KB / – | 47.64 MB (1.95x) |
| jp_llm2.pptx | yjs-typing | 333 B / 2.5 KB / 23.9 KB / – | 1.0 KB | 995 B / 1.1 KB / 2.0 KB / – | 47.59 MB (1.95x) |

Per-operation state cost, from the 1,000-edit steps:

| Operation | Stored state growth |
| --- | ---: |
| Keystroke sent as its own update (browser) | 23.9 B, of which about 1 B is the character and about 23 B the marker tombstone |
| Same, with the room's client id held fixed | 1.1 B |
| `replace_text` on a new paragraph (batched) | 19-26 B, independent of paragraph length |
| `replace_text` repeated on one paragraph (batched) | 1.3 B |
| AI edit, one engine session each | about 58 B (new client block, marker, tombstone) |
| Cell commit on a new cell (browser) | 33.6 B (about 10.6 B without the marker) |
| Cell commit on the same cell (browser) | 23 B (0.05 B without the marker) |

Pending effects per changed target: about 1.3-1.4 KB per 90-word paragraph, about 300 B
per slide bullet, about 255 B per cell. Typing into one paragraph keeps 2 effects (text and
formatting) of about twice the paragraph text. When every target has changed, effects stop
growing: book-30p 234 KB (all 168 paragraphs, about 2.5x its text), deck-50 124 KB,
cells-10k 2.32 MB after 10,000 commits over 8,991 cells.

### The `replace_text` bias

The fork's `replace_text` inserts the whole new paragraph and deletes the old one. Against
real typing that means:

- The deleted copy is garbage-collected, so it does not inflate the stored state. On
  book-30p the gc:false control reaches 1.04 MB (distinct paragraphs) and 2.08 MB
  (1,000 appends to one paragraph), while the stored state is 468 KB and 445 KB, against
  444 KB at seed.
- It leaves one tombstone per edit (about 20-26 B), even for a one-character change.
  Browser typing merges consecutive characters into one item (about 1 B per character) but
  pays the 23 B marker tombstone per update. Typing 1,000 characters through
  `replace_text` batched in one session (+1.3 KB) is therefore far cheaper than the same
  1,000 characters from a browser (+23.9 KB). With one update per `replace_text`, as the
  browser would send, the marker cost dominates both.
- Effects are unaffected. They come from comparing baselines, so they depend only on which
  entries changed.

### GC evidence

Across all runs, stored states contain only `ContentDeleted` or GC structs for removed
content: see the "Tombstone items / Deleted units" columns in `tables_final.md`. For
example, after `replace-typing` on book-30p, 8 tombstone items stand for 1,631,504
deleted characters, and the state is 445 KB against 2.08 MB for gc:false. Growth per
operation is bounded, but it adds up over time because source rooms are never compacted
(`persistence.ts:1122-1146` selects `material_yjs_documents` only). The tombstones go
away only when a publication re-seeds the state from the export, or when an XLSX or PPTX
rebase rebuilds it. A DOCX rebase keeps them: lesson.docx after 1,000 `replace_text`
edits rebased to 33.7 KB, against 32.8 KB before and 15.4 KB for seed(B). Automatic
refresh needs 5,000 net tokens, so a document that is edited back and forth may never
publish.

## 5. Refresh candidate and publication

Peak = A + (state + baseline + effects) + (captured state + B + seed(B) + baseline(B)).
Rows are for the last step of each model, then publication with no newer checkpoint
(state := seed(B)) and with 10 edits saved after the capture (`rebaseOffice`).

| File | Model | Source A | Export B (B/A) | Captured state | seed(B) | baseline(B) | Candidate row | Peak charged (x A) | After publish (x A) | After publish with 10 later edits (rebased state) |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| lesson.docx | replace-distinct | 37.4 KB | 38.4 KB (1.026) | 32.5 KB | 15.4 KB | 3.6 KB | 89.9 KB | 164.7 KB (4.40x) | 57.4 KB (1.53x) | 76.9 KB (state 33.7 KB) |
| feature-rich.docx | replace-distinct | 39.2 KB | 40.0 KB (1.02) | 77.3 KB | 70.8 KB | 13.0 KB | 201.1 KB | 336.7 KB (8.59x) | 123.8 KB (3.16x) | 137.1 KB (state 81.0 KB) |
| book-30p.docx | replace-distinct | 48.0 KB | 49.2 KB (1.026) | 468.2 KB | 477.3 KB | 145.4 KB | 1.14 MB | 2.03 MB (42.4x) | 671.9 KB (14.0x) | 692.3 KB (state 487.0 KB) |
| book-300p.docx | replace-distinct | 358.7 KB | 378.9 KB (1.056) | 4.53 MB | 4.92 MB | 1.41 MB | 11.24 MB | 18.81 MB (52.4x) | 6.70 MB (18.7x) | 6.52 MB (state 4.72 MB) |
| images-10.docx | replace-distinct | 4.19 MB | 4.16 MB (0.992) | 5.69 MB | 5.68 MB | 42.0 KB | 15.57 MB | 25.55 MB (6.10x) | 9.88 MB (2.36x) | 9.91 MB (state 5.70 MB) |
| opaque-objects.docx | replace-distinct | 66.7 KB | 64.8 KB (0.972) | 116.0 KB | 90.5 KB | 15.4 KB | 286.7 KB | 503.4 KB (7.55x) | 170.7 KB (2.56x) | 216.3 KB (state 118.6 KB) |
| grades.xlsx | cell-distinct | 5.5 KB | 5.7 KB (1.026) | 14.1 KB | 3.1 KB | 5.1 KB | 28.1 KB | 54.6 KB (9.85x) | 14.0 KB (2.52x) | 17.4 KB (state 5.0 KB) |
| feature-rich.xlsx | cell-distinct | 7.3 KB | 7.0 KB (0.97) | 48.1 KB | 37.0 KB | 29.6 KB | 121.7 KB | 215.2 KB (29.6x) | 73.6 KB (10.1x) | 82.8 KB (state 43.6 KB) |
| cells-1k.xlsx | cell-distinct | 14.3 KB | 15.8 KB (1.101) | 280.5 KB | 267.7 KB | 419.1 KB | 983.0 KB | 1.93 MB (134.6x) | 702.5 KB (49.0x) | 755.2 KB (state 317.8 KB) |
| cells-10k.xlsx | yjs-cell-distinct | 87.6 KB | 97.9 KB (1.117) | 3.00 MB | 2.65 MB | 4.24 MB | 9.99 MB | 19.65 MB (224.4x) | 6.99 MB (79.8x) | 7.50 MB (state 3.17 MB) |
| cells-50k.xlsx | yjs-cell-distinct | 412.7 KB | 522.0 KB (1.265) | 13.84 MB | 13.42 MB | 21.49 MB | 49.27 MB | 87.62 MB (212.3x) | 35.43 MB (85.8x) | 38.03 MB (state 16.02 MB) |
| cells-100k.xlsx | yjs-cell-distinct | 819.4 KB | 1.05 MB (1.287) | 27.36 MB | 27.03 MB | 43.05 MB | 98.50 MB | 172.34 MB (210.3x) | 71.14 MB (86.8x) | 76.37 MB (state 32.26 MB) |
| lesson.pptx | replace-distinct | 29.3 KB | 29.4 KB (1.003) | 127.7 KB | 106.2 KB | 3.3 KB | 266.6 KB | 428.0 KB (14.6x) | 138.9 KB (4.74x) | 143.0 KB (state 109.3 KB) |
| feature-rich.pptx | replace-distinct | 16.6 KB | 16.1 KB (0.974) | 76.4 KB | 54.9 KB | 11.2 KB | 158.6 KB | 265.2 KB (16.0x) | 82.2 KB (4.96x) | 114.3 KB (state 85.4 KB) |
| deck-50.pptx | replace-distinct | 94.2 KB | 91.1 KB (0.967) | 543.5 KB | 520.5 KB | 205.3 KB | 1.36 MB | 2.33 MB (24.7x) | 816.9 KB (8.67x) | 824.4 KB (state 525.0 KB) |
| jp_llm2.pptx | replace-distinct | 24.39 MB | 23.74 MB (0.973) | 22.73 MB | 22.66 MB | 457.1 KB | 69.59 MB | 117.22 MB (4.81x) | 46.86 MB (1.92x) | 46.88 MB (state 22.68 MB) |

- The export ratio to the source is 0.97-1.07 for DOCX and PPTX, and 0.97-1.30 for XLSX.
  The generated sheets export at 1.10-1.30 because the exporter writes more verbose
  worksheet XML: 49.7 KB against 36.1 KB for cells-1k.
- Round trips without edits (`roundtrip.mjs`). The DOCX seed grows once: book-30p
  443.8 → 505.1 KB (+14%), feature-rich 57.6 → 70.8 KB (+23%), lesson 11.8 → 15.4 KB
  (+31%), opaque-objects -1%. The exported runs carry explicit formatting, which re-seeds as
  larger `_originalRunBoundaries` and `_originalFormatting`. Later rounds are unchanged
  within seed noise. XLSX, PPTX and the image DOCX are stable from round 1.
- Rebased states (10 edits saved after the capture):
  - DOCX rebinds the latest state, so it keeps that lineage and its tombstones, plus about
    3-4%. It can come out below seed(B) (book-300p 4.72 vs 4.92 MB) or far above it
    (lesson.docx 33.7 vs 15.4 KB after 1,000 edits).
  - PPTX rebuilds from the export and stores the changed parts as binary in `pptx:meta`
    (schema 4): +4.4 KB on deck-50, +30.5 KB on feature-rich.pptx, +0.1% on jp_llm2.
  - XLSX rebuilds from the export and adds an `xlsx:rebase` root holding each changed
    worksheet as uncompressed XML bytes (`part:xl/worksheets/sheet1.xml`, 51,482 B for
    cells-1k): +50 KB at 1k cells, +0.52 MB at 10k, +2.60 MB at 50k, +5.2 MB at 100k
    (rebased 32.3 MB against seed(B) 27.0 MB).

## 6. Question 1: DOCX images as data URLs

Yes. `crates/docx-parse/src/media.rs:46` builds `data:<mime>;base64,…` for every
`word/media/*` part. Image resolution puts it in `src`, and `crates/docx-edit/src/seed.rs:1054`
copies `src` into the Yjs image embed. `office-checkpoint.ts:169,293` decodes it again
for baselines and assets. Measured on images-10.docx (10 images, 6 JPEG and 4 PNG,
4,169,330 bytes):

| Measure | Bytes |
| --- | ---: |
| Image bytes in the package | 4,169,330 |
| Base64 of those images | 5,559,124 |
| Full base64 of each image found in state | 10 of 10 |
| Raw binary copies in state | 0 |
| State | 5,669,857 (1.36x image bytes; base64 is 98% of it) |
| State without the base64 | 110,733 |
| Charged after first Edit open | 9.90 MB (2.36x the 4.19 MB source) |

In the opaque-objects fixture, an OLE object's preview image enters the state the same way:
a 31 KB PNG becomes a 41.6 KB data URL.

## 7. Question 2: charts and opaque drawings as raw XML

The fix was decided on 2026-09-25 (`human/frontend/office-files.md`: raw-XML embeds,
together with upstream `4bf205b5`). Today, measured on `opaque-objects.docx` (2 inline charts with chart parts and embedded
workbooks, 2 text boxes as `mc:AlternateContent` with a VML fallback, 1 VML `w:pict`, 1 OLE
`w:object` with a PNG preview):

| Element | XML in document.xml | What the seed stores now | In an unedited export |
| --- | ---: | --- | --- |
| `w:drawing` + `c:chart` (inline) | 414 B each | `chart` embed with `chartJson` (parsed chart, 3.4 KB each), 4.1 KB per embed | run dropped; `word/charts/*`, their rels and the embedded workbooks stay in the package, orphaned, with the original rIds |
| `mc:AlternateContent` text box | 3,880 B each | `shape` embed with `shapeJson`, 1.65 KB each | re-emitted as a `wps` drawing (1.7 KB); wrapper and VML fallback dropped |
| `w:pict` (VML rectangle with text) | 567 B | nothing | dropped |
| `w:object` (OLE, Excel) | 1,006 B | `image` embed with the preview as a data URL, 41.6 KB | exported as a plain picture; the OLE part stays in the package, orphaned |

Estimate of extra state for the fix: about the XML size plus about 20 B per element (Yjs
item, key, and string length). Here that is 828 + 7,760 + 567 + 1,006 ≈ 10.2 KB, +11% on
this object-dense 93 KB state. The net depends on what the fix replaces:

- Kept alongside today's payloads: +10.2 KB.
- Replacing the chart embeds' `chartJson` (6.8 KB), the text-box `shapeJson` (3.3 KB) and
  the OLE preview data URL (41.6 KB): the state shrinks by about 41 KB, if the viewer can
  render charts and previews from the package.

The referenced parts stay in the source package, and the fix does not need to copy them.
Evidence: the current exporter preserves inherited parts and relationship ids
(`rIdChart1`, `rIdChart2`, `rIdOleImg`, `rIdOle`, and `word/charts/chart{1,2}.xml` with
their `.rels`, three `word/embeddings/*.xlsx`, `word/media/image_ole1.png`) even after it
has dropped the runs. The openwiki states the same: DOCX binds embeds and relationships to
B, and its exporter keeps inherited parts. So raw run XML that keeps its `r:id` values is
enough. In this fixture the parts are 15.1 KB of chart XML, 16.5 KB of embedded workbooks
and 31 KB of preview; real Word charts and SmartArt parts are usually larger, and they
would stay out of the quota either way.

`scan_ooxml.py` found no `w:drawing`, `mc:AlternateContent`, `w:pict` or `w:object`, and
no media, in any DOCX in the repository (e2e `lesson.docx`, and the fork's
`feature-rich.docx`, `betteroffice-demo.docx`, `footnote-anchor.docx`,
`line-spacing-baseline.docx`). These XML sizes come from hand-written OOXML modelled on
Word's output, not from a corpus. Word text boxes and shapes typically run 2-6 KB each,
plus their text twice. Documents with many shapes (flowcharts) could add tens to hundreds of
KB. Treat the figures as estimates until a real document set is measured.

## 8. Options, with measured trade-offs

Three of these overlap decisions recorded in `human/` on 2026-09-25 (uncommitted working
tree): B (XLSX baseline), E (PPTX media) and the raw-XML embeds in section 7. The numbers
below show what those decisions buy and what remains.

| Option | Measured effect | Cost or risk |
| --- | --- | --- |
| A. gzip state and baseline in the collaboration service (store and charge compressed bytes) | XLSX -93% (cells-10k 7.01 → 0.46 MB), text DOCX -72% (book-300p 6.22 → 1.72 MB), PPTX text -76%, images -15% | 21 ms gzip and 5 ms gunzip per 2.7 MB state. Every reader of `state` and the baselines must decompress: the collaboration service, Go's baseline validation, and the browser view export. Postgres TOAST already compresses large values on disk, so this mostly changes what is charged, plus the base64 bodies between the service and Go |
| B. XLSX baseline, as decided on 2026-09-25 (`human/backend-storage-quota.md`): no `:format` entry for default-styled cells, short cell ids, labels kept | cells-10k baseline 4.26 → 2.18 MB (-49%), first open 7.01 → 4.93 MB (80x → 56x); estimated for cells-100k: 70.9 → about 50 MB at first open, refresh peak 172 → about 130 MB | the state (270 B per cell) is untouched, so the 100k workbook still cannot publish on Free; 50% of cells are default-styled in these sheets |
| C. Further: drop all per-cell `:format` entries and labels | 4.26 → 0.86 MB (-80%) | loses per-cell formatting change detection unless replaced (for example by a per-sheet format digest); labels rebuilt for display; fork change |
| D. DOCX images out of state (reference by part and SHA, as the baseline already does) | images-10: state 5.67 → 0.11 MB, charged 9.90 → 4.34 MB (2.36x → 1.04x) | fork change to seed and render; the image must come from the fingerprint-checked package |
| E. PPTX media out of state (decided on 2026-09-25 in `human/frontend/office-files.md`) | jp_llm2: charged 47.6 → 26.6 MB (1.95x → 1.09x), refresh peak 117 → about 54 MB (estimate: the 21 MB of media leaves the current state, the captured state and seed(B)) | fork change, already planned; rebase overlays still store changed media parts |
| F. Write contributor markers without rotating the room's client id | 23.9 → 1.1 KB per 1,000 keystrokes; 33.6 → 10.6 KB per 1,000 cell commits | must keep the marker in the same transaction as the edit, which is why it is written there |
| G. Pending effects without `before` (the indexed baseline already has it by id) | -42% book-30p, -29% deck-50, -20% cells-10k (100 edits) | readers of effects must join the baseline; captions and publish logic read effects |
| H. Candidate peak: do not charge the captured state copy, or charge max(current, candidate) instead of the sum | removes 1 state from the peak (cells-100k: -27.4 MB of 172.3 MB) | policy change; a failed candidate still needs cleanup |

## 9. Recommendation

1. Fix XLSX first. At 49-87x, opening one 100k-cell workbook for editing uses 71% of the
   Free quota, and its refresh cannot fit in 100 MB at all. The decided baseline change
   (B) helps but is not enough on its own: the estimate for the 100k workbook is still
   about 50 MB at first open and 130 MB at the refresh peak, because the 27 MB state
   stays. Option A covers the state as well and has the largest measured effect (XLSX
   -93%, text DOCX -72%), with one mechanism for every format. Its touch points: the
   collaboration service compresses and decompresses, Go's `validSourceBaseline` parses
   the baseline, and the browser's view path receives `state`. If quota should keep
   counting uncompressed bytes, the alternative is a smaller XLSX state in the fork (the
   per-cell payload and long map key are about 270 B per cell); that was not measured.
2. Add D (DOCX images out of state) to the seed-changing batch that already carries E and
   B, so one epoch bump covers all three (see section 1.3 of the handoff review). D is
   the only one of the three not yet decided.
3. Decide the peak policy (H) explicitly. Today a large file's refresh can be refused for
   quota even though the user's steady usage fits.
4. F is small in bytes (about 2.4 KB per 100 updates) but unbounded between publications,
   and the same tracker runs in material rooms. Fix it when the contributor code is next
   touched.

## 10. Open questions for the developer

1. Should quota count logical bytes (`octet_length`, today) or stored and compressed bytes?
   Option A depends on this.
2. Is charging the full refresh peak intended? With the current sum, refreshing cells-50k
   needs 87.6 MB (88% of Free, so almost any other stored file blocks it), and cells-100k
   needs 172.3 MB, which Free can never admit.
3. Should an agent's `inspect` of a never-opened Office source seed and charge it, as it
   does now?
4. Is the DOCX state growth after the first publication (+14% for the books, up to +31%)
   acceptable, or should the exporter avoid writing resolved formatting as direct run
   formatting?
5. For the raw-XML fix: keep `chartJson`, `shapeJson` and the OLE preview data URL next to
   the XML, or replace them?

## 11. Method

- Files. Existing: `e2e/fixtures/files/basic/{lesson.docx, grades.xlsx, lesson.pptx}`,
  `vendor/betteroffice/poc/fixtures/feature-rich.{docx,xlsx,pptx}` and
  `bench/parsers/fixtures/docs/jp_llm2.pptx`. Generated by `storage/gen_files.py` (zipfile,
  hand-written OOXML, Pillow): book-30p/book-300p.docx (15k and 145k words, headings, 30%
  of paragraphs with a bold or italic phrase, a few bullet lists, a Word-like `styles.xml`
  with 376 latent styles, Office theme); images-10.docx (6 JPEG + 4 PNG, 4.17 MB);
  opaque-objects.docx; cells-{1k,10k,50k,100k}.xlsx (10 columns: ids, dates, 8 regions, 50
  products, integers, prices, a formula column `E*F` with cached values = 10% formulas,
  percents, ratings, short notes; 5 cell styles); deck-50.pptx (50 title-and-content
  slides with 6-8 bullets, python-pptx template).
- Scripts in `storage/`: `seed_probe.mjs` (first open), `edit_probe.mjs` (growth,
  candidate, publication, rebase), `analyze_state.mjs` (composition), `image_probe.mjs`,
  `opaque_probe.mjs`, `roundtrip.mjs`, `rebase_probe.mjs`, `compress_probe.mjs`,
  `options_probe.mjs`, `decided_baseline.mjs`, `jsonb_ratio.mjs`, `scan_ooxml.py`,
  `tables.mjs`, `fill_report.mjs`. Raw records are
  in `storage/runs/*.jsonl` and `storage/seed_*.jsonl`, exports in `storage/exports/`.
- Accounting replicated: `encodeBaseline` JSON length for baselines, raw state length,
  jsonb text for effects (`lib.mjs: jsonbText`), the candidate and publication formulas
  from the Go code, and the contributor-marker logic from `contributors.ts` (copied, not
  imported).
- Machine: Windows 11, Node 22.19.0, 16 cores. Times are single runs on this machine.

## 12. Caveats

- The generated files are synthetic. Real Word files carry rsids, proofing marks and many
  more runs per paragraph, which would raise `_originalRunBoundaries` and format markers.
  Real workbooks have more styles and fewer unique strings. Media sizes are realistic but
  noise-based.
- Browser typing and cell commits are emulated with Yjs on the room's own data model. They
  match the engine's structure (checked above), but the real editors may add format
  markers or send several updates per keystroke (IME, selection). If they send more
  updates, the marker cost rises proportionally.
- One update per keystroke is assumed. The Office host applies each iframe update to the
  provider's doc as it arrives (`useOfficeRuntime.ts:303-311,361-365`), and Hocuspocus
  applies each message in its own transaction with `local=false`, which triggers the
  rotation (`yjs.mjs:3342-3345`).
- Postgres was not used. jsonb text length is computed from PostgreSQL's documented
  output format (`", "` and `": "` separators, the same string escaping as
  `JSON.stringify`). The effects contain no numbers, so numeric formatting cannot differ.
- Saves and baselines are CPU-heavy on large workbooks: `officeBaseline` took 1.2-1.7 s at
  10k cells, 25 s at 50k and 76 s at 100k, and every checkpoint save runs it in the one
  shared Office worker. This is outside storage, but it bounds how often large XLSX
  checkpoints can commit.
- One 10,000-commit run failed once inside the engine ("attempted to take ownership of
  Rust value while it was borrowed", which hides the first error) while another large job
  shared the machine with about 2.7 GB free. It passed on rerun, and a fresh WASM instance
  opened the same state. This looks like memory pressure in the probe, but the masking of
  the first error in `office-checkpoint.ts`'s `catch` path is real.
- Seed sizes vary by about 1% between runs (random engine client id), so the first-open
  numbers in section 1 and the step-0 rows of the edit runs can differ slightly.
- The per-100-edit numbers for distinct targets depend on paragraph length, because
  effects store whole paragraphs. The book files use 60-160-word paragraphs.
