# Make a quiz: hosted box models against DeepSeek's figure boxes (2026-11-04)

Epo asked for this because DeepSeek's figure boxes run narrow. It tests hosted
models trained to return boxes against the box call in "Make a quiz"
(`extraction.locate` on `deepseek/deepseek-v4.1-flash-1017`, with `FIGURE_PAD`),
on the same 40 figures. It also tests post-processing that needs no extra AI
call. The result is compared with the layout model in
`bench/extraction/reports/2026-11-04-layout-models.md` on
`claude/bench-layout-figures`. Mac, 2026-11-04. Script:
`scripts/hosted_boxes.py`.

## Does a hosted model beat the layout model?

No, not by more than noise.

Qwen3-VL-30B grown to nearby ink has higher totals than PP-DocLayout_plus-L with
1017 picking the box. The lead is 1 to 3 crops of 80, which is one or two
figures over two runs. It flips when you change the margin or fix the gold's
blank areas. On the half of the figures its setting was not chosen on, it is one
crop behind.

All counts are over two runs: 28 scanned crops, 52 born-digital crops. *Both*
means one crop is whole and tight. *Held out* is the 40 crops on the half of the
figures not used to choose the setting. The layout model's settings were chosen
on all the figures, so its held-out column flatters it a little.

| Pipeline | Scans whole | Scans tight | Digital whole | Digital tight | Whole /80 | Tight /80 | Both /80 | Held out both /40 |
|---|---|---|---|---|---|---|---|---|
| **PP-DocLayout_plus-L, 1017 picks the box, caption, 1% pad** | **28** | **26** | **48** | **46** | **76** | **72** | **68** | 38 |
| Qwen3-VL-30B, ink growth (gap 6, cap 50, margin 10) | 26 | 28 | 52 | 45 | 78 | 73 | 71 | 37 |
| GLM-4.5V, ink growth (gap 8, cap 80, margin 5) | 26 | 28 | 47 | 50 | 73 | 78 | 71 | 35 |
| Qwen3.6-Plus, 0.5% pad | 28 | 23 | 50 | 47 | 78 | 70 | 68 | 38 |
| Qwen3.6-Plus, today's pad | 28 | 20 | 52 | 25 | 80 | 45 | 45 | 21 |
| DeepSeek 1017, today's prompt, ink growth (gap 6, cap 80, margin 5) | 23 | 24 | 45 | 40 | 68 | 64 | 56 | 27 |
| DeepSeek 1017, today's prompt, today's pad (production) | 20 | 16 | 43 | 24 | 63 | 40 | 36 | 17 |

The layout row was rescored here from that bench's saved crops, and it gives the
report's 76, 72 and 68. None of these pipelines took in another figure. Only
DeepSeek took in the next question, 2 crops in each of its rows.

Each pipeline fails differently. I looked at all 40 crops of one run of each
hosted candidate, and the layout model's flaws come from its report and saved
crops:

- **The layout model** loses Biology Q2's y-axis title in both runs. Its Q14 crop
  also holds the four options, because 1017 picks the outer box.
- **Qwen3-VL-30B with ink growth** loses the "Figure 1" caption of 2024 P1 Q8 in
  both runs. That is its only real loss. A few born-digital crops are loose, such
  as Maths Q25 with "NOT TO SCALE" beside it.
- **Qwen3.6-Plus with a 0.5% pad** loses nothing printed. Its boxes are sometimes
  far too big on HKDSE Paper 1 pages, though. The 2021 P1 Q8 crop in run 2 is 31%
  figure and holds parts (a) and (b) of the question.

## Recommendation

**Keep the layout-model plan.** A tie on quality gives no reason to add a second
vision model and new hosts. The layout route keeps 1017 as the only AI model, no
new host sees the pages, and no host can retire the model. Its cost is the
onnxruntime dependency, a 130 MB model file, and about 520 MB during a run.

