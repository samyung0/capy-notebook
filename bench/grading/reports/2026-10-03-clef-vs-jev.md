# Clef and Clef-flash against Jev

Cloudflare released two decision models on 2026-10-01: `@cf/cloudflare/clef` (27B,
$0.24 per M input tokens) and `@cf/cloudflare/clef-flash` (9B, $0.09). They use
Jev's SystemOne request shape. Can either replace Jev ($0.042) for quiz grading?
This report re-runs the Jev experiments unchanged against both models.

- **Clef** ties Jev on the production grading request: 439 of 464 items exact
  against Jev's 435. The difference is inside Jev's own run-to-run noise. Clef
  also ties Jev on the computation warning and is a little worse on LaTeX
  (35 of 40 against 37). It is **deterministic**: an identical repeat changed 0
  of 116 decisions, where Jev changed 5. Clef costs about 5× Jev per part and was
  slower from this laptop (1.01 s against 0.66 s median).
- On math, Clef is better than Jev at step checking with a worked reference: all
  35 wrong answers caught, against Jev's 32. It is much worse on unit
  conversions. It rejects 38 of 106 genuine equivalents, including power-of-ten
  shifts such as 4 TB = 4000 GB, where Jev rejected none.
- **Clef-flash** is not usable for grading. It gives "partial" too readily and
  matched only 360 of 464 items.

Not run yet: the cross-subject rubric probe and the routing probe on Clef, and
every math probe on Clef-flash. The account is on the Workers free plan (10,000
neurons a day), and the allocation ran out after about 1,550 requests. See
[Pending](#pending).

All labels come from the earlier Jev reports and are AI-authored, not
human-certified. Read [2026-10-02-jev-production-contract.md](2026-10-02-jev-production-contract.md)
and [2026-09-19-typesafe-jev-judge.md](2026-09-19-typesafe-jev-judge.md) for the
fixtures, labelling rules and the Jev numbers quoted here.

## Connection

`POST https://api.cloudflare.com/client/v4/accounts/{account}/ai/run/@cf/cloudflare/{clef|clef-flash}`
with a Cloudflare API token. The body is Jev's body with `model` set to `clef` or
`clef-flash`. Structured `state` objects and structured `instructions` objects
are accepted unchanged. The answers come back inside Cloudflare's
`{"result": …}` envelope with the same `choice` / `noul` / `score` fields.
Clef's token counts are about 14% lower than Jev's for the same payloads
(175,513 against 204,089 for the `prod` arm).

## E1: production grading request

The `prod` arm sends one request per part: question text, full markscheme,
answer, one zero/partial/full `choice` per item and the vocabulary guard. It
covers 176 answers and 464 item labels.

| With the vocabulary guard | Jev | Clef | Clef-flash |
| --- | ---: | ---: | ---: |
| Items exact (of 464) | 435 (93.8%) | 439 (94.6%) | 360 (77.6%) |
| Part exact / within 0.5 (of 176) | 154 / 167 | 155 / 170 | 128 / 157 |
| Half marks recovered (of 21) | 16 | 16 | 21 |
| Zero items given credit (of 249) | 15 | 11 | 66 |
| Gaming answers over-credited (of 55) | 2 (2.0 marks) | 1 (0.5 marks) | 6 (4.5 marks) |
| Terse/partial answers under-credited (of 44) | 5 | 7 | 7 |
| Without the guard: items exact | 425 | 427 | 317 |
| Median latency | 0.66 s | 1.01 s | 0.84 s |
| Cost of the arm | ≈ $0.009 | ≈ $0.042 | ≈ $0.016 |

Clef and Jev disagree on 36 items: 16 where only Jev is right and 20 where only
Clef is right. A further 9 items are wrong for both. A four-item lead is not
evidence of a better model. Clef's errors fall in the same places as Jev's:
rambling answers (9 items), partial answers given full credit or credited on a
dependent item (7), real content next to an injection (4) and terse answers (4).

The guard behaves differently. Clef flagged all 22 keyword lists, where Jev
flagged 21, but the highest score on a genuine answer was 0.55, against Jev's
0.18. It zeroed one partial answer, "Build embankments." (gold 1, 0, scored 0.55),
and one injection wrapped round a real point (0.78). With Clef the 0.5
threshold has less margin. It was fixed for Jev and has not been re-tuned.

`choice` confidence is on a different scale. For Clef the median confidence was
0.62 on correct items and 0.13 on wrong ones. All 25 errors are below 0.5, but so
are 193 of 464 items, which is 42% of marks flagged for review against Jev's 11%.
A review cue needs its own threshold for Clef.

Clef-flash leans heavily towards "partial". That explains why it recovers all
21 half marks while crediting 66 items whose gold is zero. Rambling (36),
partial (30) and injection (21) answers carry most of its errors.

### Run-to-run noise

The 44 keyword and partial answers were sent a second time with an identical
request. Both Clef models returned the same decision on all 116 items, and the
guard scores came back identical to four decimal places. Jev changed 5 of 116
decisions on the same repeat. With Clef, differences between arms are real
differences in the request, not sampling.

## E2: computation warning

The same 84 author questions were scored, with 81 counted. The table uses the
production wording, warning at ≥ 0.3.

| State | Model | P / R at 0.3 | Lowest computational | Highest non-computational |
| --- | --- | --- | ---: | ---: |
| question + scheme | Jev | 1.00 / 1.00 | 0.76 | 0.09 |
| question + scheme | Clef | 1.00 / 1.00 | 0.60 | 0.21 |
| question + scheme | Clef-flash | 1.00 / 1.00 | 0.39 | 0.10 |
| question only | Jev | 1.00 / 0.97 | 0.09 | 0.16 |
| question only | Clef | 0.92 / 0.97 | 0.04 | 0.45 |
| question only | Clef-flash | 0.90 / 0.95 | 0.05 | 0.48 |

All three models separate the 81 questions perfectly at 0.3 with the scheme.
The Clef models do it with narrower margins. Without the scheme, both Clef
models warn on conceptual "explain why" maths that Jev's product wording left
alone. Clef scored "why is a square never negative" 0.45, "why negative times
negative is positive" 0.34 and the triangle angle sum 0.31. Every model misses
the village-population question, whose calculation appears only in the scheme.

## E3: LaTeX

| | Items exact (of 40) | Parts exact (of 20) |
| --- | ---: | ---: |
| Jev | 37 | 17 |
| Clef | 35 | 15 |
| Clef-flash | 31 | 15 |

Two of Clef's five misses are the ones Jev also made: the bracketed "(H bonded
to the very electronegative O)" treated as required. Two more are contradiction
answers given 0.5 instead of 1 on the item they did not contradict. The last is
"The loaded trolley is heavier." given 0.5 instead of 0. LaTeX itself caused no
miss. Clef gave the LaTeX keyword list zero, which Jev did not.

