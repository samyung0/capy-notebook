# OpenDataLoader font recovery experiment

The Chinese feedback paper does not need OCR to recover its broken Latin text.
One embedded font has the wrong PDF `ToUnicode` map. Repairing only that font
restores all 64 source table values, the surrounding model comparisons and the
human evaluation accuracies. The original extraction retained only eight table
values. Both tested repairs preserve identical rendered pixels on all 16 pages.
Production remains unchanged.

## Source evidence and scope

The source is the intact 16-page
[ACL CCL feedback paper](https://aclanthology.org/2024.ccl-1.10.pdf), SHA-256
`6a67443bc89ae7d493464d1d2610f100b192745b6428909e8fc1fc889504b1a1`.
Source pages below are one based, so PDF page 8 is printed page 141.

Font object 150, `ZCFYFI+CMR10`, is an embedded Type1 Latin font. Its cleartext
font program explicitly maps byte 65 to glyph `/A`, 66 to `/B`, and so on.
However, its `ToUnicode` points to object 153, whose single range maps all
256 byte codes to U+7500 through U+75FF. The Chinese font
`GANJYC+gbsnu75` also references object 153, correctly for that font. This explains
why letters and decimal digits became plausible CJK characters, escaping the
existing missing-text and replacement-character heuristics.

The pilot detects this narrow contradiction. It requires a literal embedded
Type1 encoding array, no overriding PDF encoding, at least eight explicitly
named Latin letters, and a whole-byte CJK Unicode map. Unsupported fonts do not
qualify. It does not infer a repair from font names, document language or a
dictionary of plausible words.

All eight original PDFs from the
[new-document corpus](2026-09-09-java-new-documents.md) were audited, 254 pages in
total. Only CCL font 150 qualified. The other 115 CCL fonts were left alone,
including the correct bold font that supplies the eight readable cells.
The seven other documents, 238 pages, also stayed unchanged. These include
English, French, German, Spanish, Japanese, Traditional Chinese and the damaged
historical NIST OCR layer. This is one real positive document and a small set of
negative controls, not a general font-corruption accuracy estimate.

The existing source-frozen
[CCL checks](../fixtures/beijing-ocr-new-documents.json) supplied the exact
64-value table, row names, grouping requirements and page 3/page 8 prose checks.
Their bytes and hash were copied before candidate runs. Source page PNGs were
retained; pages 2, 3, 8 and 10 received visual review. Pages 2 and 10 are additional
qualitative checks, not additional frozen numerical test cases.

## Two tested repairs

| Arm | PDF change | Java extraction | PDF rewrite |
| --- | --- | ---: | ---: |
| Original baseline | None | 2.171 s | None |
| Drop contradictory cmap | Remove `ToUnicode` from font 150, allowing embedded glyph decoding | 2.177 s | 0.008 s |
| Rebuild contradictory cmap | Attach a new map derived from font 150's embedded glyph names | 2.181 s | 0.117 s |

The audit took 0.165 seconds for the CCL document and 0.430 seconds across all
eight PDFs. Audit time includes constructing the proposed replacement map for
the detected font. All numbers are individual runs; millisecond differences
between Java arms should not be treated as a performance ranking.

These were fresh matched runs in `capy-java-native:20260909` on
`159.195.61.195`, limited to eight CPUs and 14 GiB memory. Java uses one thread,
OpenDataLoader 2.5.7, cluster tables, included headers/footers and HTML Markdown.
The original corpus was mounted read only and the container had no network.
Neither OCR nor Qwen was called. PyMuPDF 1.28.2 and the already installed pypdf
6.18.0 supplied PDF access and Adobe glyph-name mappings.

The rebuilt map uses a new PDF object. It never edits the shared original map,
so the Chinese font keeps its correct mapping. Unknown glyph names fail the
rebuild explicitly. Both candidates were reopened and all 16 pages were rendered
at 144 dpi. Every page had exactly equal dimensions and SHA-256 of pixel bytes
before and after repair.

## Source and final chunk results

| Check | Original | Both repairs |
| --- | --- | --- |
| Page 8 table numeric cells | Eight readable correct values | All 64 match the frozen values in exact row order |
| Original eight bold-font numeric values | Correct | Same values retained; 56 additional cells recovered |
| Page 3 prose identifiers in overlapping final chunks | 0 of 9 | 9 of 9, including `INLG2022`, `GPT-Neo`, `BERT`, `RoBERTa`, `ICNALE`, `EXPECT` |
| Page 8 model/metric/accuracy identifiers in overlapping final chunks | 0 of 8 | 8 of 8, including `GPT3.5-Turbo`, `GPT4-Turbo`, `mBART`, `mT5`, `62.84`, `59.27` |
| Full-document production chunks | 113 | 78 |
| Entire page 8 numeric table in one production chunk | Absent | Chunk 39 contains all 64 cells, every row name, header words and table caption |

Chunk indices are zero based and come from the fresh full-document extraction,
not the older five-page screening PDFs. The production chunker was replayed
without modifications, and its source hash is recorded in `score.json`.
The fresh original `content_list.json` also matches the retained
`full-odl-java-headers-full-r1/ccl-feedback/content_list.json` byte for byte:
322 blocks and SHA-256
`f403391e3f618d8b620b288f1978d0d577eb05390439e05795d68fe2c46321e8`.
`retained-baseline-comparison.json` records that check without path normalization.
Each of the eight source row names followed by its complete eight-value sequence
is present in chunk 39. The last four rows also recur through normal overlap in
chunk 40. Page 8 prose in chunks 38 through 41 now supports the separate mBART
Edit+EV and mT5 GTs comparisons, plus the 62.84/59.27 human-accuracy statement.

This remains a flattened table. OpenDataLoader still emits paragraphs rather
than a table object. The chunk contains the words `mBART`, `mT5`, `BERTScore`,
`P`, `R` and `F1`, but does not express the nested column spans or mark the bold
maxima. Numeric recovery is complete for this table; semantic table recovery
is incomplete. Presence checks do not certify complete prose or diagram fidelity.

The rebuilt arm also turns the font's `fi` and `ff` presentation ligatures into
ordinary letters. Examples include `modification`, `offering`, `qualifiers` and
`cutoff`. Dropping the map leaves those ligatures as Unicode presentation glyphs.
Both arms have 78 chunks, but six chunk texts differ. One reference-page chunk's
overlap and citation-region list also differ because the expanded characters
change the token estimate. This is not exact chunk identity between strategies.

Visual review found the intended prose recovery on pages 2 and 10: the English
abstract, model identifiers, citations, `Transformer`, `Seq2Seq`, and the literal
English examples are readable again. The native extraction still has repeated
Chinese heading glyphs, watermark fragments and an extra extracted equals sign
near the page 10 phrase about identical prompts. Font repair does not establish
that every extracted glyph is useful visible body text. Page 3's dialogue remains
interleaved across panels, and its strikethrough meaning is still lost.

The earlier [MinerU source review](2026-09-09-beijing-ocr.md) recovered this table's
64 numbers but retained corrupted surrounding prose. This experiment closes the
native text-mapping gap without an OCR pass. It does not establish equal overall
quality to MinerU, and no new MinerU timing or accuracy run was performed here.

## What this supports next

Use font evidence before OCR for this identifiable class of malformed PDF.
The explicit rebuild is the stronger follow-up candidate because every changed
mapping has recorded glyph evidence and ligatures become ordinary searchable
letters. Removing the contradictory map is the smaller implementation and gave
the same table and prose gains here.

Keep the gate narrow until a genuinely independent corrupt-font document is
tested. The current method deliberately leaves NIST's damaged OCR layer alone:
that document has no qualifying contradictory font map, so embedded-font repair
does not solve its recognition errors. Geometric/OCR disagreement remains a
separate follow-up for damaged existing OCR and unsupported font encodings.

## Reproduction and artifacts

Runner: [experiment_odl_font_recovery.py](../scripts/experiment_odl_font_recovery.py).
It exposes `prepare`, `run`, `score` and `check`. `prepare` requires a fresh output
directory and freezes source checks; `run` writes separate candidate PDFs and
Java results; `score` uses current production chunking locally.

```sh
python experiment_odl_font_recovery.py prepare --root /data --output /output/r1 --checks /checks.json
python experiment_odl_font_recovery.py run --root /data --output /output/r1
uv run python -X utf8 bench/parsers/scripts/experiment_odl_font_recovery.py score --output bench/parsers/reports/local/2026-09-09-odl-font-recovery/r1
uv run python bench/parsers/scripts/experiment_odl_font_recovery.py check
uv run --with ruff ruff check --isolated bench/parsers/scripts/experiment_odl_font_recovery.py
```

The first two commands run in the pinned Java image with `/data/scripts` on
`PYTHONPATH`, the old corpus mounted at `/data:ro` and a fresh writable `/output`.
The focused contradiction checks and isolated Ruff check passed. No existing
benchmark or production file was edited by this experiment.

VM artifacts are under `/opt/capy-odl-font-recovery-20260909/r1`. A complete
archive and extracted copy are local under
`bench/parsers/reports/local/2026-09-09-odl-font-recovery/`. They include the
frozen run manifest, all eight font audits, embedded encoding/cmap evidence,
source renders, both repaired PDFs, raw Java JSON/Markdown/logs, pixel hashes,
production chunks, page excerpts and the ordered-cell score. The executed
preparation/run snapshot and the later scoring-script hash are retained
separately. Benchmark containers exited and were automatically removed.

## Additional 430-page negative controls

A source-only review plan was frozen before the fresh 22-document regression
candidate was inspected. All 362 document-local font records remain unselected:
350 are outside the explicit embedded Type1 encoding gate, and 12 were inspected
without the qualifying CJK contradiction. This is abstention evidence, not a
claim that unsupported fonts are correctly encoded.

Every candidate font audit matches the frozen source audit. All original,
parsed-PDF and Java source hashes agree, no repaired PDF exists, and the
executed script matches the frozen local script. Thus there is no rewritten
source page requiring a before/after pixel check and no font-induced change to
final content or citation geometry. The actual font audit phase totals 0.309
seconds across the 430-page VM run. No algorithm was changed.

The source inventories and final content/chunk hash receipts are under
`reports/local/2026-09-09-odl-third-regression/font-exponent-review/`. This adds
negative controls without another positive font-repair transfer result.
