# Textbook structure baseline and Batch transcription proposal

Date: 2026-09-16. Follow-up to [the ODL quality review](2026-09-16-odl-textbook-quality-review.md), answering whether tables/formulas can be transcribed in Batch and how severe the heading problems are.

## Assessment

Batch visual transcription is a practical candidate. It should produce literal source transcriptions, with separately tested selection, validation and replacement. Its accuracy on these books has not been measured yet.

The expanded local audit shows that section metadata is materially unreliable in both OpenIntro books. Running page banners appear in roughly half of searchable chunk paths. More seriously, a diagram label can become the parent of hundreds of later chunks. These are measured metadata defects, not an estimate that half the book's body text is wrong. jamovi has fewer confirmed examples, but absence of a running-header match does not certify its structure.

Production code and the running pilot remain unchanged. This turn added a local audit script, source-review witnesses and documentation. It made no model request or new parse and did not re-index anything.

## Measured heading problems

The [audit script](../scripts/audit_textbook_structure.py) reads saved blocks/chunks and the original PDFs. Eligibility matches the pilot's `page_start >= first_content_page` rule. It identifies a deliberately narrow family of running banners:

1. The block is currently a heading and lies wholly within the top 6% of the page.
2. Its first or last isolated number equals that PDF page's one-based number.
3. Removing just that folio leaves text recurring on at least three pages.
4. The complete original banner text matches text extracted from the source page's top strip.

All 408 OpenIntro and 463 AHSS candidates matched the source text. The diagnostic does not detect headers with different page-number offsets or all forms of page furniture. It is not an adopted production classifier.

| Book | Searchable chunks | Chunks with a matched running banner in their path | Share | Searchable excerpts with that banner |
| --- | ---: | ---: | ---: | ---: |
| OpenIntro Statistics | 1,311 | 606 | 46.2% | 389 / 871 |
| Advanced High School Statistics | 1,389 | 690 | 49.7% | 488 / 974 |
| Learning Statistics with jamovi | 1,064 | 0 detected | 0% for this detector | 0 / 416 |

Of those affected chunks, 571 in OpenIntro and 654 in AHSS score at least 0.9 with no confidence reasons. Section paths are not scored by the confidence function.

The previous pilot's 201/890 and 243/990 excerpt counts used a narrower textual pattern and included front matter in the denominator. This audit also catches repeated section banners and checks source geometry/text. The counts are different measurements, not an unexplained change in the saved corpus.

### Body labels become long-lived parent headings

The following five source regions were rendered and visually reviewed before recording their roles in [the witness fixture](../fixtures/textbook-structure-witnesses.json). This is agent source inspection, not independent human validation or random sampling.

| Book / source page | Actual source role | Label inserted into paths | Affected chunks | Resulting page span |
| --- | --- | --- | ---: | --- |
| OpenIntro p198 | Figure 5.5 column labels | `n = 50 n = 100 n = 250` | 86 | 198–228 |
| AHSS p214 | Figure 3.6 column labels | `n = 50 n = 100 n = 250` | 301 | 214–334 |
| AHSS p134 | Probability-tree column labels, Example 2.39 | `Event Garage full` | 161 | 134–195 |
| jamovi p369 | Table 14.9 row labels and cells | `attended? no ...` including beta expressions | 4 | 369–370 |
| jamovi p412 | Figure 15.13 caption | `Figure 15.13. The jamovi CFA analysis window` | 5 | 413–417 |

AHSS's two reviewed diagram labels affect 462 distinct chunks, 33.3% of searchable chunks. They survive through later sections. A sample path at p334 still contains the plot labels from p214 above section 3.9, Chi-square tests. The text of the later section is present, but its ancestry is wrong.

For the union of matched banners and these reviewed body roles, 651 OpenIntro chunks, 886 AHSS chunks and nine jamovi chunks are affected. The unions remove overlap; they are not sums of independent error rates. These remain scoped counts of the inspected error classes, not complete structural-accuracy scores.

### Why it persists and why it matters

[`adapter.py`](../../../parser/odl/adapter.py) transfers native heading levels. [`chunking.py`](../../../pipeline/pipeline/retrieval/chunking.py), `_push_heading`, retains a heading until a later heading has an equal or shallower level. The graph labels receive comparatively shallow levels, 6 or 7, so many genuine subsections remain beneath them.

This affects more than display. `Chunk.indexed_text` prepends the path to embedded text. The pilot also groups consecutive chunks by identical path when building excerpts. False labels can therefore influence retrieval and the sections the library agent sees. No retrieval-quality delta has been measured for this new diagnostic, so the amount of answer degradation is still unknown.

An in-memory path-only diagnostic removes the source-matched banners and counts consecutive groups again:

| Book | Current eligible groups | Groups after removing matched banner components |
| --- | ---: | ---: |
| OpenIntro | 871 | 768 |
| AHSS | 974 | 876 |
| jamovi | 416 | 416 |

This demonstrates artificial fragmentation in the current paths. It does not prove the remaining groups are correct excerpts. The diagnostic neither repacks text nor reconstructs heading ancestry. Removing the reviewed body labels changes only one further jamovi group; long-lived labels often contaminate many paths without adding boundaries.

