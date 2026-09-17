# Selective formula and table recovery

Date: 2026-09-16. MinerU complete; Qwen Batch pending. The provider comparison remains unfinished until the submitted jobs return.

## Scope and frozen inputs

Sixteen manually selected regions compare MinerU 3.4.5 CPU pipeline transcription with Alibaba Qwen3.8-Flash asynchronous Batch transcription. Seven regions revisit known textbook failures; nine come from two newly acquired source families. Six regions contain tables with formulas in their cells. Selection is manual, so these results do not measure automatic routing or crop recall.

New source review happened before either candidate produced output. The [source manifest](../fixtures/selective-recovery-sources.json) records hashes, legal download locations and source-reviewed heading, banner, diagram-label and repeated interior-text checks. The [case fixture](../fixtures/selective-recovery-cases.json) records page numbers, PDF-point crop boxes, mathematical gold, table associations and neighboring-text anchors. Pages are one-based PDF pages.

| Book | Source family | PDF pages | Download and licence |
| --- | --- | ---: | --- |
| Analyse, première année | Exo7, French mathematics | 207 | [Official PDF](https://exo7.emath.fr/cours/livre-analyse-1.pdf), CC BY-NC-SA 3.0 France printed on PDF page 204. Benchmark use only; no commercial redistribution claim. |
| Linear Algebra, fourth edition | Jim Hefferon | 525 | [Author-linked university PDF](https://jheffero.w3.uvm.edu/linearalgebra/book.pdf), [author's CC BY-SA 3.0 US licence option](https://hefferon.net/source.html). |

An OpenStax download returned HTTP 403 and was skipped. Hefferon's university mirror is an author-provided public download. No source crops were published to a public bucket or site.

Both engines receive identical raster visual content. Each original PDF crop is rendered at 180 DPI once. Qwen receives the PNG as an inline Base64 image. MinerU receives that same PNG inside a one-page raster-only PDF. Their internal resizing and recognition may differ. This compares selective visual recovery, not original-native PDF extraction. The shared ODL full-book baseline and fixes are evaluated separately.

The initial r1 crops were inspected visually. Before submission, r2 removed partial edge glyphs and corrected prose anchors to the text actually inside the crop. Source gold was not revised after observing a candidate. The r2 request file SHA256 is `9bff678372be9bd8d1a4315532ae7e8121c5b8b9e182b729e0a6c7f6c521f9a3`. Maximum serialized line size is 81,281 bytes.

## Scoring

- Mathematical checks preserve operators, signs, radical and fraction scope, superscript/subscript binding and literal source values. Equivalent LaTeX formatting is allowed.
- Table checks require the right value under the right row and column headers. LSJ Table 14.9 adds a `read textbook` header spanning two data columns. Its unruled `attended?` label does not uniquely establish an exact HTML rowspan, so that encoding abstains. The two Exo7 tables contain nine derivative rows each. Hefferon's three tables contain fourteen dimensional-formula rows in total.
- The AHSS source prints `0.431(1000)` after a previous line using `0.0431`. Retaining that inconsistency is a transcription pass; silently correcting it is a failure.
- Neighbor checks score only the explicitly frozen visible prose/caption anchors. They do not establish complete prose accuracy. Formula gold does not cover every incidental mathematical token in surrounding prose.
- Unreadable source or uncertain gold receives an explicit abstention. Output uncertainty is recorded separately from correctness.

The [adjudication notes](../fixtures/selective-recovery-adjudication.json) also exclude one incorrect frozen prose anchor. AHSS says family income units `are in $1000s`; the fixture mistakenly wrote `is`. The source was rechecked during output review, and this anchor abstains for both engines. The 57 mathematical checks remain unchanged. Adjudication was performed by the reviewing agent against the original rendered source, without a model judge.

## API protocol and cost basis

Alibaba's [Batch guide](https://help.aliyun.com/en/model-studio/batch-inference) lists Qwen3.8-Flash image input in Beijing. Its [Batch API reference](https://help.aliyun.com/en/model-studio/batch-interfaces-compatible-with-openai) explicitly supports Base64 image inputs for multimodal tasks. The generic guide's public-URL requirement applies when supplying a remote URL; this experiment supplies image bytes directly. The API reference currently lists a 6 MB line limit, but this run retained the existing client's stricter 1 MB limit.

The prompt asks for faithful transcription, LaTeX mathematics, HTML tables with explicit spans and existing surrounding prose/captions. It forbids solving, correcting printed errors, filling missing content and inventing figure descriptions. The expected answers are absent from the prompt. Settings are temperature 0, `enable_thinking=false`, maximum 8,192 output tokens and JSON object output with `markdown` and `uncertain` fields. The existing durable Batch client is reused without changes; the old knowledge-base Batch jobs remain untouched.

The checked [Beijing price](https://help.aliyun.com/en/model-studio/model-pricing) is CNY 0.8 input and CNY 2.7 output per million tokens, discounted 50% for Batch. Usage-derived cost is therefore input tokens × 0.4/1,000,000 plus output tokens × 1.35/1,000,000. This is a list-price estimate from actual returned usage, not an account invoice; free quotas and promotions may alter the bill. Provider queue/processing wall time is separate from local MinerU call latency.

## Reproduction and receipts

Runner: [compare_selective_recovery.py](../scripts/compare_selective_recovery.py). Ignored receipts: `bench/parsers/reports/local/2026-09-16-selective-recovery/`.

```powershell
.venv/Scripts/python.exe bench/parsers/scripts/compare_selective_recovery.py prepare --output <new-run-directory>
.venv/Scripts/python.exe bench/parsers/scripts/compare_selective_recovery.py submit --output <new-run-directory>
.venv/Scripts/python.exe bench/parsers/scripts/compare_selective_recovery.py collect --output <same-run-directory>
```

Inside the existing isolated MinerU container, use `/opt/mineru/bin/python`, run the runner's `mineru` mode with `--inputs` pointing to the frozen r2 directory under read-only `/repo`, and write `--output` under `/tmp`. Copy receipts back to this experiment's ignored directory. Two sequential passes use four CPU threads. Imports are timed separately; per-case timing includes MinerU's parse and artifact dumps, excluding the preceding source raster render and input read. The container was stopped after inference.

The first launch used a host-only PDF import unavailable in the MinerU environment and exited before inference. Moving that import into the render function resolved it. The initial French language setting `fr` was also invalid for MinerU 3.4.5. Its installed `mineru/utils/ocr_language.py` documents `latin` as an alias for the multilingual `ch` OCR model. Ten failed French calls are retained as configuration errors, costing 107.63 local call-seconds. Only the five French cases were rerun, twice, with `latin`. The successful English and French cohorts therefore ran in separate processes. These setup errors are excluded from recognition accuracy and valid latency, and retained in the receipts.

The one-request Base64 capability probe is `batch_ab797952-3274-4208-8910-1dfb8feb76e3`. The 16-case comparison is `batch_f9116dde-41f8-4496-8af6-a2d896cf6d89`. Each has its own durable client state. One read-only probe collection failed with a transport error; collecting the same saved batch succeeded afterward. No duplicate submission followed that error.

## Results

### MinerU

All sixteen cases produced usable output in both valid passes, with identical Markdown hashes between passes. Repeated determinism is not independent accuracy validation.

| Measure | Result |
| --- | ---: |
| Exact pinned mathematical checks | 50 / 57 |
| Prior-known mathematical checks | 12 / 13 |
| New-family mathematical checks | 38 / 44 |
| Mathematical cells with correct value and row/column association | 27 / 36 |
| Complete mathematical tables, including headers and associations | 1 / 6 |
| Visible neighboring prose/caption anchors | 26 / 27 scored; one gold typo abstains |
| Exact source row-span encoding | One ambiguous LSJ check abstains |

These are results on selected source regions, not an estimate of whole-book accuracy. The mathematical-cell metric requires the corresponding left-hand function or quantity label to remain correct. Ordinary mathematical font styling is ignored; changing Greek alpha to Latin a, lowercase x to uppercase X, adding an overline, or adding a stray term fails.

| Region | Exact math checks | Mathematical cells | Material result |
| --- | ---: | ---: | --- |
| OS4 standard deviation | 1/1 | — | Restores `s = √25.52 = 5.05`. |
| OS4 standard error | 1/1 | — | Correct nested radicals/fractions; drops the visible example-ending line. |
| OS4 27/212 | 1/1 | — | Correct numerator, denominator and result. |
| OS4 appendix SE | 1/1 | — | Correct radical and fraction scopes. |
| AHSS Bayes | 3/3 | — | All successive fractions correct. |
| AHSS source typo | 1/2 | — | Preserves printed 0.431 but omits the preceding 0.0431 equation. |
| LSJ Table 14.9 | 4/4 | 4/4 | Beta cells correct; `read textbook` incorrectly spans all four columns instead of two data columns. |
| Exo7 ordinary derivatives | 7/9 | 6/9 | Alpha becomes a; cos x is emitted as COS X in a row label and a derivative cell. |
| Exo7 composite derivatives | 9/9 | 9/9 | Only completely correct table in this set. |
| Exo7 quotient derivatives | 4/5 | — | Appends an extra g² after the quotient derivative. |
| Exo7 inverse derivative | 1/1 | — | Nested inverse and denominator scopes correct. |
| Exo7 extremum definition | 4/4 | — | Both non-strict inequalities, intersection and derivative check correct. |
| Hefferon pendulum table | 4/5 | 1/5 | Invented overline; merged mass/gravity labels; shifted arc row association. |
| Hefferon orbit table | 4/5 | 4/5 | Invented overline on the first formula. |
| Hefferon wave table | 3/4 | 3/4 | Invented overline on the first formula. |
| Hefferon pendulum equation | 2/2 | — | Radical and negative exponent correct. |

The 26/27 anchor result is narrower than complete neighboring-text preservation. Hats on p or f disappear from prose in the OS4 SE, OS4 appendix SE and Hefferon equation crops, despite their main formulas passing. This is a concrete collateral change that a replacement gate must catch. Tight cropping can also alter MinerU's body/furniture decisions, as seen in the missing example-ending line. These results do not prove that copying whole crop output back into the document is safe.

Valid first-pass calls sum to 207.45 seconds, with a 9.52-second median. The second passes sum to 146.20 seconds, median 8.35 seconds, range 1.99–18.30 seconds per region. English and French imports separately took 5.32 and 3.56 seconds. The first-pass sum includes two process starts and initial model work; it is not one uninterrupted sixteen-case job. No GPU inference was used. Receipts are `mineru-r2/`, `mineru-latin/`, `r2/timings.json` and `r2/manual-review.json` under the ignored experiment directory.

### Selection coverage and ODL context

The [saved-artifact snapshot script](../scripts/compare_selective_recovery_review.py) checks region overlap against the original three pilot bundles and the parent's fresh baseline bundles for the two new books. Only 2/16 manual crops overlap any chunk below confidence 0.9. Only 2/6 mathematical-table crops overlap a parser block typed as a table, both Exo7 tables. Those detected tables still lose fractions, radicals, exponents and set symbols in cell text.

This is a limited routing proxy. An overlapping low-confidence chunk need not identify the damaged formula, and existing table classification does not create a precise crop. No automatic selector was implemented or evaluated. The successful manual recovery of known OS4 fractions therefore does not establish that the pipeline would automatically find them. Receipt: `r2/odl-baseline.json`.

### Qwen Batch

At the collector's verified startup, 2026-09-16 10:14:15 UTC, the sixteen-case batch was still `in_progress`, 0/16 completed and 0 failed, about 20.3 minutes after creation. The earlier single-image probe was also `in_progress`, 0/1 completed, about 30.5 minutes after creation. Provider `in_progress_at` equals `created_at`; these fields do not distinguish queue delay from inference work. No usage or transcript has returned, so accuracy and actual token cost are unavailable. Acceptance of a Batch job does not establish image transcription success.

A hidden collector process, PID 23292 at startup, is running on this PC for at most two hours. It polls the two saved IDs every five minutes, retries only read transport failures, and never uploads, submits or retries failed inference requests. It stops once both jobs reach a terminal state or its deadline expires. Other API/validation errors stop it with a saved error status. Completed responses are validated by the existing Batch client, then copied into `transcripts/` with `usage-summary.json`. The old pilot jobs are untouched.

`r2/watch-process.json` records the executable, argument array and start time. `r2/watch-status.json` records progress; redirected stdout/stderr are beside it. Startup was verified with both recorded job IDs and empty stderr. Resume only after the previous collector has stopped, using the same saved state:

```powershell
.venv/Scripts/python.exe -X utf8 bench/parsers/scripts/compare_selective_recovery.py watch --output bench/parsers/reports/local/2026-09-16-selective-recovery/r2 --max-wait-seconds 7200
```

The offline [check script](../scripts/compare_selective_recovery_check.py) passed for all sixteen inputs. It verifies that the Base64 bytes equal the PNG bytes and that each raster-only PDF embeds precisely the same pixels with no native text. Its fake read-only client verifies recovery from a transport failure and stopping at terminal completion. Ruff checks and Python compilation passed. Recognition scoring still requires source review after the Batch outputs arrive; the collector does not decide correctness or a production backend.

### Initial conclusion, superseded below

Selective visual recovery can restore mathematical structure missing from native ODL text, including formulas inside tables. The observed MinerU errors rule out blind whole-region replacement. Qwen's comparative quality and usage remain unmeasured until collection finishes. No production transcription backend has been selected or integrated by this experiment.

### Requested status recheck

At 2026-09-16 11:25 UTC, fresh read-only API requests still report the vision
comparison `in_progress`, 0/16 completed and 0 failed after 91.15 minutes. The
probe is also `in_progress`, 0/1 after 101.29 minutes. Neither has output/error
files or an API error. The collector is alive. Receipt: `status-recheck.json`.
ODL is not executing inside these jobs: each contains image bytes and a Qwen
transcription prompt. Full local ODL parsing already finished separately.

The older knowledge-base tagging jobs were checked separately. All 12 provider
jobs are completed. Collecting their existing files yields 2,308 JSON-decodable
responses, six invalid JSON responses and one provider HTTP 400
`invalid_parameter_error`; zero requests are missing. The provider says the
HTTP 400 occurred because generation under JSON response format became invalid
and was aborted. These are output failures, not an ODL timeout. This collection
does not certify tag-schema correctness or semantic quality and does not resume
the downstream pilot. The old driver remains stopped on `failed_shards`.
Receipts: `old-tag-jobs-status-recheck.json`, `old-tag-jobs-collected.json`,
`old-tag-jobs-usage-recheck.json`. No inference was resubmitted.

At 11:53:47 UTC, another direct read-only API check reports the comparison
still `in_progress`, 0/16 after 119.85 minutes, and the probe 0/1 after 129.99
minutes. Neither has a reported failure or output/error file. Receipt:
`status-final-recheck.json`. The collector remains alive. These observed waits
are provider Batch wall time; they cannot be attributed to local ODL parsing.
The API fields still do not separate queue time from inference time. Alibaba
documents Batch as asynchronous background work with a completion window;
short local parser execution does not determine that service's turnaround.
[Batch documentation](https://help.aliyun.com/en/model-studio/batch-inference),
[Batch API](https://help.aliyun.com/en/model-studio/batch-interfaces-compatible-with-openai).

### Normal API and strict-schema follow-up

Epo requested normal API calls with thinking disabled. The collector was stopped
after its process identity was verified. Cancellation was accepted for the
sixteen-case Batch job; its terminal state is `cancelled`, with 16 provider
requests completed and none failed before cancellation took effect. All outputs
were collected: 12 JSON objects passed basic decoding and four failed it. Its
6,658 input and 2,801 output tokens remain billable usage evidence, estimated
CNY 0.006445 at the dated Batch rates. This is separate from normal calls. The
single-image probe also completed and was collected. No new Batch jobs were sent.

The [normal API source review](2026-09-16-qwen-normal-recovery.md) records the
same sixteen crops through Qwen3.8-Flash with `enable_thinking=false`. The first
JSON-object pass took 14.22 seconds at four workers; three formatting retries
brought summed command time to 26.66 seconds. Those 19 calls used 8,345 input and
3,620 output tokens. All final objects had empty uncertainty lists, including
one table with missing row labels. That run passed 57/57 pinned math checks,
32/36 associated cells and 5/6 complete tables, with four tables violating the
requested HTML format. These are selected-case results, not whole-book accuracy.

On Epo's structured-output follow-up, requests switched to strict JSON Schema.
The schema-only pass took 17.50 seconds but still returned arrays for AHSS Bayes
and the Hefferon pendulum table. Separate text/image contract probes obeyed a
schema enum over a conflicting prompt value, showing the parameter is active
without establishing universal conformance. A fresh full pass with an explicit
one-object system instruction passed 16/16 schemas in 17.14 seconds, using 8,610
input and 3,337 output tokens. Exact-source quality is adjudicated separately in
the linked review. All crops and raw responses remain available for comparison.

New calls enforce local schema validation as well as request-level constraints.
Missing reasoning-token metrics are recorded as unavailable; request bodies
disable thinking and the returned reasoning content is empty. Usage for failed
calls and explicit retries is retained. Neither strict JSON nor model-reported
uncertainty authorizes automatic source replacement. No production transcription
backend or automatic crop selector was installed.

Current commands use `prepare` followed by `normal --workers 4`; `collect`
only reads historical Batch outputs. The old `submit` and `watch` modes are
retired. `compare_selective_recovery_check.py` now checks input pixel identity;
normal API durability/schema behavior is covered in the pilot's offline tests.
[Alibaba structured output](https://help.aliyun.com/en/model-studio/qwen-structured-output).
