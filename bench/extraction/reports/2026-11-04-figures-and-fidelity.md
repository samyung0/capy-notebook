# Make a quiz: figures and fidelity (2026-11-04)

The third round of the question-extraction bench. The first two
([first cut](2026-11-03-first-cut.md),
[keys in one prompt](2026-11-03-keys-in-one-prompt.md)) scored labels, keys
and marks only. This round checks what a learner sees: the figures, cropped
into the quiz for the first time, and the text itself against the page. All
runs use `deepseek/deepseek-v4.1-flash-1017` on OpenRouter on the extraction
slot's route (InferenceNet, then Cloudflare, then `wafer/us`, fallbacks off);
InferenceNet served every call. Mac, 2026-11-04.

Papers: 2021 Paper 1, 2024 Paper 1 and 2022 Paper 2 as before, and 2022 Paper 1
(pages 2-8, with its marking scheme) added for its tables: question 9 prints a
frequency table and a cumulative frequency table side by side. All four are
scans with no text layer.

## What changed in the code

- **Figures are cropped into the quiz.** The window call names each figure: the
  page image it is on, the part whose text it follows, and a few words on what
  it shows. After pairing, one call per page with figures sees that page alone,
  reasoning off, and answers a box per figure (`locate_figures`). The box is
  padded and the figure cropped from the page with its long side at 2,200 px
  (`FIGURE_PAGE_EDGE`, about 190 DPI on A4), so labels read and a small figure
  stays small. It goes after its part's text as an image block, and its
  description becomes the alt text that grading reads. The gateway stores the
  crops as the quiz's own editor assets, as it stores the chat agent's library
  figures: written to `editor-assets/{id}/…` and inserted with the quiz in its
  creating transaction. They are charged to the run's starter like images it
  uploads (M16) and checked against its plan image cap. A quiz and figures over
  the starter's quota fail the run as `storage_full`. No new table, key prefix
  or payer.
- **Options are shown once.** Lettered option lines that the model also copied
  into a part's text are taken out when they match the options. A one-part
  question whose stem repeats its part's text, or the stem's last sentence,
  keeps that text once.
- **Scheme repeats are left out.** A scheme entry with the same label as an
  earlier one is merged into it only when it continues the last entry of the
  previous scheme piece. Any other repeat is left out and named in the report
  (`schemeRepeats`).
- **Prompt:** a sub-part's lead-in (text printed under (b) before (i)) is now
  its own field (`lead_in`), and a dollar sign for money is written `\$`.

## Figures

### Where the boxes come from

At first the window call gave the boxes itself, beside two page images and the
whole extraction. Those boxes were too far off to crop from:

| Boxes from | Crops | Whole | Tight | Missed the figure |
|---|---|---|---|---|
| The window call (2022 P2 run 71, 2021 P1 runs 71-72) | 14 | 4 | 3 | 3 (2022 P2 Q20, Q21, Q24) |
| A call that sees the page alone, no pad (run 72, all four papers) | 14 | 5 | 13 | 0 |
| The same, padded (runs 73 and 74) | 28 | **21** | 18 | 0 |

*Whole* means at most 2% of the figure falls outside the crop. *Tight* means
at least 70% of the crop is figure. Both are measured against gold boxes read
by hand from gridded renders (`figure_boxes` in the gold files, about ±5 on the
0-1000 grid).

A one-off probe asked the same page-alone call for its boxes in pixel
coordinates. Those were off by up to 16% of the page, against 2.5% on the
0-1000 grid, so the grid stays.

The located boxes sit a little low. Their tops cut off labels above the figure
(5 of 14), while their bottoms were already loose (9 of 14). The pad
(`FIGURE_PAD`) adds 2% of the page at the sides, 3% at the top and 0.5% at the
bottom. Simulated on run 72's 14 boxes it gave:

| Pad (left/right, top, bottom) | Whole | Tight |
|---|---|---|
| none | 5/14 | 13/14 |
| 1% all round | 9/14 | 11/14 |
| 2% all round | 10/14 | 8/14 |
| **2%, 3%, 0.5%** | **12/14** | **11/14** |

### Every crop, by eye (runs 73 and 74)

I looked at all 28 crops. 21 hold the whole figure with all its labels. The
other seven:

