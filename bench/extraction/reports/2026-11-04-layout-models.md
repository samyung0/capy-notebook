# Make a quiz: layout models for finding figures (2026-11-04)

Epo asked on 2026-11-04 whether a document layout model finds the figures on
exam pages better than the AI box call Make a quiz uses today. They asked for
whatever is easiest to run on our machines, not minding the resources. Every
model ran on the ingest host, in one throwaway container with no network, at
the parser's production limits. The matching step, which needs DeepSeek 1017,
ran from the Mac.

## Recommendation

**Use PP-DocLayout_plus-L, in PaddlePaddle's own ONNX export, under
onnxruntime. Run it at extraction time, only on the pages the windows name
figures on, inside the retrieval service. Keep today's box call as the
fallback.**

- **Detection.** It found all 40 gold figures (14 on the HKDSE scans, 26 on the
  born-digital IGCSE papers). It gave one false positive in 59 pages, a second
  box around Q14's figure and its options.
- **Crops.** 1017 picked boxes by number, and code added the caption and a 1%
  pad. On the scans, 28 of 28 crops were whole and 26 of 28 tight. On the
  born-digital papers, 48 of 52 were whole and 46 of 52 tight. The box call
  gets 21/28 and 18/28 on the scans and 43/52 and 24/52 on the born-digital
  papers.
- **Cost.** 0.55 s of wall time per page at 2 threads (production retrieval
  has 2 CPUs), 0.22 s at 8 threads. It loads in 0.55 s and peaks at 540 MB.
  The runtime is onnxruntime and numpy (about 140 MB) plus a 130 MB model
  file. The Apache-2.0 licence covers both the weights and the ONNX export.

How it would replace `locate_figures`:

1. For each page with figures, run the model on the page image the windows
   already rendered (long side 1,568 px). Keep the `image` and `chart` regions
   that score 0.5 or more. When two regions overlap with an IoU of 0.8 or
   more, keep one. Keep nested boxes: they are the alternatives the next step
   chooses between.
2. If the page has no box, send it to the box call as today.
3. Otherwise draw the boxes on the page, numbered, and make the same one call
   per page (reasoning off). It asks for box numbers instead of coordinates
   (the prompt is in `scripts/layout_match.py`). If the reply is malformed, or
   names no box for a figure, that figure goes to the box call.
4. Crop the picked boxes together. Add a `figure_title` or `chart_title`
   region the model found within 2.5% of the page above or below the box,
   with its middle over the box. Pad the crop by 1% of the page on every side.
   The box call keeps its own `FIGURE_PAD`.

Loading per run and freeing it afterwards costs 0.55 s, so the service holds
nothing between runs. A paper with six pages of figures adds about 3.5 s to a
run that already takes 100-330 s. While a run holds the model, it uses about
520 MB more. That fits easily in production's 3 GiB limit, but is tighter in
UAT's 1.5 GiB.

Ingest is the other place to run it. The parser already ships onnxruntime
(RapidOCR), so there it adds only the model file. It would cost about 1
CPU-second on every page of every upload, for a feature that needs a few pages
per quiz, and the index would need somewhere to keep the boxes. That becomes
the better choice only if other features also want figure boxes, for example
for scans, which OpenDataLoader cannot box.

## What ran

- **Host.** The ingest host (Debian 13, AMD EPYC 9645, 8 vCPUs), from about
  02:00 to 02:35 UTC on 2026-11-04.
- **Container.** One container, `capy-layout-bench`, running image
  `capy-layout-bench:20261104`: `python:3.12-slim`, plus `libgomp1`, `libgl1`
  and `libglib2.0-0`, which Paddle needs. It ran with `--network none
  --cpus 8 --memory 14g --memory-swap 18g`, the production parser's limits,
  and kept its files in `/opt/capy-layout-bench-20261104`.
- **Setup.** The venvs and weights were installed beforehand, from short-lived
  networked `--rm` setup containers.
- **Copied to the host.** The four HKDSE scans, the three born-digital PDFs
  and the gold files.
- **Removed afterwards.** All of the above: the container, the images, the
  build-cache records the build made, and the folder.

**Load on the host:**
- The shared ingest containers stayed under 1% CPU throughout.
- During the born-digital batch, `capy-library-db` used about one core.
  Timings from that batch are not used; its detections are.
- The scan batch and a later timing rerun ran on a quiet host, and their
  numbers agree.

