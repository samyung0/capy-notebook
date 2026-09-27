# Jev inputs for the question bank

This records an archive review and a new 192-call paired context comparison.
Production grading is unchanged. Epo selected text-only Jev for
non-computational open/essay questions and deterministic answer types for
computational questions. The context, per-item partial-credit contract and
review/edit admission behavior still need evaluation.

## Existing request shape

`bench/grading/scripts/typesafe_math.py` already posts JSON to SystemOne:

```json
{
  "model": "jev-latest",
  "state": { "question": "Question text", "user_answer": "Student text" },
  "questions": {
    "r0": {
      "type": "noul",
      "instructions": "The user_answer conveys the specified marking point.",
      "criteria": {
        "true": "The point is stated or clearly conveyed in the student's words.",
        "false": "The point is omitted, contradicted or only related vocabulary is present."
      }
    }
  }
}
```

Each marking point is a separate decision definition. The state contains
text; a JSON object is compatible with a text-only model. Image URLs or SVG
bytes do not supply visual understanding. The archived run requested
`jev-latest` and reported `jev-1.13.0`; a new run must record the resolved
model again.

## What the saved results establish

The [original Jev report](2026-09-19-typesafe-jev-judge.md) and
[Laya replay input audit](2026-09-27-laya-cpu.md) record 86/96 essay awards
and 1,544/1,592 English seed awards agreeing with expected labels at a
0.5 Boolean threshold. Item agreement was 369/384 for essays and
3,136/3,184 for seeds. These are synthetic AI-authored/reviewed cases,
not independently graded student submissions.

The routing fixture has 102 questions, with three ambiguous labels excluded.
Question-only computation detection got 99/99 scored cases correct, including
conceptual mathematics and proofs. It does not cover graph/image-dependent
questions. Non-computational and assessable from the supplied text are
different properties.

The existing item gold is binary. A whole answer gets a partial award when
some complete marking points are met. That does not establish the new
policy of awarding 0, 0.5 or 1 on each individual point.

On September 27, the archived probabilities in
`data/grading-benchmark/laya-20260927/requests.jsonl` were counted using
`0.35 <= probability < 0.65`, the proposed half-credit band:

| Set | Answers | Marking points | Points in band | Gold labels of those points |
| --- | ---: | ---: | ---: | --- |
| Essay | 96 | 384 | 13 | 13 unmet |
| English seed | 1,592 | 3,184 | 64 | 63 unmet, 1 met |

This is a descriptive re-score of saved values, without inference. It shows
why uncertainty about a Boolean proposition cannot be treated as an
established partial-credit rule. There are no item-level half-credit labels
in these rows with which to validate the proposed middle band.

## Live context comparison, September 27

Epo supplied a credential for this run. It was passed through the runner's
hidden input prompt, without writing it to a file. All 192 calls returned
HTTP 200 and model `jev-1.13.0`. The input and runner hashes are recorded in
`data/grading-benchmark/jev-context-20260927/manifest.json`; raw results and
the summary are beside it. The runner is
[`jev_context.py`](../scripts/jev_context.py).

Both arms used exactly the same 96 essay answers and four marking definitions
per answer. One arm retained the original question text; the other removed
only the `question` field. Requests ran interleaved, up to four at a time,
once per condition, without retries. Both arms used the existing 0.5
Boolean threshold and binary item gold.

| Metric | With question | Scheme and student answer only |
| --- | ---: | ---: |
| Correct marking-item decisions | 368/384, 95.8% | 365/384, 95.1% |
| Correct historical whole-answer awards | 86/96, 89.6% | 85/96, 88.5% |
| Incorrectly credited unmet points | 16/170 | 19/170 |
| Missed met points | 0/214 | 0/214 |
| Input tokens | 68,784 | 66,408 |
| Median request latency | 0.640 s | 0.626 s |
| Failed requests | 0 | 0 |

Five item decisions changed across three keyword-stuffed answers, in
business, medicine and conceptual mathematics. One whole-answer award
changed. Removing the question saved 3.5% of input tokens here and produced
three net additional false credits. The schemes carried most of the input.
This small, unrepeated difference does not establish a general accuracy
advantage for either context policy.

The result supports studying a scheme-first input, while giving little cost
reason to discard available question text in these examples. It does not
cover omitted figures, cross-part references or the new 0/0.5/1 item-level
policy. Those remain separate experiments. At the proposed half-credit
probability band, this run had 12 with-question and 15 without-question
points in the middle band; every one was labeled unmet in the binary gold.

## Next experiment

The subsequent [288-call partial-credit and context screening](2026-09-27-jev-partial-credit.md)
completed the first synthetic comparison for items 2 and 3 below. Direct
three-way grading outperformed probability bands; plain marking-item strings
still exposed keyword-stuffing and partial-credit errors. These findings do not
replace held-out evaluation or computation/text-sufficiency admission tests.

1. The first 96-answer paired context comparison is complete above. Repeat
   or expand it with real ambiguity and held-out cases before choosing a
   universal policy. Preserve all variants from each question family together.
2. Add explicit per-item 0/0.5/1 gold with genuine partial fulfillment,
   omissions, contradictions and keyword stuffing. Compare a direct
   three-way decision against the proposed probability bands. Keep this
   calibration separate from held-out scoring.
3. Add shared-stem, cross-part and figure-dependent cases to determine which
   question details must accompany the marking scheme. Distinguish a
   self-contained scheme from one such as "correct interpretation of the
   graph", which cannot be assessed from student text alone.
4. Reuse the computation fixture and add visual dependency cases. Evaluate
   computation and sufficient text separately before selecting the review
   check's threshold and reject/warn behavior.

Record model identity, prompt and input hashes, per-item gold provenance,
score agreement, false credits, latency and input usage in a fresh run path.
Do not overwrite the old `typesafe-*.jsonl` archives. The existing
`typesafe_math.py` CLI writes fixed archive paths and needs a new output path
before reuse.

The runner's offline `--check` passed. Saved results were checked for a
credential marker, with none found. Further runs need a credential through
`--key-stdin` or `TYPESAFE_API_KEY`; this run did not persist one in an env file.
