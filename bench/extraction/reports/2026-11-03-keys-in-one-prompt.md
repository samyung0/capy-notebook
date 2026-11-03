# Make a quiz: keys in one prompt (2026-11-03, round 2)

The second bench of question extraction, after Epo's decisions on the first
cut (`todo-study-tracking.md` §8, "After the first cut", and
`todo-study-tracking/R6-extraction-prompt.md`). The page windows now give every
part its key in the same call: copied when the page prints it, otherwise
worked out (`key_source: worked_out`), with a short worked solution, at
thinking `mid`. A given mark scheme or answer list still replaces worked-out
keys by label in code, so this bench measures the model's own keys before that
replacement against the official answers. Same papers, gold and stand-ins as
[the first cut](2026-11-03-first-cut.md). Mac, 2026-11-03, 19:30–21:15 JST.

## The model: 0731 is text-only

Epo picked DeepSeek V4 Flash 0731 through OpenRouter, in an extraction slot of
its own, on the condition that it takes page images. It does not:
OpenRouter's model listing gives `deepseek/deepseek-v4-flash-0731`
`input_modalities: ["text"]` on all 29 of its endpoints, and a request with a
page image answers 404 "No endpoints found that support image input". So the
slot was not built and no run used 0731; the numbers below are
`deepseek/deepseek-flash` on DeepSeek's own API (the chat slot's pin, which
the first cut used), windows at `mid`, outline and scheme parse with
reasoning off. The model choice is back with Epo.

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

## Left out

- 0731 (text-only, above). No other model was benched this round.
- Figure crops (boxes only), Office pages and Markdown sections, as before.
- No run went through the gateway, retrieval service and database end to end
  (Docker was not running); the bench calls the pipeline in-process.

## Reproduce

```sh
python bench/extraction/scripts/run.py --paper 2022-p2 --model deepseek --repeat 1 \
  --refs data/question-bank/references/hkdse-math-compulsory --env-file <keys file>
```

Spend this round, every run and probe included: about 1,900 credits, $1.
