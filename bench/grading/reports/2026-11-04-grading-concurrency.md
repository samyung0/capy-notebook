# How many open parts should one submission grade at once?

Today `gradeOpenParts` (`server/internal/httpapi/quiz_grading.go`) grades 5 parts
at a time, cuts each call at 30 s and fails the whole check if any part fails. This
bench grades simulated 40-part submissions with the
[round-3](2026-11-03-deepseek-grading-round3.md) prompt on the 1017 pin, with 5, 10,
20 and 40 parts in flight, then runs 3, 5 and 10 submissions at once.

- **Parts in flight barely change how long a submission takes.**
  - One 40-part submission took 28–86 s at every setting.
  - The median was 47 s at 5 in flight, 44 s at 10, 38 s at 20 and 49 s at 40.
  - The slowest maths part sets the time: one maths part took over 30 s in 10 of
    12 runs.
  - More in flight only slows each call. Per-call p50 is about 2 s at 5–10 in
    flight, 3–6 s at 20 and 8 s at 40.
- **Wafer's throughput is fixed at about 1,000 output tokens a second for this key.**
  - That is about 1.1–1.4 calls a second for this mix.
  - It is the same with 1, 3 or 5 submissions running.
  - A 40-part submission produces about 31,000 output tokens, 78% of them maths
    reasoning. So Wafer alone grades about two such papers a minute; anything more
    queues.
- **Refusals appear only between 100 and 200 calls in flight.**
  - Up to 100 in flight, Wafer answered every call itself, but slowly: maths p50 about
    20 s and p95 77–91 s.
  - At 200 in flight, OpenRouter sent 82 of the 380 answered calls (22%) to
    InferenceNet. They started in the first 20 s of the burst, so InferenceNet did
    take over when Wafer was full.
  - At that level, 5 maths calls got no answer within 180 s.
  - Cloudflare never served. No 429 reached us at any level.
- **Today's 30 s timeout and any-failure rule would fail almost every paper.** 28 of
  the 30 submissions had at least one call over 30 s: 10 of 12 single submissions
  and all 18 under load. With a 120 s cut, 2 of 12 single submissions still fail
  (both from errors), and 11 of 18 under load.
- **Accuracy holds under load.**
  - Graded answers agree with the round-3 1017 runs on the same answers 97–100% of
    the time at every setting, which is run-to-run noise.
  - Only failed calls lower the score.
- **Errors other than timeouts:**
  - 2 connections cut mid-reply, at 40 in flight;
  - 5 replies in 1,160 that gave an answer rule without its `id`, all on the
    one-rule IELTS own-words parts (4 of them on the same answer). A validator that
    matches rules by position would accept them.
- **Cost:** $0.49 for 30 submissions (1,160 calls), about $0.016 a submission or
  $0.0004 a part.

**Recommendation:**
- **Per submission:** a limit of 10. Above 10, calls just wait longer, and on a busy
  route a big submission crowds out the rest.
- **Total for grading on Wafer:** 40 in flight, as its own gate. Treat 60 as the
  point where queueing starts and 100 as the ceiling.
