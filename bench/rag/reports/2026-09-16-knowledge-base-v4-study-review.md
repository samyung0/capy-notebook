# Knowledge-base v4 pilot: independent study-output review

Date: 2026-09-16. Scope: the frozen six requests `stat-01`, `stat-02`, `stat-08`, `stat-15`, `stat-18`, `stat-24`, both A/B arms, including all 50 generated practice questions. No generation, repair, parser changes, or prompt changes were performed by this reviewer.

## Conclusion

The sample demonstrates useful source-based explanations and reliable refusal for the two out-of-scope outputs. It does **not** justify unattended study-material publication. `stat-02-A` contains an incorrect general scaling rule and misses the requested variance result; `stat-08-A` drops a theorem condition; `stat-18-B` repeats a false textbook figure reading and fails figure attribution. `stat-18-A` gives sound general box-plot instruction but does not deliver an activity using an actual displayed figure.

All 12 raw outputs passed local JSON-schema checks. Eleven were exported unchanged; `stat-18-B` remains raw-only because the existing provenance gate rejected it. Schema validity and valid source IDs do not establish mathematical correctness or adequate teaching coverage.

## Source preparation and audit

Checks were frozen **before reading generated materials** in `data/knowledge-base-pilot-v4/review/source-checks.json` (SHA256 `50417fad18a40677c76516107af5e6822bdb32a72c6cd51b84e613e4f58345e4`). All three original PDFs matched the corpus source hashes. The preparation used fresh baseline excerpts and original PDF text, with visual inspection of AHSS PDF p45 and LSJ PDF p100 for the box plots.

The completed receipt is `data/knowledge-base-pilot-v4/review/study-review-audit.json`. It records input/output hashes, per-output findings, exact source/figure IDs, export status, and checks that:

- Native model messages equal the prepared messages, and request payloads contain only the learner request and sources; fixture evaluation labels were not supplied.
- Supplied excerpt text and pages equal the fresh corpus.
- Native response text, parsed values, and adapter values agree; the eleven selected exported JSON materials preserve the raw material values.
- Requests used `deepseek-flash` with reasoning effort `none`; all twelve selected responses report zero reasoning tokens.
- All supplied/used excerpt IDs and question references exist. The only selected figure-to-used-excerpt failure is `stat-18-B`.

The model received complete retrieved text plus figure metadata/original captions, **not figure pixels**. The reviewer could inspect those pixels independently.

## Results by request

| Request | A | B |
| --- | --- | --- |
| `stat-01`: median and skewed incomes | Correct income arithmetic and explanation; purpose-dependent choice of mean/median. | Same correct arithmetic. Minor setup error: says four people before listing the original three. |
| `stat-02`: SD, variance, units, doubling | Revise: variance ×4 omitted; unrestricted negative-scaling rule wrong; population/sample convention blurred. | Correct SD ×2, variance ×4, units and negative-multiplier qualification. |
| `stat-08`: CLT versus raw data | Correct central distinction and heuristic threshold; missing fixed-mean/SD condition. | Retains the source condition and distinguishes population from sample means. |
| `stat-15`: regression and extrapolation | Correct units, slope, intercept and −$18,800 calculation using one AHSS model. | Same; avoids mixing the dollar and thousand-dollar versions of the intercept. |
| `stat-18`: actual box-plot figure | Correct whisker/outlier convention; incomplete figure activity in the exported Markdown. | Incorrect label/value interpretation; figure attribution rejected. |
| `stat-24`: unbounded spectral theorem | Correct refusal; no invented proof or practice questions. | Correct refusal despite different retrieved statistical material. |

### 1. `stat-02-A`: missing target concept and misleading calculation convention

The request explicitly asks what happens to both variance and standard deviation when measurements double. A only states that SD doubles; neither its note nor its five questions/answers says that variance quadruples. B includes this conclusion.

A also says multiplying values by a constant multiplies SD by that constant, without restricting the constant to positive values. This is false for a negative multiplier: SD scales by the absolute value. The supplied AHSS excerpt `exc_0689cddaba206d_77` explicitly includes the −0.5 example and explains the positive SD multiplier. B preserves this qualification, though its preceding general sentence would be clearer if restricted to positive constants.

Finally, A introduces sample variance with denominator `n−1`, then gives `[1,1,5,5]` SD `2` without identifying the population convention. AHSS PDF p41 footnote29 explicitly identifies **population** SD for this example. Population variance is `4` and SD `2`; sample variance is `16/3` and SD approximately `2.309`. The numeric source example itself is valid, but the merged lesson does not make the convention clear. This is exactly the kind of consistency check needed when combining source passages.

### 2. `stat-08-A`: theorem qualification lost

Both outputs correctly explain that a sampling distribution concerns repeated sample means, not a transformation of the original observations. Both treat `n≥30` as a rule of thumb and qualify how population shape affects the required sample size. Their ramped-distribution examples are supported by LSJ `exc_45ecdb7da7734b_164`; they are not invented visual observations.

