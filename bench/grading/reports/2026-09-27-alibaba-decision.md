# Alibaba decision model, 27 September 2026

Stopped at the developer's request. No additional requests or experiments are
planned. Application grading was not changed.

The hosted `decision-model-preview` was tested through the configured Singapore
workspace using Alibaba's documented
[System One API](https://www.alibabacloud.com/help/en/model-studio/decision-model-api).
The environment variables are named `ALIBABA_BEIJING_KEY` and
`ALIBABA_BEIJING_URL`, but the configured endpoint is in `ap-southeast-1`.
The key was loaded from ignored `.env.local` and was not saved in artifacts.

## Completed comparisons

The [runner](../scripts/alibaba_decision.py) reused the archived Jev requests
prepared by [laya_cpu.py](../scripts/laya_cpu.py). There were 159 rubric pilot
requests and 801 math, equivalence and routing requests. Both runs completed
without API or response-validation failures. Eight workers used persistent
HTTPS connections, with no retries. Jev numbers below come from the archived
September 19 responses, not a new API run. All primary decisions use >= 0.5.

| Matched rubric cases | Archived Jev | Alibaba |
| --- | ---: | ---: |
| 63 seed answers, two question families per domain | 61/63, 96.8% | 17/63, 27.0% |
| All 96 essay answers | 86/96, 89.6% | 36/96, 37.5% |

Alibaba credited 57/62 unmet seed marking points and 146/170 unmet essay
points. It missed 0/64 met seed points and 4/214 met essay points. It strongly
over-credits answers. Even an optimistic cutoff sweep chosen after seeing
these same labels reached only 40/63 seed awards and 61/96 essay awards,
both at 0.95. This sweep is not held-out calibration.

| Probe, excluding arguable labels | Archived Jev | Alibaba |
| --- | ---: | ---: |
| Incorrect worked math accepted, no reference | 17/35 | 35/35 |
| Incorrect worked math accepted, final reference | 13/35 | 35/35 |
| Incorrect worked math accepted, worked reference | 3/35 | 35/35 |
| Wrong final-value equivalences accepted | 1/25 | 25/25 |
| Wrong unit conversions accepted | 27/120 | 117/120 |
| Wrong algebraic equivalences accepted | 10/115 | 110/115 |
| Question-only compute routing correct | 99/99 | 94/99 |

Both models accepted all genuinely correct/equivalent answers in those
math/equivalence sets. Alibaba's errors are overwhelmingly false acceptance.
One unsafe routing miss was "Is 91 a prime number? Explain.", with computation
probability 0.23. Routing agreement does not establish suitability as a grader.

Twenty additional control requests checked input representation and decision
formats. The same mitochondria rubric was credited for a blank answer and
"Paris is the capital of France." at 0.98 with the original `noul` prompt.
Plain text versus object state, a more direct instruction, `choice` and
`score` formats did not fix this behavior. Simple cat/dog controls passed.
The endpoint can classify simple state facts; the observed grading failures
cannot be explained merely by every response having the same constant value.
One initial connection check also succeeded.

## Timing and limits

The 159-request pilot took 13.72 seconds at concurrency eight, consuming
48,504 reported input tokens. Client p50/p95 was 0.554/1.783 seconds;
reported server p50/p95 was 313/612 ms.

The 801-request probe run took 57.68 seconds, consuming 141,311 input tokens.
Client p50/p95 was 0.541/0.738 seconds; reported server p50/p95 was 295/343 ms.
These are developer-PC-to-Singapore API measurements, including connection
setup for the initial requests. They are not CPU or VM deployment measurements.

The rubric pilot covers 16 seed question families and 16 essay subjects.
The full 1,592-seed corpus was not run. Labels are AI-authored/reviewed
synthetic examples, not human-certified student submissions. The hosted
preview returns a model alias rather than an immutable weight revision.

## Preserved evidence

Ignored local artifacts are under `data/grading-benchmark/alibaba-20260927/`:
`pilot.jsonl`, `probes.jsonl`, their summaries, `requests-probes.jsonl`,
`controls.json` and `format-controls.json`. Control files contain the full
request and response objects. The original replay input and source hashes
remain under `data/grading-benchmark/laya-20260927/`.

The [Laya report](2026-09-27-laya-cpu.md) records its completed pilots,
interrupted wider run, checksum-verified local copies and removal of all
Laya weights and the isolated runtime from the ingest VM at 03:00 UTC.