- **Timeout:** about 120 s for maths parts, and grade in the background with
  per-part results, not a 30 s all-or-nothing check. Details
  [below](#recommendation).

## Setup

- **Grader:** [`grading_concurrency.py`](../scripts/grading_concurrency.py) reuses
  `deepseek_grading.py`'s round-3 prompt, answer rules and code copy check, with the
  IELTS whole-paragraph rules measured as passage coverage.
- **Model:** `deepseek/deepseek-v4.1-flash-1017`.
- **Route:** `wafer/us` ($0.038 / $0.50 per million, mxfp4), then InferenceNet, then
  Cloudflare, `allow_fallbacks: false` (`deepseek-v41-1017-wafer`). DeepInfra is not
  in the list, so it cannot serve.
- **Thinking:** low effort on maths only, 16k limit.
- **Calls:** a new HTTPS connection per call, no retries, and a 180 s timeout so
  slow calls are measured rather than cut.
- **A submission is 40 parts:**
  - 20 HKDSE maths parts with working;
  - 8 IELTS reading parts;
  - 8 HKDSE Chinese reading parts;
  - 4 contract parts.

  Each part gets one answer, and the answer kind rotates with the submission's
  seed. Seeds 0–2 were run at every setting; the load runs used seeds 10–39. Parts
  the copy check scores never reach the model (0–3 per submission). That is why a
  submission is 37–40 calls.
- **Run 1:** seed 0 at 5, 10, 20 and 40 in flight, seed 1 in the reverse order, and
  seed 2 shuffled (20, 5, 40, 10). That is three submissions per setting, to see
  through time-of-run drift.
- **Run 2:** 3, 5 and 10 submissions started together, each with 20 in flight: 60,
  100 and 200 calls at once. 20 per submission was run 1's best median.
- **When:** 2026-11-03, 16:35–16:53 UTC, from a Mac in Hong Kong time.

## Run 1: one submission, 5 to 40 parts in flight

| In flight | Wall time (s), seeds 0 / 1 / 2 | Call p50 (s) | Maths p50 / p95 (s) | Errors | Agreement with round 3 |
| ---: | --- | --- | --- | --- | --- |
| 5 | 46.7 / 40.6 / 57.3 | 2.0–2.3 | 3.9–6.0 / 21–23 | none | 106/109, 102/109, 108/109 |
| 10 | 86.3 / 43.6 / 28.3 | 2.0–3.1 | 4.9–7.6 / 17–24 | 1 malformed | 107/109, 101/107, 109/109 |
| 20 | 73.0 / 37.8 / 36.1 | 3.1–5.7 | 9.9–10.9 / 22–24 | none | 108/109, 106/109, 108/109 |
| 40 | 59.8 / 49.5 / 28.1 | 7.7–8.2 | 10.4–11.4 / 23–49 | 2 cut connections, 1 malformed | 109/109, 99/102, 109/109 |

- **Wall time is the longest maths call plus its wait.** The 86 s and 73 s outliers
  each contain one maths part that took over 60 s.
- **More in flight trades queue time for longer calls.** At 5, calls wait in the
  submission's own queue. At 40, everything starts at once and every call takes 3–4
  times longer.
- **No setting is reliably faster within this noise.** 20 had the best median and no
  errors.
- **Only Wafer served** at every setting.

## Run 2: several submissions at once, 20 in flight each

| Submissions (calls in flight) | Wall time per submission (s) | Call p50 / p95 (s) | Maths p50 / p95 (s) | Calls > 60 s | Errors | Served by | Agreement with round 3 |
| --- | --- | --- | --- | ---: | --- | --- | --- |
| 3 (60) | 72, 82, 103 | 3.5 / 71 | 23 / 77 | 10 | none | Wafer 118 | 320/327 (97.9%) |
| 5 (100) | 87, 92, 96, 100, 139 | 4.5 / 88 | 20 / 91 | 30 | 2 malformed | Wafer 193 | 529/541 (97.8%) |
| 10 (200) | 111–156 | 6.8 / 104 | 28 / 118 | 67 | 5 timeouts at 180 s, 1 malformed | Wafer 298, InferenceNet 82 | 1,056/1,074 (98.3%) |

**At 200 in flight, InferenceNet was the overflow:**
- The calls OpenRouter sent there started within the first 20 s of the burst.
- They were mostly maths (48) and IELTS (24).
- They were slower than Wafer's at the median (11.8 s against 6.4 s) but had a
  shorter tail (p95 53 s against 111 s).

**The 5 calls that never answered** were maths parts sent at the very start. A
route without the InferenceNet fallback would have refused or timed out far more.

**Wafer's output was flat from 1 to 5 submissions:**

| Load | Output tokens a second | Calls a second |
| --- | ---: | ---: |
| 1 submission | 370–1,090 (median about 650) | 0.5–1.3 |
| 3 submissions | 917 | 1.1 |
| 5 submissions | 1,026 | 1.4 |
| 10 submissions (with InferenceNet) | 2,003 | 2.5 |

## Timeouts and the any-failure rule

Submissions that would fail if every part must succeed, by per-call cut:

| Runs | Errors only (no cut) | Cut at 30 s | Cut at 60 s | Cut at 120 s |
| --- | ---: | ---: | ---: | ---: |
| 12 single submissions | 2 | 10 | 4 | 2 |
| 3 at once | 0 | 3 | 3 | 0 |
| 5 at once | 2 | 5 | 5 | 3 |
| 10 at once | 5 | 10 | 10 | 8 |

- **The 30 s client timeout fails nearly every paper.** Thinking on maths needs
  more: a heavy maths part takes 20–50 s even alone, and the 16k limit allows
  more.
- **Under load, even 120 s fails most papers** under the all-or-nothing rule.
- **Grading has to tolerate a slow or failed part:** per-part results, re-grading
  only the failed part, or grading in the background.

## Accuracy

- **Agreement:** graded answers agree with the round-3 1017 runs on the same answers
  (InferenceNet, one call at a time) on 97–100% of items at every setting and load:
  97.9% for 3 at once, 97.8% for 5 and 98.3% for 10. That matches round 1's
  run-to-run noise.
- **Against gold:** the single submissions score 106–108 of 109 items for seed 0
  (reference 106) and 105–106 for seed 2 (reference 106).
- **Failures:** only failed calls lower the score. They count as wrong: for example
  92 of 109 for seed 1 at 40 in flight, with 3 failed calls.
- **Provider:** Wafer (mxfp4) grades the same as InferenceNet (fp8) on these answers.

## Cost

| | Value |
| --- | ---: |
| Spend | $0.49 |
| Calls | 1,160 |
| Submissions | 30 |
| Parts scored by the copy check, no call | 40 |
| Input tokens | 1,966,648 (1,809,280 cached) |
| Output tokens | 922,364 (717,668 reasoning) |
| Per submission | about $0.016 |
| Per part | about $0.0004, 0.8 credits |
| Share of cost from the 20 maths parts | almost all, through reasoning tokens |

## Recommendation

1. **Per-submission limit: 10 parts in flight** (from 5).
   - Wall time doesn't improve beyond it (median 44 s against 38 s at 20, within
     noise).
   - Each extra parallel call slows every call on the route.
   - 10 keeps one large paper from occupying the whole grading gate.