**If Epo does not want that runtime in retrieval, Qwen3-VL-30B with ink growth is
an equal alternative.** It needs one call per page, about 50 lines of Pillow, and
a parser for Qwen's replies. It costs $0.007 per 16 pages against about $0.0016, and takes 5.6 s a page at the
median. It needs Epo's sign-off, because it adds a model beside 1017, and his
provider order (Novita then SiliconFlow served these runs).

**Either way, ink growth improves the fallback box call.** Layout's plan keeps
today's call for pages with no box. Replacing `FIGURE_PAD` with ink growth takes
DeepSeek from 63 whole, 40 tight and 36 both to 68, 64 and 56, with no new model.
This goes against Epo's 2026-11-04 decision to keep the top pad
(`human/agentic-retrieval.md`), so it needs his call. It is not built.

**Not worth pursuing:**

- GLM-4.6V, whose raw boxes are the narrowest of all (22 of 80 whole).
- Qwen3.6-Flash, which is erratic on born-digital pages.
- Mistral OCR, which splits figures, leaves out titles and captions, and costs
  the most.
- Growing to text lines, which adds nothing over ink growth or a small pad on the
  models worth using.

**Not tested:** Gemini and Alibaba Model Studio. Both answer 403 from this Mac
(see "Blocked"). I retested both after Epo's account switch and got the same
answers.

## What ran

**Figures.** The same 40 gold figures as the previous round, on 32 pages. The 14
scanned figures (HKDSE 2021 P1, 2022 P1, 2022 P2, 2024 P1) are now in
`fixtures/scanned/figures.json`, with run 73's descriptions and each figure's next
question number, found with Tesseract. The 26 born-digital figures are in
`fixtures/digital/figures.json`.

