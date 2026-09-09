# OpenDataLoader accuracy follow-up

Four inexpensive native repairs improve the known failures without an OCR or
Qwen call. Their gains survive a combined replay of all eight intact documents,
254 pages. The strongest result is font repair: the Chinese paper's table goes
from eight readable numeric cells to all 64, while preserving identical rendered
pixels on all 16 pages. Production parsing and model settings remain unchanged.

These are targeted improvements on the existing corpus. They do not establish
general accuracy equal to MinerU. No new MinerU run or end-to-end ingest timing
was performed; the comparison to MinerU's remaining strengths uses today's
earlier source reviews.

## What improved

| Strategy | Source and final-chunk result | Measured added work |
| --- | --- | --- |
| [Repair a contradictory font map](2026-09-09-odl-font-recovery-experiment.md) | Chinese table 8/64 to 64/64 exact values; all 17 checked prose identifiers restored; every numeric row in one production chunk | Audit 254 pages in 0.430 s; rebuilding the one map takes 0.117 s. Fresh Java extraction is 2.171 s original and 2.181 s repaired for the 16-page paper |
| [Repair column continuations](2026-09-09-odl-reading-order-experiment.md) | Both German continuation checks go from wrong order to correct order within individual chunks, with original page/region citations retained | 0.1359 s median transformation time over 254 pages on the VM |
| [Preserve native table context](2026-09-09-odl-native-tables-experiment.md) | All 48 Japanese rows retain eight headers, the 2025 title and person unit; eight complete source-checked rows pass | 0.3945 s added copying/adaptation/chunking over eight intact documents locally |
| [Retain source cell colors](2026-09-09-odl-source-styles-experiment.md) | All 15 yellow French cells recovered, all 49 signed values unchanged, complete table and significance caption in one chunk | 1.2144 s total source inspection over 254 pages on the VM; 0.1607 s median for the French document |

Timing scopes differ. The table is not additive and does not report a combined
pipeline time. Java timings are individual fresh-process observations. Reading
order uses three repeats; table packing reports the sum of per-document medians
on Windows. Color inspection uses one full-corpus observation plus three French
observations. Captioning, embedding, indexing, queueing and retrieval are excluded.

## Why the font result matters

The Chinese PDF assigns a Chinese Unicode map to one Latin Type1 font. The
Latin font's embedded glyph names provide an independent, exact source for a
repair. The map is shared with a real Chinese font, so changing the shared object
would corrupt valid Chinese text. The candidate attaches a new map only to the
contradictory Latin font. A second, smaller arm simply removes that font's bad
map; it recovers the same table values but retains presentation ligatures.

All 254 pages were audited and only that one font qualified. The seven other
documents were untouched by font repair. This avoids OCR for this specific
failure and restores surrounding prose that the earlier MinerU run also left
corrupted. It is one positive document, not a general detector of broken fonts.

## Strategies rejected or bounded

- Demoting the German vertical sidebar heading did not fix chunk continuity.
  Keeping its heading level and splitting the right-column sentence prefix did.
  Intact parsing calls one left-tail block a list rather than text; the final
  experiment tests both representations and preserves their original boxes.
- Strict structured packing fails on a malformed native Chinese table. The
  selected explicit bounded arm applies structure only to well-formed tables
  with explicit headers. Other native tables retain ordinary packing, with the
  reason recorded. Both strict failures remain in the results.
- PyMuPDF line-based table extraction finds no table on the Hong Kong and
  Attention transfer pages. Text-based extraction mixes tables with page prose.
  Those candidate grids were rejected rather than substituted for native output.
- Color matching initially inspected every table cell. Skipping pages without
  yellow drawing fills reduced full-corpus inspection from 4.5114 to 1.2144 s,
  with identical accepted annotations and chunks.

## Combined output

[replay_odl_accuracy.py](../scripts/replay_odl_accuracy.py) composes the final
reading-order output, rebuilt-font Chinese output and source-style French output,
then runs bounded native table packing. It verifies that every input uses the
same baseline, rejects overlapping edits and records exact input/output hashes.
The fresh Chinese baseline is byte-identical to the retained corpus baseline.

All eight documents complete. Chunks increase from 973 to 1,049, about 7.8%.
That is a storage and retrieval-cost consideration, not an accuracy metric.
No embedding or retrieval-cost measurement was run.

The final replay retains the four specific gains:

- Chinese chunk 39 contains every source row and all 64 numeric values.
- Japanese chunks 27 through 30 preserve all 48 rows with complete headers,
  title and unit, and cite source page 11.
- French chunk 24 retains all 49 values, 15 color annotations and the original
  explanation of statistical significance.
- German chunks 5 and 116 contain the two column-turn continuations and cite
  source pages 3 and 23. The latter keeps the three original source regions.

Indices are zero based and refer only to this saved combined replay. The final
source-scored VM outputs produce exactly the same eight combined chunk files as
the independently reviewed first composition.

## What still separates this from complete parsing

Chinese numeric recovery still leaves nested mBART/mT5/BERTScore headers and bold
maxima flattened. Attention Table 2 still loses exponent notation and merged
training-cost scope. Hong Kong paragraph-only tables still split years, units
and values. NIST's damaged existing OCR, equations and graphs remain unresolved.
German continuations retain some unrelated ancestor headings. Diagrams and
photographs still need visual interpretation, and neither source color retention
nor exact numeric checks validate Qwen's descriptions.

I would carry these native repairs into the next candidate evaluation, then test
source/OCR disagreement and selective recovery of the remaining table/formula
regions. A new independent corrupt-font document and complete unseen table
judgments are needed before widening these heuristics. The existing 219-page
caption plan was not rerun, so this experiment does not claim a measured decrease
in caption requests or end-to-end latency.

## Evidence and checks

The four linked reports retain source hashes, frozen checks, rejected variants,
exact runtime identities, timings and reproduction commands. Raw public-source
PDFs remain in ignored benchmark artifacts. The aggregate directory is
`bench/parsers/reports/local/2026-09-09-odl-accuracy/`:

- `combined-final/manifest.json` binds all eight chosen inputs and output hashes.
- `combined-final/verification.json` records the source-based combined checks.
- `review/independent-review.md` records the Astra-high independent review.
- `source-snapshot/` preserves the final runners, check fixture and dependencies.
- `evidence-manifest.json` inventories the retained local evidence by SHA-256.

The independent reviewer reproduced native table, font, color and reading-order
outputs, checked source pixels and verified the combined gains. No actionable
correctness finding remained. Focused executable checks and isolated Ruff checks
pass; `pnpm run fmt:py` also passes. The benchmark code does not change the
production parser, chunker or deployment configuration. No provider credentials
or provider calls were used. All experiment containers have exited, and their
VM artifact directories remain available for reproduction.
