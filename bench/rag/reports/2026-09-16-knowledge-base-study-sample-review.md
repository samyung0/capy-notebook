# Knowledge-base study sample review

The interrupted run produced four reviewable outputs within the frozen six-request sample. The one complete A/B pair contains a false explanatory sentence in A that B avoids. A separate B output gets the requested doubling calculation right but states a false rule for negative scaling. Valid JSON and source IDs did not prevent these errors. This partial review cannot establish an A/B quality gain.

## Scope and selection

This is a source-grounded semantic review by the implementation subagent, not an independent human assessment. Six requests were selected before study outputs existed. Selection is purposive and covers known failure modes; it is not a representative sample or an accuracy estimate.

| Request | Split | Reason for selection |
| --- | --- | --- |
| stat-01 | dev | Foundational mean/median explanation for a high-school beginner |
| stat-02 | dev | Standard deviation and variance formulas, units and scaling |
| stat-08 | dev | Central limit theorem prerequisites and the distinction between observations and sample means |
| stat-15 | dev | Regression interpretation, extrapolation and consistency across dollar/thousand-dollar source versions |
| stat-18 | heldout | Actual box plot, whisker convention and source figure grounding |
| stat-24 | heldout | Refusal of a requested theorem outside the supplied textbooks' scope |

The frozen request fixture is `bench/rag/fixtures/knowledge-base-pilot-questions.json`, SHA256 `f7d1dd5f8350c004774e6ccbed91a64f43d5e4926c7aa165535210ce4cd61416`. Expected labels and source-check fields are review criteria only. They are not model inputs.

Arm A uses the production hybrid retrieval and per-file cap. Arm B reranks the same candidate pool with evidence-checked topic/role tags. Generation uses normal Qwen3.8-Flash, thinking disabled, request-level strict JSON Schema, following the revised decision in `human/agentic-retrieval.md`. The corpus remains the original parser/chunker v3/v9 run. Later parser improvements are not part of this comparison.

For each arm, the review compares the actual generated note and questions with that request's supplied excerpts in `data/knowledge-base-pilot/run/models/materials/input.jsonl`, SHA256 `bf483accc9d32b9c0f751c851daf44e78c9fbde3a695b5023a429df9b39dd754`. Excerpt IDs and one-based PDF pages identify the evidence. Schema-valid IDs alone do not establish semantic support. No providers are called and no running output is changed for this review.

## Source checks completed before generation

- **Mean/median:** LSJ excerpt `exc_45ecdb7da7734b_95`, PDF pp78–79, supplies incomes 50,000, 60,000 and 65,000, then adds an income of 100,000,000. It reports means 58,333 and 25,043,750 and medians 60,000 and 62,500. The text says the appropriate summary depends on the purpose; it does not declare the median universally better.
- **Units and conventions:** AHSS excerpt `exc_0689cddaba206d_86`, p39, supplies the sample denominator `n−1` and same-units versus squared-units distinction. Its scaling example `exc_0689cddaba206d_94`, p41, gives SD 2 for the list 1, 1, 5, 5, with a footnote explicitly specifying population SD. An explanation must not present that value as the sample SD.
- **Regression:** AHSS `exc_0689cddaba206d_915`, p460, expresses both income and aid in thousands, with intercept 24.3 and slope −0.0431. OS4 `exc_f213361bf057b0_727`, p360, uses dollars and intercept 24,319. AHSS `exc_0689cddaba206d_919`, p461, contains the book's inconsistent `0.431(1000)` line despite the preceding model coefficient 0.0431 and result −18.8. A generated example must maintain one convention and not propagate the faulty arithmetic.
- **Box plot:** The original AHSS p45 capture, Figure 1.28, visibly marks the median, quartiles, whiskers and two high outliers. Excerpts `exc_0689cddaba206d_108` and `_109` supply the caption and rule: whiskers end at the most extreme observed values within the 1.5 IQR bounds, not at the bounds themselves. The lower whisker reaches approximately 5 percent.
- **A source-level figure/text conflict:** LSJ `exc_45ecdb7da7734b_110`, PDF p100 / printed p85, says that values 46 and 163 exceed an upper bound of 107. Direct inspection of the PDF confirms this wording is printed in the book. The chart's two high dots have labels 46 and 163 but vertical positions near 108 and 116. Those labels appear to identify observations, not their measured values. A generated explanation should avoid turning them into plotted values. The review render is retained at `data/knowledge-base-pilot/study-review/lsj-p100.png`.

## A/B output review

The material stage stopped after provider stalls, with `complete: false` and `status: interrupted_after_stalls`. Across all 48 planned requests, 18 started: 12 schema-valid responses were retained, six failed or had uncertain outcomes, and 30 were not started. Four of the six failed/uncertain calls were interrupted in flight; their raw `sending` receipts remain unchanged. No response is inferred for them. Known usage covers the 12 received calls only; six attempts lack usage receipts.

Only four received outputs belong to this review's frozen selection: stat-01-A, stat-01-B, stat-02-B and stat-08-A. These form one complete pair and two single-arm observations, not six completed comparisons. Review used the actual records and the aggregated `models/materials/realtime/results.json`; final study export did not complete. The other eight received outputs were not substituted into this sample.