| Figure | Runs | What is lost |
|---|---|---|
| 2021 P1 Q9 (bar chart) | 73, 74 | the ends of the chart title (both ends in run 73, the last word in run 74); run 73 also cut the y-axis label |
| 2022 P2 Q14 (dot patterns) | 73, 74 | the trailing "⇒ ⋯" after the third pattern; the crop also holds the question's option "A. 52" |
| 2022 P2 Q38 (circle with tangents) | 73, 74 | the tangent line's end and its label Q on the left |
| 2022 P2 Q21 (circle) | 74 | the top of the triangle and the label A |

No crop holds anything from the next question. Most crops (9 of 14 in each run)
hold the last line of their own question's stem at the top: that is the price
of the top pad. Two hold page furniture: a page number in one, the "Go on to
the next page" footer in another.

Examples are in [the report's folder](2026-11-04-figures-and-fidelity/): a
clean crop (2022 P2 Q22), one with its stem line above (2022 P1 Q8), the bar
chart (2021 P1 Q9, run 74), and the two that clip (2022 P2 Q38 and Q14).

### Sizes

The crops are JPEGs at quality 80, 600-1,060 px on the long side, 12-54 KB each
(median 19 KB). A 16-page paper with 10 figures adds about 190 KB to the
starter's storage. The locate calls add one call per page with figures: 6 calls
on 2022 Paper 2, under $0.002 a run.

## Fidelity: the text against the page

The bench compares each saved question's text (stem, parts, options, table
cells) with the page's own text. These scans have no text layer, so it compares
with two readings: the refs folder's Tesseract OCR (rough, it garbles maths)
and the cached VLM page read. A number or unit is *unsupported* when neither
reading has it in that question's span. It is *dropped* when both readings have
it and the extraction does not. Scheme entries are checked the same way
against the scheme's readings, for unsupported numbers only. Alternative
methods and examiners' comments are left out on purpose, so a dropped count
would mean nothing there. LaTeX is parsed with KaTeX; the app renders with
MathLive, which is more lenient. The flagged cases were checked against the
page by hand.

| Paper | Run | Numbers compared | Unsupported | Dropped | Questions exact | KaTeX failures (spans) | Scheme numbers unsupported |
|---|---|---|---|---|---|---|---|
| 2021 P1 | 73 | 39 | 0 | 0 | 8/8 | 0 (156) | 4 of 89 |
| 2021 P1 | 74 | 38 | 0 | 1 | 7/8 | 0 (156) | 3 of 87 |
| 2024 P1 | 73 | 68 | 0 | 1 | 9/10 | 0 (155) | 0 of 72 |
| 2024 P1 | 74 | 72 | 4 | 1 | 8/10 | 0 (154) | 0 of 72 |
| 2022 P1 | 73 | 68 | 3 (+2 units) | 0 | 9/10 | 0 (146) | 0 of 50 |
| 2022 P1 | 74 | 64 | 0 | 1 | 9/10 | 0 (138) | 0 of 50 |
| 2022 P2 | 73 | 463 | 0 | 0 | 45/45 | 0 (670) | (answer list) |
| 2022 P2 | 74 | 463 | 0 | 0 | 45/45 | 0 (692) | (answer list) |

Two 2021 questions (4 and 6) are left out of the comparison because the OCR lost
their labels. Every other flag, checked against the page:

- **2021 Q10(b), run 74, dropped "3": a lost lead-in.** The text "Denote the
  graph of y = f(x) + 3 by G" under (b), before (i), was missing, so (b)(i) and
  (b)(ii) refer to a G the quiz never defines. The same happened to 2021
  Q8(b)'s lengths ("It is given that AC = 25 cm, AE = 60 cm, …") in runs 51 and
  71. A sentence in the prompt saved it in runs 72 to 74, but Q10's lead-in was
  still lost in run 74. Sub-parts now carry a `lead_in` field that code puts
  first in their blocks. The window-size bench measures it.
- **2024 Q5, run 74, and 2022 P1 Q5, run 73: text shown twice.** The one-part
  question's text was in both the stem and the part: whole in 2022 P1 Q5, and
  the last sentence ("Find (5a+8b)/(2b+3c)") in 2024 Q5. The saved runs hold
  four such questions in all (also 2022 P2 Q31, Q33 and Q34 in run 72). Code now
  keeps the text once.
- **"Figure 1" (2024 Q8, 2022 P1 Q8): dropped "1".** The caption is in the
  figure, and the crop holds it.
- **2021 Q8, scheme numbers 2800, 400, 580, 660.** These come from a later
  question's solution that the scheme parse named "8 b(ii)". Merged in, as run
  51 did, it gave Q8(b)(ii) 4 marks instead of 2 and another question's marking
  points. It is now left out and named in `schemeRepeats`; run 73's and run
  74's saved Q8(b)(ii) has its 2 marks and the scheme's 1M and 1A.