A omits the supplied AHSS qualification that the population has a fixed mean and standard deviation (`exc_0689cddaba206d_328`, PDF p192). Its question1 answer instead makes the broad claim without that qualification. B keeps the source condition. Neither arm explicitly teaches independence; both refer to random samples. This remains introductory coverage, not a complete formal theorem/prerequisite treatment.

### 3. `stat-18-B`: a source error becomes a teaching error

B says the upper fence is `107` and two observations, `46` and `163`, exceed it, then calls these the outlier values in its limitations. **46 is not above107.**

This error exists in the prose of LSJ PDF p100 and survives in `exc_45ecdb7da7734b_110`. The original Figure5.4 places labels `46` and `163` beside two dots around108 and116 on an axis ending near120. They are observation labels, not those dots' y-values. The source also explains that jamovi adds row-number labels in the supplied `exc_45ecdb7da7734b_113` (PDF pp102–105). Thus the model had conflicting source information, even without pixels. Its limitation that these values were not independently verified does not correct the false statement.

A avoids the bad numbers and correctly describes whiskers ending at observed values within the `1.5×IQR` fences rather than automatically at minimum/maximum or exactly at the fences. Both identify the relevant source convention; no universal min/max-whisker assumption was introduced.

B separately lists `fig_45ecdb7da7734b_735` while omitting its parent `exc_45ecdb7da7734b_113` from `excerpt_ids`. Its advice to keep legitimate outliers also comes from that omitted excerpt. `run/material-export.json` correctly records `Material figure has no attributed source excerpt`; no `stat-18-B` artifact was exported.

### 4. `stat-18-A`: figure references alone do not complete the requested activity

A's JSON lists the AHSS figures on PDF pp45–46 and LSJ Figure5.4. Its note and questions, however, explain generic parts of a box plot rather than walking through one named figure. The exported `run/materials/stat-18-A.md` has no image, figure number or page reference. It therefore does not give the learner the requested actual-figure exercise.

The raw JSON preserves the no-pixels limitation, but the Markdown export omits the `limitations` field. This is a pilot delivery limitation, separate from parser accuracy. Original figure metadata remains available for a future reader; it is not yet a completed visible study activity in this artifact.

## Other source and teaching checks

- **Income arithmetic:** LSJ PDF p79 supports $50,000/$60,000/$65,000, initial mean approximately $58,333 and median $60,000; adding $100,000,000 gives mean $25,043,750 and median $62,500. Both arms are correct. B gives results with fewer calculation steps than A. Both add a coffee-shop question without introducing its full scenario in the note; the source supports the answer, but the practice item is not fully self-contained.
- **Regression consistency:** Both use AHSS's model with both variables in thousands: `24.3−0.0431x`, slope −$43.10 per additional $1,000 income, intercept $24,300, and input1000 for a $1million income. They give the correct −$18,800 extrapolation result, caution against causal interpretation, and do not invent a numeric observed range. AHSS PDF p461 prints `0.431` in one substitution line, inconsistent with its own model and answer. Both outputs silently use the correct `0.0431`. These are adapted worked examples, not claimed verbatim quotations, so this is a source-discrepancy caveat rather than an arithmetic failure. It should remain visible in source curation.
- **Refusal:** Both `stat-24` outputs set `answerable=false`, produce zero practice questions, and explain why the supplied statistics excerpts cannot support the requested proof. Neither manufactures an operator-theory argument or uses incidental statistical theory as evidence.
- **Level and prerequisites:** The income explanation is accessible and the regression lesson defines its coefficients. The SD convention and CLT qualification problems show that citations alone do not supply prerequisite/consistency checks. No learner scores or study history were provided, so this experiment does not test progress-based adaptation or prerequisite diagnosis.

## What this comparison can establish

A/B messages are **identical** for `stat-01`, `stat-02`, `stat-08` and `stat-15`, not merely overlapping retrieval results. Their output differences are generation variation and cannot be credited to tags. `stat-18` and `stat-24` have different contexts; one draw per arm cannot separate the effect of that context change from generation variation. The former exposes a source-error risk, while the latter succeeds at refusal in both arms.

These are the same six frozen review IDs used earlier, with four development and two held-out fixture labels. Reusing them does not create a fresh independent generalization test. This is also not a controlled comparison against the older Qwen pilot: the parser corpus and generation model changed. No broad quality-superiority claim is supported.

The narrow result is useful: the fresh local pipeline can produce coherent, attributed lessons, but provenance gating catches only some failures. A teaching review must also check requested concepts, arithmetic conventions, theorem conditions, contradictions inside sources, and whether the exported artifact actually contains the requested figure activity. None of the factual issues above was automatically turned into a reliable low-confidence review item.
