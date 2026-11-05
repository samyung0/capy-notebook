# Make a quiz: window size (2026-11-04)

How many questions can one batch of page images extract? This round changes
only `WINDOW_PAGES`, the number of pages each model call sees at a time. It
stays at 2 in the code. Epo decides.

## Answer

- **One call reliably records 12 questions.** All 5 replies that recorded
  exactly 12 finished, and the largest used 14,931 output tokens, 62% of the
  24,000 cap. The one reply at 18 used 21,496 tokens, 90% of the cap, and the
  same window in the other run was cut off with nothing recorded. No reply
  recorded 13 to 17, so the true limit is somewhere in that gap, unmeasured.
- **The recommendation is to keep 2 pages.** Keys and marks do not change with
  window size, and cost is flat from 2 to 6 pages. Window 3 is 5% faster on the
  mean across all papers, but 2 leaves the most room. It stays under 12 questions
  up to 6 questions a page, 3 pages up to 4, and 4 pages up to 3. Paper 2 has 3
  to 4 a page.
- **The cap is on tokens, and the question count only follows from it.** Replies
  of 3 or fewer questions reached 19,265 tokens, because reasoning is about half
  of the output and it does not scale with what the reply records.

## What ran

Six settings: 1, 2, 3, 4 and 6 pages, and all selected pages in one window. Four
gold papers: 2021 P1, 2022 P1, 2024 P1 (10 written questions each) and 2022 P2
(45 multiple choice questions at 3 to 4 a page). Two runs per setting, 48 runs,
one after another on the Mac. Every call used `deepseek/deepseek-v4.1-flash-1017`
on OpenRouter on the extraction route (InferenceNet, Cloudflare, then `wafer/us`,
fallbacks off). InferenceNet served all 48 runs, and Cloudflare also served calls
in 3 of them. The 48 runs billed $0.631. The check in
[Questions that cross a page](#questions-that-cross-a-page) added 14 runs and
$0.21, so the round cost $0.84 of the $5 budget.

## Results

Each row sums 8 runs over 150 gold questions. Credits and seconds are means per
run, with the written papers and Paper 2 apart because they differ so much.

| Window | Labels found | Lost | Part structure | Part marks | MCQ keys worked out | Figures named | Crops whole | Credits written, P2 | Seconds written, P2 | Longest run | Billed |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 150/150 | 0 | 129/150 | 128/150 | 87/89 | 28/28 | 22/28 | 22.4, 61.0 | 140, 382 | 418 s | $0.115 |
| 2 | 150/150 | 0 | 130/150 | 129/150 | 86/90 | 28/28 | 24/28 | 19.1, 58.9 | 110, 309 | 319 s | $0.104 |
| 3 | 150/150 | 0 | 133/150 | 133/150 | 88/90 | 28/28 | 22/28 | 20.8, 55.7 | 112, 272 | 280 s | $0.106 |
| 4 | 150/150 | 0 | 132/150 | 132/150 | 85/90 | 28/28 | 23/28 | 19.1, 60.0 | 104, 345 | 441 s | $0.106 |
| 6 | 147/150 | 3 | 127/147 | 126/147 | 83/87 | 28/28 | 22/28 | 17.9, 66.9 | 100, 335 | 411 s | $0.109 |
| all | 150/150 | 0 | 133/150 | 133/150 | 86/90 | 18/28 | 14/18 | 18.5, 45.4 | 82, 214 | 221 s | $0.091 |

As in the earlier rounds, the Paper 1 structure misses are mostly 1-mark parts
typed as short answers where the gold types them open. No setting produced an
extra label.

What the model did in those runs:

| Window | Calls | Re-asks | Cut off | Refused | Continued | Windows out of steps | Busiest window (steps) | Questions a recording call | Most questions in a reply | Most parts in a reply | Output a page (highest run) | Largest reply | Guard fired |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 152 | 5 | 0 | 4 | 0 | 0 | 3 | 2.0 | 4 | 4 | 3,046 | 13,207 | 0 |
| 2 | 91 | 11 | 0 | 7 | 0 | 0 | 3 | 3.0 | 8 | 8 | 2,968 | 12,453 | 0 |
| 3 | 64 | 5 | 0 | 8 | 0 | 0 | 3 | 4.6 | 10 | 10 | 3,288 | 19,265 | 0 |
| 4 | 48 | 8 | 0 | 4 | 0 | 0 | 6 | 5.4 | 12 | 12 | 2,852 | 14,931 | 0 |
| 6 | 49 | 13 | 1 | 4 | 0 | 1 | 6 | 4.8 | 18 | 18 | 3,434 | 24,000 | 0 |
| all | 34 | 20 | 0 | 9 | 0 | 2 | 6 | 5.7 | 10 | 19 | 2,066 | 20,356 | 0 |

The run guard (8,000 output tokens a page) never fired. The highest run reached
3,434 a page.

### Paper 2, run by run

Paper 2 is the only paper dense enough to test the limit.

| Window | Run | Labels | MCQ keys | Crops whole | Calls | Cut off | Largest reply | Seconds | Billed |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 81 | 45/45 | 44/45 | 7/10 | 31 | 0 | 10,120 | 418 | $0.0293 |
| 1 | 82 | 45/45 | 43/44 | 9/10 | 32 | 0 | 5,409 | 345 | $0.0255 |
| 2 | 81 | 45/45 | 42/45 | 9/10 | 17 | 0 | 9,466 | 299 | $0.0228 |
| 2 | 82 | 45/45 | 44/45 | 9/10 | 17 | 0 | 12,453 | 319 | $0.0302 |
| 3 | 81 | 45/45 | 43/45 | 8/10 | 11 | 0 | 11,121 | 265 | $0.0243 |
| 3 | 82 | 45/45 | 45/45 | 8/10 | 12 | 0 | 11,931 | 280 | $0.0259 |
| 4 | 81 | 45/45 | 42/45 | 8/10 | 12 | 0 | 13,764 | 441 | $0.0297 |
| 4 | 82 | 45/45 | 43/45 | 9/10 | 8 | 0 | 14,931 | 250 | $0.0244 |
| 6 | 81 | 42/45 | 39/42 | 8/10 | 11 | 1 | 24,000 | 411 | $0.0347 |
| 6 | 82 | 45/45 | 44/45 | 8/10 | 8 | 0 | 21,496 | 260 | $0.0256 |
| all | 81 | 45/45 | 43/45 | no figures named | 6 | 0 | 17,613 | 221 | $0.0190 |
| all | 82 | 45/45 | 43/45 | 8/10 | 6 | 0 | 20,356 | 207 | $0.0219 |

### Replies by the questions they record

All papers, all 48 runs.

| Questions in the reply | Replies | Output tokens (median) | Output tokens (largest) |
|---|---|---|---|
| 1 to 3 | 162 | 1,206 | 19,265 |
| 4 to 6 | 43 | 2,685 | 9,757 |
| 7 to 9 | 29 | 6,139 | 17,613 |
| 10 to 12 | 13 | 5,894 | 20,356 |
| 13 or more | 1 | 21,496 | 21,496 |

At exact counts on Paper 2:

| Questions in the reply | Replies | Output tokens (median) | Output tokens (largest) |
|---|---|---|---|
| 8 | 10 | 2,844 | 17,613 |
| 9 | 9 | 8,541 | 12,586 |
| 10 | 7 | 5,516 | 20,356 |
| 12 | 5 | 12,076 | 14,931 |
| 18 | 1 | 21,496 | 21,496 |

On written papers the most was 10 questions and 19 parts in one reply, at up to
10,711 tokens. Those papers ran out of questions before they ran out of room, so
that is a floor and not a limit.

## Why bigger windows break

The first reply of a window does most of the reasoning for its pages, so it grows
with the window. First replies on Paper 2:

| Window | Median output | Largest | Median questions | Most questions |
|---|---|---|---|---|
| 1 | 1,906 | 10,120 | 3 | 4 |
| 2 | 3,728 | 12,453 | 6 | 8 |
| 3 | 6,642 | 11,931 | 9 | 10 |
| 4 | 12,331 | 14,931 | 12 | 12 |
| 6 | 7,796 | 24,000 | 9 | 18 |
| all | 18,984 | 20,356 | 9 | 10 |

At 6 pages the model records fewer in its first reply, so the median falls, while
the largest reply hits the cap. Three things go wrong as the window grows:

1. **A window can run out of steps.** A window gets 6 calls, and the model often
   falls to 3 questions a reply (37 Paper 2 replies recorded exactly 3). Six
   calls at 3 is 18 questions, and 15 after a cut-off. Window 6, run 81, went that
   way: on pages 7 to 12 its first reply spent all 24,000 tokens reasoning with no
   tool call, the re-ask brought it down to 3 a reply, and the steps ran out at 15
   questions. Questions 34, 35 and 36 were lost and `report.missing` named them.
   The quiz was still saved.
2. **Margin goes first.** Window 4, run 81, used all six steps on its third window
   with no cut-off at all (`[3,3,3,3,1,0]`). The all-pages setting recorded
   `[8,8,8,8,8,5]` and `[10,10,10,10,5,5]`, still recording at the last step in
   both runs. A paper with a few more questions would lose them.
3. **Figures drop out in one long window.** All-pages run 81 named no figures at
   all on Paper 2, so 10 of the 28 are missing from that row. The other 5 sizes
   named 28 of 28.

Window 1 has the opposite cost. It makes more calls for the same result (152
against 91), runs 25% slower than window 2 and bills 11% more, and every page
break is a window edge. A larger window also makes a failure cost more, and
progress shows only after each window.

## Questions that cross a page

I added this check; it was not in the brief. No question in the four gold papers
crosses a page (checked against the VLM reads), so `continue_question` fired 0
times in the 48 runs and the table above says nothing about window edges. Paper:
Cambridge IGCSE Biology 0610, 2023 specimen, Paper 4, where every one of its 6
questions (32 parts, 80 marks) crosses pages. It has no answer file, so keys are
not scored here, and the reference is the PDF's text layer.

| Window | Run | Parts saved | Right parts and marks | Words kept (lowest question) | Q2(b) lead-in | Calls | Refused | Continued | Not open | Seconds | Billed |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 81 | 32/32 | 6/6 | 80% (50%) | no | 34 | 2 | 10 | 0 | 240 | $0.0177 |
| 1 | 82 | 32/32 | 5/6 | 80% (50%) | no | 33 | 1 | 10 | 0 | 224 | $0.0177 |
| 2 | 81 | 32/32 | 6/6 | 88% (72%) | yes | 17 | 0 | 6 | 0 | 159 | $0.0128 |
| 2 | 82 | 32/32 | 6/6 | 88% (72%) | yes | 19 | 1 | 8 | 0 | 157 | $0.0138 |
| 3 | 81 | 32/32 | 6/6 | 81% (50%) | no | 20 | 2 | 5 | 3 | 231 | $0.0189 |
| 3 | 82 | 33/32 | 5/6 | 88% (72%) | yes | 15 | 0 | 5 | 0 | 188 | $0.0153 |
| 4 | 81 | 32/32 | 6/6 | 88% (72%) | yes | 12 | 2 | 3 | 0 | 146 | $0.0130 |
| 4 | 82 | 32/32 | 6/6 | 87% (72%) | yes | 10 | 0 | 3 | 2 | 137 | $0.0127 |
| all | 81 | 32/32 | 5/6 | 88% (72%) | yes | 5 | 1 | 0 | 0 | 139 | $0.0131 |
| all | 82 | 32/32 | 6/6 | 87% (72%) | yes | 5 | 0 | 0 | 0 | 112 | $0.0101 |
| 2 from the cover | 81 | 33/32 | 5/6 | 88% (72%) | yes | 22 | 3 | 4 | 0 | 214 | $0.0171 |
| 2 from the cover | 82 | 32/32 | 6/6 | 80% (50%) | no | 22 | 1 | 5 | 1 | 185 | $0.0142 |
| 4 from the cover | 81 | 27/32 | 5/6 | 69% (12%) | no | 14 | 1 | 5 | 1 | 223 | $0.0188 |
| 4 from the cover | 82 | 30/32 | 5/6 | 78% (50%) | no | 16 | 3 | 3 | 1 | 177 | $0.0150 |

"From the cover" selects pages 1 to 17 instead of 2 to 17, so every window edge
falls one page later. "Not open" counts `continue_question` calls refused because
the question was not the open one. Most of the missing words are figure labels,
which stay in the crop.

`continue_question` works: at window 2 from page 2, all 6 questions came back
whole in both runs. That clean result is partly luck, because a window edge did
not land on the one sentence that needed it. With the edges moved by one page,
window 2 lost that sentence in 1 of 2 runs.

## Findings for Epo

I found these and did not fix any of them. Each needs a decision. The lazy option
is my recommendation.

1. **Options repeated without letters.** `_without_options` removes lettered
   lines only. In window 3, Paper 2, run 81, nine questions (28, 29, 31, 33, 34,
   35 and others) carry their options again as plain lines in the part text, so a
   learner sees them twice. It is 1 run of 12 on Paper 2, and it accounts for all
   66 unsupported numbers in window 3. Option: also remove option lines that match
   the options in order with no letter.
2. **A sentence lost at a window edge.** Text printed at the end of a page, before
   a sub-part on the next page, is dropped when a window ends there. Biology Q2(b)
   ("Person A and person B were monitored…", pages 4 to 5) lost it at windows 1 and
   3 and when the edges moved at 2 and 4. The next window never sees that page. Over
   12 runs of 2021 P1, the same kind of lead-in inside one page survived 11 or 12
   times, so the edge is what loses it. Option: add a field on the record call for
   text printed after the last part, and put it before the first part the next
   window adds. Scans have no text layer to pass along, so the model has to hand it
   over.
3. **A second record can erase earlier parts.** `continue_question` inside the same
   window is refused as "not the open question", because `Run.extend` only accepts
   the last question of the previous window. The model then records the question
   again and `Run.add` replaces the earlier parts with no report flag. Window 4 from
   the cover, run 82, lost Q1's a(i) and a(ii) this way, and Q1 came back with 4 parts
   worth `[1,1,2,4]`. Option: treat the last question recorded in the current window
   as open too.
4. **A question split in two.** Window 4 from the cover, run 81, split Q3 into "3"
   (1 part) and "3(b)" (5 parts) at a window edge. It is one run, and I have not
   traced why, so I would watch it and build nothing yet.
5. **A cut-off costs a step.** Recovery leaves 5 steps at 3 questions a reply. At
   window 2 this was never hit, so nothing needs doing unless the window grows.
   Option if it does: do not count a reply with no tool call against the steps.
6. **A long number misread, and once the options changed to fit.** Paper 2 Q34 prints
   a long number with six zeros. Three of 11 runs dropped a zero (window 1 run 81,
   window 6 run 82, all-pages run 81). Window 1 run 81 went further: it rewrote all
   four options, lowering each exponent, so its
   wrong number still gives A. Its key stays A, so key scoring cannot see this. Only
   the numbers check caught the changed options, and it cannot catch a dropped zero
   at all. Window size is not the cause. Option: add a prompt line that says to copy
   options as printed, and never to change them to match a sum.

## Fidelity across the 48 runs

Numbers are checked against the same OCR and VLM reads as the
[figures report](2026-11-04-figures-and-fidelity.md).

| Window | Numbers checked | Unsupported | Dropped | Questions exact | KaTeX failures | Stray `$` | Scheme repeats |
|---|---|---|---|---|---|---|---|
| 1 | 1,261 | 4 | 5 | 140/146 | 0/2,285 | 0 | 2 |
| 2 | 1,271 | 2 | 4 | 140/146 | 0/2,216 | 0 | 6 |
| 3 | 1,334 | 66 | 4 | 135/146 | 0/2,155 | 0 | 2 |
| 4 | 1,268 | 0 | 4 | 142/146 | 0/2,189 | 0 | 6 |
| 6 | 1,210 | 0 | 4 | 139/143 | 0/2,175 | 0 | 2 |
| all | 1,268 | 0 | 4 | 142/146 | 0/2,007 | 0 | 2 |

Window 3's 66 is finding 1. Window 1's 4 is finding 6. Neither tracks window size.

## Limits of this round

- Two runs per setting. A difference of a few keys is noise.
- Paper 2 is the only dense paper, so the 12 is 5 replies on one paper and one
  question type. On written papers nothing went past 10 questions.
- The Biology paper has no answer file, so its keys are not scored, and only 7 of
  its 8 crops have gold boxes (6 or 7 were whole in each run).
- Window 1 run 81 was made before the commit that keeps a quiz when a box call
  fails. That commit does not change window behaviour.
- Bench results made before the `run.py` wrapper fix show `figuresLeftOut: None`.
  Production was not affected.

## Reproduce

```sh
uv run --with pymupdf==1.28.2 python bench/extraction/scripts/run.py \
  --paper 2022-p2 --model v41-1017 --repeat 81 --window-pages 2 \
  --refs <references> --env-file <keys file>  # --window-pages 0 means all pages
python3 bench/extraction/scripts/window_table.py
.venv/bin/python -I bench/extraction/scripts/window_crossing.py <born-digital folder>
```