## Batch transcription feasibility

Alibaba's current [Batch guide](https://help.aliyun.com/en/model-studio/batch-inference) lists `qwen3.8-flash` image understanding in Beijing and a 50% input/output discount. The [Batch API reference](https://help.aliyun.com/en/model-studio/batch-interfaces-compatible-with-openai) documents Base64 image inputs. Thus a small local crop test can be packaged directly without provisioning B2. Check the serialized request against the documented 1 MB line limit; larger images can use provider-fetchable URLs. This is documented support, not a completed image request on our workspace.

The checked Beijing list prices are CNY 0.8 input and CNY 2.7 output per million tokens, giving Batch rates of CNY 0.4 and CNY 1.35. For illustration, 10,000 regions averaging 3,000 total input tokens including the image and 500 output tokens would cost CNY 18.75 for one pass. This excludes additional attempts, verification passes and any storage costs. Image resolution and output size must be measured; this is not a corpus quote. [Alibaba pricing](https://help.aliyun.com/en/model-studio/model-pricing).

Use many independent requests in a JSONL batch. A large combined prompt makes omissions, result matching and retries harder to isolate. Batching gives the documented discount; increasing the number of items is not an additional volume discount.

### What should be transcribed

- **Formulas:** literal LaTeX, including fraction/root scope, superscripts, subscripts, punctuation and equation numbers. Preserve variable names and numeric precision. Mark unreadable spans explicitly.
- **Tables:** rows and columns with explicit header associations and merged-cell spans where necessary, plus captions, units and footnotes. Store cell contents as strings so `0.010`, `0`, blank and a printed dash remain distinct.
- **Source errors:** transcribe the printed value faithfully and flag suspected errata separately. The AHSS `0.431` typo must not silently become `0.0431` in the transcription.
- **Provenance:** source hash, page, region, original parsed block IDs, model/request identity and review result accompany each proposal.

The prompt should ask for transcription only. A plausible recalculation is not evidence of the source text. A second pass can flag disagreements, but agreement between passes does not prove correctness, as the prior `M3` to `M8` experiment demonstrated.

### Selection is an independent problem

All three saved books contain **zero explicit `equation` blocks**, despite their many formulas. The saved `table` counts are 140, 140 and nine; at least the visually inspected jamovi Table 14.9 is represented as heading/text instead. Selecting only ODL's equation/table node types would miss required material.

For a bounded first test, freeze known source regions manually before looking at model outputs. For broader use, compare a page-level visual inventory with PDF geometry/native candidate detection, then transcribe the selected regions with nearby context. Measure both missed regions and transcription errors. A perfect transcription of the selected objects does not establish complete book coverage.

Do not send corrected expressions back through the unchanged repeated-text filter: it currently deletes body formula components, as established by the earlier review. Integration needs an explicit preservation rule and a new corpus version.

## Proposed next tests

### A. Table/formula transcription

Freeze a first set of 40 formulas and 20 tables, covering known failures and already-correct regions. Include small inline fractions, roots, signs, decimals, equation labels, multi-level table headers, blank/dash cells, units and source typos. Include another source family for transfer testing because OpenIntro and AHSS share material.

Compare current extraction with image-only Batch transcription on those exact regions. Withhold the expected transcription from the prompt. Report complete-expression accuracy, exact cell strings with their header positions, full-table accuracy, changed-correct cases, omitted content, abstentions and provider-returned token usage. Mark proposals for review; no bulk replacement is justified by this feasibility assessment alone.

### B. Heading roles and structural integrity

Freeze reviewed page sequences containing chapter changes, genuine section headings, diagram/table labels, captions, worked examples and content continuing across pages. Compare these independently:

1. Source-proved margin banner classification.
2. Body-role classification that prevents figure/table labels from becoming section ancestors, using source context and the book's outline where available.
3. A Batch visual role review for unresolved candidates, constrained to existing blocks and real headings.

Keep real headings that are absent from a table of contents. A source outline is evidence, not a complete whitelist. Evaluate correct parent section and title for complete paragraphs/examples, not just the presence of heading words somewhere in a path. Confirm that every non-heading text block and source citation region survives. Measure excerpt continuity and a small retrieval comparison only after classification checks pass.

The present findings are strong enough to prioritize these tests. They do not justify a global heading-level cap, deleting all large-font labels or treating jamovi as a clean control without further source checks.

## Verification and local receipts

```powershell
.venv/Scripts/python.exe bench/parsers/scripts/audit_textbook_structure.py --self-check
.venv/Scripts/python.exe bench/parsers/scripts/audit_textbook_structure.py
```

The diagnostic's six controls passed. The full saved-corpus scan completed, and a second run after formatting reproduced the same counts. The Astra xhigh reviewer independently recounted every header and witness chunk-ID set and confirmed the propagation counts. Ruff format/check passed. Local `reports/local/2026-09-16-structure-baseline/audit.json` and `audit-verified.json` record PDF/corpus/block/fixture hashes, exact chunk IDs, candidate banners, source matches and witness paths. Source renders are beside them. No generated correction or changed heading classification was applied.
