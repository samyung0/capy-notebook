# ODL textbook quality review

Date: 2026-09-16. Review by a new Astra xhigh subagent and the parent agent, using the current implementation, earlier parser experiments and saved three-book pilot outputs.

## Assessment

Keep ODL while testing the confirmed failures separately. The first repair to investigate is the repeated-text filter: it deletes real body formulas that ODL has already extracted. Native fraction layout, symbol-font decoding and running-header classification are separate problems. Replacing the parser or adding broad OCR now would make these causes harder to measure.

The current extraction score cannot certify mathematical correctness. Several source-confirmed failures score above 0.95, including one at 1.00. A review queue limited to low scores would miss them.

This is a review with a saved-block diagnostic replay, not an implemented fix. No production code, source PDF, saved parser bundle, active pilot corpus, database, Batch input or running process was changed. No provider request or new Java parse was made. Suggested behavior below remains a proposal. The existing decision to discard repeated non-heading text is recorded in `human/agentic-retrieval.md`; this review supplies evidence for revisiting it, without recording a new human decision.

## Evidence and reproduction

The pilot uses release `b79795b4d4c973f6792405123d7c50d2987c5581` and chunker `v9`. Source identities, editions, PDF hashes and licenses are frozen in [the book manifest](../../rag/fixtures/knowledge-base-pilot-books.json). Page numbers below are one-based PDF pages. Content-list block indices are zero-based.

Local receipts are under `data/knowledge-base-pilot/run/odl-review/`:

- `audit.py` invokes the actual production furniture predicate and packer on saved artifacts. It does not call the parser, an embedding service or a database.
- `audit.json` records input hashes, source/release/parser identities, selected source blocks and final chunks, exact deletion counts and the diagnostic replay.
- `os4-p54.png` and `os4-p193.png` are source-page renders visually inspected by the parent.
- Earlier page-50/page-431 and source-typo receipts are in `run/source-audit.json` and `run/confidence-audit.json`, summarized in [the pilot report](../../rag/reports/2026-09-16-knowledge-base-local-pilot.md).

The large source/artifact files remain local and ignored. The review can be replayed on this PC with:

```powershell
.venv/Scripts/python.exe data/knowledge-base-pilot/run/odl-review/audit.py
```

No production test suite was rerun for this report. Relevant tests were inspected. The saved-block baseline comparison and source inspections below were executed.

## 1. Repeated-text filtering removes body mathematics

### Cause

[`parser/odl/furniture.py`](../../../parser/odl/furniture.py), `repeated_across_pages`, treats any identical non-heading text on three or more pages as running page furniture. It does not check whether the text is in a margin. The parser freezes those normalized strings before table recovery. [`packing.py`](../../../pipeline/pipeline/retrieval/packing.py), `_is_furniture` and `pack_blocks`, then remove every matching non-heading block before chunking.

This behavior matches the existing decision and tests. The problem is the rule itself: an equation, graph label or repeated instruction can recur throughout a textbook body.

### Confirmed losses

| Source | Present after parsing | Final indexed text | Confidence and reasons |
| --- | --- | --- | --- |
| OpenIntro Statistics p54, block 757 | `√` in the standard-deviation expression | `s =` followed by `25.52 = 5.05`, missing the root | Chunk 167: 1.000, no reasons. Chunk 168: 0.990, no reasons |
| OpenIntro Statistics p193, blocks 2799, 2800, 2801, 2803 | `SEpˆ =`, `p(1 − p) n`, `=`, `= 0.010` | Only `0.88(1 − 0.88) 1000` remains after “the following formula” | Chunk 564: 0.952, no reasons |
| Learning Statistics with jamovi p243, block 1847 | `𝑡 =` | Test-statistic identity disappears; numerator and damaged denominator fragments remain | Chunk 544: 0.994, no reasons |

The first two cases were checked against rendered source pages. Page 54 prints `s = √25.52 = 5.05`. Page 193 prints the full expression:

```text
SE_p̂ = √[p(1 − p)/n] = √[0.88(1 − 0.88)/1000] = 0.010
```

The jamovi case is verified through saved block-to-chunk artifacts; it was not separately visually certified during this review.

The exact production predicate gives these corpus totals:

