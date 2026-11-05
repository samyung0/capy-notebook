# Make a quiz: layout first, end to end (2026-11-04)

The first run of the built flow: the layout service over HTTP, the real
`extraction.run`, and the bench's scores. Before this, the
[window-pick report](2026-11-04-figure-matching.md) tested the same idea with
patches around production code and detections read from a file. Mac, 8 GB,
one process at a time.

## Answer

- **The build matches the report.** Ten papers once each gave 37 whole, 36 tight
  and 34 both of 40 gold crops. The report's row is 76, 73 and 70 of 80, which is
  38, 36.5 and 35 of 40. The gap is one known mistake, below. The eye check matches
  too: 35 of 35 right, 35 whole, 33 tight, against 70, 70 and 66 over two runs.
- **Production's window call is the tested call, word for word.** Before the two
  prompt changes, the diff of the window call's messages, tools and settings
  against `figure_windows.py` at `5700f09fd` was empty.
- **Every forced failure finished with its figures from the box call.** The
  service killed mid-run and a 429 flood lost no figure and no question.
- **`trailing_text` fixes the sentence lost at a window edge.** Before: 0 of 9 runs
  clean (8 invented a part to hold it, 1 lost it). After: 9 of 9, and 8 of 8 with
  the held text not shown to the next window.
- **The "digit for digit" line does not fix Q34.** The dropped zero is in the stem
  and comes from the page read, and the line is about options. Options were right
  with and without it.

## What ran

The service ran in a venv from `layout/requirements.in` on `127.0.0.1:8092`, with
the pinned model file (SHA-256 checked), 4 threads and 1 worker. A page took 0.75
to 0.97 s alone, and the process held 440 MB. Docker was not running, so the image
has not been built.

Every model call used `deepseek/deepseek-v4.1-flash-1017` on the extraction route,
thinking `mid`, two pages a window. InferenceNet served all of them. Three papers
ran at once in one process, so seconds below include waiting on each other and on
the service's one worker.

| Set | Prompt | Runs | Billed |
|---|---|---|---|
| Ten papers, five more of 2022 P2, Biology at each offset | Frozen | 23 | $0.432 |
| The same | Both changes | 23 | $0.415 |
| Biology at each offset, held text not shown | Both changes | 8 | $0.124 |
| Service killed, flood, no URL on seven papers | Both changes, ink growth | 9 | $0.141 |
| **Total, of $2** | | 63 | **$1.11** |

## The ten papers

Whole and tight count every crop a run made, against gold or the eye fixture. By
box call is 0 everywhere: no figure on these pages needed it.

