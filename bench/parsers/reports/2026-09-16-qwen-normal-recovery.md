# Qwen normal API selective-recovery review

Review date: 2026-09-16. Historical JSON-object-only arm, including its three format retries. Qwen3.8-Flash, normal API, thinking disabled in every request. The strict JSON Schema follow-up is reported separately below; the earlier sections retain the historical evidence. This is an independent source review of the saved outputs. The reviewer made no provider calls and changed no source gold or parser code.

## Result

Qwen restores all 57 pinned mathematical expressions on these manually chosen crops. It still damages one table's row associations and reports no uncertainty about that failure. The results support further selective recovery work, but not blind replacement of source regions.

| Measure | Qwen normal, after format retries | MinerU CPU, existing matched review |
| --- | ---: | ---: |
| Exact pinned mathematical checks | 57/57 | 50/57 |
| Prior-known mathematical checks | 13/13 | 12/13 |
| New-family mathematical checks | 44/44 | 38/44 |
| Mathematical cells with correct value and row/column association | 32/36 | 27/36 |
| Semantically complete tables, including headers and associations | 5/6 | 1/6 |
| Visible neighboring prose/caption anchors | 27/27 | 26/27 |

One known prose-anchor error in the frozen gold and one ambiguous LSJ row-span encoding remain abstentions for both engines. The 27 anchors are selected phrases, not a whole-crop prose accuracy measure. Formatting equivalence follows the existing adjudication: spacing, font styling, braces and equivalent fraction commands may differ; mathematical operands, signs, hats, primes, scope and table associations must survive.

There is a separate output-format defect. Four of the five semantically correct tables are Markdown although the prompt requires HTML. Only 2/6 table outputs use HTML, and only 1/6 satisfies both semantic structure and the requested HTML format. A consumer that requires HTML cannot treat 5/6 semantic success as 5/6 directly ingestible tables.

## Per-region findings

| Case | Exact math | Associated mathematical cells | Source review |
| --- | ---: | ---: | --- |
| OS4 standard deviation | 1/1 | — | Radical, value and prose retained. |
| OS4 standard error | 1/1 | — | Hat on p retained in the equation and prose; example-ending line retained. |
| OS4 fraction 27/212 | 1/1 | — | Fraction, estimate and surrounding answer text retained. |
| OS4 appendix standard error | 1/1 | — | Both radical scopes and prose hat retained. |
| AHSS Bayes | 3/3 | — | Conditional probability and successive fractions retained. |
| AHSS source typo | 2/2 | — | Retains the source's 0.0431 first coefficient and printed 0.431 second coefficient. No silent correction. |
| LSJ regression table | 4/4 | 0/4 | Omits both attendance row labels and gives the spanning header the wrong width. |
| Exo7 ordinary derivatives | 9/9 | 9/9 | Greek alpha, set symbols, case, signs and row associations retained in HTML. |
| Exo7 composite derivatives | 9/9 | 9/9 | Primes and derivative associations retained, but returned as Markdown. |
| Exo7 quotient derivatives | 5/5 | — | All identities retained without a stray denominator term. |
| Exo7 inverse derivative | 1/1 | — | Nested inverse and denominator scopes retained. |
| Exo7 extremum definition | 4/4 | — | Both non-strict inequalities, intersection and derivative check retained. |
| Hefferon pendulum table | 5/5 | 5/5 | All five rows, labels and exponents retained in the final response, as Markdown. |
| Hefferon orbit table | 5/5 | 5/5 | Both mass labels and negative powers retained, as Markdown. |
| Hefferon wave table | 4/4 | 4/4 | All four quantities and dimensional formulas retained, as Markdown. |
| Hefferon pendulum equation | 2/2 | — | Negative exponent, radical and function hats retained in equation and prose. |

### The remaining table error

The LSJ source labels the two attendance rows `no` and `yes`, separately from the textbook-reading `no` and `yes` columns. Qwen retains the column labels but omits both row labels. Its body starts with an `attended?` cell spanning two rows and the beta expressions immediately beside it. Thus a reader no longer has explicit labels for which attendance response belongs to each row. All four beta expressions pass as isolated math; all four fail the stricter cell-association check.

Qwen also emits `<th colspan="3">read textbook</th>` across all three emitted columns. The source header covers only the two data columns. This defect is independent of the preexisting abstention about whether `attended?` itself must use a row span.

Every final output contains `uncertain: []`, including this table. An uncertainty-only review queue would miss the observed structural error. Correct formulas and valid JSON do not certify a table's structure.

## Retries, evidence and timing

The initial 16 calls returned 14 JSON objects and two single-element arrays. One of the objects omitted the required `uncertain` key, so 13/16 initial responses met the two-key object contract. AHSS Bayes and LSJ were called once more with a JSON-object-only formatting instruction. The pendulum table was called once more requiring both keys. Final scoring uses those three replacement responses and the other thirteen original responses. This is a 19-call, format-repaired result, not a single-pass 16/16 format success.

The added instructions did not contain mathematical answers or source labels. The original source pixels were unchanged in every request. All sixteen frozen case objects still match `r2/prepared.json`; all crop hashes match their original receipts. The final set is `r2/normal-format-final/batch/realtime/results.json`, SHA256 `d285f6aa32ee561c5d6b11661e65fe1367984c4f54420498b58d40eb68d03c8b`. Per-case judgments, selected receipt directories and hashes are in ignored `r2/normal-review.json`.

