# Jev partial credit and missing context

Direct three-way grading is the better candidate in this screening run.
With question context and ordinary marking-item strings, it matched 62/66
authored scores; applying 0.35/0.65 bands to a Boolean `noul` matched 55/66.
The bands gave zero to 10 of the 11 answers intended to earn half a mark.
Explicit per-item zero/partial/full criteria improved direct grading to 66/66.
This is synthetic screening, not production approval or human grading accuracy.

## Design and provenance

[`jev-partial-credit.json`](../fixtures/jev-partial-credit.json) contains 12
non-computational English marking items with six responses each: a correct
paraphrase, genuinely partial content, wrong content, a contradiction, keyword
stuffing and an attempted grading instruction. Eight items have self-contained
schemes; three refer to a shared stem, a previous part or a figure with its
relevant content fully described in text. The last figure is unavailable and
has no textual equivalent.

A Codex agent authored the fixture and expected grades. The parent agent
reviewed every criterion, answer label and missing-context exclusion before
inference. No human certified these labels. The fixture uses an explicit rule
that a contradiction of required content overrides correct content within the
same marking item. That rule is part of this experiment, not a new application
grading decision.

Each of 72 answers ran with and without question text. One HTTP request asked
for both a `choice` among zero/partial/full and a `noul` about whether the full
marking criterion was satisfied. The latter was mapped using the proposed
bands: below 0.35 gives zero, below 0.65 gives half, otherwise full. The two
outputs therefore share a request; they are not independent model runs.
Student instructions are treated as answer text in both methods.

Two scheme modes were run, 144 requests each:

- Explicit: full, partial and zero criteria for that particular marking item.
- Plain: only the full marking-item string, with generic grading rules.
  Fixture-specific partial/zero criteria and all gold labels stayed offline.

The plain follow-up checks applicability to the planned `markscheme: string[]`
format. It was run after the explicit results, on the same fixture, and is not
a held-out evaluation or independently calibrated policy. No prompt or label
was tuned to individual errors, and no failed request was retried.

## Results

All **288/288 requests** returned HTTP 200, valid output and model
`jev-1.13.0`, requested as `jev-latest`.

| Scheme | Question context | Scoreable answers | Direct correct | Bands correct | Direct correct half marks | Bands correct half marks |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Explicit criteria | Included | 66 | 66 | 56 | 11/11 | 1/11 |
| Explicit criteria | Omitted | 48 | 48 | 40 | 8/8 | 0/8 |
| Plain marking item | Included | 66 | 62 | 55 | 10/11 | 1/11 |
| Plain marking item | Omitted | 48 | 47 | 40 | 8/8 | 0/8 |

The denominators differ because questions requiring omitted evidence have
unknown gold in the context-free arm. Do not compare those percentages as if
they covered the same questions. On the 48 self-contained answers that are
scoreable in both arms, removing question text changed no grades in either
scheme mode or scoring method.

The 66 scored answers with context have 44 zero, 11 half and 11 full labels.
Repeated variants of an item are correlated, and most examples share the same
two-component criterion structure. The apparent perfect explicit-criteria
result is narrow evidence that Jev can follow these supplied rules.

Plain direct grading made four errors with question context:

| Item / answer | Expected | Direct | Error |
| --- | ---: | ---: | --- |
| Conceptual derivative / keywords | 0 | 0.5 | Credited a list of related terms |
| Shared-stem access objection / keywords | 0 | 0.5 | Credited a list of related terms |
| Previous-part machine action / partial | 0.5 | 0 | Missed credit for identifying the action alone |
| Transcribed food-web figure / keywords | 0 | 0.5 | Credited a list of related terms |

The bands produced one false half-credit award for the shared-stem keyword
list and missed ten genuine half marks. This is consistent with the underlying
question: confidence that the full criterion is satisfied is not the fraction
of the criterion satisfied. These results do not test a different proposition,
separate decisions about individual subrequirements, or alternative thresholds.

## Missing evidence

Each scheme mode includes 30 diagnostic requests with unknown gold: the three
context-dependent items without their question text, plus the unavailable
figure in both arms. They are excluded from accuracy, never labeled zero.

With context omitted, the direct method gave positive awards at confidence
at least 0.8 in six explicit-mode and five plain-mode requests. These are
unsupported by the supplied evidence, not measured grading errors. The
three-way choice has no abstain option, so even a zero is a forced output,
not proof that the model detected missing evidence correctly.

Keep shared stems, relevant prior-part details and adequate textual figure
descriptions when the scheme refers to them. A computation classifier alone
cannot establish that a text-only grader has enough evidence. This experiment
did not benchmark the classifier or an admission threshold.

## Run records and reproduction

| Mode | Ignored run directory | Input tokens | Median request latency |
| --- | --- | ---: | ---: |
| Explicit | `data/grading-benchmark/jev-partial-credit-20260927/` | 116,960 | 0.624 s |
| Plain | `data/grading-benchmark/jev-partial-credit-plain-20260927/` | 103,616 | 0.626 s |

Each directory contains `manifest.json`, `results.jsonl` and `summary.json`.
Manifests record fixture/runner/dependency hashes, endpoint, requested model,
concurrency and planned request identity. Results retain model-facing state,
decision definitions, resolved model, probabilities, usage and elapsed time.
The explicit run preceded the addition of the mode flag; that mode's
model-facing payload is unchanged in the current runner.

The runner uses four workers at most, a 60-second timeout and no retries. Its
first planned request validates the response shape before the rest proceed;
that response is retained, not repeated. The credential was passed through
hidden input and was not persisted in a file. Saved results contained no
credential marker.

```powershell
python bench/grading/scripts/jev_partial_credit.py --check
python bench/grading/scripts/jev_partial_credit.py --scheme-mode plain --dry-run
python bench/grading/scripts/jev_partial_credit.py --scheme-mode plain --key-stdin --output data/grading-benchmark/jev-partial-credit-reproduction
```

Use a fresh output directory. The self-check covers mode isolation, paired
context, threshold boundaries, malformed/non-finite outputs, failures and
unknown gold. Live calls are opt-in, not CI tests.

## Recommendation and remaining work

Prefer direct 0/0.5/1 decisions for the next grading design. Keep available
question context and write self-contained marking items. Before promotion,
evaluate a held-out set of realistic answers and underspecified schemes,
especially keyword stuffing and meaningful but incomplete explanations.
Explicit partial-credit criteria helped here; adopting additional stored
criteria is a separate design choice, not necessary to record these results.

Quantity questions remain deterministic and use a fixed authored unit with
value-only learner entry, per Epo's decision. No numeric grading or unit
conversion was sent to Jev in this experiment. Application changes, fixed-unit
input tests and computation/text-sufficiency admission tests remain in the
implementation plan and follow-ups.
