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

## Decisions for Epo

1. **Locate failures fail the run.** A locate reply that is not one box per
   figure counts as a failed attempt, like a scheme reply that is not JSON: one
   silent retry, then the run fails. The alternative is to save the quiz
   without that page's figures and name them in the report.
2. **Storage full at the end fails the run** (`storage_full`), credits spent.
   The alternative is to save the quiz without its figures.
3. **The top pad brings in the question's own stem line** in about two thirds
   of crops. Without it, 5 of 14 crops lost labels at the top. Keep it, or
   accept clipped labels for cleaner crops?
4. **Wide figures with a continuation** (2022 P2 Q14's "⇒ ⋯") and lines that
   run far out (Q38's tangent) are clipped in both runs. Fixing them needs a
   smarter crop (snapping to ink) or a second, zoomed locate call; not done.

## Left out

- No born-digital paper: every paper here is a scan, so "the page's own text
  layer" is the OCR and the VLM read. On a PDF with a text layer the check uses
  the layer itself.
- No run went end to end through the gateway (Docker was not running). The Go
  side of the figures (storing the crops as the quiz's assets) is covered by
  `TestFinishedExtractionStoresItsFiguresAsTheQuizsAssets`, which runs in CI.
- The lead-in field and the partial-stem fix landed after runs 73 and 74.

## Cost

Runs 71 to 74 (14 runs) were billed $0.20 by OpenRouter. The locate probe, and
the VLM page reads of 2022 Paper 1 and its scheme (21 pages on the captioning
route), cost about $0.01 more.

The repository's `.env.local` holds no `OPENROUTER_API_KEY`. The bench read it
from `deploy/.env.uat` (only the `DEEPSEEK_API_KEY` and `OPENROUTER_API_KEY`
lines; nothing printed).

## Reproduce

```sh
python bench/extraction/scripts/run.py --paper 2022-p1 --model v41-1017 --repeat 1 \
  --refs data/question-bank/references/hkdse-math-compulsory --env-file <keys file>
```

Add `--score-only` to rescore a saved run. Crops land in
`.results/crops/<paper>-<model>-<n>/`.