**Pages:**
- Rendered with the production capture settings: the whole page at a long
  side of 1,568 px (1109x1568), JPEG quality 80, as the windows see it.
- 37 scan pages: every page in the four gold files, cover and blank page
  included.
- 22 born-digital pages: every page that holds a gold figure (from
  `fixtures/digital/figures.json`, added on `claude/study-extraction` today).

**Scoring** (`scripts/layout_score.py`) follows the figures report:
- *Whole*: at most 2% of the gold box falls outside the crop.
- *Tight*: at least 70% of the crop is figure.
- Run on the saved box-call results, the scorer reproduces that report's
  21/28 whole and 18/28 tight on the scans. On the born-digital papers it
  gives 43/52 whole and 24/52 tight. The other report says 25 tight because
  it rounds before comparing; one crop is at 0.6996.

Each gold figure is scored twice:
- *Raw*: the model's best-overlapping box, as is.
- *Crop*: the boxes a correct pick takes, plus an adjacent caption, then
  padded.

A *false positive* is a picture or chart box that is no gold figure's best
box and lies less than half inside every gold figure on its page.

## Candidates and licences

| Model | Weights licence (model card) | Ran as | Model file |
|---|---|---|---|
| PP-DocLayout_plus-L (RT-DETR-L, 20 classes) | Apache-2.0, ONNX export too | ONNX (`PaddlePaddle/PP-DocLayout_plus-L_onnx`), and PaddleOCR | 130 MB |
| PP-DocLayout-L (RT-DETR-L, 23 classes) | Apache-2.0 | PaddleOCR | 129 MB |
| PP-DocLayout-M (PicoDet-L, 23 classes) | Apache-2.0 | PaddleOCR | 23 MB |
| PP-DocLayoutV2 | Apache-2.0, ONNX export too | ONNX (`PaddlePaddle/PP-DocLayoutV2_onnx`) | 214 MB |
| PP-DocLayoutV3 (PaddleOCR-VL 1.5's layout model) | Apache-2.0, ONNX export too | ONNX (`PaddlePaddle/PP-DocLayoutV3_onnx`) | 131 MB |
| docling-layout-heron (RT-DETRv2, 17 classes) | Apache-2.0, ONNX export too | ONNX (`docling-project/docling-layout-heron-onnx`), and transformers | 171 MB |
| docling-layout-heron-101 | Apache-2.0 | transformers | 307 MB |

**Runtimes:**
- onnxruntime 1.31.1 (MIT).
- PaddlePaddle 3.2.2, PaddleOCR 3.7.0 and PaddleX 3.7.2 (all Apache-2.0).
- torch 2.15 CPU (BSD-3-Clause) and transformers 5.22.1 (Apache-2.0).

**Left out:**
- DocLayout-YOLO and Ultralytics-based models (AGPL-3.0).
- Surya (GPL code, restricted weights).

The cards give no terms beyond the licence. V2 and V3 were not in the brief.
They were added because PaddlePaddle publishes official ONNX exports of both,
and the parser's [2026-09-13 layout experiment](../../parsers/reports/2026-09-13-odl-layout-ocr.md)
already ran V3.

**What the frameworks cost:**
- **Paddle versions.** PaddlePaddle 3.3.1 fails on these models with oneDNN
  on (`ConvertPirAttribute2RuntimeAttribute not support`); 3.2.2 works.
- **OpenCV.** PaddleX requires the full `opencv-contrib-python`, not the
  headless build, so the image needs libGL. That apt layer was 215 MB.
- **Docling.** docling-ibm-models 4.0.4 no longer ships a layout predictor, so
  Heron ran through transformers, as its model card shows.
- **The ONNX runs agree with the frameworks.** Their pre- and post-processing
  is about 40 lines in `scripts/layout_detect.py`. Heron's ONNX scores match
  torch's to four decimals. plus-L's ONNX boxes match PaddleOCR's within a
  pixel, and the two score the same at the settings recommended here.

## Detection

Threshold 0.5 (Paddle's default). *Crop* means the correct pick, plus an
adjacent caption, padded 1%. The box call's row counts its padded crops over
two runs, so it has twice as many.

| Model | Found (of 40) | Scans, whole / tight (of 14) | Born-digital, whole / tight (of 26) | False positives (59 pages) |
|---|---|---|---|---|
| Box call today (two runs, padded) | 80 of 80 crops on their figure | 21/28, 18/28 | 43/52, 24/52 | – |
| **PP-DocLayout_plus-L** (ONNX) | **40** | **14, 14** | 24, 23 | 1 |
| PP-DocLayoutV3 (ONNX) | 40 | 12, 14 | **25, 24** | 0 |
| PP-DocLayoutV2 (ONNX) | 39 | 14, 13 | 22, 22 | 0 |
| PP-DocLayout-L (Paddle) | 39 | 13, 11 | 23, 23 | 1 |
| PP-DocLayout-M (Paddle) | 31 | 11, 11 | 14, 18 | 0 |
| Heron (ONNX; torch identical) | 37 | 12, 13 | 20, 21 | 9 |
| Heron-101 (torch) | 36 | 11, 12 | 19, 21 | 15 |

PP-DocLayout_plus-L run through PaddleOCR scores the same as its ONNX export.

**PP-DocLayout_plus-L in detail.** "Caption" means the caption is added
before the pad.

| Box | Scans whole / tight | Born-digital whole / tight |
|---|---|---|
| Raw, no pad | 4 / 14 | 14 / 26 |
| Raw, 1% pad | 10 / 14 | 23 / 23 |
| Raw, 2% pad | 13 / 13 | 23 / 15 |
| Caption, no pad | 6 / 14 | 15 / 26 |
| **Caption, 1% pad** | **14 / 14** | **24 / 23** |
| Caption, 2% pad | 14 / 13 | 24 / 15 |

**Raw boxes sit tight on the ink.** All 40 are tight; whole fails by a few
pixels of labels, and the 1% pad covers that.

**The caption step fixes two cases:**
- HKDSE's "Figure 1" under three of the four Paper 1 figures.
- The title above 2021 Q9's bar chart. Every model boxed the chart without
  its title; the box call clipped the title's ends in both runs.

**A 2% pad is too much for born-digital pages.** Their figures are small, and
tight falls to 15 of 26.

**At threshold 0.3:**
- plus-L is unchanged: one more false positive, and slightly looser crops.
- V3 also gets the bar chart's title, which it scores 0.33: 13/14 on the
  scans.
- Heron finds all but one figure, but with 39 false positives. Those are the
  "Go on to the next page" arrow, the marks in the page corners, the cover's
  title block and a whole-page box on the blank last page.

**What plus-L still misses:**
- **2022 P2 Q14 (dot patterns).** It gives two nested boxes: the figure
  (0.56) and the figure with the options A-D under it (0.62). The oracle pick
  is the tight one, so detection scores it whole and tight. Matching is the
  problem (next section). The outer box is the one false positive.
- **Biology Q2 (blood glucose graph).** The box starts at the plot and leaves
  out the y-axis title printed above it. The box call lost a graph's axis
  title the same way.
- **Maths Q25 and Physics Q23.** The box takes in "NOT TO SCALE" beside the
  figure, which the gold leaves out, so the crop counts as loose. A learner
  arguably needs that note.
- **Physics Q1, the pen with six turns of string.** The figure is 5% of the
  page tall, so 1% of padding leaves it 68% figure.
- **Maths Q17.** This is a gold artefact. The gold box follows the circle's
  Bezier control points, about 3% of the page past the printed circle. The
  crop holds everything printed, but scores 92% covered.

**Where the other models fall short:**
- **V3** is the best model on the born-digital papers. It loses on the scans:
  it boxes only Q14's three arrows, not the dot patterns, and needs threshold
  0.3 for the bar chart's title.
  Its masks double its memory (next section).
- **V2** misses one born-digital figure (Physics Q17's gap between two
  surfaces) and has the largest file.
- **Heron** misses 2022 P2 Q22's triangle at 0.5, and its false positives are
  page furniture on every HKDSE page.
- **M** misses 9 of 40.

## Matching: 1017 picks the box

`scripts/layout_match.py` uses plus-L's boxes at 0.5, outlined on the page and
numbered, each box in its own colour, as in
[this example](2026-11-04-layout-models/2022-p2-p5-numbered-boxes.jpg).

- One call per page, on 1017 on the extraction slot's route, reasoning off.
  InferenceNet served every call.
- The scans used the window call's own descriptions from runs 73 and 74.
- The born-digital papers used the fixture's descriptions, with two repeats.
- The crop takes the picked boxes, the adjacent caption and a 1% pad.

| Figures | Calls | Right pick | Whole | Tight | Both | Billed |
|---|---|---|---|---|---|---|
| Scans, runs 73 and 74's descriptions (28) | 20 | 26 | **28** | **26** | 26 | $0.0021 |
| Born-digital, repeat 1 (26) | 22 | 26 | 24 | 23 | 21 | $0.0022 |
| Born-digital, repeat 2 (26) | 22 | 26 | 24 | 23 | 21 | $0.0004 |
| Box call today, scans (28 crops) | – | – | 21 | 18 | 16 | – |
| Box call today, born-digital (52 crops) | – | – | 43 | 24 | 23 | – |

**Over the 80 figures:**
- Layout model and 1017: 76 whole (95%), 72 tight (90%), 68 both.
- Box call: 64 whole (80%), 42 tight (53%), 39 both.

**Reply time.** A page's call took about 2 s. All 22 born-digital calls ran
at once in 2.1-2.5 s.

**The prompt went through two versions:**
- The first did not name split figures. 1017 then picked only one piece of
  two born-digital figures: Maths Q21's triangle beside its rectangle, and
  Biology Q3's pedigree beside its key. That gave 24 of 26 right picks in
  both repeats, and the scans the same 26 of 28.
- The final prompt says a figure may be split across boxes and to give all of
  them. It also says that of nested boxes, the right one holds the whole
  figure and the least else.

**One pick is still wrong.** In both scan runs, 1017 picks Q14's outer box
over the nested tight one, so the crop holds the four options
([example](2026-11-04-layout-models/2022-p2-q14-outer-box-picked.jpg)). It is
whole, not tight; the box call's Q14 crop also held option A.

**No call needed in the easy cases.** Giving boxes to figures top to bottom
whenever a page has as many boxes as figures gets 26/28 and 19/26 whole and
tight. The call matters on pages with nested or extra boxes and on split
figures.

**Cost.** Both prompt versions over all three sets cost $0.009 in total.

**Examples:**
- [2021 P1 Q9](2026-11-04-layout-models/2021-p1-q9-chart-with-title.jpg):
  the bar chart with its whole title.
- [2022 P2 Q38](2026-11-04-layout-models/2022-p2-q38-tangents-whole.jpg):
  with Q and the tangent's end. The box call clipped both in both runs.

## Speed and memory

Ingest host, quiet. Each model is one process with two passes over the 37
scan pages:
- *Cold* is the first page after loading.
- *Warm* is the median of the other 73.
- *Load* is creating the session, not starting Python.
- *Peak RSS* includes the interpreter, about 21 MB.

| Model, runtime | Threads | Load | Cold page, wall / CPU | Warm page, wall / CPU | Peak RSS |
|---|---|---|---|---|---|
| **plus-L, ONNX** | 8 | 0.58 s | 0.24 / 1.79 s | **0.22 / 1.75 s** | 541 MB |
| plus-L, ONNX | 4 | 0.55 s | 0.34 / 1.29 s | 0.33 / 1.33 s | 540 MB |
| plus-L, ONNX | 2 | 0.53 s | 0.61 / 1.21 s | **0.55 / 1.09 s** | 539 MB |
| plus-L, ONNX | 1 | 0.56 s | 1.17 / 1.16 s | 1.05 / 1.04 s | 542 MB |
| V2, ONNX | 8 / 1 | 1.05 / 0.84 s | 0.36 / 2.74 s | 0.24 / 1.94 s; 1.14 s at 1 thread | 623-635 MB |
| V3, ONNX | 8 / 1 | 0.88 / 0.70 s | 0.44 / 3.34 s | 0.35 / 2.81 s; 1.21 s at 1 thread | 1,152 MB |
| Heron, ONNX | 8 / 1 | 0.54 / 0.50 s | 0.23 / 1.72 s | 0.16 / 1.30 s; 0.84 s at 1 thread | 520-529 MB |
| L, Paddle 3.2.2 | 8 | 2.85 s | 0.74 / 4.89 s | 0.30 / 2.40 s | 920 MB |
| plus-L, Paddle 3.2.2 | 8 | 2.95 s | 0.76 / 4.83 s | 0.34 / 2.71 s | 1,031 MB |
| M, Paddle 3.2.2 | 8 | 2.14 s | 0.14 / 1.09 s | 0.04 / 0.32 s | 624 MB |
| Heron, torch | 8 | 4.47 s | 0.41 / 3.05 s | 0.32 / 2.43 s | 770 MB |
| Heron-101, torch | 8 | 4.04 s | 0.55 / 4.12 s | 0.45 / 3.51 s | 875 MB |

**What a page costs.** At 8 threads, onnxruntime's threads spin while they
wait, so CPU time runs above wall time. The single-thread figure, about 1
CPU-second per page for plus-L, is a page's real cost.

**Throughput.** One process at 8 threads does about 4.5 pages a second on the
host's 8 vCPUs. Production retrieval's 2 CPUs do 0.55 s a page; UAT's 1 CPU
does 1.05 s.

**First page.** onnxruntime has almost no warm-up: the cold page costs what a
warm page does. Paddle's first page costs 2 to 3.5 times a warm one.

## Install size

| Runtime | Installed | Largest parts |
|---|---|---|
| onnxruntime 1.31.1, numpy, Pillow, PyYAML | 165 MB | onnxruntime 68, numpy 70, Pillow 23 |
| PaddlePaddle 3.2.2, PaddleOCR 3.7.0, PaddleX 3.7.2 | 1,333 MB, plus 215 MB of libGL in the image | paddle 701, OpenCV contrib 182, pandas 81, modelscope 66, numpy 70 |
| torch 2.15 CPU, transformers 5.22.1 | 1,213 MB | torch 809, transformers 120, sympy 74, numpy 70 |

The retrieval image already has Pillow and PyMuPDF. The parser image already
has onnxruntime 1.29.

Model files' SHA-256, as run:

| File | SHA-256 |
|---|---|
| `PP-DocLayout_plus-L_onnx/inference.onnx` | `77afb2ca…07ff0e` |
| `PP-DocLayoutV2_onnx/inference.onnx` | `cd540dc2…095aac` |
| `PP-DocLayoutV3_onnx/inference.onnx` | `45bf7175…28ba` |
| `docling-layout-heron-onnx/model.onnx` | `59c81a3a…922a` |

## Decisions for Epo

1. **Build it as recommended?** That means plus-L in ONNX, in the retrieval
   service, at extraction time, on the figure pages, with the box call as the
   fallback. The alternative is running it at ingest.
2. **UAT memory.** A run adds about 520 MB inside retrieval's 1.5 GiB limit.
   Is that acceptable, or should UAT's limit go up?
3. **Captions in the crop.** The crop takes in a caption the model finds
   beside the figure, such as "Figure 1", which the HKDSE question text refers
   to. The born-digital gold leaves "Fig. n.n" out, yet tight still held at
   23 of 26. Keep the captions?

## Left out

- **Small set.** 40 figures and 59 pages, with gold read to about ±5 on the
  grid. Thresholds, the caption gap and the pad were all set on this set.
- **The matching prompt** was revised once on this set (see above).
- **No end-to-end run.** Matching used saved descriptions, not a new
  extraction.
- **Not tried:** onnxruntime with its memory arena off, int8 weights, batching
  pages.
- **No Mac numbers.** Every model ran on the ingest host.

## Reproduce

On the ingest host, in the container that `scripts/layout_host.sh`
describes:

```sh
python layout_detect.py render --pdfs /work/data --gold /work/gold --pages /work/pages
python layout_detect.py render --pdfs /work/digital --digital /work/digital/figures.json --pages /work/pages-digital
sh layout_host.sh                                              # scans: every model, two passes
PAGES=pages-digital OUT=out-digital PASSES=1 sh layout_host.sh  # born-digital pages
```

Then on the Mac, with the outputs copied next to their `pages/` folders:

```sh
python bench/extraction/scripts/layout_score.py <out>/*.json --threshold 0.5 \
  --box-call bench/extraction/.results/2022-p2-v41-1017-7[34].json …
python -I bench/extraction/scripts/layout_match.py <out>/pp-plus-l-onnx.json --name scans \
  --figures bench/extraction/.results/*-v41-1017-7[34].json --env-file <keys file>
python -I bench/extraction/scripts/layout_match.py <digital out>/pp-plus-l-onnx.json \
  --name digital --digital --repeat 1 --env-file <keys file>
```

The OpenRouter key came from `deploy/.env.uat`. Only its `OPENROUTER_API_KEY`
line was read, and nothing was printed.
