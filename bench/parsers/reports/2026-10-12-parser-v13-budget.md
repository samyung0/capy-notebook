# Parser budget, parser v13, and how heavy models would be

Date: 2026-10-12. Follows [v12 against MinerU](2026-10-12-v12-vs-mineru-unseen-books.md).

## Summary

- **Budget gate.** `scripts/budget.py` runs 13 fixtures that stay inside the
  upload limits. CI runs them in the `Parser budget` workflow: on pushes that
  touch the parser, on dispatch, and before every production release from
  Deploy ingest, which is how the parser ships. Absolute budgets are unset until three
  CI runs exist and a developer signs off; until then the job checks invariants
  only (README, "Parser budget").
- **Parser v13 adds three native repairs:**
  - Symbol-font `ToUnicode` remapping;
  - calculation lines are no longer headings;
  - vector-figure blocks.

  v13's total time is within noise of v12 (−2% over the non-scan fixtures).
  The measurable costs are +0.6 s in the font phase on a Word-made Symbol book
  and about 7 ms per page for vector figures.
- **Quality on the blind sample pages v13 changes (19 of 72):**

  | Measure | v12 → v13 |
  | --- | --- |
  | Waterworks formulas | 0.50 → 0.64 (good 6 → 31) |
  | Waterworks false headings | 4 → 0 |
  | Instrumentation vector figures | 0.0 → 0.5 |

  The other four sampled books are unchanged. The remaining gaps to MinerU
  are fraction and root structure, and diagram labels that stay in the body
  text.
- **Formula recognition is heavy on CPU**, 0.15–3.4 s per formula. The only
  candidate that fits next to the parser is PP-FormulaNet+ S, the RapidAI ONNX
  build: 233 MB, 0.85 GB peak, 0.15–0.26 s per crop, about 2 s per page on the
  densest book.
- **A pixel layout model on every page does not fit.** The fastest licence-clean
  detector costs 62–104 ms per page and gets our classes wrong. A classifier
  over native PDF primitives costs about 30 ms per page unoptimised and matches
  the vision teacher once its training books cover a style. The proposed next
  step is that fitted native role model (section 5).

## Heading depth (added to v13 after the timing passes)

A subagent traced the `text_level` values up to 68 (Lessons in Industrial
Instrumentation) and 49 (Waterworks). These are ODL style ranks that `relevel`
never touches outside outline contradictions. Two rules are in v13:

- **`depth_levels`** renumbers each heading to its depth in the chunker's stack.
  - Maximum level falls from 68 to 6 and from 49 to 7.
  - No section path changes on Waterworks, Legal or Marine.
  - It costs 14 ms over 44,110 blocks.
- **Label-only bookmarks** ("UNIT 3") now match.
  - 289 of 373 Waterworks chunks lose a wrong "UNIT 2: GEOMETRIC SHAPES ›"
    ancestor.
  - Controls are unchanged.

**Also in v13, signed off 2026-10-12:**

- **Short wide-band running heads.** Groups covering fewer than five pages now
  count as banners when they share the line of a group that passes. Lessons'
  "viii CONTENTS" front matter becomes furniture, and 63 front-matter chunks
  lose "Contents › viii CONTENTS". On 9 other books (the budget books and three
  sample books) no chunk changes. This extends the v10 rule that a group must
  cover five pages and a tenth of the book.
- **Figure labels.** A vector figure's labels move from body text into
  `figure_labels`, which the chunker indexes on the figure's `[Figure]` line.
  - Chunk counts barely move (textbook 1,547 → 1,549).
  - About 19% of the chunks change in the instrumentation book and 8.5% in the
    textbook, because the labels leave the prose.
  - A query on a label still finds the same chunk.
  - Text containing `=` beside a figure is no longer taken as a label, which
    fixes the p40 formula.

## 1. Fixtures

| Id | Pages | Size | What it exercises |
| --- | ---: | ---: | --- |
| paper-2col | 19 | 0.6 MB | two-column paper, tables, equations |
| mixed-scan | 42 | 0.6 MB | slide PDF with 2 scanned pages |
| newspaper-scan | 2 | 0.5 MB | multi-column scan |
| legal-prose | 277 | 1.6 MB | deep headings, boxed examples |
| vector-drawings | 104 | 1.9 MB | technical drawings, 14 image-only pages |
| math-worked | 384 | 10.0 MiB | Word worked calculations, Symbol font, at the free cap |
| textbook-26mib | 610 | 25.7 MiB | figure-heavy textbook near the Pro cap |
| logic-1016p | 1,016 | 3.9 MB | LaTeX notation, 18 text-less pages |
| limit-1400p | 1,400 | 13.1 MiB | exactly the page cap (generated: logic + waterworks) |
| scan-120p | 120 | 10.9 MiB | image-only pages, the OCR stage (generated) |
| docx-handbook | 52 | 41 KB | DOCX via LibreOffice |
| xlsx-gradebook | 705 | 1.3 MB | 224k cells via LibreOffice |
| pptx-84-slides | 84 | 23 MiB | Japanese deck, 69 pictures |

