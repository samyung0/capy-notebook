# DeepSeek source-fidelity review

Review date: 2026-09-16. Independent source review of the DeepSeek comparison requested by the developer. Saved requests and responses identify the model as `deepseek-flash`, using the Responses API at `api.deepseek.com`. Thinking is disabled with `reasoning.effort: none`.

## Result

DeepSeek preserves all 57 pinned mathematical values and scopes. It also fixes the LSJ table associations missed by both Qwen runs. One source symbol is wrong: the wave table changes Latin `v` to Greek `ν`. The output reports no uncertainty about that substitution.

| Measure | DeepSeek JSON object | Qwen JSON object, after format retries | Qwen strict schema plus explicit instruction | MinerU CPU |
| --- | ---: | ---: | ---: | ---: |
| Pinned semantic mathematical checks | 57/57 | 57/57 | 55/57 | 50/57 |
| Correct values with row/column association | 35/36 | 32/36 | 32/36 | 27/36 |
| Semantically complete tables | 5/6 | 5/6 | 5/6 | 1/6 |
| Scored neighboring prose/caption anchors | 27/27 | 27/27 | 27/27 | 26/27 |

DeepSeek's prior-known math score is 13/13 and its new-family score is 44/44. Existing abstentions remain unchanged: one incorrectly transcribed prose anchor in the gold and the ambiguous exact LSJ `attended?` row-span encoding. These selected checks are not whole-book accuracy or complete prose recall.

### Output format is a separate result

All six DeepSeek tables are HTML, and five are semantically complete. However, the three Hefferon tables use HTML `<sup>` and `<sub>` instead of the requested LaTeX inside mathematical cells. Their powers retain signs, values and exponent scope, so they pass semantic mathematics. They do not pass that output-format requirement.

Thus **43/57 mathematical checks use the requested LaTeX encoding**; the other fourteen are correct HTML mathematical encodings. **3/6 tables satisfy semantic correctness plus both requested formats**, HTML tables containing LaTeX mathematics. This distinction matters for a consumer that expects to extract LaTeX directly. It is not acceptable to describe the run as perfectly compliant transcription.

## Source findings

| Case | Semantic math | Associated mathematical cells | Finding |
| --- | ---: | ---: | --- |
| OS4 standard deviation | 1/1 | — | Radical, value and neighboring definition retained. |
| OS4 standard error | 1/1 | — | Hat on p, nested fraction/radical and example-ending line retained. |
| OS4 fraction 27/212 | 1/1 | — | Estimate and surrounding answer text retained. |
| OS4 appendix standard error | 1/1 | — | Radical scopes and prose hat retained. |
| AHSS Bayes | 3/3 | — | Conditional probability and all successive fractions retained. |
| AHSS source typo | 2/2 | — | Literal `family_income` and both printed coefficients, 0.0431 and 0.431, retained. |
| LSJ regression table | 4/4 | 4/4 | Both response labels and data-column headings correctly aligned. |
| Exo7 ordinary derivatives | 9/9 | 9/9 | All signs, Greek alpha, set symbols and row labels retained. |
| Exo7 composite derivatives | 9/9 | 9/9 | All primes and derivative associations retained. |
| Exo7 quotient identities | 5/5 | — | All five identities retained. |
| Exo7 inverse derivative | 1/1 | — | Nested inverse and denominator scopes retained. |
| Exo7 extremum definition | 4/4 | — | Critical-point prime and both non-strict inequalities retained. |
| Hefferon pendulum table | 5/5 | 5/5 | Correct powers and labels, encoded with HTML superscripts. |
| Hefferon orbit table | 5/5 | 5/5 | Correct mass labels and negative powers, encoded with HTML superscripts. |
| Hefferon wave table | 4/4 | 3/4 | Powers correct, but velocity label `v` becomes `ν`. HTML superscripts. |
| Hefferon pendulum equation | 2/2 | — | Negative exponent, radical and function hats retained. |

### LSJ improvement

`read textbook` has `colspan="2"` over the two data columns, with `no` and `yes` directly beneath it. The attendance rows preserve their own `no` and `yes` labels. The second `attended?` cell is blank, which is covered by the original source adjudication's exact-rowspan abstention. No source gold was relaxed to accept this output.

### Unflagged symbol substitution

The frozen wave-table row is `velocity of the wave v`. The source PDF's native text confirms Latin `v`, U+0076, and the crop was rechecked visually. DeepSeek emits Greek small nu `ν`, U+03BD, beside the correct dimensional formula. Greek/Latin identity is a source-fidelity requirement, not a font-style difference, so that cell association fails and the table is not completely correct.

Every output has `uncertain: []`. This includes the symbol error. No decoded output contains an unexpected control character. An empty uncertainty list is therefore insufficient evidence that the transcription is correct.

## Evidence and execution

The 16 actual Responses requests were independently checked against Qwen's explicit strict-schema input. System and user text match exactly after the API's content-type conversion. Every image decodes to the original frozen PNG bytes. Request hashes, source-input hashes, original case objects and crop hashes match their receipts. Raw response JSON values, exported results and transcript files agree. All 16 values independently pass the local object schema. There were sixteen calls and no format retries in this arm.

This run uses **JSON object mode with local schema validation**. Separate saved provider conflict probes accepted schema-shaped requests but returned a prompt-selected value and extra field contrary to the schema. Neither those probes nor 16 locally valid crop responses establishes provider-enforced JSON Schema. The transcription comparison does not rely on such a guarantee.

Saved client timing is **7.35 seconds** with four workers. Individual request times sum to **26.30 seconds**, median **1.61 seconds**. Provider usage totals **7,003 input tokens and 3,341 output tokens**. All sixteen responses explicitly report zero reasoning tokens. These totals exclude the separate schema probes, tag checks and summaries.

Qwen's explicit strict run took 17.14 client seconds for sixteen calls with four workers. Its earlier JSON-object run needed nineteen calls across format retries, totaling 26.66 command-seconds and excluding inspection gaps. MinerU's matched second CPU pass took 146.20 summed serial call-seconds. These are observed runs with different transports, output constraints and execution arrangements; they are not interchangeable estimates of whole-document ingest speed or statistically established model latency.

The reviewed result is `r2/deepseek-json-object/crops/results.json`, SHA256 `498602dc64fd1856103927e3d46835208246b552d98db2748dfb1017ed292f38`. Per-case judgments and provenance checks are in ignored `r2/deepseek-source-review.json`. The original [Qwen review](2026-09-16-qwen-normal-recovery.md) and [MinerU review](2026-09-16-selective-recovery-comparison.md) remain separate.

DeepSeek performed well on these selected crops, particularly the difficult table alignment. This does not establish automatic crop selection, whole-book reliability, confidence calibration or safe replacement of existing chunks. No production provider choice or integration was made by this review.
