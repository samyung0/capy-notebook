# GLM curate-loop content review: first nine knowledge-scope cases

Reviewed the fixture criterion, saved material, `run.json` calls and `text_sent_to_model`, `retrieval.json`, and every saved capture for:
`statistics-overview`, `regression-general`, `regression-by-hand`, `regression-r`, `independent-t-test`, `paired-t-test`, `jamovi-t-test`, `mean-median`, and `leadership-general`.

Verdict labels judge the saved note's request-scope fit and factual/source support. Capture compliance is reported separately, because a sound note can still violate the read/capture workflow.

## Aggregate

- Request/scope and source-support verdicts: 6 pass, 3 partial, 0 fail.
- Read-before-write: **9/9 compliant**. Every excerpt ID attached to the successful material write had a prior successful `read_knowledge` call. Some first writes were refused, but the successful retry followed the reads.
- Capture: **0/9 fully compliant** under the prompt's strict rule for source-specific numerical results, formulas, table cells, relationships, and figures. Three cases made a successful capture before writing (`regression-general`, `regression-by-hand`, `independent-t-test`), but each used additional uncaptured formula/table/output facts. Six cases made no capture despite using such facts.
- Capture attempt count: **3/9**; complete capture coverage: **0/9**.

## Material findings

### statistics-overview: PASS content; capture fail

- Request fit: Good beginner introduction. It explains descriptive and inferential statistics and their uses. It does not become a software tutorial, epilogue, or objectives list.
- Source support: The central distinctions are supported by reads of `exc_f97f47b7a1fd68_5_v2`, `exc_f97f47b7a1fd68_6_v2`, `exc_45ecdb7da7734b_139_v3`, `exc_45ecdb7da7734b_153_v3`, and `exc_e49c11171c5f1c_269_v1`. The probability-versus-statistics contrast is explicitly in `exc_e49c11171c5f1c_269_v1`; descriptive versus inferential and sampling bias are explicitly in the Hebl excerpts.
- **Medium, capture:** The note reproduces source-specific Olympic means `2:44:22` and `2:13:18`, and polling values such as `1,000`, `4.6 million`, `23%`, and `29%`, with no capture call. Those are table/example facts subject to the capture rule. `retrieval.json` and the reads support the text, but text support does not replace required visual verification.
- **Minor, support:** “Statistics is the science of collecting, summarizing, and interpreting data” is a plausible synthesis, but none of the attached excerpts states that full definition. The excerpts directly support summarizing data and inferring from samples.

### regression-general: PARTIAL

- Request fit: Good one-predictor explanation and a coherent worked exam-score prediction. It does not require a software workflow. The capture of page 113 verifies `y-hat = -173.51 + 4.83x`, prediction at `x=73`, observed range `65–75`, and the slope interpretation.
- **Medium, unsupported formula:** The note says `b = r(s_y/s_x)` and `a = y-bar - b x-bar`. Its only attached/read excerpts are `exc_64ed84430ae3b2_261_v2` and `exc_64ed84430ae3b2_262_v2`. Those passages define least squares, give the fitted exam equation, range, and slope meaning, but they do not give either summary-statistic formula. The page-113 capture does not show them either.
- **Capture:** Partial only. It captured the fitted line and prediction guidance, but did not capture the added coefficient formulas or the page-112 least-squares/SSE presentation.

### regression-by-hand: PASS content with a minor numerical presentation issue; capture fail

- Request fit: Strong. It is self-contained, uses one predictor, and walks through slope, intercept, line, check, and prediction without requiring software.
- Source support: `exc_f213361bf057b0_564_v3`, `exc_f213361bf057b0_566_v3`, and `exc_0689cddaba206d_703_v3` support the Elmhurst data, formulas, fitted equation, and conditions. The capture of page 358 verifies the means, standard deviations, correlation, and slope formula.
- **Minor, numerical wording:** “These hand values match the software output ... up to rounding” conceals a visible mismatch between the hand intercept `24,327` and software intercept `24,319.3`. It results from using the rounded slope `-0.0431`, so the work remains coherent, but “match” is too strong. State that the difference comes from rounding the slope.
- **Medium, capture:** The note quotes uncaptured software output `24,319.3` and claims the match. The single page-358 capture does not show the page-359 software table or the final software coefficients.