Upload limits: at most 1,400 pages, 500 text-less pages and 30 MiB, so a
3,000-page book cannot reach the parser. With the deployed 1 GB heap, Java
fails on a 3,311-page book; within the cap it is fine, as the v11 stress report
found.

## 2. v12 against v13, in-process on the M1

Four passes on one machine, run alternately (v12, v13, v12, v13). Execution
seconds are the mean of the passes that completed.

| Fixture | v12 s | v13 s | Δ | Peak GiB v12 / v13 |
| --- | ---: | ---: | ---: | --- |
| paper-2col | 2.9 | 2.6 | −10% | 0.36 / 0.37 |
| mixed-scan | 12.9 | 13.7 | +6% | 1.06 / 1.02 |
| newspaper-scan | 13.0 | 13.5 | +3% | 1.12 / 1.06 |
| legal-prose | 17.0 | 17.5 | +3% | 0.96 / 0.89 |
| vector-drawings | 32.7 | 29.3 | −10% | 1.10 / 0.97 |
| math-worked | 15.9 | 17.4 | +10% | 0.73 / 0.59 |
| textbook-26mib | 204.8 | 222.4 | +9% | 1.05 / 0.96 |
| logic-1016p | 72.1 | 75.4 | +5% | 1.05 / 1.06 |
| limit-1400p | 128.7 | 95.7 | −26% | 1.31 / 1.20 |
| scan-120p | 561.4 | 454.2 | −19% | 1.21 / 1.30 |
| docx-handbook | 9.1 | 8.7 | −5% | 0.41 / 0.47 |
| xlsx-gradebook | 25.3 | 26.4 | +4% | 0.70 / 0.92 |
| pptx-84-slides | 28.5 | 29.0 | +2% | 0.67 / 0.65 |

How to read this table:
- Repeated passes of the same revision differ by 15–50%: v12's
  vector-drawings took 25.9 s and then 39.6 s, and scan-120p 685 s and then 438 s.
  That noise comes from other jobs on an 8 GB laptop. It is why CI runs the gate
  and why budgets come from CI.
- The phase timings isolate the new stages:
  - the font phase on math-worked grows from 0.45 to 1.1 s (the whole PDF is
    rewritten once a font is repaired);
  - `add_vector_figures` costs 4.4 s over the textbook's 610 pages (143 figures);
  - every other phase is unchanged.
- v12 crashed with SIGABRT in the OCR stage twice, once on limit-1400p and
  once on logic-1016p. Both happened while two other benchmarks were filling
  memory (10 GB swap). The crash did not recur in three clean standalone runs.
  The CI gate fails on any crash.

## 3. Quality: v12 against v13 on the pages v13 changes

This is the same blind rubric as the MinerU review, with A and B shuffled per
page. v13 changes 19 of the 72 sample pages, all in two books.

| Book, element | v12 | v13 |
| --- | --- | --- |
| Waterworks formulas (106) | 0.50: 6 good / 95 partial / 5 bad | 0.64: 31 good / 74 partial / 1 bad |
| Waterworks false headings | 4 | 0 |
| Waterworks section paths (12 pages) | bad 12 | bad 12 |
| Instrumentation figures (8) | 0.0: 8 bad | 0.5: 8 partial |
| Instrumentation formulas, section paths, text | 0.64 / 1.0 / 0.93 | same |

What the reviewers saw:
- **Section paths in Waterworks stay wrong.** ODL never marks the
  "Practice Problems 2.2–3.2" headings, so v13's chunks stay under a stale
  "Practice Problems 1.1b". The cause is a missed heading, not the calculation
  rule.
- **Figures grade partial** because their labels also stay in the body text as
  `figure-label` blocks. The team decided earlier to keep labels searchable.
  Moving them into the figure's own text would grade good.
- **A new flaw:** one display formula next to a diagram on p40 was absorbed as a
  label.

Projected on all 72 pages, formulas go from about 0.51 to 0.60 (MinerU 0.79)
and figures from 0.48 to about 0.61 (MinerU 0.92).

## 4. Formula recognition cost

Measured on the M1 with 4 CPU threads, using 216 real crops cut at MinerU's
formula boxes. The machine was heavily contended, so these are upper bounds.

| Model | Disk | Peak RSS | CPU ms per crop, inline / display (median) | Waterworks s/page |
| --- | ---: | ---: | --- | ---: |
| UniMERNet small (MinerU 3.4.5 default) | 776 MB | 1.89 GB | 1,760 / 3,445 | 23.3 |
| PP-FormulaNet+ M, torch | 591 MB | 1.50 GB | 1,157 / 1,474 | 10.4 |
| PP-FormulaNet+ M, ONNX (RapidAI) | 594 MB | 1.56 GB | 792 / 922 | 11.0 |
| PP-FormulaNet+ S, ONNX (RapidAI) | 233 MB | 0.85 GB | 153 / 261 | 2.3 |