| Paper | Labels | Structure, marks | MCQ keys | Crops | Whole | Tight | Both | Layout s | Seconds | Billed |
|---|---|---|---|---|---|---|---|---|---|---|
| 2021 P1, frozen | 10 | 5, 5 of 10 | - | 2 | 2 | 2 | 2 | 16 | 117 | $0.0080 |
| 2021 P1, changed | 10 | 5, 5 of 10 | - | 2 | 2 | 2 | 2 | 21 | 110 | $0.0077 |
| 2022 P1, frozen | 10 | 7, 7 of 10 | - | 1 | 1 | 1 | 1 | 17 | 121 | $0.0085 |
| 2022 P1, changed | 10 | 7, 7 of 10 | - | 1 | 1 | 1 | 1 | 22 | 106 | $0.0082 |
| 2022 P2, frozen | 45 | 45, 45 of 45 | 43/45 | 10 | 10 | 10 | 10 | 25 | 550 | $0.0423 |
| 2022 P2, changed | 45 | 45, 45 of 45 | 43/45 | 10 | 10 | 10 | 10 | 33 | 423 | $0.0331 |
| 2024 P1, frozen | 10 | 8, 8 of 10 | - | 1 | 1 | 1 | 1 | 5 | 131 | $0.0091 |
| 2024 P1, changed | 10 | 7, 7 of 10 | - | 1 | 1 | 1 | 1 | 12 | 121 | $0.0102 |
| IGCSE Biology, frozen | 6 | - | - | 8 | 7 | 8 | 7 | 16 | 216 | $0.0140 |
| IGCSE Biology, changed | 6 | - | - | 8 | 7 | 8 | 7 | 29 | 218 | $0.0153 |
| IGCSE Maths, frozen | 26 | - | - | 14 | 9 | 9 | 8 | 14 | 206 | $0.0144 |
| IGCSE Maths, changed | 26 | - | - | 10 | 9 | 9 | 8 | 23 | 160 | $0.0127 |
| IGCSE Physics, frozen | 40 | - | - | 14 | 14 | 12 | 12 | 12 | 197 | $0.0140 |
| IGCSE Physics, changed | 40 | - | - | 14 | 14 | 12 | 12 | 51 | 304 | $0.0211 |
| 2021 P2, frozen | 45 | - | - | 10 | 10 | 10 | 10 | 12 | 270 | $0.0236 |
| 2021 P2, changed | 45 | - | - | 10 | 10 | 10 | 10 | 34 | 307 | $0.0233 |
| 2023 P2, frozen | 45 | - | - | 9 | 9 | 7 | 7 | 13 | 495 | $0.0382 |
| 2023 P2, changed | 45 | - | - | 9 | 9 | 7 | 7 | 32 | 403 | $0.0300 |
| 2025 P2, frozen | 45 | - | - | 9 | 9 | 9 | 9 | 14 | 313 | $0.0238 |
| 2025 P2, changed | 45 | - | - | 9 | 9 | 9 | 9 | 29 | 291 | $0.0215 |

Ten papers billed $0.196 and took 2,616 s on the frozen prompt, $0.183 and 2,443 s
with the changes. The report's mean per set was $0.172 and 1,912 s.

### Against the report's row

| Against gold, one run of each | Scans whole, tight | Digital whole, tight | Whole | Tight | Both | Not reached |
|---|---|---|---|---|---|---|
| This trial, frozen | 14, 14 of 14 | 23, 22 of 26 | 37 | 36 | 34 | 1 |
| This trial, changed | 14, 14 of 14 | 23, 22 of 26 | 37 | 36 | 34 | 1 |
| The report's row, per 40 | 14, 14 | 24, 22.5 | 38 | 36.5 | 35 | 0.5 |

**The gap is Physics Q1.** The window named the ruler and the pen as one figure with
boxes 1 and 2, in both runs here and in 1 of 2 in the report. In a run with that
mistake the pen has no crop of its own and the ruler's crop is loose. Every other flaw
is on the report's list: Biology Q2's
missing axis title, Maths Q17's gold artefact, and Maths Q25 and Physics Q23 taking
in "NOT TO SCALE". On the eye pages, 2023 P2's Q23 and Q38 hold their options, also
listed.

Maths Q16 on the frozen run named the same cumulative frequency diagram under three
of its parts, so that crop is stored three times. Nothing checks for this. It did not
happen on the changed run.

## Prompt diff

`prompt_match.py` generates the window call's messages, tools and settings and the
tool results for unreadable figures, on the same two pages and boxes, from
`figure_windows.py` at `5700f09fd` and from production, each in its own process.
Before the two changes both dumps were 19,157 bytes and `diff` printed nothing.

After the changes the diff is exactly: one added line and one changed line in the
system prompt, and `trailing_text` on the two tools. The user message, settings, tool
results and crops are unchanged.

## The failure paths

| Forced | Paper | Result | Layout | Crops | By box call | Left out | Whole, tight | Seconds |
|---|---|---|---|---|---|---|---|---|
| Service killed (SIGKILL) after 5 pages | 2022 P2 | 45 questions, 45 of 45 marks, 43 of 45 keys | 4.4 s, 11 pages failed at once | 10 | 9 | none | 9, 6 of 10 | 386 |
| 429 flood from 16 clients at depth 2 | 2021 P1 | 10 questions | 17.6 s, every page busy after 4 tries | 2 | 2 | none | 1, 2 of 2 | 122 |
| No URL | 7 gold papers | All labels | 0 s, no request | 46 | 46 | none | 33, 28 of 40 gold | 96 to 461 |

