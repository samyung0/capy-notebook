# Make a quiz: which step gives a figure its box (2026-11-04)

Epo asked which flow to build once PP-DocLayout_plus-L finds the figures on a page.
The main candidate, Epo's idea: the user selects pages, layout runs on those pages,
and the window call gets the clean page image plus the boxes as JSON. It records each
figure by box number in the same call that extracts the questions. No second call and
no matching step. Nothing is drawn on the page images.

The comparison is matching in code: the windows name figures as they do today, code
gives boxes to names in reading order when the counts agree, and a picking call or the
box call handles the rest. Also compared: always picking and today's box call. Scripts:
`scripts/figure_windows.py`, `scripts/figure_matching.py`. No app code changed. Mac,
2026-11-04.

## Verdict

**Build the window pick.** It gave the most whole and tight crops, picked the wrong
box once in 149 named figures, needs no extra call, costs slightly less than today,
and changed nothing measurable in how questions are read.

| Figures against gold, 80 crops (28 scanned, 52 born-digital) | Scans whole | Scans tight | Digital whole | Digital tight | Whole | Tight | Both | Figures no name reached |
|---|---|---|---|---|---|---|---|---|
| **Window picks from the JSON boxes** | **28** | **28** | **48** | **45** | **76** | **73** | **70** | 1 |
| Order matching, then picking or box call, on real names | 28 | 28 | 45 | 42 | 73 | 70 | 67 | 4 |
| Always picking, on the same real names | 28 | 26 | 45 | 42 | 73 | 68 | 65 | 4 |
| Always picking, the layout bench's run (names from the fixture) | 28 | 26 | 48 | 46 | 76 | 72 | 68 | 0 |
| Today's box call, real names | 24 | 17 | 38 | 25 | 62 | 42 | 37 | 6 |

Both whole and tight on the same crop is the column to read. A figure no name reached
counts as neither. Two of the digital "not whole" crops in every row are Maths Q17,
where the gold box follows Bezier control points 3% of the page past the printed
circle, so the crop holds everything printed.

On the 26 pages without gold, read by eye (three new HKDSE papers and the rest of the
IGCSE papers), the window pick named 70 crops and all 70 got the right box. All 70 were
whole and 66 tight.

**Why not order matching.** It works on real names: 430 figures went through the order
branch in 95 runs and none got the wrong box. It rests on an assumption the window pick
does not need, though. A window that names one thing wrongly, or records two names out
of order, makes a wrong crop with nothing to flag it. It also starts from the names the
windows write today, and with no boxes to look at they missed 4 of the 52 digital crops
against 1 for the window pick.

**Decisions this needs from Epo:**

