# Native ODL repair experiments, 13 September 2026

Substantial native table improvements are possible on the preserved sources. A mixed-text grid extractor plus body-only replacement reconstructs all 39 source-labelled rows across six Chinese/French tables, including their column headers and explicit row groups in final retrieval chunks. The baseline had 21 complete flat rows and zero rows with that explicit structure. This candidate also exposes a real packing loss: one short French prose tail disappears. A conservative final-chunk admission check retains 31 of the 39 structural gains and preserves that prose. Neither result establishes broad production readiness.

This is a fresh local experiment, not a replay of the missing historical 430-page raw outputs. No production code, thresholds, shared host, live database, or provider API was changed. The runnable implementation is [experiment_odl_native_improvements.py](../scripts/experiment_odl_native_improvements.py). Raw evidence lives under [the local run directory](local/2026-09-13-odl-native-improvements/), abbreviated `local/` below. That directory and the preserved PDFs are local artifacts, not portable checked-in inputs.

## Scope and frozen expectations

Seven complete PDFs, 140 pages, were parsed freshly with Java 17.0.11 and ODL 2.5.7. The jar SHA-256 is `74f0d797bea8088bd4a58137e372eb38a5fa24639e06b633cef7f78eba14cd62`. Python was 3.12.7 with PyMuPDF 1.28.2 and pypdf 6.18.0. The isolated runtime was `/private/tmp/capy-odl-quality-20260913/py312/bin/python`. Java used cluster tables, header/footer inclusion, one thread and a 2 GiB heap cap. The production native helpers, actual production packer and heading retention ran locally; fresh OCR and indexing were excluded.

| Source | Pages | PDF producer metadata | Role |
| --- | ---: | --- | --- |
| `rag__zh__zh-CN` | 11 | Founder | Known table candidates, pages 7 and 9 |
| `rag__fr__camembert-taln` | 12 | PyPDF2 | Known mixed-text tables, pages 4, 6 and 7 |
| `rag__zh__mixed_zh_en` | 20 | Microsoft Word LTSC | Known double-painted glyph candidates, pages 1, 13 and 14 |
| `ccl-feedback` | 16 | ReportLab | Reused development control |
| `bert` | 16 | pdfTeX 1.40.17 | Reused development control; later exploratory table gain |
| `resnet` | 12 | pdfTeX 1.40.12 | Reused development control |
| `hongkong-figures` | 53 | Adobe PDF Library 17.11.238 | Reused development control; unsafe candidate discoveries |

Producer metadata names the last writer; PyPDF2 does not establish the French document's upstream authoring system. These are source families, not seven statistically independent upload populations.

[frozen.json](local/2026-09-13-odl-native-improvements/frozen.json) contains verified source hashes and manually transcribed headers, values and groups from rendered PDFs. It was written before the fresh baseline and candidate runs. The six tables have 39 rows. Their source crops are `source-{zh-dataset,zh-results,fr-corpus,fr-genres,fr-downstream,fr-design}.png`. The sources had already been identified during diagnosis and were reused while improving the extractor. They are development examples, not holdouts.

Before revision 3, a separate [control manifest](local/2026-09-13-odl-native-improvements/controls-frozen.json) selected WikiNER French, 6 pages, pdfTeX 1.40.25; Japanese `jp_llm`, 26 pages, Acrobat Distiller/InDesign; and German education, 32 pages, Adobe PDF Library/InDesign. These 64 pages were freshly parsed. No table-row positives were labelled on them and every candidate abstained. They test non-interference across other sources, not positive transfer. They were already historical benchmark sources and are not globally untouched documents.

`cluster-r1/` and `controls-native-r3/` retain source PDFs, raw Java JSON/Markdown, logs, adapted blocks before glyph/table repair, final native blocks, furniture and actual chunks. `run.json` records source-helper and jar hashes. All native helper hashes still matched the recorded baseline at final verification. A separate default-detector run parsed five sources, another 104 page-passes, for 308 fresh Java page-passes over 204 unique pages. This was bounded local work; timings do not establish ingest-VM capacity.

## What actually prevented activation

