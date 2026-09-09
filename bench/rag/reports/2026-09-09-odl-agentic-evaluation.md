# Refined OpenDataLoader versus MinerU through the agent

The current refined native OpenDataLoader is competitive with MinerU through
the agentic flow. It answers all requested facts on 41/48 held-out questions,
versus 41–42/48 for MinerU. It produces more answers that also pass grounding,
citation and material-extra-claim review: 23/48 versus 15/48. The factual coverage
is similar; this run does not establish that ODL consistently retrieves more
facts or that a small-sample lead will repeat.

The development experiments did not justify changing ODL retrieval defaults.
Generic table-context instructions and optional source-page reading both scored
below unchanged ODL. Keep the native parser improvements; prioritize citation
geometry, evidence association and the agent's stopping behaviour next.

Completed: 64 development attempts, 96 primary held-out attempts, 15 known-failure
diagnostic attempts and 16 separately registered availability attempts. Pilots
and provider-health probes are excluded. No production parser, prompt, retrieval
configuration or service was changed.

## Primary held-out comparison

| Measure | Refined ODL | MinerU |
| --- | ---: | ---: |
| Every requested fact correct | 41/48 (85.4%) | 41–42/48 (85.4–87.5%) |
| Equal-question mean fraction of correct required claims | 86.46% | 89.24–89.93% |
| Entire answer passes correctness, grounding, citations and material extras | 23/48 (47.9%) | 15/48 (31.3%) |
| Nonempty completed answers | 43/48 | 45/48 |
| Median agent answer time | 16.45 s | 17.14 s |
| Mean agent answer time | 24.88 s | 25.02 s |

Seven questions pass the strict review in both arms, sixteen only in ODL, eight
only in MinerU, and seventeen in neither. The strict difference is 16.7 percentage
points in this run. It includes unsupported additions and missing citation
geometry, so it must not be presented as a sixteen-point gain in factual recall.
Partially correct compound claims do not count as fully correct in the mean.

One source cell remains ambiguous. NIST Table 2's printed mean is difficult to
distinguish between 1.267 and 1.287 in the original embedded raster; the frozen
rubric says 1.267 and MinerU answers 1.287. We retained the original rubric and
an uncertain source judgment, rather than substituting arithmetic from nearby
rows for the reported mean. This accounts for the MinerU factual range. Its
primary answer has separate definite errors, and ODL's primary attempt is empty,
so the ambiguity cannot change either strict count. The scorer preserves the
unresolved cell; the separately recorded bounds explain the fixed strict result.

The primary run used the existing 15-second interactive provider timeout. Each
arm had seventeen failed embedding calls; ODL also had two Qwen call failures.
Some turns recovered and others ended empty or in error. These original outcomes
remain in the denominator. Median and mean times include those outcomes and are
agent timings after indexing, not parsing or complete upload-to-answer latency.

Qwen planning/answer calls reported 1,105,138 input / 28,957 output tokens for ODL
and 1,118,520 / 30,611 for MinerU, including 622,336 and 642,048 cached input
tokens respectively. There were 213 and 215 Qwen attempts. Missing usage on
failed calls is unknown. These records do not support a meaningful agent-token
saving from changing parser alone.

## What this measures

Both parsers feed the current production chunk indexing, hybrid retrieval,
document-reading tools and answering agent in an isolated VM laboratory. Alibaba
`qwen3.8-flash` generates image captions, source summaries and answers. DeepInfra
`Qwen/Qwen3-Embedding-4B` generates 2,560-dimensional embeddings. Parser-specific
image selection is retained. Captions and indexes are freshly prepared from
verified existing parser output; historical QA scores are not reused.

The corpus has 29 logical sources and 663 coordinate-PDF pages. Each arm indexes
28 sources successfully. The same Hong Kong language-policy source fails during
Qwen summary generation with `data_inspection_failed`. Its incomplete content is
removed using production cleanup, and its question remains in the evaluation.
The final searchable indexes contain 2,846 ODL chunks and 2,868 MinerU chunks.

The [plan](2026-09-09-odl-agentic-plan.md),
[source audit](2026-09-09-odl-agentic-question-audit.md) and
[review protocol](2026-09-09-odl-agentic-review-protocol.md) specify the comparison.
The fixture contains 16 development and 48 held-out questions. It is a
shared-source question holdout, not a new-corpus test. Questions and rubrics are
AI-authored or adapted from earlier fixtures and reviewed against original source
pages. Answer judgments are source reviews by AI agents, not independent human
grading. One generated answer per condition is not enough to establish small
differences as repeatable effects.

## Development baseline