| Request | Arm A | Arm B |
| --- | --- | --- |
| stat-01 | Correct LSJ arithmetic, but the closing sentence wrongly says the new mean of $25,043,750 is earned by nobody “except Bill.” Bill earns $100,000,000, so nobody in the example earns the mean. Its limitation also changes “overall income” into “total wealth.” These are generation errors despite relevant provenance. | Reproduces LSJ's income example and mean/median arithmetic correctly. Uses LSJ `_95` and AHSS `_83`, and explicitly excludes the irrelevant county-weighted-mean example. Clear beginner explanation; focuses on typical income and avoids A's false aside. |
| stat-02 | Uncertain request outcome; no output reviewed | Correct same/squared units and doubling result: SD ×2, variance ×4. However, the general claim that multiplying by a constant multiplies SD by the same factor is false for negative factors. It needs “positive factor” or absolute value. The supplied p42 scaling example only uses positive 9/5. |
| stat-08 | Correctly distinguishes a distribution of sample means from raw observations; defines the former and qualifies n≥30 as a rule of thumb. SEM decreases with n, matching LSJ `_165`. However, the explanation omits the explicit random-sample condition present in AHSS `_418`/`_419`, leaving prerequisites incomplete. | Interrupted in flight; no output reviewed |
| stat-15 | Not started; unreviewed | Not started; unreviewed |
| stat-18 | Not started; unreviewed | Not started; unreviewed |
| stat-24 | Not started; unreviewed | Not started; unreviewed |

The stat-08 A/B input excerpts are identical, including order; differences in its generated materials cannot be attributed to changed retrieval. Other context changes are concrete: stat-02 B replaces AHSS's p41 population-SD example with p42's temperature transformation; stat-15 B removes the p461 typo/extrapolation example and adds OS4 p359/360; stat-18 B removes LSJ's conflicting outlier prose and adds OS4's IQR definition. Context changes alone are not proof of improved material quality.

### Concrete checks on received outputs

- **stat-01-A/B arithmetic:** `(50000 + 60000 + 65000) / 3 ≈ 58333`; adding 100,000,000 gives `100175000 / 4 = 25043750`; the middle pair gives `(60000 + 65000) / 2 = 62500`. Both outputs get these right. A then contradicts its own stated Bill income with “which no one at the table actually earns except Bill.” The source does not contain that aside. B avoids it. Both draw the main explanation from the same LSJ excerpt, so a one-run difference does not isolate a tag effect.
- **stat-02-B scaling:** Its text says SD is multiplied by “that same factor” for a general constant. For a factor of −2, that would produce a negative SD. The appropriate general expression is `SD(aX) = |a| SD(X)`, while `Var(aX) = a² Var(X)`. The response's specific positive doubling answer is correct. Its five questions cover units, interpretation, positive conversion, shifts and a distributional rule; they do not expose the negative-factor error.
- **stat-08-A prerequisites:** The note explains repeated sample means before applying the CLT, a useful teaching sequence. It preserves the source's fixed mean/SD qualification and says n≥30 is a rule of thumb. The source explicitly calls for random samples; neither the note nor its five practice questions states or checks that condition. This is an instructional omission, not a claim that its raw-data distinction is wrong.
- **Scope of figure and refusal evidence:** The received mean/median notes reference the caption-backed LSJ figure and do not invent plotted values. However, no output for the selected figure-dependent box-plot request or out-of-scope spectral-theorem request exists. The review therefore makes no claim about visual interpretation or reliable refusal.

## Interpreting the tag intervention

The tag export contains 2,315 classified excerpts. The root audit counted 799 with verified evidence and 1,616 review rows; review rows do not by themselves mean incorrect topics. Arm B admits only confident role/topic matches whose evidence passes the quoted-text check.

Ten baseline excerpts from the selected cases were checked before material generation: LSJ `_95`, `_103`, `_165`, `_110`; AHSS `_86`, `_699`, `_915`, `_919`, `_109`, `_108`, with the full source-specific prefixes used above. All ten fail the exact evidence check. Their evidence fields generally join real phrases with literal ellipses, so they are not contiguous quotations after whitespace normalization. For example, the AHSS p39 SD evidence joins its square-root definition to the separate sentence about squared units. Its `spread` topic matches the passage, but that does not satisfy the quotation contract. These examples explain why valid subject classifications can be excluded from B's intervention. They do not justify relaxing the check or treating all review rows as correct.

## Limits

Only four outputs from the six selected requests were received, all from the development split. The two selected held-out requests never started. This review cannot establish corpus-wide correctness, held-out performance, or a causal quality gain from tag reranking. Model-generated tags were checked for schema and quoted evidence, not reviewed by a human subject expert. The two OpenIntro books share source lineage and do not constitute independent corroboration. Figure captures are available for this review, but the material model receives source text and figure metadata without the image pixels; successful text-based figure references do not demonstrate visual interpretation.

The full pilot remains incomplete. The received examples justify a narrow conclusion: relevant source excerpts and validated provenance can produce useful teaching material, but neither schema validation nor attribution catches every mathematical or explanatory error. No acceptance rate, winning arm or blanket accuracy claim follows from this sample. No provider switch, repair call, regeneration or production change was made for this review.