**Calls.** One call per page. Each sees the page as production renders it (long
side 1,568 px) with its figures listed as production lists them ("Question 8:
…"). A failed call is retried once, as production does. Two runs per model.

**Prompts.** Each model is asked in its own box format, keeping production's rule:
"the whole figure with its labels, title, axis labels and caption, and nothing of
the question text, options or answer lines around it."

- Qwen: "Locate each of these figures … Report bbox coordinates in JSON format",
  a list of `{"label", "bbox_2d": [x1, y1, x2, y2]}` on 0-1000.
- GLM: one line per figure with `<|begin_of_box|>[x1, y1, x2, y2]<|end_of_box|>`
  on 0-1000.
- Gemini: Google's detection system prompt and `box_2d` as `[ymin, xmin, ymax,
  xmax]` on 0-1000. It is written, but no call got through.

**Routing.** Every route was pinned with `allow_fallbacks: false` and DeepInfra on
`provider.ignore`. Parasail served all 68 Qwen3-VL-235B calls. Novita served 59
Qwen3-VL-30B calls and SiliconFlow 5. Alibaba served Qwen3.6, and Z.AI served GLM.
OpenRouter has no 32B Qwen3-VL, so I ran 30B-A3B.

**Models beyond the brief.** Qwen3.6-Flash and Qwen3.6-Plus were added because
Model Studio was blocked and Alibaba serves them through OpenRouter. GLM-4.5V and
GLM-4.6V both ran, since Gemini was out.

**Reasoning.** Off (`reasoning.enabled: false`) on Qwen3.6 and GLM. Every call
reported 0 reasoning tokens. The Qwen3-VL instruct models do not think.

**Baselines.** The DeepSeek rows are the earlier prompt-variant runs, read into
this bench: scanned runs 201-202 with `digital-1` and `-2` for today's prompt, and
runs 221-224 for "list the labels first". The layout row is that bench's final
crops, rebuilt from its saved edges.

**Scoring.** `locate_digital.score`, comparing exact values as `layout_score.py`
does. *Whole* means at most 2% of the gold figure falls outside the crop. *Tight*
means at least 70% of the crop is figure. *Next question* means the crop's bottom
passes the top of the next question number. *Other figure* means the crop holds
more than 5% of another gold figure on the page.

## Every model

Counts are over two runs. "Padded" is today's `FIGURE_PAD`. The layout row's
padded columns are its final crop. The ink columns use each model's own setting,
listed under "Growing to ink".

| Model, served by | Raw whole scans /28 | Raw whole digital /52 | Raw tight /80 | Padded whole scans | Padded whole digital | Padded tight | Padded both | Ink whole scans | Ink whole digital | Ink tight | Ink both |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Layout plus-L with 1017, InferenceNet | – | – | – | 28 | 48 | 72 | 68 | – | – | – | – |
| DeepSeek 1017, today's prompt, InferenceNet | 6 | 25 | 69 | 20 | 43 | 40 | 36 | 23 | 45 | 64 | 56 |
| DeepSeek 1017, list the labels first, InferenceNet | 14 | 32 | 66 | 21 | 45 | 43 | 37 | 17 | 44 | 61 | 47 |
| Qwen3.6-Plus, Alibaba | 22 | 47 | 72 | 28 | 52 | 45 | 45 | 24 | 49 | 72 | 65 |
| Qwen3.6-Flash, Alibaba | 20 | 21 | 67 | 25 | 33 | 51 | 33 | 27 | 47 | 62 | 57 |
| Qwen3-VL-235B-A22B, Parasail | 12 | 46 | 72 | 26 | 48 | 51 | 47 | 26 | 49 | 71 | 66 |
| Qwen3-VL-30B-A3B, Novita | 17 | 41 | 77 | 24 | 50 | 55 | 51 | 26 | 52 | 73 | 71 |
| GLM-4.5V, Z.AI | 6 | 29 | 78 | 20 | 45 | 56 | 43 | 26 | 47 | 78 | 71 |
| GLM-4.6V, Z.AI | 2 | 20 | 78 | 20 | 34 | 58 | 34 | 27 | 42 | 76 | 65 |
| Mistral OCR plugin | 16 | 32 | 78 | 20 | 40 | 56 | 40 | 20 | 38 | 78 | 56 |
| Mistral OCR, pieces joined | 16 | 34 | 78 | 20 | 44 | 56 | 42 | 20 | 42 | 78 | 60 |

Next question: DeepSeek today's prompt 2 padded and 2 grown, list first 1 padded.
No other row took one in. No crop took in another figure.

Raw boxes are mostly tight and often not whole, and nearly every miss is a label
or a line's end just outside the box. Qwen3.6-Plus has the most whole raw boxes.
GLM's hug the drawing hardest.

### Cost, speed and provider

| Model | Served by | $ per page, run 1 | $ per 16-page paper | Median s a page | p90 s | Tokens in, out a call |
|---|---|---|---|---|---|---|
| Layout plus-L with 1017 | local, then InferenceNet | about 0.0001 | about 0.0016 | about 2 for the pick, plus 0.55 at 2 threads | – | – |
| DeepSeek 1017, today's prompt | InferenceNet | 0.00004 | 0.0006 | not recorded per call | – | – |
| DeepSeek 1017, list first | InferenceNet | 0.00013 | 0.0021 | not recorded per call | – | – |
| Qwen3.6-Plus | Alibaba | 0.00079 | 0.0127 | 3.5 | 4.8 | 1,872, 96 |
| Qwen3.6-Flash | Alibaba | 0.00044 | 0.0070 | 3.2 | 5.1 | 1,872, 77 |
| Qwen3-VL-235B | Parasail | 0.00056 | 0.0089 | 2.2 | 3.5 | 1,867, 89 |
| Qwen3-VL-30B | Novita, SiliconFlow | 0.00043 | 0.0069 | 5.6 | 8.2 | 1,867, 73 |
| GLM-4.5V | Z.AI | 0.00139 | 0.0223 | 3.2 | 3.9 | 2,380, 18 |
| GLM-4.6V | Z.AI | 0.00070 | 0.0112 | 4.3 | 5.5 | 2,385, 26 |
| Mistral OCR plugin | plugin, carrier call on Novita | 0.00208 | 0.0333 | 3.3 | 4.2 | – |

"Per 16-page paper" is 16 page calls, an upper bound, since production calls only
the pages with figures. Z.AI's cache cut GLM's second run to $0.00033 and $0.00040
a page. The layout model also costs about 1 CPU-second a page and 540 MB at peak.

## Post-processing

Settings were chosen on the tuning half, every other figure in each set (7 scanned,
13 born-digital), for the most crops both whole and tight. Another question or
figure in a crop costs two of those, and whole breaks ties. The other half checks
the choice.

### Wider and narrower pads

A wider pad rescues DeepSeek only by turning most crops into page. Top stays at 3%.

| Model | Sides / bottom | Whole /80 | Tight /80 | Both /80 | Next question or other figure |
|---|---|---|---|---|---|
| DeepSeek, today's prompt | 3% / 1% | 64 | 31 | 29 | 4 |
| DeepSeek, today's prompt | 6% / 1.5% | 72 | 7 | 6 | 5 |
| DeepSeek, list first | 3% / 1% | 68 | 31 | 27 | 3 |
| DeepSeek, list first | 6% / 1.5% | 77 | 4 | 4 | 3 |
| Qwen3.6-Plus | 3% / 1% | 80 | 28 | 28 | 0 |
| Qwen3-VL-235B | 3% / 1% | 77 | 42 | 41 | 0 |
| Qwen3-VL-235B | 4% / 1.5% | 80 | 22 | 22 | 0 |
| Qwen3-VL-30B | 3% / 1% | 76 | 40 | 38 | 0 |
| Qwen3-VL-30B | 5% / 1% | 78 | 19 | 19 | 0 |
| GLM-4.5V | 3% / 1% | 67 | 50 | 40 | 0 |

The hosted boxes need much less, so I also tried narrower pads, which the brief
did not ask for. The layout model's 1% pad prompted it.

| Model | Chosen pad (left, top, right, bottom) | Whole /80 | Tight /80 | Both /80 | Held out whole/tight/both /40 |
|---|---|---|---|---|---|
| Qwen3.6-Plus | 5, 5, 5, 5 | 78 | 70 | 68 | 40/38/38 |
| Qwen3-VL-30B | 10, 10, 10, 10 | 74 | 73 | 69 | 36/39/35 |
| Qwen3-VL-235B | 5, 5, 5, 5 | 72 | 71 | 64 | 34/39/34 |
| GLM-4.5V | 20, 20, 20, 20 | 69 | 56 | 47 | 33/26/21 |
| DeepSeek, today's prompt | 10, 20, 10, 5 | 57 | 61 | 47 | 28/30/23 |

### Growing to ink

The page image the model saw becomes an ink mask, with grey below 150 counted as
ink. Each edge moves out one pixel at a time while the strip just outside it holds
at least 2 dark pixels. It stops after `gap` blank grid units, or `cap` units from
the model's edge. The four edges repeat until none moves, then `margin` is added.
The grid was gap 4/6/8/12/16, cap 30/50/80/120 and margin 0/5/10.

| Model | Gap, cap, margin | Whole /80 | Tight /80 | Both /80 | Held out whole/tight/both /40 |
|---|---|---|---|---|---|
| Qwen3-VL-30B | 6, 50, 10 | 78 | 73 | 71 | 38/39/37 |
| GLM-4.5V | 8, 80, 5 | 73 | 78 | 71 | 35/40/35 |
| Qwen3-VL-235B | 4, 30, 5 | 75 | 71 | 66 | 37/39/36 |
| Qwen3.6-Plus | 6, 30, 0 | 73 | 72 | 65 | 36/38/34 |
| GLM-4.6V | 8, 50, 5 | 69 | 76 | 65 | 33/40/33 |
| Qwen3.6-Flash | 8, 120, 5 | 74 | 62 | 57 | 37/35/33 |
| DeepSeek, today's prompt | 6, 80, 5 | 68 | 64 | 56 | 31/32/27 |
| Mistral OCR | 8, 30, 0 | 58 | 78 | 56 | 28/40/28 |
| DeepSeek, list first | 6, 50, 0 | 61 | 61 | 47 | 27/34/24 |

A gap of 4 to 8 works. At 12 or more the edge crosses the line spacing and climbs
into the stem, and tight falls. The cap hardly matters at that gap. Qwen3.6-Plus
gets nothing from growing: at margin 5 it gives the same counts as a plain 0.5%
pad, because its boxes already contain the ink.

Growing cannot save DeepSeek. After it, today's prompt still ends 13% of the page
short of Q14's third pattern, and a label past a blank gap stays out, as with
"(h+2)" in Maths Q21.

### Growing to short text lines

Model Studio's `advanced_recognition` could not be called, so I tried its idea
with Tesseract's text lines (2,200 px render). The rule takes in every line of at
most `longest` characters within `reach` units of the box, and never a longer one,
which would be question text. The grid was reach 5/10/20/30, longest 6/12/20 and
margin 0/5/10.

| Model | Reach, longest, margin | Whole /80 | Tight /80 | Both /80 |
|---|---|---|---|---|
| Qwen3.6-Plus | 5, 6, 5 | 78 | 70 | 68 |
| Qwen3-VL-235B | 5, 6, 5 | 75 | 71 | 66 |
| Qwen3-VL-30B | 5, 6, 10 | 74 | 73 | 69 |
| DeepSeek, list first | 10, 6, 5 | 57 | 62 | 45 |
| DeepSeek, today's prompt | 5, 6, 10 | 54 | 59 | 44 |

It beats the tuned ink setting only on Mistral's boxes and on Qwen3.6-Plus, and
there it only matches a 0.5% pad. Nearly every model settled on 6 characters, so it
takes in almost nothing. A label like "six turns of string" is as long as text it
must leave out.

### Remaining misses

[`misses-best.jpg`](2026-11-04-hosted-figure-boxes/misses-best.jpg) shows the
misses of the three close pipelines, gold box in green and crop in red.

- **Maths Q17, in the layout and Qwen3.6-Plus rows, is not a real miss.** The gold
  box follows the circle's Bezier control points, 3% of the page past the printed
  circle. Both crops hold everything printed.
- **Biology Q2, layout model, both runs:** the y-axis title above the plot is lost.
- **2024 P1 Q8, Qwen3-VL-30B, both runs:** the "Figure 1" caption is lost.

[`misses-deepseek-ink.jpg`](2026-11-04-hosted-figure-boxes/misses-deepseek-ink.jpg)
shows DeepSeek's today's prompt after ink growth. Q14 and Maths Q21 lose real
content in both runs, Physics Q27 in run 1, and 2021 P1 Q9, Physics Q22 and Biology
Q2 in run 2. The misses on 2022 P2 Q38 and Maths Q17 are blank gold, the same problem
as above.

## Gold with blank areas

Some gold boxes hold blank page. Maths Q17 has 33 grid units on the right, 2022 P2
Q38 has 13 on top, and others have 3 to 9. So I rescored everything against the
gold cut to what is printed inside it (anything darker than grey 235, far paler
than the ink level, so growth does not mark its own work). The layout row gains
its two Q17 crops.

| Pipeline, one setting on both golds | Gold as it stands: whole, tight, both | Printed ink: whole, tight, both |
|---|---|---|
| Layout plus-L with 1017 | 76, 72, 68 | 78, 72, 70 |
| Qwen3-VL-30B, gap 6, cap 50, margin 10 | 78, 73, 71 | 78, 70, 68 |
| Qwen3-VL-30B, gap 6, cap 50, margin 5 | 74, 75, 69 | 78, 75, 73 |
| Qwen3.6-Plus, 0.5% pad | 78, 70, 68 | 80, 69, 69 |
| GLM-4.5V, gap 8, cap 80, margin 5 | 73, 78, 71 | 75, 76, 71 |
| DeepSeek today's prompt, gap 6, cap 80, margin 5 | 68, 64, 56 | 72, 61, 55 |

This is why I call it a tie. Qwen3-VL-30B's lead moves between margin settings
depending on which gold you trust, and it never exceeds 3 crops. The fixture is
shared with the other benches, so I left it unchanged and did not correct
`gold_digital.py`.

## Document APIs

OpenRouter's file-parser plugin with `mistral-ocr` returns no coordinates. The
parsed file in the message's `annotations` holds the page's markdown, with
`![img-0.jpeg](img-0.jpeg)` placeholders, and the cut-out images as data URLs. I
probed one scanned page and one born-digital page, then ran all 32 pages twice.

To score the cut-outs, the bench finds each one on the page again by template
matching (46 of 49 matches scored above 0.8), and each gold figure takes the
cut-out overlapping it most. Mistral writes titles and captions as text, so they
fall outside its images, and it splits a figure made of separate drawings into
pieces. Examples are the two hearts, the four option diagrams of Physics Q34, and
a pedigree and its key. Joining the pieces inside the gold box is an upper bound
because it uses the gold, and it still gives only 50 of 80 whole raw. It costs
$0.002 a page.

A direct test would need a key from Epo:

- The Mistral OCR API returns `pages[].images[]` with corner coordinates. It would
  save the matching step, but the regions are the same ones scored here, so I do
  not expect a different result.
- Azure Document Intelligence `prebuilt-layout` returns `figures[]` with bounding
  regions and a caption, so captions would stay with the figure. It needs an Azure
  resource endpoint and key. Untested.

## Blocked

**Gemini** (`google/gemini-3.8-flash`, `google/gemini-3.5-flash-lite`). Every call
answers 403 "The request is prohibited due to a violation of provider Terms Of
Service". That holds on Google AI Studio and Vertex, on those models and on
`gemini-2.5-flash-lite`, even for a text-only "Say ok.", so the content is not the
cause. The Mac's address geolocates to Japan, where Gemini is offered, which points
at the OpenRouter account or key. Epo would need to check that account, or give a
Google AI Studio key. The prompt is in the script, ready to run.

**Alibaba Model Studio, Singapore** (`ALIBABA_MODELSTUDIO_KEY` and `_URL` from
`deploy/.env.uat`). Listing models works. Every chat and embedding call answers 403
"Access denied by API-Key restrictions". I tried `qwen3-vl-plus`,
`qwen-vl-ocr-2025-11-20`, `qwen3.6-flash`, `qwen3.8-flash`,
`deepseek-v4.1-flash-1017`, `qwen-plus` and `qwen3.7-text-embedding`. The key is
most likely limited to the servers' addresses, so testing from the Mac needs Epo to
add its address or issue a bench key. I did not try other endpoints to get past the
restriction. No call went through, so no free quota was drawn.

The workspace lists `qwen3-vl-plus` and `qwen-vl-ocr-2025-11-20`. It does not list
`qwen3-vl-flash`, and `qwen3.5-ocr` answers "Model not exist". A run would add
`qwen3-vl-plus` against the OpenRouter Qwen3-VL rows, `qwen-vl-ocr` asked for figure
boxes, and `advanced_recognition` lines. The routes are in the script (`ms-*`
models, `lines --source modelstudio`). The OCR model's coordinate space needs
checking against a born-digital page's text layer first.

Model Studio prices, Singapore, per million tokens, from the pricing page on
2026-11-04:

| Model | Input | Output | Free quota |
|---|---|---|---|
| `qwen3-vl-plus`, input up to 32K | $0.20 | $1.60 | 1M tokens for 90 days |
| `qwen3-vl-plus`, up to 128K | $0.30 | $2.40 | same |
| `qwen3-vl-plus`, up to 256K | $0.60 | $4.80 | same |
| `qwen-vl-ocr` | $0.07 | $0.16 | 1M tokens; the dated `qwen-vl-ocr-2025-11-20` has none |
| `qwen3.6-flash` | $0.25 | $1.50 | none |
| `qwen3.5-ocr`, Beijing only | $0.069 | $0.275 | – |

Alibaba's OpenRouter endpoint charges less for `qwen3.6-flash`, at $0.1875 and
$1.125. Qwen3.6-Plus costs $0.325 and $1.95 there.

## Notes

- **Qwen3-VL-235B's answers.** In run 2 it wrote four multi-figure pages as one JSON
  object repeating `label` and `bbox_2d`. A strict JSON read keeps only the last box,
  so those pages failed and were retried, and the retry repeated it. The bench's
  parser reads the keys in order and recovers them. Qwen3.6-Plus did the same on one
  page in run 2, and Qwen3-VL-30B and Qwen3.6-Flash never did. Any Qwen integration
  needs that parser.
- **GLM's box tokens** do not come back through OpenRouter, so answers read "1: [276,
  125, 797, 287]".
- **Exact comparisons.** `locate_digital.score` rounds before comparing, so this
  bench compares exact values, as `layout_score.py` does. That moves a few crops
  against the earlier numbers.
- **Small set.** 40 figures from seven papers, with settings chosen on these same
  figures. Only large gaps here mean much.
- **Not tested:** Qwen on production's own `{"boxes": …}` prompt, or a whole
  extraction end to end. The descriptions are saved ones.

## Spend

| What | Billed |
|---|---|
| Qwen3.6-Plus, 2 runs | $0.051 |
| Qwen3.6-Flash | $0.029 |
| Qwen3-VL-235B | $0.036 |
| Qwen3-VL-30B | $0.029 |
| GLM-4.5V | $0.058 |
| GLM-4.6V | $0.037 |
| Mistral OCR plugin, 2 runs and probes | $0.144 |
| Gemini and Model Studio, all 403 | $0 |
| **Total** | **about $0.38** |

The DeepSeek and layout rows reuse existing runs and cost nothing here.

## Reproduce

From the repository root, with the root `.venv` (pymupdf 1.28.2) and Tesseract:

```sh
S=bench/extraction/scripts/hosted_boxes.py
REFS="--scans data/question-bank/references/hkdse-math-compulsory --digital data/question-bank/references/born-digital"
python -I $S call qwen3-vl-30b --repeat 1 $REFS --env-file deploy/.env.uat
python -I $S lines --source tesseract $REFS
uv run --no-project --with numpy --with opencv-python-headless --with pymupdf==1.28.2 \
  --with pillow --with httpx python -I $S mistral --repeat 1 $REFS --env-file deploy/.env.uat
python -I $S deepseek <locate-base-scan-201.json> <digital-1.json> --name deepseek-today --repeat 1
python -I $S layout <layout-match-scans-plus-l-v2.json> <layout-match-digital-plus-l-v2-1.json> \
  <layout-match-digital-plus-l-v2-2.json> $REFS
python -I $S score $REFS               # add --trim-gold for each method against printed ink
python -I $S sheet layout-plus-l-1017:raw qwen3-vl-30b:ink $REFS --out misses.jpg
```

Runs land in `.results/hosted/runs/`, scores in `.results/hosted/summary.json`, and
the running spend in `.results/hosted/spend.json`. The script reads only the
`OPENROUTER_API_KEY` and `ALIBABA_MODELSTUDIO_*` lines from the keys file and prints
none of them.