The flood sent 20,955 requests in 122 s: 20,873 answered 429 and 82 answered 200. The
service stayed up and its depth limit held.

A failed page does not slow the run down: a refused connection fails at once, and a
busy page costs about 6 s of waiting before it gives up.

### Ink growth on the box call

The port gives the same box as `grow_ink` at `5700f09fd` on all of 312 boxes on
real pages. The no-URL runs are the first with real names: 33 whole, 28 tight and 25
both of 40, or 66, 56 and 50 when doubled, against the hosted test's 68, 64 and 56
and the old pad's 63, 40 and 36. Whole and both track that test, and tight falls a
little short. This is one run, against the test's two.

Twice in 26 Biology runs a window gave `boxes: []` for a figure printed on an earlier
page than the one it named (Q2 and Q6, both at window 4 from the cover). The box call
had nothing to find, failed twice, and the quiz saved without that figure, named in
`figuresLeftOut`. That is the path Epo decided on, and no crop was wrong.

## The code-only fixes

**Continuing a question in its own window.** `Run.extend` also accepts the last
question recorded in the current window, as Epo decided. Refused continues fell from 8
in 14 Biology runs to 3 in 26, but **the defect is not gone**. In 2 of the 26 runs one
reply recorded Q1 and Q2, and the next continued Q1, which was no longer the last. That
was refused, the model recorded Q1 again with its 4 new parts, and a(i) and a(ii) were
replaced (marks `[1,1,2,4]`). My recommendation is a one-line change: accept any
question recorded in this window (`key in window`), which also removes the
`window_last` field. It changes no prompt or string. I built what was decided and left
this for Epo.

**Options shown twice.** `_drop_option_lines` also removes a run of lines matching the
options in order. Real runs showed more shapes than the brief's plain lines, so the
match also takes a bare letter ("A a relay"), a letter in the math ("$A.\ (8,
60^\circ)$") and a line typeset where the option is not ("A. $82\text{ cm}$." beside
"82 cm"). Replayed offline over the saved questions, of 445 multiple-choice parts per
set:

| Set | Options still in the text, as run | With the fix |
|---|---|---|
| Frozen | 20 | 1 |
| Changed | 4 | 1 |

The one left is Physics Q17, which names its options in a printed sentence, so it
stays.

## Sentence lost at a window edge: `trailing_text`

Biology Q2(b)'s sentence is printed at the end of page 4 and its parts start on page
5. The runs below have a window edge there.

| Prompt | Runs | Sentence kept | Q2 marks right (3,3,3,4,2) | A part invented for it | Paper's parts all right |
|---|---|---|---|---|---|
| Frozen | 9 | 8 | 1 | 8, worth 1 to 5 marks | 1 |
| `trailing_text`, shown to the next window | 9 | 9 | 9 | 0 | 8 |
| `trailing_text`, not shown | 8 | 8 | 8 | 0 | 6 |

Settings: window 1 and 3 from page 2, window 2 and 4 from the cover, two runs each,
and the trial's whole-paper run on the first two rows.

The frozen prompt's "kept" is worse than it looks. The model has no place for the
sentence, so it writes it as a new part with marks and an invented answer, which a
learner would then be asked. That was not visible in the
[window-size report](2026-11-04-window-size.md), which counted the sentence as kept.

**Is the open question enough?** No. The next window sees the open question's labels
and text, plus its own page images. The sentence is on the page before, and that page
is not sent. We do not ask the model to check the last question either: the prompt
only asks it to continue the question if the first page carries on with it.