Notes:
- The model's digits agreed with the native text layer on 82% of the
  waterworks formulas for UniMERNet and plus-M, and on 62% for plus-S.
- The rejected outputs were real misreads: `$36.27` → `536.27`, `1 SG` →
  `1.5G`.
- The guard must also compare `,` and `.`: `25,120` read as `25.120` passes a
  digits-only check.
- Batching hurts on CPU, because one long formula holds up its whole batch.
- MinerU has no separate formula detector. Its layout model, PP-DocLayoutV2,
  costs about 0.85 s per page on every page.

## 5. A layout model fitted to our documents

**Pixel detectors.** 13 detectors were run on the 72 pages, on CPU with 4
threads:

| Detector | Licence | ms/page | Fit to our classes |
| --- | --- | ---: | --- |
| PP-DocLayout-S | Apache-2.0 | 62–104 | calls code `image`, running headers titles |
| PP-DocLayout-M | Apache-2.0 | 273 | |
| PP-DocLayoutV3 (shipped) | Apache-2.0 | 1,426 | |
| Docling egret-medium | Apache-2.0 | 749 | best: page_header, code, caption, list_item |

Excluded on licence: the YOLO family and DocLayout-YOLO (AGPL-3.0) and Surya
(non-commercial).

All vision models box vector diagrams and calculation lines correctly. Run-in
italic headings are boxed by none.

**Native role model.** A prototype gives each text line 40 features:
geometry; size relative to body text; bold, italic, mono and math-font share;
glyph classes (digits, operators, private use, Greek); numbering; gaps;
repetition across pages; overlap with drawings. A LightGBM model is trained on
PP-DocLayoutV3 labels from 240 pages of the six books. It costs about 30 ms
per page (7 ms extraction, 17 ms Python features, 6 ms model), and about
10 ms is expected once vectorised.

| F1 against the teacher | Heading | Formula | Furniture | Text |
| --- | ---: | ---: | ---: | ---: |
| Pages split, books seen in training | 0.85 | 0.95 | 0.96 | 0.95 |
| Leave one book out | 0.66 | 0.27 | 0.64 | 0.80 |

Formula and figure collapse when a book is held out because each class comes
almost entirely from one book in this six-book sample. The limit is how many
books the labels cover, not what the model can learn.

**Labels cost little:**
- PDF outlines exist on all six local books, and their titles appear on the
  target page in 85–100% of samples.
- Word and InDesign books carry tag trees.
- PP-DocLayoutV3 and Egret can label offline as teachers: about 2 CPU-seconds
  per page, so 4,000 pages take about 2.5 CPU-hours.
- DocLayNet (CDLA-Permissive) has human labels with its PDF text cells.

Training the native model needs no GPU. A pixel detector cannot be fine-tuned
on the M1: MPS crashes and CPU takes about 3 s per image. A rented A10 or L4
costs about US$5–20 per run.

**Recommendation:**
1. Replace the hand-written role rules with a native line/region role model:
   heading and level, body, list, caption, footnote, code, furniture, display
   formula and figure region. Train it on teacher labels agreed by both models,
   outline headings and DocLayNet text cells. Keep the drawing-cluster figures.
2. Keep a fitted PP-DocLayout-S for scans and for pages the native model is
   unsure of.

**First experiment:**
- 40 library books, stratified by producer (Prince, LaTeX, Word, InDesign),
  50 pages each.
- Evaluate leave-book-out on 8 held-out books and on the six review books.

Success means:
- heading F1 ≥ 0.80 (v12 scored 0.47 in the blind review);
- display-formula-line F1 ≥ 0.85;
- furniture F1 ≥ 0.90, with no running header promoted;
- vector-figure recall ≥ 0.8;
- under 20 ms per page at p90.

**What it cannot fix:**
- scans;
- formula structure (fractions, roots, matrices);
- table cell structure;
- heading levels in a book with inconsistent styling and no outline.

## Reproduction

- **Budget:** `scripts/budget.py`, fixtures in `fixtures/budget/`. The local
  passes are in the scratch directories `bud-v12-{a,b}` and `bud-v13-{a,b}`;
  v12 ran from a worktree of `6cafe6a0`.
- **Review:** `reports/local/2026-10-12-mineru-v12/`: `v13/` (whole-book v13
  parses), `packets13/`, `blind_key13.json`, `review13/`. The packet builder is
  `packets13.py` in that directory.
- **Formula and layout probes:** run by subagents in the session scratch
  directory; not kept in the repo.