- **Money.** Run 72 saved "the profit is $78" with a bare `$`. It shows
  correctly only because the text has one `$`; a second amount would turn the
  text between them into maths. The prompt now asks for `\$`, and runs 73 and
  74 have no stray `$`.
- **Duplicated options.** In the earlier run 52, 21 of 2022 Paper 2's 45
  multiple-choice questions held their lettered option lines in the text as
  well as in the options (counting a text block with both "A." and "B." lines).
  The new code removes all 21 from that run's saved output, and no run since
  has any left. In 7 of the 21 (the 7 Epo counted), the part's text was only
  the option list, as a block of its own; there the stem becomes the part's
  text.

Units (cm, mm, km, kg, %, °, minutes, hours) agree everywhere except the
duplicated 2022 P1 Q5. Apart from the cases above, every number on these pages
came through, and every number saved is on the page.

### Tables (2022 Paper 1, question 9)

Both runs saved both tables as two table blocks, each 5 rows by 2 columns with
the header flag right: 20 of 20 cells in place in each run (the entries a, x and
y as `$a$`, `$x$` and `$y$`, and 10 – 14 as `$10 - 14$`).

## Keys and marks, for comparison with round 2

| Paper | Runs 73, 74 | Labels | Part structure | Part marks | MCQ keys worked out = official | Seconds | Billed |
|---|---|---|---|---|---|---|---|
| 2021 P1 | 2 | 10/10, 10/10 | 8/10, 7/10 | 7/10, 7/10 | – | 107, 96 | $0.0096, $0.0077 |
| 2024 P1 | 2 | 10/10, 10/10 | 8/10, 7/10 | 8/10, 7/10 | – | 110, 114 | $0.0102, $0.0092 |
| 2022 P1 | 2 | 10/10, 10/10 | 6/10, 8/10 | 6/10, 8/10 | – | 80, 111 | $0.0082, $0.0090 |
| 2022 P2 | 2 | 45/45, 45/45 | 45/45, 45/45 | 45/45, 45/45 | 43/45, 44/45 | 326, 275 | $0.0289, $0.0227 |

As in round 2, the Paper 1 structure misses are mostly 1-mark parts typed as
short answers, which the gold types as open.

## Epo's decisions (2026-11-04)

1. **A failed box call** gets one silent retry; after that the quiz is saved
   without that page's figures, and the report names their questions
   (`figuresLeftOut`). The run does not fail. Built and tested.
2. **Storage full at the end:** the quiz is saved without its figures, which
   are named in `figuresLeftOut`. Built and tested. Only a quiz that does not
   fit by itself fails as `storage_full`.
3. **The top pad stays**, including the question's own stem line it brings
   into about two thirds of the crops.
4. **Clipped wide figures** (2022 P2 Q14 and Q38) are left as they are for
   now.

## Born-digital pages

Epo asked whether the box call, which works on scans, also works on
born-digital pages. If it does, Make a quiz does not need the parser's figure
boxes from ingest. I tested it on three public Cambridge IGCSE specimen papers
from cambridgeinternational.org. Each page has a text layer. The PDFs are kept
in the ignored `data/question-bank/references/born-digital/`, never in git.

- **Mathematics 0580** (2025 specimen, Paper 2): 7 figures, all vector graphics
  (a semicircle, grids, a cumulative frequency curve, a histogram grid, a
  cyclic quadrilateral, shapes with dimension labels).
- **Physics 0625** (2023 specimen, Paper 2, multiple choice): 12 vector
  diagrams. Four pages hold two figures each (on one, both belong to
  question 1), and question 34's four option diagrams form one figure.
- **Biology 0610** (2023 specimen, Paper 4): 3 embedded raster photographs
  (two photomicrographs and a photograph) and 4 vector figures (a graph, a
  pedigree with its key, a food web, a nitrogen cycle).

That is 26 figures on 21 pages.

**Gold boxes come from the PDF itself** (`scripts/gold_digital.py`). For each
figure, a seed region is set by hand. The gold box is everything the PDF holds
inside that region: drawings, images and words, labels included. The
"Fig. n.n" caption and "NOT TO SCALE" are left out. All 26 were checked by eye
on renders; each holds the whole figure and nothing of the question text.

**Each figure was run as production runs it** (`scripts/locate_digital.py`).
`extraction.locate_figures` sends one call per page, reasoning off, with the
page image at the windows' resolution, the same prompt and padding, on the
extraction route. Each figure is listed with its question label and a
description of the kind the window writes. Two repeats; InferenceNet served
every call.