2. **Total in flight for 1017 on Wafer: 40, as a gate of its own for grading.**
   - At 40 in flight, maths p50 is about 11 s and p95 23–49 s.
   - From 60 in flight, everything queues behind Wafer's fixed throughput: maths p50
     doubles to about 20 s and p95 passes 75 s. Non-maths parts stay fast (p95
     2–7 s).
   - Wafer starts handing calls to InferenceNet between 100 and 200.
   - Treat 100 as the ceiling and 60 as the point where latency doubles.
   - Today's 1017 row (40 in flight, 20 interactive, shared with captions and ghost
     text) is keyed on the slug. A Wafer-first grading route should get its own row,
     so grading bursts don't starve captions.
3. **Plan for throughput, not concurrency.**
   - Wafer gives this key about 1,000 output tokens a second, about two 40-part
     papers a minute.
   - A class of 30 submitting the same paper together needs about 15 minutes on
     Wafer alone.
   - So grade assignment submissions in a background queue. Assignments hold AI
     marks for approval anyway.
   - Let the InferenceNet fallback absorb bursts.
   - Report per-part progress as parts finish.
4. **Timeouts and failures:**
   - Raise the maths-part timeout to about 120 s, and keep 30 s for non-maths parts.
     Their p95 stayed at 2–13 s at every load, including 200 in flight.
   - Replace "any failed part fails the check" with per-part results, or re-grade
     only the failed parts. Re-asking a timed-out part is the retry an orchestration
     like ingest is allowed (AGENTS.md); a learner pressing Check again re-runs
     everything.
   - Cap reasoning on maths parts if 120 s is too long for practice.
5. **Validator:** accept an answer rule without an `id` when the rules come back in
   order and the count matches. That covers all 5 malformed replies here.

## Limitations

- **One API key, one afternoon.** Wafer's capacity is shared with other OpenRouter
  customers and will vary with the hour; the ~1,000 tokens a second is what this
  key saw.
- **OpenRouter doesn't report refused attempts,** only the provider that finally
  served. "Wafer refused" is inferred from InferenceNet serving calls in the first
  seconds of the 200-call burst.
- **Repetitions:** three per setting in run 1, one per load level. Wall times vary
  by a factor of three between identical setups, so differences between 10, 20 and
  40 in flight are not established.
- **The submission mix** is one paper shape (half maths with thinking). Papers with
  fewer maths parts will be far faster and cheaper.
- **Labels:** AI-written, as in rounds 1–3.

## Provenance and reproduction

Runs are in the ignored `data/grading-benchmark/grading-concurrency-20261104/`, with
one `manifest.json` and `results.jsonl` per run (start and end times, provider, HTTP
status, usage, cost and awards per part). Committed records:
[`2026-11-04-mac-concurrency/`](2026-11-04-mac-concurrency/), the summary and
per-call records. Keys were read from `deploy/.env.uat` into memory. A search of the
run files for each key's first ten characters found nothing.

```sh
S=bench/grading/scripts/grading_concurrency.py
D=data/grading-benchmark/grading-concurrency-<fresh>
E=deploy/.env.uat
python $S --check
for k in 5 10 20 40; do python $S run --subs 1 --inflight $k --seed 0 --label s0-k$k --env $E --output $D/s0-k$k; done
python $S run --subs 3 --inflight 20 --seed 10 --label load3-k20 --env $E --output $D/load3-k20
python $S run --subs 5 --inflight 20 --seed 20 --label load5-k20 --env $E --output $D/load5-k20
python $S run --subs 10 --inflight 20 --seed 30 --label load10-k20 --env $E --output $D/load10-k20
R=data/grading-benchmark/deepseek-grading-20261103-r3
python $S report --runs $D/* --reference $R/v41-1017-r3 $R/v41-1017-r3-reading-en $R/v41-1017-r3-reading-zh --output $D/summary.json
```