| Book | Frozen text keys | Matching blocks removed | Removed blocks wholly inside normalized y=100..900 | Pages with those interior removals |
| --- | ---: | ---: | ---: | ---: |
| OpenIntro Statistics | 98 | 898 | 856 | 172 |
| Advanced High School Statistics | 103 | 840 | 787 | 170 |
| Learning Statistics with jamovi | 13 | 92 | 79 | 37 |

These are deletion counts and a positional diagnostic, not a measured error rate. Some repeated content may be dispensable and some boxes are imperfect. Confirmed formula loss establishes the defect independently of that uncertainty. All removed blocks, including margin blocks, occur on 178, 200 and 39 pages respectively.

Other selected keys include `s √n`, `point estimate − null value SE`, `∑`, `𝐹 =`, `Frequency` and `Interest Rate`. They warrant source review; the enumeration alone does not prove every occurrence is necessary.

### Controlled diagnostic completed

Replaying saved OpenIntro blocks through production `pack_blocks` and `retain_headings` exactly reproduced all 1,341 saved chunks' text, section paths and page spans.

In a separate in-memory copy, removing only five keys from the frozen filter restored the p54 root and the p193 formula label, symbolic expression and numeric result:

```text
√
SEpˆ =
p(1 − p) n
=
= 0.010
```

The replay is causal evidence, not a proposed five-string exception list. The p193 fraction and radical structure remains damaged after the text returns. Preventing deletion and recovering mathematical structure therefore need separate acceptance checks.

### Smallest next experiment

Compare the current rule with a rule that proves a repeated occurrence is page furniture using margin location, recurring typography/position and source role. Classify occurrences, not only strings: a genuine footer and an identical phrase in the body must not cause body deletion. Retain uncertain body content. Reuse the narrower isolated-folio and explicit-footer evidence where applicable.

Freeze examples of repeated equations, graph labels and real headers/footers first. Use saved bundles for the first diagnostic. Their final content lists are already post-table-recovery, so verify the final rule on preserved pre-table-recovery blocks or a later refinement-stage replay, with both production copies and the existing freeze order, before adoption. The existing frozen keys are sufficient for the completed deletion ablation. Require the confirmed formulas to survive, reviewed real furniture to remain excluded and no new loss of source content. Report extra chunks/tokens and false classifications. Raising the recurrence threshold or adding math-string exceptions does not address the underlying problem.

## 2. Native formulas lose both symbols and spatial relationships

OpenIntro p431 is already wrong in native `parsed/document.md`, before chunking:

```text
pˆ = 21227 = 0.127
SE ≈ pˆ(1n−pˆ) = 0.127(1212−0.127) = 0.023
```

The source prints a numerator `27` over denominator `212`. The fraction bar is a separate horizontal drawing with zero height at y=696.246 points. An area-based rectangle intersection can miss it. The standard-error expression also contains a radical whose glyph is extracted as `q` from CMEX9.

There is direct font evidence for a bounded experiment. Font xref 4284 has neither a `ToUnicode` entry nor a PDF `Encoding` entry, but its embedded Type1 program contains a literal encoding array. Existing `fonts.explicit_encoding` reads byte 113 as `radicalBig`, 112 as `radicalbig` and 114 as `radicalbigg`. The installed Adobe glyph mapping maps all three names to `√`. Similar entries identify stretched parentheses and a hat. This is stronger evidence than guessing from a likely statistical formula.

Current repairs do not cover either failure:

- [`exponents.py`](../../../parser/odl/exponents.py) restores only a source-proved raised integer following `×10` or `·10`.
- [`fonts.py`](../../../parser/odl/fonts.py) repairs a particular contradictory CJK `ToUnicode` mapping. A missing mapping is a different case.
- [`ocr.py`](../../../parser/odl/ocr.py) primarily selects pages with fewer than 40 text-layer characters. A prose-rich digital page with damaged formulas stays native.
- Flat descendant text from [`adapter.py`](../../../parser/odl/adapter.py) cannot express all numerator, denominator and radical relationships. Packing cannot recover geometry already absent from its input.

Test these as separate arms:

1. Recover only supported glyph meaning from explicit embedded encoding on a temporary PDF copy, with identical rendered pixels and abstention for unknown mappings. Include actual mathematical `q` and ordinary prose `q` controls.
2. Recover only unambiguous fraction/root scope from source spans and drawings. Include adjacent fractions, small footnotes, minus signs versus fraction bars, equation labels and already-correct expressions.
3. Detect and flag ambiguous structures without rewriting them.