Fresh Java emits no table blocks on either target Chinese or French document. The two Chinese tables do pass the existing source extractor. Both are refused by the existing replacement pass because the expanded citation box partially overlaps a bilingual caption block. They have no unpositioned page blocks and no overlapping native tables; source/native coverage of the fully contained body blocks passes. BERT page 6 has the same partial-context failure. Exact receipts are in [replacement-gates.json](local/2026-09-13-odl-native-improvements/replacement-gates.json).

For Chinese page 7, the offending block is `表2 THUCNews数据子集基本信息 Table 2 Basic information of THUCNews subset`. The citation box contains part of this combined native block. The production veto is therefore doing what it was written to do, but context geometry prevents an otherwise possible body repair. See [source_context](../../../parser/odl/tables.py:103) and [replace_tables](../../../parser/odl/tables.py:749).

The admission-only experiment keeps complete captions outside the replacement area and replaces only fully covered body blocks. That admits both Chinese tables, but the current extractor merges the distinct dataset and category columns on page 7. It therefore gains only the 11 page-9 rows with correct full column associations. French tables still fail because the current numeric-column model cannot represent mixed text columns, wrapped genres, numeric percentile header tiers or explicit grouped rows. Increasing the existing header-level limit would not address those misclassifications. See [recover](../../../parser/odl/tables.py:561).

## Measured alternatives

A structural row passes only if every frozen value maps to one distinct expected column-header path and the complete pipe row plus its headers occurs together in an actual final chunk. Explicit group labels must appear in the same row where applicable. Source row order and final chunk row order are checked separately. The flat-row metric only asks whether all source row values occur consecutively in a chunk after whitespace and pipe normalization. Zero structural rows does not mean the baseline contained zero useful table text.

| Frozen table | Rows | Baseline complete flat rows | Current grid, body-only admission: structural | Mixed grid r5: structural | r6b with prose conservation: structural |
| --- | ---: | ---: | ---: | ---: | ---: |
| Chinese p7, dataset/category | 4 | 0 | 0 | 4 | 4 |
| Chinese p9, model results | 11 | 0 | 11 | 11 | 11 |
| French p4, corpus statistics | 3 | 3 | 0 | 3 | 3 |
| French p4, genres | 5 | 4 | 0 | 5 | 5 |
| French p6, downstream tasks | 8 | 6 | 0 | 8 | 8 |
| French p7, design groups | 8 | 8 | 0 | 8 | 0 |
| Total | 39 | 21 | 11 | 39 | 31 |

Both mixed variants retain all 39 complete flat rows. r6b leaves the final eight in their baseline flat representation. Raw comparisons are [current-grid-body-r5](local/2026-09-13-odl-native-improvements/current-grid-body-r5/summary.json), [mixed-r5](local/2026-09-13-odl-native-improvements/mixed-r5/summary.json), and [mixed-r6b-conserve](local/2026-09-13-odl-native-improvements/mixed-r6b-conserve/summary.json).

The mixed extractor infers repeated complete body-row templates from source geometry, preserves multiple text columns, attaches ruled or aligned header tiers, and repeats explicit source group labels with their rows. Numeric header tiers are separated from body anchors. Italic group headings may contain roman words, as in the source's `Stratégie de masking`. Replacement protects existing native tables and furniture, refuses partial body overlap, and requires normalized character conservation of both removed native text and source text within the body. This is an extraction and admission change, not a document-name rule or threshold increase.

BERT page 6 is an additional exploratory gain outside the frozen 39-row denominator: five rows by ten columns, including task-size header tiers. All values and row order were checked against `source-extra-bert-r3.png` and final chunks. BERT had already been inspected and reused as a development control, so this is not independent holdout success. The admission-only arm also recovers this table.

Two simpler extraction alternatives failed. Whole-page PyMuPDF line/text strategies merged prose or split tables incorrectly. Clipping them to existing source rule bands still split Chinese headers/grouped thousands, broke French genre wrapping and mishandled the design table. Receipts are `pymupdf-defaults.json` and `pymupdf-clipped.json`. Removing `--table-method cluster` produced no native target tables in Chinese, French or BERT and removed Hong Kong's 69 raw native table blocks. Its full semantics were not certified; it is not a recommended global switch.