### regression-r: PARTIAL

- Request fit: The opening correctly teaches `lm(outcome ~ predictor, data=...)`, and `exc_dd1e65de648fb2_998_v2` directly supports the command and simple-model coefficients.
- **Medium, confusing model scope:** The note's main code and coefficient example use the simple model `regression_1 <- lm(danielle_grump ~ danielle_sleep, ...)`. In its generic `summary()` walkthrough, it then says “here R² = .816” without identifying the model. Read excerpt `exc_dd1e65de648fb2_1020_v2` says `.816` belongs to the two-predictor `regression_2` output. This placement can make a learner attribute `.816` to `summary(regression_1)`. The note does, however, explicitly label `F(2,97)=215.2` as coming from “the two-predictor version of this example” and labels `baby_sleep, p=.969` as coming from “the two-predictor model.” Those two claims are not a demonstrated silent splice or contradiction.
- **Medium, unsupported/overstated:** The exact `danielle_sleep p < 2e-16` is not present in any attached read. “Evidence that the predictor really is related” also overstates what a coefficient p-value alone establishes; it tests the model coefficient under assumptions.
- **Capture:** No capture despite source-specific coefficients, p-values, R-squared, F statistic, degrees of freedom, and an output table. This is a partial/confusing note rather than a demonstrated model/output contradiction.

### independent-t-test: PASS content; capture fail

- Request fit: Correct independent-groups variant, equal-variance Student test, and a complete hand calculation. It clearly distinguishes paired observations and mentions Welch rather than substituting it.
- Source support: `exc_f97f47b7a1fd68_315_v2` supports the Animal Research groups, assumptions, means, variances, and mean difference; `exc_858bafa062c60b_66_v2` supports pooled variance and `df=n1+n2-2`; `exc_45ecdb7da7734b_241_v3` supports the separate reporting example. The computed `t≈2.53` and two-sided `p≈.016` are numerically coherent with the stated givens.
- **Medium, capture:** The page-407 capture verifies the general test formula and mean difference, but not the page-406 table containing `n=17`, means, and variances. The note copies those values and computes pooled variance from them. It also reproduces the jamovi reporting block without capturing its output figure.
- **Minor, interpretation:** “Conclude that females rate animal research as more wrong than males do” should say the result supports a population mean difference under the stated sampling/model assumptions; the current wording is broader than the inferential qualification immediately above it.

### paired-t-test: PASS content; capture fail

- Request fit: Strong matched/repeated-measures explanation. It correctly treats the paired test as a one-sample test on within-person differences, gives `df=N-1`, keeps the difference direction explicit, and uses a coherent Chico worked example.
- Source support: `exc_45ecdb7da7734b_248_v3` and `exc_dd1e65de648fb2_882_v2` support the method; `exc_dd1e65de648fb2_885_v2` and `exc_45ecdb7da7734b_249_v3` support the example's means, SDs, `t`, `df`, `p`, CI, and effect size.
- **Medium, capture:** No capture despite copying the full source output table and numerical results (`58.385`, `56.980`, `1.405`, `0.970`, `6.475`, CI, and `d`).

### jamovi-t-test: PASS request/software fit; capture fail