**Does showing it the held text help?** Not measurably. Code places the text either
way, so it lands first in part 2 in all 17 runs, and the worked solutions read Fig.
2.1 with or without it. My recommendation is to stop showing it, which removes one
`if` and one key from the message. It is built as shown until Epo decides.

No regressions: labels, keys and gold crops are the same in the ten-paper table. No
other paper used the field in 14 runs, and no question but Biology Q2 did. In about a
third of the runs the held text starts with its printed "(b) ". That is harmless but
not clean.

Why the "all right" column stops short of the runs: the 2 not-shown misses are the Q1
re-record above and an extra part in Q3. The 1 shown miss is the last window (page 17)
replying in words with no tool call, so Q6's last two parts were lost with nothing in
the report, since `report.missing` only names whole questions. None involves the held
text.

## Options copied digit for digit: Q34

2022 Paper 2 Q34 prints `12B00CD000000E`, six zeros, with options on `4^22, 4^14, 4^24,
4^16`.

| Prompt | Runs | Zeros right | Options as printed |
|---|---|---|---|
| Earlier runs, all window sizes | 11 | 8 | 10 |
| Frozen | 6 | 4 | 6 |
| With the line | 6 | 2 | 6 |

The line does not fix the zero, and it could not: the zero is in the question's text,
not an option. **The cause is the page read.** The indexed text for that page says
`12B00CD00000E`, five zeros, so the model sees five in the text and six on the image.
The rewritten options happened once in 23 runs, too rarely to tell whether the line
helps. Nothing got worse with it. I would take it out, since it shows no benefit. To
fix the zero itself, the choice is what scan pages send as text, which is a prompt
change for Epo.

## Limits

- One run of each paper per prompt, so a difference of a mark or two is noise.
- Mac and Linux detections differ slightly, on 1 box in 22 digital pages.
- **Not built:** the Docker image, the compose file on a host and the Linux wheels. The
  Dockerfile fails its build if the model does not load.
- **Not run:** a paper through the gateway, because that needs the local stack on Docker
  on an 8 GB Mac already using 3 GB of compressed memory and swap, with pgvector
  missing from its Postgres. The Go tests for stored crops and hidden clones need CI.
- Service sizes wait for the capacity test.

## Reproduce

```sh
R=data/question-bank/references; S=bench/extraction/scripts
# The service, in a throwaway venv with layout/requirements.in and the pinned model:
APP_ENV=development CAPY_LAYOUT_TOKEN=<token> LAYOUT_MODEL_PATH=<inference.onnx> LAYOUT_THREADS=4 \
  LAYOUT_WORKERS=1 LAYOUT_QUEUE_DEPTH=12 LAYOUT_MAX_BYTES=4194304 LAYOUT_MAX_PIXELS=5000000 \
  python -I -m uvicorn app:app --app-dir layout --host 127.0.0.1 --port 8092 --no-access-log
# The runs, in the root .venv:
CAPY_LAYOUT_URL=http://127.0.0.1:8092 CAPY_LAYOUT_TOKEN=<token> python -I $S/layout_trial.py run \
  --tag changed --window-pages 2 --scans $R/hkdse-math-compulsory --digital $R/born-digital \
  --env-file deploy/.env.uat --jobs 2021-p1:1 igcse-maths-0580-2025-sp2:1
python -I $S/layout_trial.py score --tag changed
python -I $S/layout_trial.py crossing --tag changed --digital $R/born-digital
python -I $S/layout_trial.py q34 --tag changed
python -I $S/layout_trial.py sheet --tag changed --name 2022-p2-all-w2-3
# Failures: add --kill-pid <service pid> --kill-after-pages 5, or --flood 16 with
# LAYOUT_QUEUE_DEPTH=2, or leave CAPY_LAYOUT_URL unset.
python -I $S/prompt_match.py production > production.json   # and `variant <tree>`, then diff
python -I $S/prompt_doc.py --window <result.json>:<index> ...
```

Results land in the ignored `.results/trial/<tag>/`.