The root agent's already-computed PPDocLayoutV3 boxes were also tested as candidate regions, using source text and source rules for reconstruction. This arm recovered all four available tables, 20 labelled rows on Chinese p7 and French p4/p7. Source rules already recovered the same 20. There were no predictions for Chinese p9 or French p6 in this arm; reporting 20/39 as detector recall would be wrong. This was a reused development subset with no new OCR, model inference or model-based cell values. See [model-grid-r5](local/2026-09-13-odl-native-improvements/model-grid-r5/summary.json).

## Failed revisions and downstream conservation

Every intermediate output remains available. Revision 1 produced a bad BERT page-8 table by assigning a joined multi-task header to unresolved leaf columns. Revision 2 rejects that ambiguity. Revision 2's expanded support for thin rectangle rules also admitted Hong Kong pages 31 and 32 with repeated `Number / %` columns but omitted their parent years, 2018, 2022 and 2023. Revisions 3 onward reject duplicate complete header paths instead of inventing their scope. These are failed repairs, not improvements justified by numeric conservation. Source crops and receipts remain under `source-extra-*`, `mixed-r1/` and `mixed-r2/`.

Revisions 1 and 2 reached 28 labelled structural rows. Revision 3 reached 36. Revision 4 extracted all six tables, but the scorer treated `5%` as a substring of `95%` and falsely marked the corpus table ambiguous. Revision 5 fixes exact header-tier matching. A separate scorer correction prefers the explicit group when identical rows occur under different groups. Original labels were unchanged. Raw earlier summaries retain their original scoring defects; the final counts use the corrected scorer.

r5's parser-level conservation checks pass: every block outside replacement bodies remains, every surviving native block stays in order, and all existing final native tables remain unchanged. All 44 accepted rows, the frozen 39 plus BERT's 5, retain source and chunk row order. Yet final chunks lose the French page-7 prose `compréhension de la langue.`. It remains in the content list. Introducing an explicit table forces a prose flush; the existing `_pack` minimum-size filter drops the resulting short nonredundant tail. See [pack_blocks](../../../pipeline/pipeline/retrieval/packing.py:410) and [the final filter](../../../pipeline/pipeline/retrieval/chunking.py:371).

r6b adds a bench-only postcondition: if previously chunk-visible retained native prose disappears, restore that page's native representation and record the repair as rejected. It abstains on French p7, reaches 31 structural rows and has no detected loss of previously visible retained prose on the ten sources. [Audit receipts](local/2026-09-13-odl-native-improvements/mixed-r6b-conserve/audit.json) also confirm source/chunk row order and outside-body preservation. The first `mixed-r6-conserve` run stopped on an existing malformed native table while checking prose; it remains as an incomplete run. r6b limits this prose check to text/list blocks and completes.

Whole-chunk character counts decrease on changed documents because overlapping prose windows and repeated context change. The audit retains those deficits rather than calling them proof of source loss or success. It separately checks complete retained native text, explicit table cells and row order. These checks do not certify every source character's position or every repeated occurrence.

The requested packing ablation sets `cfg.chunk_min_tokens` to zero only inside the local process and restores it in `finally`. It repacks both baseline and r5. All 39 associations survive and the lost French phrase returns, but the setting also retains noise and a duplicate heading.

| Source | Extra baseline chunks at minimum zero | Extra r5 chunks at minimum zero | Added content examples |
| --- | ---: | ---: | --- |
| Chinese paper | 0 | 0 | None |
| French paper | 1 | 2 | Existing bibliographic tail; additionally the previously lost prose plus page number 59 |
| Word thesis | 1 | 1 | `xviii` |
| CCL feedback | 2 | 2 | Keywords; copyright/page line |
| BERT | 0 | 0 | None |
| ResNet | 1 | 1 | `9` |
| Hong Kong | 1 | 1 | Exclusion note about refused entrants and drivers |
| WikiNER control | 0 | 0 | None |
| Japanese control | 2 | 2 | Meaningful continuation tails |
| German control | 4 | 4 | `| 4 |`, a prose tail, two repeated headings |
| Total | 12 | 13 | One additional exact duplicate German heading chunk |

The experiment isolates an existing pruning behavior exposed by new table boundaries. It does not justify a global minimum of zero. The useful contract is to retain nonredundant source prose at boundaries while still filtering furniture and duplicate carryover. Evidence is in [min0-r7](local/2026-09-13-odl-native-improvements/min0-r7/summary.json) and [controls-min0-r7](local/2026-09-13-odl-native-improvements/controls-min0-r7/summary.json).