The three normal command durations total **26.66 seconds** for the initial sixteen calls and three format retries. Their summed individual request time is **66.49 seconds**. These are concurrent client-call measurements, excluding the gaps for inspection and retry preparation. They are not directly comparable to sixteen serial MinerU CPU calls, and they are not full-document parsing time. Returned usage across all nineteen normal attempts totals **8,345 prompt tokens and 3,620 completion tokens**, including the format failures. The requests explicitly disable thinking; returned reasoning-token details are empty, so this review does not infer an independently measured reasoning-token count.

The separate [MinerU comparison](2026-09-16-selective-recovery-comparison.md) describes its serial CPU timing and source failures. The prior Batch job remains a separate historical attempt; its turnaround and any eventual usage are not included in the normal-call totals.

## Limits

All sixteen crops were manually chosen. This review does not measure automatic detection, crop recall, textbook-wide error rates, or safe merging into existing chunks. The earlier ODL routing snapshot found that only 2/16 crops overlapped a chunk below 0.9 confidence and only 2/6 mathematical-table crops overlapped a block typed as a table. Better transcription does not resolve that selection gap.

Qwen is stronger than the tested MinerU CPU configuration on these pinned mathematical checks. Both still need source-bound structural checks before a table or surrounding passage replaces existing content. No production transcription backend was selected or integrated by this review.


## Strict JSON Schema follow-up

A fresh run adds the provider's strict `json_schema` response format. The first full strict-schema run returned 14/16 valid objects; AHSS Bayes and the pendulum table still returned arrays. A second full run adds a system instruction requiring one object, both keys and HTML tables. It returns 16/16 schema-valid objects. The original user transcription prompt and all source image bytes remain identical in both runs. This follow-up scores the second run, with no response-by-response quality selection or retries inside it.

Two separate text/image contract probes returned the schema's enum value despite a contradictory prompt. Those receipts demonstrate that the schema field affects output. They do not prove a universal format guarantee, especially given the arrays observed in the first full run. Local schema validation remains necessary.

| Measure | Earlier JSON-object arm, with format retries | Strict schema plus explicit instruction |
| --- | ---: | ---: |
| Exact pinned mathematical checks | 57/57 | 55/57 |
| Prior-known mathematical checks | 13/13 | 12/13 |
| New-family mathematical checks | 44/44 | 43/44 |
| Correctly associated mathematical cells | 32/36 | 32/36 |
| Semantically complete tables | 5/6 | 5/6 |
| Tables returned as requested HTML | 2/6 | 5/6 |
| Semantically correct HTML tables | 1/6 | 4/6 |
| Scored neighboring anchors | 27/27 | 27/27 |
| Nonempty model uncertainty arrays | 0/16 | 1/16 |

The strict arm has three substantive source errors:

- **AHSS source typo.** Both printed coefficients survive, including the intentional transcription of 0.431. But the first equation changes the identifier `family_income` to `f a m i l y_{-} i n c o m e`. The subscript-minus form is not equivalent to the source identifier, so the full first expression fails. This case is 1/2 mathematical checks, with `uncertain: []`.
- **Exo7 extremum definition.** The source has `f'(x_0)=0`. The output loses the prime and contains `f^{`, the control character **U+0008**, then `ar{}}(x_0)=0`. This remains a mathematical failure; the review does not remove the control character and guess a prime. The other three checks pass, making 3/4, again with `uncertain: []`.
- **LSJ table.** Attendance row labels `no` and `yes` now survive. However, the header's `no` and `yes` occupy HTML columns 2 and 3 while the beta expressions occupy columns 3 and 4. The source's two data columns are therefore misaligned with their headings. The `read textbook` header also still uses `colspan="3"`. Isolated beta expressions score 4/4, associated cells 0/4. This time the model reports uncertainty about header alignment, although its explanation says two columns while the actual HTML spans three.

All other pinned mathematics pass. The pendulum table remains Markdown despite the extra HTML instruction; its five rows are semantically correct. Both preexisting source-gold abstentions remain unchanged.

This fresh sixteen-call run takes **17.14 seconds of client command time**, with **62.13 summed request-seconds**, **8,610 prompt tokens** and **3,337 completion tokens**. It inherited no outputs. Thinking is disabled in every saved request, and none of the returned messages contains reasoning text. The provider returns no reasoning-token counts; those remain unknown. The preceding strict run, contract probes and historical retries are separate work and are excluded from this run's timing and token totals.

The strict arm's final receipt is `r2/normal-structured-explicit/batch/realtime/results.json`, SHA256 `5e429dc2f334111d766c69168b16a06c80282532ec78f9013c23d78e2445a61d`. Per-case judgments are in ignored `r2/normal-structured-review.json`. Historical results remain in `r2/normal-review.json`.

Strict JSON Schema verifies the outer object's structure. It does not validate the mathematics or the HTML stored inside its string. This small comparison also changes the system instruction and samples a fresh set of responses; it does not establish that schema use caused either a quality gain or a regression. Both Qwen arms show useful recovery, but neither establishes safe automatic replacement or sufficient confidence routing.