| | Repeat 1 | Repeat 2 | Scans, runs 73 and 74 (for comparison) |
|---|---|---|---|
| Figures | 26 | 26 | 28 |
| Whole after the pad | 22 | 21 | 21 |
| Whole without the pad | 13 | 12 | – |
| Tight (≥ 70% figure) after the pad | 12 | 13 | 18 |
| Missed entirely | 0 | 0 | 0 |
| Took in the next question | 0 | 0 (one bottom edge touched the next question's first line by 0.5% of the page, nothing visible) | 0 |
| Took in another figure on the page | 0 | 0 | 0 |
| Calls, time, billed | 22 calls (one retried), 4.2 s, $0.0006 | 22, 3.9 s, $0.0006 | – |

By kind, over both repeats:

| Figures | Count | Whole after the pad |
|---|---|---|
| Raster (photographs) | 6 | 6 |
| Vector | 46 | 37 |
| Large (5% of the page or more) | 38 | 33 |
| Small (under 5% of the page) | 14 | 10 |
| Alone on their page | 36 | 33 |
| Two on their page | 16 | 10 |

**What is lost when a crop is not whole.** Every miss is a label set outside
the drawn lines: a leader-line label ("converging lens", "six turns of
string", "transparent plastic"), a dimension label at the side ("(h+2)"), or,
once, a graph's y-axis title and numbers. Small figures and pages with two
figures are where this happens most. The scans lost the same kind of thing.

The pad was tuned on scans, where located boxes sit a little low. On
born-digital pages the raw boxes are already well placed, so the pad mostly
adds the stem line above and the caption below. That is why tight drops from
22-23 of 26 without the pad to 12-13 with it.

Crops are 10-235 KB (median 26 KB). Large vector graphs and photographs are the
biggest, at about 1,000-1,400 px on the long side.

**Verdict.** One box call is good enough for every kind of page we tried: on
scans and born-digital pages alike it placed every box it was asked for on
its figure (14 scanned and 26 born-digital figures, two runs each, 80 boxes),
never took in another question or figure, and gave whole crops for 75% of the
scanned figures and 83% of the born-digital ones. The parser's figure boxes
from ingest are not needed for Make a quiz.

It is not exact on either kind of page. About one figure in five or six loses
a side label. On born-digital pages that could be fixed without ingest boxes:
at crop time, snap the located box to the PDF's own drawings, images and words
around it, the way the gold boxes were made. Scans have nothing to snap to.
Not built.

**Not done:** OpenDataLoader's own image and chart boxes on these pages. Java
17 is on the Mac, but running the parser locally means installing
`opendataloader-pdf` into a separate environment and building its entry jar,
so this optional comparison was skipped.

## Left out

- No born-digital paper: every paper here is a scan, so "the page's own text
  layer" is the OCR and the VLM read. On a PDF with a text layer the check uses
  the layer itself.
- No run went end to end through the gateway (Docker was not running). The Go
  side of the figures (storing the crops as the quiz's assets) is covered by
  `TestFinishedExtractionStoresItsFiguresAsTheQuizsAssets`, which runs in CI.
- The lead-in field and the partial-stem fix landed after runs 73 and 74.
- The born-digital test ran the box call alone, with hand-written figure
  descriptions, not the whole extraction.

## Cost

Runs 71 to 74 (14 runs) were billed $0.20 by OpenRouter. The locate probe, and
the VLM page reads of 2022 Paper 1 and its scheme (21 pages on the captioning
route), cost about $0.01 more. The two born-digital repeats cost $0.0012.

The repository's `.env.local` holds no `OPENROUTER_API_KEY`. The bench read it
from `deploy/.env.uat` (only the `DEEPSEEK_API_KEY` and `OPENROUTER_API_KEY`
lines; nothing printed).

## Reproduce

```sh
python bench/extraction/scripts/run.py --paper 2022-p1 --model v41-1017 --repeat 1 \
  --refs data/question-bank/references/hkdse-math-compulsory --env-file <keys file>
```

Add `--score-only` to rescore a saved run. Crops land in
`.results/crops/<paper>-<model>-<n>/`. The born-digital test:

```sh
python -I bench/extraction/scripts/gold_digital.py data/question-bank/references/born-digital
python -I bench/extraction/scripts/locate_digital.py data/question-bank/references/born-digital \
  --repeat 1 --env-file <keys file>
```
