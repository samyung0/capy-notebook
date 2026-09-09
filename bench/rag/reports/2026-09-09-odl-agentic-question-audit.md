# Source audit for the ODL/MinerU agent comparison

The fixture contains 64 questions: 16 development and 48 heldout, with 58 answerable items and six questions whose requested information is absent from their explicitly permitted source. All 29 question-bearing sources (663 coordinate PDF pages) form the shared corpus. No new agent answer was inspected during question selection, evidence extraction, source review, or rubric correction. This report records question design, not answering results.

The fixed family split prevents a paired question about the same narrow fact or figure from crossing development and heldout. It is a question holdout over shared sources, not a fresh source-domain holdout. The 13 added parser documents were used in earlier parser experiments, and legacy questions were exposed in earlier retrieval experiments. These limitations remain even if the answering run is new.

## Inputs and source binding

- [Question fixture](../fixtures/odl-agentic-questions.json): prompts, split, permitted file scopes and separate source rubrics.
- [Portable source inventory](local/2026-09-09-odl-agentic-source/sources.json): stable logical IDs, repository-relative coordinate PDFs, page counts, original and coordinate SHA256 values, and known original VM paths.
- [Legacy bank inventory](local/2026-09-09-odl-agentic-source/question-bank-inventory.json): 33 existing banks, 310 records and 289 distinct question strings.
- [Extracted source-page text](local/2026-09-09-odl-agentic-source/source-page-text.json) and [source page renders](local/2026-09-09-odl-agentic-source/source-pages/): evidence comes from the supplied PDFs. The two CCL font repairs are text locators only; their hashes are separate, and the corresponding gold was checked against original source pixels.

All 16 legacy originals match the parser regression source manifest by SHA. Fourteen are PDFs; two are PPTX originals with converted PDFs supplying page coordinates. The other 13 sources are the eight parser development documents, two CCL font-transfer documents, and three independent parser controls. The fixture does not contain current or old chunk indices as answer gold.

Twenty-eight prompts are copied verbatim from the legacy banks, retaining bank SHA and zero-based row index. Thirty-six questions were added from source evidence. Three questions require facts from two sources. A fourth legacy prompt (022) supplies the MoE connection itself and is marked cross_source_context: its requested claims can be supported by the lecture alone. Question languages are English 24, German 6, Spanish 6, French 7, Japanese 7 and Chinese 14. Overlapping categories include ordinary content 25, tables 22, figures 11, formulas 5, cross-language 6, and missing evidence 6. All six missing-evidence cases are heldout.

## Agent input and scoring boundary

Only question text, language, explicit file scope and an opaque run ID may reach the answering agent. Expected source IDs, claims, evidence, answerability, tags, family and split are evaluation data. A null scope means the complete 29-source corpus. A non-null scope must restrict both search and document reads through the arm-specific file-ID map, and permitted filenames must be visible to the agent. The expected gold sources must never silently narrow retrieval.

The legacy ablation prompt (027) is ambiguous among several papers in the merged corpus. It retains its original wording with an explicit CIL-LLM file scope. The six negative questions (059–064) also have explicit scopes. Earlier workspace-specific irrelevant questions were not reused as global negatives: adding sources can make them answerable, such as FlashAttention in a Japanese lecture or mitochondria in a biology source.

Semantic answer correctness, support for every factual claim, coverage in the actual tool evidence, citation support, and behavior when evidence is missing must be scored separately. Equivalent supported answers from another permitted source are acceptable when the question does not name a particular source, figure or table. The listed evidence is an expected reference, not an exclusive citation allowlist. Numeric units, table row/column relationships, requested years and formula operators matter. Hyphen-only spelling differences in model names should be diagnosed separately from semantic model/version errors.

The primary ODL arm uses the selected native parser output. An OCR or formula-model hybrid would require a separate arm. The rubric cannot replace missing parser content with the gold source text in the answering context.

## Source ambiguities resolved before freeze

- Attention question 030 explicitly asks Table 2: the printed Transformer (big) English–French score is 41.8, while nearby prose says 41.0. The table answer and an accurately stated discrepancy are supported.
- WikiNER question 018 asks the original French subcorpus, approximately 3.5 million tokens. The manually corrected gold subset has 700,000 tokens and 26,818 sentences. Question 016 asks the latter sentence count.
- The newspaper is a synthetic scan with repeated generic text. Question 006 can establish that the council voted the previous night; it cannot establish the decision, vote count or city. Missing city information is tested explicitly in 059.
- Spain question 035 asks the broad CPI groups. Food and non-alcoholic beverages rose 11.7%; housing and related utilities/fuels fell 11.0%. The finer product changes 29.4% and -39.0% are optional illustrations, not required extras or substitutes.
- Hong Kong question 041 converts 1,641.9 thousand to 1,641,900 people and retains 21.8%. The report date and reference year are distinct in questions 061 and 062.
- The accelerometer photograph has component labels but no readable serial number. Question 060 requires a bounded inability to establish the requested number, not a claim that the instrument never had one.
- ResNet question 064 asks across-run standard deviation in Table 2, which reports single top-1 error values. The 25.03% entry is not a standard deviation; absence is not zero.
- The ResNet overfitting evidence crosses a column boundary beneath tables. The source excerpt for 052 includes both source halves; it does not stop at the first-column cutoff.

## Validation and review

The local audit checks all 64 unique IDs and prompts, the 16/48 split, all 57 families confined to one split, use of all 29 sources, all evidence pages in range, seven explicit scopes, and all six negatives scoped. It verifies 28 legacy prompts verbatim against their bank hashes, 43 literal excerpts as exact substrings of saved source-page extraction, 29 coordinate PDF hashes, locator hashes and 40 image-evidence links. Twenty-nine original-source page renders or crops are retained. Literal source text preserves its extraction quirks; it is not candidate parser output.

An independent agent reviewed the high-risk numeric, visual and missing-evidence items against original source pages without inspecting answering outputs. Its two scope/rubric findings were addressed before freeze: the ambiguous ablation question now has enforced file scope, and Spain's finer product examples are optional. This is an independent AI source audit, not a human-labelled benchmark. Review notes and final hash records are retained with the local artifacts.

Frozen fixture SHA256: `262346659ff2c096c7a08e7b658ac8dfc7f70fe5fad258ab025ac218609be0ce`. The [validation record](local/2026-09-09-odl-agentic-source/validation.json), [independent review](local/2026-09-09-odl-agentic-source/independent-question-review.md) and [artifact manifest](local/2026-09-09-odl-agentic-source/freeze-manifest.json) bind the reviewed evidence.