## Double overprints and remaining limits

The earlier source sweep found exactly double-painted Chinese glyph clusters in the Word thesis, including 31 on page 1 and 18 each on pages 13 and 14. Fresh Java already deduplicates these labels. A bench candidate admitted double-run inspection, required exact deletion-only correspondence with deduplicated source text and enough overlapping painted glyphs, and changed zero blocks in all ten PDFs. The source phenomenon is present, but no missed native error was demonstrated. Removing the production triple-run screening condition has no measured benefit on these candidates. Per-block rejection receipts are `double-receipts.json` in each variant directory.

The 64 source-separated pages remain byte-for-byte equal at the block level in r3, r5 and r6. Their actual chunks also remain unchanged under the native candidate. Together with reused controls, the final audit protects 157 existing final table blocks. These controls include imperfect native extraction; unchanged does not mean correct. There is still no source-separated positive-transfer demonstration for the new mixed-grid algorithm.

The 39-row score measures text/header/group associations. It excludes source bold significance, gray shading, complete caption attachment, footnote linkage and metric-definition scope. The prototype preserves textual notes outside the body, but does not always repeat them in the table chunk. BERT and the French design table can have empty table titles because the native caption did not match the simple text-block selector. Source bold is recorded in assignments but not emitted as a semantic annotation. These limitations prevent a claim of complete table meaning even where the row score is perfect. No retrieval questions, model answers, citation quality, OCR accuracy, production latency or memory capacity were measured here.

The next evaluation should freeze a new source-family-separated manifest before inspecting candidate output, identify actual native defects from source renders plus raw Java, and retain positive tables, ambiguous headers, already-correct native tables and short prose adjacent to tables. All six current targets, BERT and Hong Kong are now development data. Keep the 39-row rubric for regression, but add styles, units, captions, footnotes and final text conservation before accepting a repair. Keep the current failed versions as negative controls. A fresh source family with a naturally occurring mixed table defect is needed to establish positive transfer; more pages of abstention cannot supply that evidence.

## Reproduction and verification

Use new output names. Source manifests and all original PDF hashes are checked before fresh parsing. The `freeze` mode creates the known-source expectations only when `frozen.json` does not exist. The existing control manifest records its separate selection time.

```sh
PY=/private/tmp/capy-odl-quality-20260913/py312/bin/python
SCRIPT=bench/parsers/scripts/experiment_odl_native_improvements.py
JAR=/private/tmp/capy-odl-quality-20260913/py312/lib/python3.12/site-packages/opendataloader_pdf/jar/opendataloader-pdf-cli.jar

"$PY" "$SCRIPT" parse --java /usr/bin/java --jar "$JAR" --run native-new
"$PY" "$SCRIPT" improve --baseline native-new --output mixed-new
"$PY" "$SCRIPT" improve --baseline native-new --output admission-new --extractor current
"$PY" "$SCRIPT" improve --baseline native-new --output guarded-new --conserve-prose
"$PY" "$SCRIPT" audit --baseline native-new --output guarded-new
"$PY" "$SCRIPT" pack-ablation --baseline native-new --candidate mixed-new --output min0-new

"$PY" "$SCRIPT" parse --java /usr/bin/java --jar "$JAR" --run controls-native-new --manifest controls-frozen.json
"$PY" "$SCRIPT" improve --baseline controls-native-new --output controls-new --manifest controls-frozen.json --conserve-prose
"$PY" "$SCRIPT" audit --baseline controls-native-new --output controls-new --manifest controls-frozen.json
```

`--region-mode model` consumes the root OCR experiment's saved PPDocLayoutV3 predictions and requires those local artifacts. It is optional and makes no model call. `--table-method default` on `parse` reproduces the Java detector ablation.

Completed verification: fresh native parses, source/table/chunk audits, all stated ablations, `py_compile`, and explicit `ruff check` / `ruff format --check` with `--no-force-exclude` because repository defaults exclude `bench`. Raw snapshots preserve earlier executable versions. No production test suite or live integration test was run for this benchmark-only work.