| Measure | ODL | MinerU |
| --- | ---: | ---: |
| Questions with every required claim correct | 15/16 | 16/16 |
| Equal-question mean fraction of correct required claims | 95.31% | 100% |
| Complete answers passing correctness, grounding and citation review | 6/16 | 5/16 |

The strict measure also checks material claims added beyond the question. Both
systems frequently retrieve the requested facts, then add an unsupported
explanation, a wrong comparison or a citation that misses the supporting source
region. The baseline has two questions where both pass, four ODL-only passes,
three MinerU-only passes and seven where neither passes. These are development
results, not the held-out conclusion.

The generic table-context instruction passes 1/16 complete answers; the page
reading condition passes 4/16 after independent review of a source-table
arithmetic ambiguity. Neither exceeds baseline ODL's 6/16, so the preregistered
rule selects unchanged ODL for held-out evaluation. The decision was frozen in
`selection-v2.json` before the first held-out attempt, SHA256
`84e1b3984f7c9eb3be202b8f987114a81942edd1d7a80b92e600b4edaa991cbb`.
The latest development aggregate is `development-scores-v3.json`; its final
source-only correction changes one failure explanation without changing any
condition score or the selected configuration.

Development median answer times were 14.66 seconds for baseline ODL and 18.73
seconds for baseline MinerU. Qwen answer/planning calls consumed 154,110 input
and 11,731 output tokens for ODL versus 353,985 input and 13,061 output tokens for
MinerU. These include 56,832 and 210,304 reported cached input tokens respectively.
The page condition made nine additional caption calls: five returned descriptions
and four timed out. Missing usage for failed calls is unknown, not zero billed
tokens. Shared provider load and caching limit latency comparisons.

## Concrete paired failures

These examples are from development answers, checked against the original PDFs.
They distinguish requested facts from extra material the agent volunteered.

| Source and question | Refined ODL | MinerU | Source check |
| --- | --- | --- | --- |
| `zh-CN.pdf`, Table 4, ablation question 027 | Loses the alignment between component checkmarks and numeric rows. The baseline answer assigns skill fusion 92.5 and +10.3 instead of 87.8 and +5.6. | Preserves the table and answers all four required component claims correctly. It adds an overbroad assertion that every combination beats every single component on the reported metrics. | PDF page 10: fusion alone has A4 87.8 and degradation 1.9; compression plus keyword matching has A4 92.5 and degradation 3.0. The latter does not beat fusion on degradation. |
| `spain-figures.pdf`, question 035 | Correct requested extrema from prose, then assigns chart rates to the wrong groups, including transport +3.1 or +4.4. | Correct requested extrema, then repeats OCR-corrupted rates such as furniture +15.0 instead of +5.0. | PDF page 22: food/non-alcohol +11.7%, housing-related group -11.0%, transport -0.4%, furniture +5.0%. The prose remains usable even when the chart extraction fails. |
| `attention.pdf`, question 029 | Main attention equation and scaling explanation are correct. The extra variance derivation uses the key vector `k` as the summation upper bound instead of dimension `d_k`. | Main answer is correct. The extra variance derivation is source-correct but supplied as a known continuation despite being missing from the text the model received. | PDF page 4, Equation 1 and footnote 4. ODL retains the footnote prose with flattened math; MinerU truncates the footnote after its opening line. |

The table-context candidate corrects the ODL summation in question 029 using the
retained mathematical context. On the Spanish chart it declines to assign the
scrambled intermediate annual rates, but still adds invalid arithmetic
comparisons. Recovering context and writing a reliable final answer are distinct
parts of this evaluation.

## What the held-out failures look like

