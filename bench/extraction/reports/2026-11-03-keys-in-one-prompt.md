# Make a quiz: keys in one prompt (2026-11-03, round 2)

The second bench of question extraction, after Epo's decisions on the first
cut (`todo-study-tracking.md` §8, "After the first cut", and
`todo-study-tracking/R6-extraction-prompt.md`). The page windows now give every
part its key in the same call: copied when the page prints it, otherwise
worked out (`key_source: worked_out`), with a short worked solution, at
thinking `mid`. A given mark scheme or answer list still replaces worked-out
keys by label in code, so this bench measures the model's own keys before that
replacement against the official answers. Same papers, gold and stand-ins as
[the first cut](2026-11-03-first-cut.md). Mac, 2026-11-03, 19:30–23:50 JST.

## The model: 0731 is text-only

Epo picked DeepSeek V4 Flash 0731 through OpenRouter, in an extraction slot of
its own, on the condition that it takes page images. It does not:
OpenRouter's model listing gives `deepseek/deepseek-v4-flash-0731`
`input_modalities: ["text"]` on all 29 of its endpoints, and a request with a
page image answers 404 "No endpoints found that support image input". So the
slot was not built and no run used 0731; the numbers below are
`deepseek/deepseek-flash` on DeepSeek's own API (the chat slot's pin, which
the first cut used), windows at `mid`, outline and scheme parse with
reasoning off. The OpenRouter vision models are compared at the end.

## What changed since the first cut

- **Keys in the window prompt.** Every part carries `key_source` and a
  solution; mcq `correct`, short `accepted`, open marking `points` with marks.
  A worked-out solution is saved with the "AI-written" label.
- **One question per `record_question` call.** With several questions in one
  call at `mid`, DeepSeek's long arguments often closed a bracket early or
  wrapped themselves in `{"arguments": …}`; the tool result only said "not
  valid JSON", the model repeated the mistake, and the window's four steps ran
  out. Runs 11, 21, 31 and 32 lost 11, 12, 17 and 11 of 2022 P2's 45
  questions that way, and runs 11, 12 and 21 two or three of 2024 P1's ten
  (runs 11 and 12 also before the cut-off rule below). Now each question is its
  own call (several per reply), the tool result names the parse error and
  position, and a window has six steps. In the nine runs below six calls were
  not JSON; every one was sent again and recorded.
- **A reply cut off at the output cap** (24,000 tokens) is asked again for
  fewer questions a reply.
- **The scheme parse gets the recorded labels** ("1; 3: a, b; …"). 2024
  Q3(b), which the first cut read as `b(ii)` in 4 of 5 runs, paired as `b` in
  every run.
- **One silent retry a step** instead of three attempts.

## Results

Runs 41–43 per paper (2022 P2 also run 33, the first with the final code).
Credits include DeepSeek's prompt cache across repeats of the same paper.

| Paper | Runs | Seconds | Credits | Reasoning tokens a run | Labels found | Questions saved | Part structure | MCQ key saved = official |
|---|---|---|---|---|---|---|---|---|
| 2022 P2 | 4 | 199, 210, 218, 278 | 115, 108, 115, 145 | 24k–39k | 180/180 | 180/180 | 180/180 | 180/180 |
| 2021 P1 | 3 | 64, 64, 87 | 44, 32, 44 | 3k–8k | 30/30 | 30/30 | 21/30 | – |
| 2024 P1 | 3 | 72, 109, 70 | 44, 67, 38 | 4k–8k | 30/30 | 30/30 | 23/30 | – |

### Worked-out keys against the official answers

| Paper | Measure | Right |
|---|---|---|
| 2022 P2 | MCQ keys the model worked out (no answer printed on the pages) = official key | **175/180 (97%)**; Q24 wrong in 2 of 4 runs, Q25, Q40 and Q45 once each |
| 2021 P1 | Final answer of each part = the scheme's, judged by hand | 57/57 (exact string 32/57: factor order, `$`, `x =`, `\dfrac`, fuller reasoning) |
| 2024 P1 | Same | 50/51 (exact string 31/51); the one miss is an empty model answer for a proof part, 8(a) in run 43 |
| 2021 P1 | Marks the model gave each part = the paper's | 49/57 |
| 2024 P1 | Same | 50/51 |

