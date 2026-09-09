# Beijing Qwen3.5-OCR evaluation

The user paused Beijing endpoint testing pending regional business validation
after the first three requests were blocked by workspace entitlement. Both Qwen3.5-OCR
routes and the Qwen3.8-Flash comparison returned HTTP 403 with
`AccessDenied.Unpurchased`. No model output was produced. This does not establish
OCR accuracy, caption quality, generation latency, or model cost. The remaining
requests are paused by the user. No further regional calls were made.

This is an isolated local parser experiment. It does not change production or
use the ingest VM. The OCR work has a separate 80-request ceiling and concurrency
at most four. Three requests were spent, with no automatic retries. The temporary
credential was released for the main task to remove, with no process using it.

## Protocol and capability findings

The official model page lists image input, text output, a 65,536-token context,
49,152-token input limit and 16,384-token output limit for Qwen3.5-OCR. It does not
support constrained structured output or context caching. Prompting it to emit
JSON is different from having the API enforce a JSON schema. The advertised
Beijing price is $0.069 per million input tokens and $0.275 per million output
tokens. These are list prices, not a measurement from this run.
[Qwen3.5-OCR model documentation](https://docs.modelstudio.console.alibabacloud.com/en/model-studio/qwen3-5-ocr).

Built-in `ocr_options` tasks are documented through DashScope. Ordinary
OpenAI-compatible chat uses a task prompt instead. The tested built-in request
uses `document_parsing` without a custom prompt and preserves the complete
provider response, including any `ocr_result` data. The docs describe a Responses
API for direct PDF parsing, up to 100 MB and 50 pages with `document_parsing`.
That route has not been tested here and would be a separate experiment from the
matched page-image timing.
[OCR API documentation](https://docs.modelstudio.console.alibabacloud.com/en/model-studio/qwen-vl-ocr).

Qwen3.8-Flash's current Beijing list prices are $0.113 per million input tokens,
$0.382 per million output tokens, and $0.014 per million implicit-cache input
tokens. Its model page lists constrained structured output and caching support.
The comparison uses neither a response schema nor explicit caching.
[Qwen3.8-Flash model documentation](https://docs.modelstudio.console.alibabacloud.com/en/model-studio/qwen3-8-flash).

| Arm | Route | Request distinction |
| --- | --- | --- |
| `ocr-document` | DashScope multimodal generation | `qwen3.5-ocr`, built-in `document_parsing`, no custom prompt, rotation disabled, 3,072 to 8,388,608 pixel bounds |
| `ocr-chat` | OpenAI-compatible chat | `qwen3.5-ocr`, complete transcription plus separate visual descriptions |
| `flash-chat` | OpenAI-compatible chat | Same prompt, `qwen3.8-flash`, `enable_thinking=false` |

All three use the same full-page PNG source and the existing Java benchmark's
JPEG encoder, quality 80, longest edge at most 2,560 pixels, with no upscaling.
All request a 16,384-token ceiling. The built-in arm has different provider-side
task and pixel controls, so it is a capability comparison with matched uploaded
bytes. The two chat arms are the stricter prompt-matched comparison.

## First-attempt receipt

The pilot sent the merged t-test page once per arm at concurrency three.

| Arm | HTTP status | Wall seconds | Model output |
| --- | ---: | ---: | --- |
| `ocr-document` | 403 | 1.330 | None |
| `ocr-chat` | 403 | 1.377 | None |
| `flash-chat` | 403 | 1.185 | None |

These are rejected-request round trips, not inference timings. All three
uploaded the same 2,043 by 2,560 JPEG, with encoded SHA-256
`c0320c8663e6342d1f98bb505bfb04911201d18a240d68ec1b71a390ab776179`.
The errors have no token usage, so billed cost is unavailable rather than a
measured zero. A model appearing in `/models` does not prove that the account
can invoke it. Entitlement rejection also does not validate the full request
body against the model's runtime API.

## Frozen source controls

Before the first pilot, ten known hard full-page controls received 36 source
checks in [beijing-ocr-controls.json](../fixtures/beijing-ocr-controls.json).
They cover the merged t-test table, Japanese grouped headers and significance
marks, Chinese stages and formulas, photosynthesis curves, enzyme observations,
Hong Kong table and scan text, a Japanese GPU cost table and French learning
curves. The checks require complete source fidelity, not just anchor presence.
Previous source-job and PDF hashes are linked in `source-lineage.json`.

Eight pages from five newly sourced documents then received 29 source checks,
with no model outputs read, in
[beijing-ocr-new-documents.json](../fixtures/beijing-ocr-new-documents.json).

| Source | Selected source content |
| --- | --- |
| Attention Is All You Need | Encoder/decoder arrows, residual paths, grouped BLEU/cost table and shared training-cost cells |
| NIST 1948 accelerometer paper | Three equations, damaged scan text, eight amplitude/acceleration panels and two oscillograph traces |
| Chinese cross-language feedback paper | Three-panel feedback diagram, literal markup, grouped 64-value results table and prose |
| Japan migration statistics | National plus all 47 prefectures, eight numeric columns, signed changes and composed formula header |
| Hong Kong in Figures | Four bilingual labour tables, year groups, percentage/count distinctions and footnotes |

A separate four-check
[photograph control](../fixtures/beijing-ocr-photograph.json) covers the NIST
paper's Figure 6 instrument photograph. It tests visible parts, supported mass
relationships, and the distinction between photograph labels and dimensions
described for another figure. This prevents a diagram-only evaluation from
being presented as evidence for photograph captioning.

One intentional source consistency check preserves the Attention paper's
Table 2 value of 41.8 for big-model English-to-French BLEU and its page prose's
41.0. Replacing one with the other would silently alter the supplied page.

For a future successful run, score transcription and visual descriptions
separately, then review every table and meaningful figure against its complete
page. Classify missing content, incorrect values, wrong cell associations,
reversed arrows, missing plot observations and unsupported interpretations.
Mark approximate graph readings as estimates. A keyword score alone cannot
answer whether the recovered page is safe to study from. These purposive
controls and AI source judgments are not human-certified population accuracy.

## Offline Java and RapidOCR source review

The nine new original-page controls were compared against both
`screen-odl-java-headers-screen-r1` and `screen-selective-screen-r1`, including
their current-production `chunks.json` output. On all nine pages, raw blocks
are identical after image-path normalization, and the actual chunks are
identical. The selective stage has not repaired the following losses on these
original PDFs. This comparison does not include Qwen output.

Raw text retention, complete source relationships and actual chunk support
are separate judgments. Block and chunk indices below are zero-based. The
complete source-linked judgments and immutable content/chunk hashes are in
`baseline/source-review.json` and `baseline/pack.json` under the raw artifact
directory. There is no aggregate model score.

| Source page | Raw result | Actual chunks |
| --- | --- | --- |
| Attention architecture, printed p3 | Prose is faithful, including six layers, 512 dimensions and masking. The diagram remains an image with no generated description of arrows, joins or final Linear/Softmax path. | Chunk 5 has only the printed caption and introductory prose. Chunk 6 supports the prose relationships, but not the complete diagram. |
| Attention Table 2, printed p8 | Values are flattened into one paragraph. Superscripts become ordinary digits, such as `10^20` becoming `1020`. Blank cells, grouped headers and the two shared Transformer training-cost cells lose their structure. | Chunk 17 retains the flattened table. Table 41.8 and prose 41.0 correctly survive separately in chunks 17 and 18. |
| NIST equations, printed p361 | Equations 1 and 3 are missing apart from labels. Equation 2 is corrupted to `m—2M cos 7T-`. Useful measurements survive, but columns interleave and split the continuous-calibration sentence. | Chunks 4–7 retain the missing equations and broken reading order. Numeric anchors such as 0.44 inches, 117 c/s and 81 g do not establish formula recovery. |
| NIST graphs, printed p362 | Printed captions preserve the two 31 c/s traces and 5.6 g versus 6.2 g amplitudes. The eight chart panels lose curve observations and mass-series associations. Several labels and units are damaged. | Chunk 8 mixes Figures 3 and 5. Chunk 10 mixes Figure 4 with unrelated prose. No chunk preserves the complete plotted relationships. |
| Chinese feedback diagram, printed p136 | Most dialogue is readable, but panels a and c interleave and crossed-out `to` becomes plain `to`. Latin identifiers, citations and numerals in the prose become CJK garbage. | Chunks 10–14 preserve the same defects. A readable sentence explaining transitive verbs does not preserve all three panel relationships or the paper's references. |
| Chinese results table, printed p141 | Model names, headers, row labels and most numbers have corrupted character mappings. Only eight of 64 numeric cells remain readable. Those are the differently encoded bold cells. | Chunks 25–27 retain disconnected readable numbers among corrupted labels. The surrounding maxima and human-accuracy statements are also damaged. |
| Japan prefecture table, printed p3 | Raw HTML preserves the national row, 47 prefectures, all 384 numeric cells, signed changes and eight column labels. | Chunk 7 has the header. Chunks 8 and 9 contain correct values without repeated column labels. The 2025 table title is elsewhere, and these chunks inherit the preceding Figure 2 section. A Tokyo-row hit alone cannot identify its values or year. |
| Hong Kong labour tables, printed p6 | All four tables' numeric data and bilingual notes survive, but paragraph flattening separates years, rows and change annotations. | Sex-table years are in chunk 3 and values in chunk 4. Age-table chunk 5 and unemployment chunk 6 retain useful mappings. Underemployment counts become part of chunk 8's section path, while their thousand-person unit is in chunk 7. |
| NIST photograph, printed p363 | Prose retains much of the mass-support mechanism, but there is no visual description of the photograph. Release wire G becomes `0`, mass labels are damaged, and the two columns are reordered. | Chunks 11–14 retain the losses. Distance C, component numbers and the screw specification are corrupted; correct standalone distances do not restore the part relationships. |

The recovery selection misses both reviewed Chinese original pages, despite
their diagram and damaged results table. All five selected NIST source pages
are included solely because they contain a captionable image, rather than
being classified as scans. The NIST PDF's existing OCR text therefore makes
text presence a poor proxy for source fidelity. These are observations about
the saved selection and outputs, not changes to production selection policy.

The two controlled Chinese rasters provide a direct RapidOCR comparison
against the same source content without the broken PDF text mapping:

- On printed p136, RapidOCR restores `INLG2022`, `GenChal`, `Nagata`, `GPT-Neo`,
  `BERT`, `T5`, `RoBERTa`, `ICNALE`, `EXPECT`, the citation years and the figure
  number. Chunk 2 gives the complete retrieval/masking/generation explanation.
  It still interleaves panels a and c and loses the strikethrough on `to`.
- On printed p141, all 64 numeric cells match the frozen source values in row
  order. The model, metric and row names are readable again, along with the
  62.84 and 59.27 human-accuracy values. Each cell and header remains a separate
  OCR line, with no grouped table headers or bold-cell meaning. Chunk 5 contains
  the full numeric sequence. Chunk 6 preserves the complete prose explanation
  of mBART Edit+EV and mT5 GTs, so those particular questions can be answered
  without reconstructing the table.

The exact 64-cell comparison is saved in `baseline/ccl-table-numeric-check.json`.
This is useful OCR recovery, but it does not demonstrate table or diagram
reconstruction. The source-review record also corrects one initial rubric typo:
the author on p136 is `Ihori`, not `Thori`. The frozen fixture was kept unchanged,
and RapidOCR's correct `Ihori` is not counted as an error.

## Artifacts and runnable check

Raw artifacts are under
`bench/parsers/reports/local/2026-09-09-beijing-ocr/`. The `pilot/` directory
contains the frozen run manifest, prompt and source hashes, image encoding
hashes, full request options without credentials or base64 payloads, raw errors,
timings, and snapshots of the runner and encoder. The credential is read only
inside the process and is absent from saved requests and reports.

[bench_beijing_ocr.py](../scripts/bench_beijing_ocr.py) reuses the existing
encoder and makes one HTTP request per selected page and arm. The focused
`--check` verifies built-in and chat request shapes, thinking configuration,
and the absence of unsupported response constraints.

```sh
uv run python bench/parsers/scripts/bench_beijing_ocr.py --check
uv run --with ruff ruff check --isolated bench/parsers/scripts/bench_beijing_ocr.py
```

Both checks passed. No source-fidelity or captioning suitability conclusion can
be drawn until successful outputs exist.

## Additional offline comparison: MinerU auto

The saved `screen-mineru-auto-r1` arm was reviewed against the same nine frozen
source judgments. No source, rubric or model request was added. MinerU improves
some tables and scanned prose, but it does not recover diagram or plot meaning;
its automatic use of the original Chinese text still carries the broken font
mapping. Its Japanese table is less faithful than the native result.

| Frozen source | Raw output compared with native/selective | Actual chunk result |
| --- | --- | --- |
| Attention architecture, printed p3 | The figure is a crop with its printed caption. Prose retains six layers, 512 dimensions and masking. No arrow, positional-encoding join or Linear/Softmax description is added. | Chunk 4 has the caption and overview; chunk 5 has encoder/decoder prose. Complete diagram relationships remain absent. |
| Attention Table 2, printed p8 | Rows, blank cells, two header tiers and exponent notation are restored. The shared Transformer costs are incorrectly placed only under EN-DE, leaving EN-FR blank. Bold annotations are incomplete; `RL` becomes `RI` in the ensemble label. | Chunk 12 contains the whole table with exponents, but grouped header spans flatten and the section remains `Why Self-Attention`. Table 41.8 and prose 41.0 correctly remain in chunks 12 and 14. |
| NIST equations, printed p361 | Equation 2 is recovered correctly. Equation 1 recovers its fraction and square but changes `a` to alpha. Equation 3 has the fraction structure but corrupts symbols with bars, hats, tau and an extra star. Column order improves. | Chunk 5 pairs the correct equation 2 with its definitions. Chunks 3 and 6 retain the other equations' defects. This is partial recovery, not three correct equations. |
| NIST plots, printed p362 | Seven chart blocks have empty `content`. Printed captions survive; curves, mass-series associations, axes and 0.01-second trace marks do not. Figure 4's .053-inch value improves, but Figure 3's .030 becomes .630. | Chunk 8 keeps the three captions, without plotted relationships. Chunk 9 improves the portable-calibrator prose and mass labels. |
| Chinese feedback diagram, printed p136 | The image-only figure loses dialogue that native extraction and RapidOCR made searchable. Latin names, models, citations and numbers in prose remain corrupted. Opening prose is merged into the previous page. | Chunks 11–14 retain the corrupted prose and caption. Opening prose exists in chunks 9–10 but has page 1 metadata. Neither panel structure nor strikethrough meaning is recovered. |
| Chinese results table, printed p141 | All 64 numeric cells and eight row labels exactly match the frozen source. Model-group spans return, but `BERTScore` attaches only to `R` instead of spanning P/R/F1; bold distinctions are lost. Surrounding prose remains corrupted. | Chunks 21–22 contain the complete table, with grouped spans flattened. Human accuracies 62.84/59.27 and the prose maxima are still not reliably readable. Table recovery does not establish full-page recovery. |
| Japanese prefecture table, printed p3 | Compared with the already source-verified native table, 44 of 48 rows have identical eight-value sequences. Hokkaido/Aomori cells and Kagoshima/Okinawa rows are falsely merged. The header loses the minus between C and D; Kagawa becomes `否川`, and many prefecture names split across cells. | Chunks 7–9 retain those errors. Chunks 8–9 also lack repeated headers, year and unit. Correct national, Tokyo and Osaka anchors would miss these regressions. |
| Hong Kong labour tables, printed p6 | Four table objects replace paragraphs. Unemployment and underemployment tables are correct. The sex table merges male/female rows and misplaces values; the age table adds columns and shifts the 7.2 value under a 2022 count header. | Chunks 3–6 bring years, titles and bilingual notes together. Chunks 5–6 support complete unemployment/underemployment questions. Sex/age table cell errors remain despite closer context. |
| NIST photograph, printed p363 | Corrected column order improves mass-support and pawl/ratchet prose. Release wire G returns, although letters acquire spurious mathematical subscripts. No visual photograph description is generated. | Chunk 10 preserves the mechanism explanation. Chunk 11 restores distances A/B/C/D, the No. 6–32 screw and parts 15/13/14. These are printed-prose gains; visual H/J labels and photograph interpretation remain absent. |

The NIST conclusion physically on printed p362 is also merged into the
preceding page's raw block 33, so improved reading continuity can still have
incorrect source-page attribution. The Chinese opening paragraph has the same
issue. Page-local inspection alone would wrongly call those passages missing.

Evidence is saved under `baseline/`: `mineru-pack.json` contains all nine raw
page extracts, actual overlapping chunks, original artifact hashes and the
Chinese cross-page continuation; `mineru-source-review.json` records judgments.
`mineru-ccl-table-numeric-check.json` confirms all 64 table values in row order;
`mineru-japan-row-check.json` records all 48 row comparisons without repairing
merged cells. Per-page `--mineru.txt` and `--mineru--chunks.txt` files make the
same evidence readable. The Beijing endpoint remains paused and unassessed.