## Math probes (Clef only)

These are the 19 September probes in
[`typesafe_math.py`](../scripts/typesafe_math.py), with the same fixtures, questions
and 0.5 threshold.

### Step checking: 61 answers × three state shapes

| State | Wrong marked correct, Jev | Wrong marked correct, Clef | Correct marked wrong, Jev / Clef |
| --- | ---: | ---: | ---: |
| no reference | 17/35 | 15/35 | 0 / 1 |
| final answer only | 13/35 | 11/35 | 0 / 0 |
| worked reference | 3/35 | 0/35 | 0 / 0 |

With a worked reference Clef caught every wrong answer. That includes the
three one-token proof errors Jev passed: cos 2θ for cos 3θ scored 0.36, 6π/3
scored 0.46, and the determinant's 3(−10) for 3(−20) scored 0.11. No correct answer was
rejected. The margin is narrow: the highest wrong answer scored 0.46 and the
lowest correct one 0.69. Without a reference, Clef has the same computation
ceiling as Jev. The four corrupted sec(2π/9) proofs pass at 0.82–0.90, and
plausible wrong finals such as 3¹⁰⁰ mod 7 pass at 0.86. With only a final
answer, step-only errors still pass (9/14, against Jev's 11/14).

### Final-answer equivalence: 64 pairs

Clef rejected no genuine equivalent (0 of 33) and accepted 2 of 25 near misses,
both in the units group. Jev rejected 0 and accepted 1.

### Unit conversions: 235 pairs

| Conversion kind | Equivalent rejected, Jev / Clef | Near miss accepted, Jev / Clef |
| --- | ---: | ---: |
| decimal shift | 0/40 / 10/40 | 3/52 / 5/52 |
| non-10 factor | 0/36 / 14/36 | 18/41 / 8/41 |
| formula | 0/17 / 7/17 | 4/13 / 1/13 |
| approximate constant | 0/13 / 7/13 | 2/14 / 2/14 |
| all | 0/106 / 38/106 | 27/120 / 16/120 |

Clef's error runs the other way from Jev's. It accepts fewer wrong conversions
but rejects correct ones, including conversions that are only a shift of the
decimal point: 2.5 t = 2500 kg (0.06), 4 TB = 4000 GB (0.03), 3.2 GB = 3200 MB
(0.37), 1 L = 1000 cm³ (0.31), and −40 °C = −40 °F (0.06). No threshold fixes
this: at 0.2 it still rejects 13 equivalents while accepting 44 near misses.
Units remain a job for the deterministic quantity type.

### Algebraic form: 217 pairs

| | Equivalent rejected | Near miss accepted | Rational family near misses accepted |
| --- | ---: | ---: | ---: |
| Jev | 0/93 | 10/115 | 7/19 |
| Clef | 3/93 | 10/115 | 5/19 |

The two models are about level, and both still struggle with the rational
rewrites that need polynomial division. Clef also rejected two genuine rational
rewrites and one trig identity.

## Pending

These ran into Cloudflare error 4006 ("you have used up your daily free
allocation of 10,000 neurons"):

- Clef: rubric grading across subjects (1,688 requests) and routing (306).
- Clef-flash: every math probe. Its E1 result makes these low priority.

About 1,550 requests used the 10,000 neurons, so roughly 6–7 neurons each. The
remaining Clef work needs about two days of free allocation, or about $0.15 of
usage on the Workers Paid plan. The probe script stops at the first HTTP error
and saves nothing for that probe, so a probe has to be re-run in full.

## Conclusion

Clef is a credible second provider for the open-part grading request. It matches
Jev's accuracy, behaves deterministically and runs on infrastructure the app
already uses. Its drawbacks are about 5× the price, a guard with less margin
before it zeroes a genuine answer, and confidence values that need their own
review threshold. It does not change the math plan. Step checking against a
worked reference is cleaner than Jev's, but only by a narrow margin. Without a
reference it fails the same way, and its unit equivalence is worse. Clef-flash
should not grade.

Before relying on Clef: run the pending rubric and routing probes, re-check the
guard threshold on the E1 answers, and measure latency from a Worker binding,
not the REST API from a laptop.

## Provenance and reproduction

Contract runs are in the ignored `data/grading-benchmark/clef-contract-20261003/`,
one directory per model and run (`{clef,clef-flash}-{prod,repeat,compute,latex}`).
Each has `manifest.json` with `provider`, `results.jsonl` and `summary.json`. Probe
logs are in its `probes/`, and the raw probe rows are in
`data/grading-benchmark/runs/typesafe-*-clef.jsonl`. All calls returned the
model they were asked for. No contract request failed, and the credential marker
is absent from every run file. The Jev comparison rows come from
`jev-contract-20261002/` (E1–E3) and from the 19 September report (probes,
whose raw rows are not on this machine).

Both runners take `--provider jev|clef|clef-flash`. The payloads are unchanged.

```sh
set -a; source <(grep -E '^CLOUDFLARE_(ACCOUNT_ID|API_TOKEN)=' deploy/.env.uat); set +a
D=data/grading-benchmark/clef-contract-<fresh>
J=data/grading-benchmark/jev-contract-20261002
python bench/grading/scripts/jev_contract.py --experiment grading --arms prod --provider clef --base $J/grading --output $D/clef-prod
python bench/grading/scripts/jev_contract.py --experiment grading --arms prod --kinds keywords,partial --provider clef --base $J/grading --output $D/clef-repeat
python bench/grading/scripts/jev_contract.py --experiment compute --provider clef --output $D/clef-compute
python bench/grading/scripts/jev_contract.py --experiment latex --provider clef --output $D/clef-latex
python bench/grading/scripts/typesafe_math.py --provider clef            # steps
python bench/grading/scripts/typesafe_math.py equiv --provider clef      # also units, algebra, rubric, route
```