Every saved question kept a key: with the scheme or answer list given, every
worked-out key was replaced except one part (2024 run 42, whose scheme version
of Q7 the validator refused, so the page's keys stayed), and the report named
each disagreement (`keyDisagreements`: 1–4 parts a run, almost all
equivalent forms of the same answer).

## Findings

1. **Worked-out keys are good enough to show, marked AI-written.** 97% of the
   Paper 2 MCQ keys and every Paper 1 final answer but one matched the
   official answers. Q24 (2022 P2) is a real miss: the model answers B where
   the key is A in half the runs. Without an answer file such errors reach the
   learner, labelled AI-written; with one, the scheme replaces them and the
   report lists the disagreement.
2. **`mid` costs two to three times `low`.** 2022 P2 went from 42–50 credits
   and 70 s (first cut, `low`) to 108–145 credits and 200–280 s; Paper 1
   (7 pages with a 10–14 page scheme) from 25–34 to 32–67 credits. Reasoning
   is most of it on Paper 2 (24k–39k reasoning tokens a run against about 1k
   at `low`): working out 45 multiple-choice answers is real work. A 40-page
   paper would cost about 250–350 credits, more than a Free month's 200, and
   take 8–12 minutes.
3. **The one-call-per-question change fixed the lost windows.** Before it,
   seven of thirteen runs at `mid` lost at least one window silently (only the
   report's `missing` showed it); after it, none of ten did.
4. **1-mark parts are typed short.** The prompt makes a 1-mark part with no
   working to show a short answer; the gold (and the HKDSE scheme, "1A")
   types them open, which is most of the Paper 1 structure misses (2021 Q3(a),
   Q4(b), Q10(b)(i); 2024 Q4(b)). Short parts grade without Jev and cost
   nothing to mark; whether a learner should type only the value is Epo's
   call.
5. **Answer files may hold another paper's answers.** The 2024 answer PDF
   also lists Paper 2's MCQ letters; with the labels given, the parse names
   them "1", "2", "5", "6". Pairing keeps the first answer an entry has, so
   Paper 1's own answers won in every run, but a Paper 1 entry without a
   final answer would take Paper 2's letter as its model answer.
6. **Marks the model splits from a printed total** are still the weak spot
   on 2021 Q4 (4 marks over (a) and (b)): the report's `marksDiffer` names it,
   as in the first cut.

## OpenRouter vision models (evening, 2026-11-03)

Epo then ruled out direct DeepSeek for extraction (too expensive) and asked
for the DeepSeek models on OpenRouter that take images: the dated pin
`deepseek/deepseek-v4.1-flash-1017` and the unpinned
`deepseek/deepseek-v4.1-flash`. Same three papers, same prompt, scoring and
`mid` windows, two runs per paper per model (runs 51-52). Each model was held
on named providers with fallbacks off, as the production pins are: 1017 on
InferenceNet then Cloudflare (production's captioning pin), V4.1 Flash on
InferenceNet then DeepInfra.

**Reasoning on 1017 is our setting, not the model's.** elitellm sent every
DeepSeek pin on OpenRouter `reasoning: {enabled: false}`
(`openrouter_reasoning`), because captions, page reads, summaries and ghost
text all run with reasoning off. A probe window (2022 P2 pages 4-5, tools on)
on 1017 through InferenceNet reasoned at `low`, `medium` and `high` alike:
545-1,006 reasoning tokens, 7 questions recorded, 7/7 keys right. The effort
barely changes how much it reasons. Cloudflare answered 429 ("temporarily
rate-limited upstream") during the probe. The unpinned V4.1 Flash read the
image and called the tools at both efforts on InferenceNet, DeepInfra, Wafer,
Baidu and StreamLake. Baidu and StreamLake each sent one call that was not
valid JSON.

| | Direct Flash (round 2) | 1017, OpenRouter | V4.1 Flash, OpenRouter |
|---|---|---|---|
| Runs per paper | 4 / 3 / 3 | 2 / 2 / 2 | 2 / 2 / 2 |
| Labels found, questions saved | all | all | all |
| MCQ keys worked out = official (2022 P2) | 175/180 (97%) | 87/90 (97%) | 87/90 (97%) |
| Paper 1 final answers equivalent to the scheme | 107/108 | 69/72 (three proof parts left without a model answer) | 72/72 |
| Part marks the model gave = the paper's (P1) | 99/108 | 66/72 | 67/72 |
| 2022 P2: credits a run, seconds | 108-145, 199-278 | 52-53, 294-300 | 56-90, 237-450 |
| 2021 P1: credits, seconds | 32-44, 64-87 | 15-16, 87-90 | 22-28, 94-134 |
| 2024 P1: credits, seconds | 38-67, 70-109 | 17-21, 107-119 | 25-27, 113-116 |
| Calls not valid JSON, retries, failures | 6 resent, 0, 0 | 0, 0, 0 | 0, 0, 0 |
| Served by | DeepSeek | InferenceNet, every call | InferenceNet, every call |

Credits for the OpenRouter runs are what OpenRouter billed (`usage.cost`;
1 credit is $0.0005). They match our rates at InferenceNet's list price. Direct
Flash is priced at its catalog rate. All 12 OpenRouter runs together cost
$0.21; the probes cost about $0.02.

**Pick: 1017.** It matches direct Flash on labels, questions, multiple-choice
keys and part marks at about half the credits. It is the cheapest of the
three, a dated pin that will not move under us, and the pin that already
reads pages, captions images and writes ghost text. It is slower than direct
Flash on 2022 P2 (about 300 s against 200-280 s). Its one miss is
three open proof parts (2021 Q8(a) and Q8(b)(i), 2024 Q8(a)) saved without a
model answer. The worked solution is still there, and a given scheme fills
the answer in. The unpinned V4.1 Flash wrote every answer but cost more and
varied more (56 to 90 credits on 2022 P2). Epo's follow-up made 1017 the
extraction slot's pin (migration 0141).

## Wafer first (2026-11-04)

Epo then routed 1017 to Wafer, then InferenceNet, then Cloudflare, with
fallbacks off, for every call it serves. A quick check on that route cost
about $0.15.

- **`order` takes an endpoint tag.** OpenRouter's billed cost shows which
  endpoint served a call. `wafer/us` and `wafer/mxfp4` each reached their
  own endpoint ($0.038 and $0.16 input per million). The name `Wafer` (or
  `wafer`) took `wafer/us` in five calls of five, and `Wafer/us` found no
  endpoint. The route names `wafer/us`.
- **Captions, five images** (two textbook pages, a photo, an abstract figure
  and half an HKDSE page), each on the new route and on InferenceNet alone.
  Wafer served every call on the new route. It was faster (0.8-3.2 s against
  1.9-8.6 s) and 20-40% cheaper, and wrote the same text and numbers. Wafer
  keeps the page layout's runs of spaces in its transcriptions.
- **Extraction, 2021 Paper 1, two runs.** Wafer served every call.

| | InferenceNet (runs 51-52) | Wafer (run 61) | Wafer (run 62) |
|---|---|---|---|
| Labels found, questions saved | 10/10, 10/10 | 10/10, 10/10 | 7/10, 7/10 (5-7 lost) |
| Part marks = the paper's | 18/19, 16/19 | 14/19 | 14/14 |
| Open parts without a model answer | 2 of 15, 0 of 16 | 14 of 14 | 8 of 12 |
| Seconds, billed | 87-90 s, $0.0076-0.0078 | 42 s, $0.0062 | 528 s, $0.133 |
| Output tokens | 10-12k | 9k | 152k over 16 calls |

Run 62 ran away: its replies filled the 24,000-token output cap again and
again, the window holding questions 5-7 recorded nothing, and the run cost 17
times InferenceNet's. In both runs Wafer left the open parts' short model
answer out. The worked solution and marking points still held the answer.
Wafer also reports every output token as reasoning (`reasoning_tokens` equals
`completion_tokens` in a probe at instant as at medium), so usage rows on Wafer
overstate reasoning. Billing is not affected. For calls with reasoning off
(captions, page reads, ghost text), Wafer looks like a gain. For Make a quiz
at mid, two runs are too few to settle it, but both runs were worse than
InferenceNet's.

Epo's decisions (2026-11-04): Make a quiz takes a route of its own on the same
model, InferenceNet, then Cloudflare, then `wafer/us`, while every other 1017
call keeps Wafer first. 1017 is priced at 200 / 20 / 1200 micros for every
use, the highest of its three providers' prices in each column. A run now
stops (`stopped: output_limit`) once its windows have written 8,000 output
tokens per selected page. That is more than twice the most any normal run
wrote; run 62 wrote 21,700 a page.

## Left out

- 0731 (text-only, above).
- Figure crops (boxes only), Office pages and Markdown sections, as before.
- No run went through the gateway, retrieval service and database end to end
  (Docker was not running); the bench calls the pipeline in-process.

## Reproduce

```sh
python bench/extraction/scripts/run.py --paper 2022-p2 --model v41-1017 --repeat 1 \
  --refs data/question-bank/references/hkdse-math-compulsory --env-file <keys file>
```

(`--model deepseek` for direct Flash, `v41` for the unpinned V4.1 Flash.)
Spend this round, every run and probe included: about $1.40.