Score complete expressions, including signs, variable identity, numerator/denominator scope, roots, powers and equation labels, through final chunks. Counting surviving numbers is insufficient. Use p431 as development evidence and freeze another source family before tuning; OpenIntro and AHSS share lineage.

## 3. Confidence and review routing miss these failures

[`confidence.py`](../../../pipeline/pipeline/retrieval/confidence.py) measures token agreement with the source text layer. Its tokenizer removes operators and punctuation, and its comparison ignores order. Page coverage and pipe-table width checks add limited diagnostics. It does not check equation structure, header/value associations, section paths, figure completeness or whether the textbook itself is right.

The [pilot confidence audit](../../rag/reports/2026-09-16-knowledge-base-local-pilot.md#confidence-audit-follow-up) found 128 of 3,764 searchable chunks below 0.9. Twelve low-scoring chunks have no reason because the disagreement reason starts below 0.85. Eight chunks at or above 0.9 have reason flags. These are queue-size measurements, not parser error rates.

There is also a presentation gap. [`search.py`](../../../pipeline/pipeline/retrieval/search.py), `Passage.location`, emits reasons only when the scalar score is below the warning threshold; an empty reason becomes `no issue found`. The [`chat capture rule`](../../../pipeline/pipeline/prompts/chat.py) requires capture for numeric/formula/table evidence when confidence is below 0.9. Thus high-scoring damage can bypass the explicit capture trigger.

Proposed checks should remain separate from the existing agreement score:

- Surface every existing reason and explain every low score.
- Flag proven body-content deletion, suspect stacked math or symbol fonts, running-header roles and table/figure attachment gaps.
- Include a sample of high-scoring passages to measure misses.
- Measure review precision, missed source-confirmed problems and review time. Do not manufacture a calibrated probability by multiplying arbitrary penalties.

### Where asynchronous LLM review fits

Group candidates by source page. Each review item should contain the original page or crop when layout matters, extracted text, neighboring context, relevant block/chunk IDs and the reason it entered the queue. Text alone cannot prove the meaning of a deleted fraction bar or missing diagram.

The reviewer returns an issue type, exact source evidence, a proposed correction or an explicit abstention. Operators accept, edit or reject proposals. Preserve immutable extracted text and machine scores; store approved corrections and review status separately, then rebuild affected chunks, tags and embeddings in a new corpus version.

This can be an offline Batch task. It does not require the learner's history. The study agent can then use reviewed evidence and capture unresolved high-risk passages while tailoring exercises to the learner. The existing Qwen Batch jobs perform text tagging and generation; they have not validated a visual parser-review workflow or its accuracy.

The printed AHSS p461 coefficient typo is a source erratum, not an extraction repair. A faithful transcription may be wrong mathematically. Keep that editorial distinction explicit.

## 4. Running headers contaminate section paths

OpenIntro p50 block 678 is classified as a heading with level 20:

```text
50 CHAPTER 2. SUMMARIZING DATA
```

It sits near the top of the page at normalized y=28.765..41.345. The source font is regular CMR10, flags 4, while [`headings.py`](../../../parser/odl/headings.py), `source_headings`, requires all spans to be bold for its running-header key. The full key also includes the changing page number. The chapter banner repeats on 23 pages after removing the leading folio, but the current rule does not group it.

The generic furniture filter excludes heading blocks. Later [`retain_headings`](../../../pipeline/pipeline/retrieval/headings.py) avoids adding some repeated labels but leaves existing chunks and polluted paths unchanged. The p50 chunk scores 1.00 because its section path is outside confidence scoring.

Test a source-backed banner rule using stable position/style and chapter text, with separate evidence that the varying number is a folio. Compare metadata-only demotion first. Preserve real chapter/section headings, repeated slide titles and table headers. Do not strip all digits or globally discard header/footer regions. Require the real section hierarchy and every non-heading source block to remain intact.

## 5. Vector figures and complete table semantics remain separate checks

OpenIntro p50's vector histogram has no explicit image block. The pilot's original-caption/full-page anchors make it reachable without generated captioning. Keep that distinction: an anchor is not an extracted crop, and capture availability does not prove that a generator inspected the chart. Validate a small set containing vector and raster figures, multiple figures per page and related editions. Do not invent crop bounds or merge edition-specific figure identities.

The previous table experiments also leave open errors in header/value association and reading order. Preserve the guarded native-table work while evaluating a small set of complete tables, including units, multi-level headers, notes and missing-value markers. Source-text presence alone is insufficient. These checks need not delay the confirmed furniture fix experiment.

## What previous experiments tell us

| Earlier result | Implication for these issues |
| --- | --- |
| [Sept 9 exponent recovery](2026-09-09-odl-exponent-recovery.md) restored 18 scientific powers; two ambiguous cases abstained. Another 430 pages had no eligible positives. | Preserve the narrow rule. It provides controls, not proof of general math recovery. |
| [Sept 9 formula recognition](2026-09-09-odl-math-recovery-experiment.md) recovered 6/7 full NIST expressions, but two crop variants agreed on a wrong `M3` to `M8` change. Independent small-footnote formulas gained nothing. | Targeted OCR merits comparison after source-based repair; same-model agreement cannot authorize replacement. The later guard was tuned on the failure. |
| The same experiment scored 3/3 screening formulas at 144 dpi and 0/3 at 288 dpi; ODL CodeFormulaV2 scored 0/3 at both. | Higher resolution is not a reliable general fix. |
| [Sept 12 Qwen3.5 OCR](2026-09-12-qwen35-ocr-digital-math.md) retained 96 equation labels via `document_parsing`, with two full expressions visually checked. Its chat route dropped all display formulas on three pages and all labels. | Historical evidence is route-specific and limited. It does not validate a replacement parser or the current Qwen3.8 Batch reviewer. |
| [Sept 9 heading repair](2026-09-09-odl-heading-context-experiment.md) improved 3/12 to 12/12 source checks on its selected heading types. | Preserve those controls; regular-weight banners with changing folios are a new positive case. |
| [Native improvements](2026-09-13-odl-native-improvements.md) and [implementation](2026-09-13-odl-implementation.md) retained 34/39 development table rows, five BERT rows, 53 source style cells and seven unchanged controls. | Keep the useful admission/ownership guards. Broad table recovery previously damaged prose and cell ownership. |
| [Unseen-family validation](2026-09-13-odl-implementation.md) matched raw Java: both arms scored 38/41 rows and 238/256 cell texts, with 12/52 wrong block-region pairs and 18/61 wrong chunk-region pairs. | Those repairs have no measured positive transfer on that set. New-family positive cases and complete header semantics remain necessary. |
| Prior global header/footer exclusion removed real Japanese table headers. Broad OCR ordering introduced Japanese and Spanish regressions. | Keep local source-role proof; avoid global suppression or ordering switches. |
| [Hard structure boundaries](2026-09-13-structure-chunking.md) added 41.3% more chunks; [later section-boundary work](2026-09-13-section-boundaries.md) moved a ResNet answer span from dense rank 1 to 19. | Do not solve formula continuity by globally rebuilding chunk boundaries. Score actual answer spans and context, not page overlap alone. |

These are recorded historical results, not experiments rerun during this review. Some earlier local raw artifacts may need restoration before a matched comparison. Match source bytes, parser version and stage inputs before attributing a difference to a new repair.

## Recommended order

1. Freeze the source-confirmed issues and clean controls, with stage-of-origin labels and exact source regions.
2. Test occurrence-specific furniture classification on saved blocks. Run the heading metadata experiment independently. Neither needs new model calls.
3. Evaluate review/capture routing against the confirmed high-confidence failures and clean high-confidence controls. Keep source errata separate.
4. Test missing symbol mappings and fraction geometry separately. Compare selective visual transcription only where source-based recovery abstains.
5. Validate figure links and full table semantics on small frozen sets.
6. After candidate quality checks pass, re-index a separate comparison corpus and test complete cited answer spans. Re-embed changed text. Preserve the running pilot as the original baseline.

The immediate opportunity is preventing proven information loss. The practical longer-term model is a native parser with narrow repairs, explicit uncertainty and reviewable corrections. The earlier reports do not justify automatic mathematical rewriting based on confidence alone.