| Question and source | Refined ODL | MinerU | Implication |
| --- | --- | --- | --- |
| 032, colour-coded linguistic-bias table | Correctly identifies the requested colour-specific effects, including f6 = −3. | Recovers the numbers but cannot confirm the f6 colour-specific effect. | Native source-style recovery can preserve evidence that plain extracted values lose. |
| 051, ResNet Table 2 | Gives correct values from Table 3 but cannot confirm the requested Table 2 comparisons. | Correctly reads 18-layer plain/ResNet 27.94/27.88 and 34-layer plain/ResNet 28.54/25.03, and the 3.51-point difference. | ODL still loses an important table grid. MinerU's required facts pass; its extra testing-metadata citation omits the caption. |
| 043, NIST shaker frequencies | Required answer is correct, then adds a wrong 50 c/s value reconstructed from corrupted native text. | Required facts and the 12/30 c/s source values are correct. | OCR damage can surface in volunteered details even when the requested answer is recovered. |
| 049/050, BERT SQuAD setup and null scoring | Correctly recovers and cites the requested setup/formulas. | Core facts are correct, but indexed citation regions omit parts of the right-column continuation. | The evidence reaches the model; the failure is citation geometry, not missing knowledge. |
| 054, NIST Table 2 standard deviation | Primary answer is empty. In the separate additional attempt, repeats caption value 0.0023 although the original table says 0.0033. | Recovers 0.0033. The scanned mean remains ambiguous as described above. | A caption can contradict otherwise available native text; more reading alone does not guarantee correct reconciliation. |
| 057, ResNet bottleneck and FLOPs | Primary answer correctly gives 1×1/64, 3×3/64, 1×1/256 and 3.8/11.3 billion FLOPs. | Primary turn reaches the planning cap without answering. The additional attempt recovers the requested facts. | Treat this first-attempt difference as an agent completion failure, not proof of missing MinerU evidence. |
| 060, NIST Figure 6 negative question | Correctly abstains about the requested unsupported specification, then repeats caption errors about two views and component labels K/L. | Correctly abstains, but repeats an incorrect component inventory: three M1 labels instead of two M1 and one M3. | Both strict answers fail: a correct abstention can still contain false visual extras. |

The earlier parser defects therefore do not map one-to-one onto QA failures.
Prose can rescue a missing table; a readable table can still be misassociated;
and the agent can keep searching after it already has the answer. Reviews bind
claims to the actual clipped text submitted in provider requests and to original
PDF citation regions, rather than grading against everything in the index.

## Known difficult-source diagnostics

Five additional questions target ResNet Table 3, BERT Table 1, NIST equations
(1)/(3), and the Chinese children's-story and feedback tables. They were frozen
before the primary answers were inspected. They deliberately revisit known
parser failures and are not a second independent held-out sample.

All three conditions use a 60-second provider timeout, the same model and the
same overall tool budget. These results do not replace the primary run.

| Condition | Every requested fact correct | Strict entire-answer passes | Median time |
| --- | ---: | ---: | ---: |
| ODL baseline | 3/5 | 3/5 | 13.32 s |
| MinerU baseline | 2/5 | 1/5 | 24.43 s |
| ODL with source-page reading | 3/5 | 1/5 | 37.94 s |

ODL baseline reconstructs the ResNet-50/101/152 Table 3 pairs correctly:
22.85/6.71, 21.75/6.05 and 21.43/5.71. MinerU merges the last two top-5 cells;
the agent explicitly withholds those two values. Both parsers answer the
children's-story table correctly. ODL also answers the feedback-table question;
MinerU receives the needed table but reaches the planning cap.

Page reading is useful evidence but not a reliable general repair. It recovers
NIST equation (1), then invents a square root in equation (3), which the answer
copies. On BERT, the actual page description correctly places QQP 72.1 before
QNLI 92.7. The answer first swaps columns, then explicitly corrects them while
falsely blaming a difference between the visual and native evidence. The
corrected requested facts receive credit; the contradictory complete answer
fails strict review.

The page condition makes six tool attempts: four fresh descriptions, one cache
hit and one refused request using a filename instead of a file ID. The successful
children's-table answer uses native evidence; its page call reads an adjacent
prose page. The refused feedback request ends at the planning cap despite the
table already being available. No provider calls fail in these diagnostics.
Four new caption calls add 5,224 input and 5,847 output tokens. They use the
generic image-only caption prompt, with no question or rubric supplied.

## Availability sensitivity

After recurring provider timeouts, a rule was registered during execution:
take every question for which either primary arm returns empty/error, then run
both arms once at 60 seconds without changing their indexes, prompts or tool
budget. This selects eight questions: 014, 038, 040, 054, 055, 057, 058 and 062.
It is a failure-selected additional-attempt diagnostic, not a replacement score
or an unbiased estimate of a timeout setting's effect.

Both arms complete 7/8 additional answers, with zero provider errors. Both still
end empty on 055, the RLHF slide question, at the twelve-step planning cap. ODL
receives the complete required text; MinerU receives preference and difficulty
prose but loses the explicit left question/answer bubbles from the diagram.
This does not isolate a single cause of either empty answer. Primary completion on this selected subset was
3/8 for ODL and 5/8 for MinerU. The extra attempt and provider conditions both
change, so recovery cannot be attributed to the timeout alone. All original
failures remain in the primary results.

ODL's median additional-attempt time is 29.75 seconds; MinerU's is 24.82 seconds.
Longer timeouts do not by themselves establish faster or more accurate answers.
On this selected subset, ODL recovers all requested facts in 6/8 answers versus
5–6/8 for MinerU; strict results are 3/8 versus 1–2/8. In contrast to its primary
answer, the additional MinerU NIST answer has no independent material error, so
its strict result depends on the unresolved printed mean. These additional
attempts must not be combined with the primary 48-question scores.