1. The detector in retrieval, on every selected page before the windows start: about 1
   CPU-second a page and about 540 MB while it runs (the layout report's numbers).
2. A window-picked crop takes a 1% pad and an adjacent caption instead of `FIGURE_PAD`.
   The 2026-11-04 decision to keep the 3% top pad (`human/agentic-retrieval.md`) would
   then cover only the box call.
3. A separate fix: options shown twice (see "Reading quality"). It happens with and
   without boxes, and nothing in this flow causes it.

## How the window pick was tested

Bench only, monkeypatched around the production `extraction.run` (`figure_windows.py`),
on 1017, the extraction route, at thinking `mid`, two pages a window.

- Before each window, the detector's `image` and `chart` regions at 0.5 or more on its
  pages. One of any pair with an IoU of 0.8 or more stays. A box is dropped when it holds
  a smaller box, at least 90% inside, plus `text` regions of its own.
- After each page's text comes a line: `Boxes on this page, as JSON: [{"box": 1, "page":
  6, "coordinates": [278, 125, 805, 307], "label": "image", "score": 0.97}]`. Numbers run
  across the window. The page image is untouched.
- The tool's figure item is `boxes`, `part` and `description`, and `image` only with
  `boxes: []`. The prompt's figure paragraph says to take all the boxes of a split figure,
  to take the one holding the least else when boxes overlap, to leave out a box that holds
  no figure of a question being recorded, and to give `[]` when no box holds the figure.
- Code crops the chosen boxes together, adds an adjacent caption and pads 1%. Only `[]`
  and pages with no boxes go to the box call. `description` stays, as alt text.

**Papers, two runs of each.** The 4 HKDSE gold papers, with their schemes. The 3 IGCSE
born-digital papers, every page. New on the Mac: HKDSE 2021 Paper 2, 2023 Paper 2 and
2025 Paper 2, picked for 2 or 3 figures on a page. "Today" on the gold papers is the
saved runs `81-w2` and `82-w2`, the same code and window size; elsewhere it is this
bench's own unpatched runs. Order matching and always picking on IGCSE Physics take their
names from unpatched repeats 3 and 4, because the box call failed on Q1's page in every repeat
and repeats 1 and 2 ran before the bench kept names from before that call.

**Detector.** PP-DocLayout_plus-L's ONNX export (SHA-256 `77afb2ca…07ff0e`, the layout
bench's file), run on the Mac under onnxruntime 1.31.1 at 4 threads over 158 pages, at a
median 0.67 to 0.93 s a page. The gold scans keep the layout bench's Linux detections.
The venv, its package cache and the model were in the scratchpad and are deleted.

Mac and Linux agree except by a grid unit on 5 of 22 digital pages, and on one box: Maths
Q21's inner box scores about 0.5, so it is a box on Linux and none on the Mac. A count
can flip that way, which is one more reason not to lean on counts.

**By eye.** Each box on the 26 pages without gold is assigned to its question in
`fixtures/matching/eye.json`. Those pages are scored right or wrong against that, and a
crop is whole and tight unless marked.

## The window pick's flaws

[`window-picks-flaws.jpg`](2026-11-04-figure-matching/window-picks-flaws.jpg) shows every
crop that was not whole or not tight, gold box green and crop red.

| Figure | Runs | What happens |
|---|---|---|
| Physics Q1, ruler and pen | 1 of 2 | The one wrong pick. The window named one figure with boxes 1 and 2, and a second with box 1. The crop holds both, with text between them. The other run was right |
| Biology Q2, graph | 2 of 2 | Run 1 did not name it. In run 2 the box has no y-axis title, which is the detector's limit |
| Maths Q17 | 2 of 2 | The gold artefact above; nothing printed is lost |
| Maths Q25, Physics Q23 | 2 of 2 each | The box takes in "NOT TO SCALE": whole, loose |
| Physics Q1, the pen | 1 of 2 | A small figure at 1% pad: 68% figure |
| 2023 P2 Q23, Q38 | 2 of 2 each | The detector's box holds options A-D beside the figure: whole, loose |

Against the layout bench's always-picking, it gains 2022 P2 Q14, where the figure-plus-text
rule leaves only the tight box. Always picking chose the outer box in 15 of 15 saved runs.

## Traps

**Real windows on page selections.** A selection is whole pages (`extraction.prepare`), so
"mid-page" can only mean a question crossing a page boundary. HKDSE Paper 1 and 2 questions
do not cross with a figure, so these use the IGCSE papers. Each selection ran twice with
boxes and once without.

| Trap | Selection | Window pick | Named today |
|---|---|---|---|
| Starts mid-question, figure of a question whose start is unselected | Biology p9-10 (Q3(c), Fig 3.3) | Right, all 4 boxes of the split figure, both runs | Named |
| The same | Biology p16-17 (Q6(b), Fig 6.2) | One run right, one did not name it | Named |
| The same, beside another question's figure | Maths p10-11 (Q16(b), Q17) | Q17 right in both. Q16(b) recorded with the right box in one; left out with its box unused in the other | Both named |
| Stops mid-question | Biology p7, Biology p14-15, Maths p9 | Right, 3 selections, both runs | Named |
| Cuts a question, two figures in one window | Biology p8-9 | Right boxes in both. One run wrote the parts as questions "3(b)(i)", "3(b)(ii)", "3(c)(i)" | Named under Q3 |
| Figure on the next window's page | Maths p8-11 (Q16's histogram on p10) and the whole Biology paper (Q3's Fig 3.3 on p9) | Right in every run, by the new window's numbers | Named |
| A box that is no question's | Maths p2-3 (triangle on the formula list) | Left unused, Q4 got its own, both runs | - |
| Two figures, one question | Physics Q1; Maths Q16 on two pages | Physics 1 of 2 right (above); Maths right | Physics: the box call failed on that page in all 4 runs, and the quiz lost the figures |
| Side by side | Maths Q25 (one box) | Right | - |
| Nested boxes with no text | Maths Q21 with the Linux detections (2 boxes) | The outer box, whole and tight, both runs | - |
| A split figure | Biology Q3's pedigree and 3 key symbols | All 4 boxes in every run | - |
| A figure with no box beside one that has a box | 2022 P2 p6-7 with Q17's box removed and all of p7's | Q17 got `[]`, never Q18's box. p7's three got `[]`. The box call found all 5, both runs | - |

No selection produced a crop on the wrong figure. What the window pick can do wrong here is
fail to name a figure, which leaves the quiz short of a picture, not holding the wrong one.

**Order matching on real names.** Every saved 1017 run, plus this bench's unpatched runs.
Each run is in [`per-run.md`](2026-11-04-figure-matching/per-run.md).

| Names from | Runs | Named | Order branch: figures, right, wrong | Picking branch: figures, right | Box call |
|---|---|---|---|---|---|
| Saved runs, the 4 HKDSE gold papers, all window sizes | 61 | 212 | 212, 212, 0 | 0 | 0 |
| Saved runs of IGCSE Biology, another bench's, all window sizes | 14 | 108 | 94, 94, 0 | 14, 14 | 0 |
| This bench, IGCSE papers | 6 | 62 | 58, 58, 0 | 4, 2 | 0 |
| This bench, new HKDSE papers | 6 | 55 | 55, 55, 0 | 0 | 0 |
| This bench, selections above | 8 | 13 | 11, 11, 0 | 2, 2 | 0 |
| **Total** | **95** | **450** | **430, 430, 0** | **20, 18** | **0** |

The 2 wrong picks are Physics Q1, where the windows named one figure for what gold counts
as two; the crop is whole and loose. Real windows never put a name on the wrong page, never
recorded a page's names out of order, and never named something that is no figure. They did
leave names out: Biology Q2 and Q3's Fig 3.1, 2025 P2 Q38.

**Order matching with mistakes put on real names.** One mistake at a time, on one run of
each of 10 papers. Counts that differ went to a real picking call.

| Mistake | Cases | Counts match | Of those, wrong with nothing to flag it | Counts differ, picking call | Of those, wrong | Box call |
|---|---|---|---|---|---|---|
| A name left out | 30 | 0 | 0 | 30 | 1 | 0 |
| An extra name, listed first | 54 | 1 | 1 | 53 | 2 | 0 |
| An extra name, listed last | 54 | 1 | 1 | 53 | 0 | 0 |
| A name on the next page | 71 | 0 | 0 | 42 | 1 | 29 |
| A name on the previous page | 71 | 3 | 3 | 43 | 0 | 25 |
| One name replaced by another | 71 | 69 | 69 | 2 | 2 | 0 |
| A page's names out of order | 13 | 13 | 13 | 0 | 0 | 0 |

A single miscount is caught almost always, because only 2 of the 85 checked pages have a
box count different from their figure count: Biology p9 (1 figure, 4 boxes) and Maths p2 (no
question's figure, 1 box). The silent cases are pages where the count was already off by one:
a box nobody named, or a name with no box. Q4 named one page early lands on the formula
sheet's triangle, and an extra name on Physics p2 takes the pen. A replaced or reordered name
is silent every time, by construction. Real windows did neither in 95 runs, so this is a risk
and not a measured rate.

**Cost of matching against always picking.** Order matching skips 344 of 364 picking calls
(95%), each about $0.0001 and 1.25 s at the median. The window pick skips them all.

## Reading quality

The boxes add a few lines of text to the prompt and change no image, so nothing can be
hidden. The question was whether they distract the model. They did not, as far as these
checks can see.

- **No question lost.** In all 42 runs across the 10 papers, each paper's recorded labels
  were identical. No outline label went missing.
- **Numbers.** Against each paper's majority reading, 8 questions differed in the 20 window
  runs and 15 in the 22 runs without boxes. One is a real misread with boxes: 2021 P2 Q31 in
  run 2 read y⁴ as y² in options A and B. The same run was the only one to get Q32's option
  D right, one digit longer than B. The rest are small and in both variants: figure references
  ("Fig. 3.2"), mark notes, answer-line text, and one `61^0` for 61°.
- **Options shown twice.** Option lines also kept as separate blocks: 27 of 440 multiple-choice
  questions with boxes, 14 of 520 without. It comes in bursts, 3 with boxes and 1 without,
  which is too few to call. No number is wrong, and it is what raises "unsupported"
  below. `_drop_option_lines` catches a block holding several lettered lines, not one line
  a block. The filler "Choose the correct option." appeared 12 times without boxes and never
  with.

| Paper, runs 1 and 2 | Variant | Labels | Part structure | Part marks | Worked-out part marks | MCQ keys worked out | Numbers compared | Unsupported | Dropped | Questions exact |
|---|---|---|---|---|---|---|---|---|---|---|
| 2021 P1 | today | 10/10 | 5, 7 of 10 | 5, 7 of 10 | 17, 15 of 19 | - | 39 | 0, 0 | 0, 0 | 8/8 |
| 2021 P1 | boxes | 10/10 | 6, 6 | 6, 6 | 17, 17 | - | 39 | 0, 0 | 0, 0 | 8/8 |
| 2022 P1 | today | 10/10 | 7, 5 of 10 | 7, 5 of 10 | 16, 17 of 18 | - | 64 | 0, 0 | 1, 1 | 9/10 |
| 2022 P1 | boxes | 10/10 | 6, 6 | 6, 6 | 16, 18 | - | 64 | 0, 0 | 1, 1 | 9/10 |
| 2022 P2 | today | 45/45 | 45, 45 of 45 | 45, 45 | 45, 45 of 45 | 42, 44 of 45 | 463, 464 | 0, 1 | 0, 0 | 45, 44 of 45 |
| 2022 P2 | boxes | 45/45 | 45, 45 | 45, 45 | 45, 45 | 43, 43 | 463 | 0, 0 | 0, 0 | 45, 45 |
| 2024 P1 | today | 10/10 | 8, 8 of 10 | 8, 7 of 10 | 15, 17 of 17 | - | 70, 68 | 1, 0 | 1, 1 | 8, 9 of 10 |
| 2024 P1 | boxes | 10/10 | 7, 7 | 7, 6 | 15, 17 | - | 68 | 0, 0 | 1, 1 | 9, 9 |
| 2021 P2 | today | 45 | - | - | - | - | 484, 477 | 8, 1 | 8, 8 | 40, 40 of 45 |
| 2021 P2 | boxes | 45 | - | - | - | - | 565, 476 | 87, 3 | 7, 8 | 34, 39 |
| 2023 P2 | today | 45 | - | - | - | - | 499 | 110, 110 | 153, 153 | 14/44 |
| 2023 P2 | boxes | 45 | - | - | - | - | 499 | 110, 110 | 153, 153 | 14/44 |
| 2025 P2 | today | 45 | - | - | - | - | 498 | 0, 0 | 0, 0 | 43/43 |
| 2025 P2 | boxes | 45 | - | - | - | - | 498, 562 | 0, 63 | 0, 0 | 43, 39 |

Dropped "1" on the gold P1 papers is "Figure 1", in the crop. 2021 P2's 87 and 2025 P2's 63 are
the option bursts. 2023 P2 has an odd text layer that gives the same 110 and 153 in every run,
so those columns say nothing about it. `run.fidelity` cannot split the IGCSE papers, so
`figure_windows.py` compares them from the text layer, split at each question's margin number.
Its counts are noisy (tables and superscripts) and show no difference: 44 and 72 unsupported
with boxes on Physics against 79 and 52 without, and 19 and 19 against 24 and 19 on Maths.

## Cost and time

Mean per run, summed over the 10 papers. Today's runs include their box calls, and the window
runs need none.

| | Seconds | Billed | Input tokens | Cached | Output tokens | Reasoning tokens | Model calls |
|---|---|---|---|---|---|---|---|
| Today | 2,092 | $0.182 | 1,403,700 | 1,161,900 | 279,300 | 138,900 | 235.5 |
| Window pick | 1,912 | $0.172 | 1,321,400 | 1,142,200 | 270,800 | 138,500 | 171.5 |

The JSON costs a few dozen tokens a box, and the box calls it replaces cost more: model calls
drop by 64 across one run of each paper. Output does not grow: the highest window output is 3,602 tokens a page with boxes and 4,271 without, against
the guard's 8,000. No run stopped on a guard. Add the detector, about 1 CPU-second a page,
which order matching and always picking need as well. On production's 2 CPUs a 16-page paper
takes about 9 s of it.

Per paper, each cell with boxes then today. Up to 4 runs shared one process, and the gold papers'
today runs are from earlier the same day:

| Paper | Seconds | Billed | Output tokens | Model calls |
|---|---|---|---|---|
| 2021 P1 | 86, 100 | $0.0075, $0.0077 | 10,954, 11,499 | 12, 14 |
| 2022 P1 | 126, 109 | $0.0104, $0.0090 | 16,828, 14,346 | 12, 13 |
| 2022 P2 | 260, 309 | $0.0254, $0.0265 | 41,406, 41,718 | 18, 25 |
| 2024 P1 | 85, 122 | $0.0080, $0.0089 | 11,984, 13,858 | 14, 15 |
| IGCSE Biology | 196, 201 | $0.0152, $0.0163 | 21,960, 22,762 | 22, 30 |
| IGCSE Maths | 124, 144 | $0.0123, $0.0141 | 17,696, 19,602 | 18, 30 |
| IGCSE Physics | 166, 194 | $0.0150, $0.0171 | 22,670, 24,238 | 18, 32 |
| 2021 P2 | 263, 236 | $0.0251, $0.0231 | 40,713, 36,104 | 18, 26 |
| 2023 P2 | 330, 405 | $0.0288, $0.0343 | 47,072, 56,114 | 18, 24 |
| 2025 P2 | 275, 273 | $0.0248, $0.0250 | 39,485, 39,040 | 20, 27 |

Differences between single runs of one paper are mostly reasoning tokens, which move by more
than this between any two runs.

## Left out

- **Small set.** 10 papers in English, all exam layouts with one column, two runs each. No
  two-column page, no Chinese paper, no handwriting.
- **The `[]` path** ran only with boxes removed by hand. No real page had a figure without a box.
- **No gateway run.** The crops, storage and the UI were not touched. A window pick's crop goes
  through the same `placed` and `capture.render` as today.
- **Window sizes.** Only 2 pages a window for the window pick. Order matching covered all sizes
  through the saved runs.
- **Whole and tight** on the 26 pages without gold are by eye, on one reading of each box.
- **Rule settings.** The 0.5 threshold, the caption gap, the 1% pad and the figure-plus-text rule
  were all set on these same papers or their predecessors.

## Spend

$0.77 of the $2 for this test: $0.39 window runs with boxes, $0.31 unpatched runs, $0.06 picking
and box calls, $0.01 page reads. The earlier page reads were reused from the study-extraction
worktree's cache, copied, not changed. The model file came from Hugging Face
(`PaddlePaddle/PP-DocLayout_plus-L_onnx`, 130 MB). All PDFs were already on the Mac.

## Reproduce

```sh
R=data/question-bank/references; S=bench/extraction/scripts
# In a throwaway venv with onnxruntime, numpy, pillow, pyyaml, pymupdf==1.28.2:
python -I $S/figure_matching.py detect --paper 2023-p2 --pdf $R/hkdse-math-compulsory/2023-p2.pdf --model <dir>
# In the root .venv:
python -I $S/figure_windows.py run --scans $R/hkdse-math-compulsory --digital $R/born-digital \
  --detections <layout bench's pp-plus-l-onnx.json> --env-file deploy/.env.uat --parallel 4 \
  --jobs 2021-p1:boxes:1 igcse-maths-0580-2025-sp2:none:1 igcse-maths-0580-2025-sp2@10-11:boxes:1
python -I $S/figure_matching.py match --saved <study-extraction .results> --detections <same> \
  --scans $R/hkdse-math-compulsory --digital $R/born-digital --env-file deploy/.env.uat
python -I $S/figure_matching.py traps --saved <study-extraction .results> --detections <same> \
  --scans $R/hkdse-math-compulsory --digital $R/born-digital --env-file deploy/.env.uat
python -I $S/figure_windows.py score --saved <study-extraction .results> --detections <same> \
  --digital $R/born-digital
```

Everything lands in the ignored `.results/windows/` and `.results/matching/`. The bench reads
the keys file's `DEEPSEEK_API_KEY` and `OPENROUTER_API_KEY` lines, uses the second, and prints
neither.