- Request fit: Correct software and correct independent-samples variant. `exc_45ecdb7da7734b_241_v3` directly supports the jamovi path and variable boxes; `exc_45ecdb7da7734b_245_v3`, `exc_45ecdb7da7734b_250_v3`, and `exc_45ecdb7da7734b_261_v3` support Welch, one-sided settings, and Mann–Whitney in the same dialog.
- **Medium, capture:** No capture despite source-specific UI figures and numeric output (`74.53`, `69.06`, CI, `t(31)`, `d=.74`, Welch `t(23.02)=2.03`, `p=.054`). The interface steps are text-supported, but the source-specific figures/output still trigger the stated capture rule.
- **Medium, unwarranted generalization:** The worked report says the class difference is “suggesting a genuine difference in learning outcomes.” The read supports that phrase verbatim, but the agent was instructed to correct visible source overreach. A comparison of two tutors' classes establishes a sample/model mean difference, not that the tutors caused different learning outcomes.
- **Minor, focus:** Welch, one-sided tests, and Mann–Whitney are useful but make this less concise than the request required. They do not change the test variant, so this is a focus issue rather than a correctness failure.

### mean-median: PASS content; capture fail

- Request fit: Clear beginner explanation with a concrete example. It stays general even though one source is a jamovi book, satisfying the fixture's allowance for incidental contexts.
- Source support: `exc_45ecdb7da7734b_95_v3` directly supplies the income example and sensitivity explanation. `exc_0689cddaba206d_111_v3` supplies the definitions, skew direction, and robustness distinction. Arithmetic is correct.
- **Medium, capture:** No capture despite reproducing the source-specific income table and all of its numerical results.
- **Minor, support:** “For roughly symmetric data ... the mean is usually the default choice” is not stated in the attached reads. The sources say either mean or median can be acceptable for interval/ratio data depending on the goal. “Usually the default” should be removed or separately supported.

### leadership-general: PARTIAL

- Request fit: It identifies recognizable leadership ideas, and the final source note does disclose that both books come from educational administration. That disclosure prevents a fully silent substitution.
- **High, scope generalization:** The body repeatedly converts school-specific claims into universal leadership rules. For example, “effective leaders influence results ... by selecting, supporting, and developing effective people” comes from `exc_c93d5928c67e22_101_v3`, which specifically concerns principals selecting/developing teachers and managing school environments. “Leaders who try to do it alone are more likely to burn out” is sourced from school principals under accountability pressure. “Take a holistic view” and balancing external forces comes from `exc_f1615397c20971_68_v2`, whose reviewed scope explicitly limits it to public-school leaders under a 2008–2009 framing and says it is not evidence that the framework applies universally. A source note after the body is too weak to qualify each generalized prescription.
- **Medium, unsupported inference:** “Successful leaders ... choose what the situation demands” goes beyond `exc_f1615397c20971_68_v2`, which says successful leaders range from autocratic to collaborative behavior and gives Michele Rhee as a school example. It does not establish situational selection as a general rule.
- **Medium, support overreach:** “These skills can be learned and improved” follows a list including recognizing and managing others' emotions. `exc_f1615397c20971_19_v2` only says Goleman concluded that assessing and managing **one's own** emotions can be learned and improved.
- **Medium, capture:** No capture for the source-specific meta-analysis result `r≈.383, p<.05`.

## Compact verdict table

| Case | Request scope | Source support | Capture | Verdict |
|---|---|---|---|---|
| statistics-overview | Fits | Mostly supported | Fail | Pass content |
| regression-general | Fits | Added coefficient formulas unsupported | Partial/fail | Partial |
| regression-by-hand | Fits strongly | Supported; rounding phrasing weak | Partial/fail | Pass content |
| regression-r | Fits, but moves between simple and two-predictor examples | Unqualified R-squared and unread exact p-value; other two-predictor results are explicitly labeled | Fail | Partial |
| independent-t-test | Fits | Supported and coherent | Partial/fail | Pass content |
| paired-t-test | Fits | Supported and coherent | Fail | Pass content |
| jamovi-t-test | Fits; slightly overfull | Supported UI/test variant; causal wording too broad | Fail | Pass with caveat |
| mean-median | Fits | Supported; one minor default-choice claim | Fail | Pass content |
| leadership-general | Only partly general | School-specific claims generalized | Fail | Partial |