## Next changes supported by the evidence

1. Keep the current refined native ODL profile as the candidate for fast ingest.
   This comparison supports similar requested-fact coverage to MinerU, with
   remaining table, OCR and caption weaknesses made explicit.
2. Fix citation geometry at both stages: retain source regions when creating
   chunks, then avoid silently dropping regions during citation serialization.
   The offline merge experiment below addresses only the latter stage.
3. Test a smaller final-answer contract and a stop rule once required evidence
   is available. Both arms often damage a correct core answer with extra claims
   or consume all planning steps after retrieving the answer. This is a proposed
   next experiment, not a demonstrated improvement.
4. Keep page reading selective and experimental. Its latency and new caption
   errors do not justify enabling it generally. Test table-specific evidence
   association and native/caption disagreement before adding more page calls.

The earlier native-parser timing experiment measured 335 pages in 63.32 seconds
for ODL including chunking, versus 1,073.41 seconds for MinerU parsing. Those are
different measurement boundaries and a smaller corpus; they are not the
upload-to-answer latency measured here. This run selects 282 ODL images versus
479 MinerU images, retaining parser-specific selection. Caption preparation
includes cache reuse and concurrent calls, so it is not a cold ingest benchmark.

## Citation geometry experiment

The production citation serializer keeps only the first 12 regions in a chunk.
An annotation-only replay preserves small citations and merges overflowing
regions into one enclosing highlight per original page. Across all 32 baseline
answers, ODL has 12 overflowing citations out of 142, eight attached to final
answers. MinerU has two out of 175, one attached. Every indexed region is retained
in the replay and no citation is flagged. Source inspection confirms recovery of
the missing ablation-table value column and German institution names.

On all 96 primary attempts, the same offline replay finds 25 overflowing ODL
citations among 530, seven attached to final answers; MinerU has one among 490,
not attached. There are no replay flags. These counts include citations returned
by tools but never used in the final answer. No answers were regenerated or
rescored using the larger highlights.

This changes highlights, not model answers or available evidence. Larger
highlights include surrounding content and reduce localization precision. It
cannot repair geometry already absent from indexed chunks. See the
[source-backed replay report](2026-09-09-odl-citation-region-replay.md).

## Reproduction records

Raw runs, immutable streamed review packets, source crops, provider receipts and
review JSONL files are under `local/2026-09-09-odl-agentic/`. The frozen database
dump is `frozen-index.dump`, SHA256
`f19b7e1ee13516fb3379f6afbcfcd6ab7349424bdf5f084807ff4588a5683c4c`.
The executed development source archive is `development-archive.tar.gz`, SHA256
`2347feede62b66b09bc0ba08e5553b666a149c74ad4db61bad50b0af06d3973f`.
Its 144 files were checked for the supplied credentials; none contains them.
Production services and parser configuration are unchanged.

The complete execution archive is `final-execution-archive.tar.gz`, SHA256
`2d381cb2d05f0d08c336ea9817568de4bb45b357b489c40f7f73a73a1c5cbcbf`.
It contains 455 execution/source/cache files plus a manifest. All file hashes
were verified after download; none contains the supplied credentials. The
`final-execution/` directory holds the extracted archive. Source-PDF paths and
hashes are recorded in the corpus inventory; parser output and coordinate PDFs
remain available under the referenced parser laboratory artifacts.

Use `primary-independent-latest-reviews.json` to select the current versions of
all 96 primary reviews, preserving superseded versions for audit. The aggregate
is `heldout-primary-scores-independent.json`; the explicit uncertainty bounds
are `heldout-primary-independent-bounds.json`. `secondary-independent-final-manifest.json`
identifies the diagnostic and availability aggregates, manifests and audits.
These bind every review to its answer, provider request and original PDF region.
The final audits find no missing or duplicate attempts or evidence-binding errors.
The availability scorer inherits the primary fixture's generic label; its
separate bounds and manifest identify it as a failure-selected additional run.
The review packets, annotations, source crops and score records are also bundled
in `final-review-archive.tar.gz` (1,976 files), SHA256
`2858afea521811e2b87c83c714ed6f20a4445418ad7651d155f4f03cb5d3fb51`.

Validation completed for the benchmark helpers: Python formatting/lint, scorer
and packet-export checks, citation replay checks, prompt identity and the VM
runtime/preparation/page-tool checks. Exact executed harness hashes and check
results are retained in `final-analysis-checks.json` and the execution archive.
No production rollout or new retrieval default is implied by these lab results.
