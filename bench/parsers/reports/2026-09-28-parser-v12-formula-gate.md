# Parser v12 formula-picture gate

2026-09-28. Gate for parser `odl-2.5.7-refined-rapidocr-v12`: the formula-picture
rule from the [ODL thin-image report](2026-09-23-odl-thin-images-and-accuracy.md)
(rule 2 and the glyph-sized repeat clause of rule 3 in "A. A picture stage in the
refinement", the six tests and the tall-line guard in Question 1), ported as decided
on 2026-09-25 and 2026-09-28. The chunker stays at v12. Nothing has a version gate or
a legacy path (decision 2026-09-25).

- **Detection** (`pictures.classify`). A picture that is not a sliver, at most 2.5
  body lines tall, is inline when it overlaps a line of at most two body lines by half
  its height, is no taller than 1.8 times that line and has the line's text within
  1.5 line heights; it is display when it sits alone between two body lines. Lines
  taller than two body lines never count.
- **The six tests.** Each runs on a detected picture only. A caption line just
  below, a side under 3 pt, a word drawn on it, or in a render of its box under 0.3%
  dark ink, over 45% mid-tone or darker, or over 35% of its non-white pixels coloured
  keeps it an image.
- **Repeats.** A picture on 5 or more pages stays a formula only when it is at most
  1.6 times the page's median font size and its neighbouring words differ in most
  placements; otherwise it is furniture, as in v7.
- **Text.** A detected formula becomes an `equation` block (`_picture: inline` or
  `display`). A display formula's text is `[formula]`. `pictures.place_inline`,
  after table recovery, splices `[formula]` into the one text or list block holding
  an inline picture, between the words beside it, when that pair occurs once there.
- **Prompts.** Chat and curate each say that `[formula]` marks a formula printed as
  a picture, that the agent captures the page when a question needs that formula,
  and that it never presents the placeholder as content (`lab/playground/configs/curate.json`
  mirrors curate).

The code matches the prototype's `pictures.py` plus the six tests exactly as
`formula_features.py` and `formula_eval.py` computed them; the pixel shares come from
`Pixmap.color_count` over every pixel instead of a sample. Downstream nothing
changes: the chunker already skips empty `equation` blocks and keeps a display
formula's `[formula]`, and the knowledge-base figure stage reads only `image` and
`chart` blocks.

**Result: the gate passes, and precision equals the report's measurement.** On the 66
documents nothing changes beyond the rule: every outline anchor (5,031) and root (448)
is kept, no body block changes ancestry, wrong-path chunks stay at 389, no gold
witness changes, and every changed text block equals the baseline once its
placeholders are removed. The detector is 76% precise on the gate labels (79 of 104)
and 97.8% on the library sample, weighted as the report did, which predicted 76% and
98%. On the formula-heavy books every sampled detection is a formula (108 of 108).
Ten real figures in the sampled books lose their figure record; they are listed
below.

## Setup

- **Candidate.** A snapshot of the working tree's `parser/` (`snapshots/parser-v12`,
  the 32 tracked files) mounted read-only over `/app/parser` in a throwaway container
  of the builder's image `capy-kb-parser:pilot-v11`, with the builder container's env
  and limits (7 GiB, swap 14 GiB, 4 CPUs, 1,800 s deadline, 3g heap), the source cap
  raised to 512 MiB, its own token, port 18099 and `RELEASE_SHA` `6ef13def` as a
  placeholder. `/healthz` reported `odl-2.5.7-refined-rapidocr-v12`.
- **Baseline.** The v11 gate's `v11` arm (copied from the 2026-09-25 gate folder).
- **Extra books.** Ten library books through both arms, the second arm being HEAD's
  v11 code in a second throwaway container (`v11h`, port 18100): the formula-heavy
  Brief Calculus, Fundamentals of Electrical Engineering I, Introductory Business
  Statistics, Principles of Business Statistics and Online Statistics; Marine Ecology
  (page 33's white images behind vector diagrams); and four books with small real
  figures: Mathematics for Elementary Teachers (number lines), Understanding Music
  (notation), Introduction to G Programming (screenshots) and Compact Anthology part 1
  (figure strips).
- **Library replay.** `pictures.classify` and `place_inline` from the working tree
  over the builder's saved parses of 120 distinct books with image blocks (read-only;
  their `images/` stand in for ODL's image files).
- **Merge check.** `main` was merged under this work (`6cef74ae`, parser changes in
  `app.py`, `ocr.py`, `java.py`, `document.py`, `source_text.py`, `refine.py`). A third
  container (`v12m`, port 18101, `CAPY_PARSE_WORKERS=1`, `CAPY_PARSE_MAX_PAGES=5000`)
  ran the merged tree with this change over the same 66 documents and ten books.
- The containers and tokens were removed afterwards. The live builder parser
  (`capy-kb-parser-v4-pilot`, stopped), the library, `data/knowledge-base/` and the
  ingest host were not touched.

## Gate against v11

| | v11 | v12 |
| --- | ---: | ---: |
| documents, pages | 66, 16,924 | 66, 16,924, all parsed |
| outline anchors kept | 5,031 | 5,031 of 5,031 |
| roots | 448 | 448, all kept |
| body blocks whose ancestry changes | | 0 of 147,180 |
| gold witnesses changed | | 0 of 26 |
| scope gold verdicts | | 6 of 6 pass |
| wrong-path chunks (`_entries` references) | 389 | 389 |
| v11 units missing from v12's chunks | | 4, the paragraphs that gained placeholders |
| documents that change | | 11 |
| formula pictures | | 104: 86 display, 18 inline (4 placed) |
| figure records | 10,088 | 9,984 (104 lost, all retyped pictures) |
| server parse time, all documents | 2,550 s | 2,868 s (see Timing) |

**Block for block** (`pictures_diff.py`): both arms have the same blocks in the same
order in all 66 documents. Every difference is one of: an image retyped as a formula
(104), or a text block that equals v11's once `[formula]` is removed (4). No other
block, key or furniture text differs, so the code HEAD gained between v11's commit
and this change does not alter output.

**Inline placement on the gate.** 4 of 18 placed. The 14 unplaced (Chemistry 8,
Precalculus 4, BOJ 2) have no host block: they sit in table cells or diagrams.

## Precision

**Gate labels.** Every v12 detection matches one of the 207 pictures the 2026-09-23
arm A retyped and labelled by eye (`formula_filters.LABELS`), so no new picture needs
a label.

| | Arm A (no tests) | v12 | the report's estimate with the six tests |
| --- | ---: | ---: | ---: |
| formulas | 81 | 79 | 79 |
| key caps | 46 | 10 | 10 |
| logos, badges, icons | 14 | 9 (Rice logos) | 9 |
| chart pieces, blank backgrounds | 39 | 2 (BOJ) | 2 |
| real figures | 27 | 4 | 4 |
| precision | 39% | 76% | 76% |

The tests reject 2 of arm A's 81 formulas, as the report measured.

**Library sample** (150 detections from 35 books, `labels/lib_sample_formula.json`).
The replay keeps 107: 97 formulas, 5 figures, 3 text pictures, 1 chart piece, 1
symbol. Unweighted precision is 90.7%; weighted by each book's detections, 97.8%. It
drops 5 formulas: 4 coloured formulas in the networking book and 1 in G Programming.

**Library replay.** 3,063 formula pictures in 23 books (2,109 inline, 954 display),
1,692 inline placed (80%). Brief Calculus 1,708, EE I 403, Introductory Business
Statistics 298, Principles of Business Statistics 156, Concepts of Biology 136,
Operations Management 82, Principles of Finance 79, Intro to Logic 66, Engineering
Computation with MATLAB 56, Basic Political Concepts 28, Online Statistics 6. The
2026-09-23 census's 2,530 counted repeats first; v12's glyph clause keeps repeated
glyphs as formulas (588 in Brief Calculus alone).

## Book-sample review

Contact sheets (`sheets/`), each picture outlined in red with its line, reviewed by
eye:

| Sample | Detections shown | Formulas | Not formulas |
| --- | ---: | ---: | --- |
| Brief Calculus, fresh v12 (random 36 of 1,708) | 36 | 36 | |
| EE I, fresh v12 (random 36 of 403) | 36 | 36 | |
| Both business statistics books, fresh v12 (18 each) | 36 | 36 | |
| Other extra books, all | 12 | 6 | Understanding Music 5, Compact Anthology 1 |
| Gate, all | 104 | 79 | Rice logos 9, key caps 10, BOJ chart pieces 2, figures 4 |
| Library replay, all detections in the 14 books with 1-28 | 79 | 61 | see below |
| Library replay, 12 each from five mid-count books | 60 | 60 | |

The gate books the report named:

- **Rice logos.** One per OpenStax book on page 5, 9 in all: still detected (display,
  72 x 28 pt). Harmless to text (a `[formula]` block on the copyright page) but wrong.
- **Calculator key caps** (Introductory Statistics pp. 833-840): 10 of 46 still
  detected, the grey key caps; the dark and blue ones fail the mid-tone and colour
  tests.
- **BOJ chart tiles:** 2 of 39 left, two small pieces of a page-92 diagram, both
  unplaced.
- **MIT Strang:** 0 detections (the tall-line guard).
- **Marine Ecology page 33:** 0 detections in the whole book; the two white images
  behind the chlorophyll diagrams stay image blocks (the blank test).
- **Small real figures:** Mathematics for Elementary Teachers and G Programming have
  no detections; Understanding Music loses 5 (below).

**Real figures that lose their figure record** (fresh parses):

- Physics p. 354: the thermometer photo (144 x 28 pt, display).
- Chemistry p. 402: two molecular-orbital drawings (234 x 24 pt, display).
- Precalculus p. 1351: a triangle (130 x 27 pt, display).
- Understanding Music p. 8: the "Cause → Generating mechanism → …" diagram captioned
  "Figure 1.1" at the right below it (the caption test does not catch it).
- Understanding Music p. 26: two notation pictures ("= a measure").
- Understanding Music pp. 196, 204: two score excerpts in listening-guide tables.
- Compact Anthology part 1 p. 631: one strip of an engraving that the PDF slices into
  line-high strips.

The library replay adds the same kinds in books not parsed today: Compact Anthology
part 2 p. 211 (a strip), three glyph labels inside Electromagnetics vector diagrams
and a thin bar of one of its plots, the CC symbol in Information Systems, a Cyrillic
citation and a table icon in the e-learning book, and two text boxes in Accountancy.

## Placement and per-book counts

Fresh parses of the formula-heavy books:

| Book | Inline | Display | Placed | Unplaced: pair repeats / no host / pair not in text | Repeats kept as formulas | Figure records v11 → v12 |
| --- | ---: | ---: | ---: | --- | ---: | --- |
| Brief Calculus | 1,565 | 143 | 1,300 (83%) | 194 / 67 / 4 | 588 | 1,635 → 515 |
| EE I | 0 | 403 | | | 0 | 1,191 → 788 |
| Introductory Business Statistics | 240 | 58 | 182 (76%) | 39 / 18 / 1 | 94 | 254 → 50 |
| Principles of Business Statistics | 79 | 77 | 65 (82%) | 4 / 10 / 0 | 35 | 318 → 197 |
| Online Statistics | 0 | 6 | | | 0 | 374 → 368 |

Brief Calculus matches the report: its prototype found 1,722 pictures and the six
tests were estimated to keep 1,708; v12 keeps 1,708 and places 1,300 (the prototype
placed 1,305 of 1,577). Across the ten books every
changed text block equals v11's without its placeholders, and nothing else changes.
The unplaced reasons come from replaying the production rule over v11's text; the
replay places exactly the 1,547 the parser placed.

## Timing

Server parse time over the 66 documents went from 2,550 s (v11, 2026-09-25) to
2,868 s, but v12's run shared the host with the extra books' two arms, the library
replay and the test suite. Measured instead with `refine.parse_pdf` in one idle
container, v11 and v12 in turn:

| Book | v11 | v12 | Where |
| --- | ---: | ---: | --- |
| EE I (364 pages, 403 formulas) | 19.1 s | 21.2 s | structure +2.3 s |
| Brief Calculus (235 pages, 1,708 formulas) | 22.1 s | 29.8-31.3 s | structure +5-6.6 s, repairs +2-2.4 s |
| OpenStax Chemistry (1,203 pages, 63 formulas) | 204 s | 203 s | structure +6.3 s, repairs +2.5 s, Java varies by 10 s |

The cost is the page text and words read once per page that holds a picture, and a
render per detection.

## Merge check

`main` moved to `6cef74ae` during the run. The merged tree with this change
(`v12m`) gives the same blocks and furniture as `v12` on all ten extra books and on 64
of the 66 gate documents. In the other two, 38 OCR line blocks (Business Plan Guide
37, Chemistry 1) differ only in `_ocr_score`, by at most 0.00001, from the merge's
ONNX thread count (8 to 4); their text is identical. So the gate measures what is
committed, and neither arm needed a rebuild. The merged run's server parse time over
the 66 documents, with the host otherwise quiet, was 2,592 s against v11's 2,550 s.

## Tests

- New in `pipeline/tests/test_odl_refine.py`: each of the six tests alone keeps an
  otherwise-detected inline picture an image (parametrised; each case trips only its
  own test); a picture beside a tall merged line and one 2.9 body lines tall stay
  images; a display formula carries `[formula]`, an inline one is spliced between its
  words, and one whose word pair repeats in its paragraph stays unplaced; a repeated
  glyph among new words stays a formula while a repeat beside the same words and a
  repeat taller than 1.6 times the font size become furniture.
- Each fails on a mutated rule: the six tests removed (6 fail), either tall-line
  guard removed, the fixed-context or glyph-height clause removed, all repeats
  discarded, placement disabled.
- `pnpm run test:pipeline:offline` on the merged tree: 858 passed, 5 failed outside
  this change (Windows: a prompt_toolkit console, an encoding in the quiz golden, and
  three `test_parser_java.py` cases that use `signal.SIGKILL`), with the five modules
  that import `fcntl` and `test_parser_app.py` left out.

## Decision

The rule meets the gate and the report's precision. Open questions for the developer:

1. **Unplaced inline pictures.** An inline picture with no single host block or with
   a word pair that repeats in its paragraph stays an empty `equation` block, so its
   formula leaves no mark in chunk text (the prototype's behaviour, kept). Unplaced:
   14 of 18 on the gate, 338 of 1,885 in the extra books (237 repeated pairs, 96 no
   host, 5 pairs not found), 417 of 2,109 in the library replay. Options: keep it; give
   an unplaced picture the display text `[formula]` as its own block, which the chunk
   shows after the paragraph; or append `[formula]` to the host paragraph.
2. **Remaining false positives.** Accept 76% gate precision (Rice logos, grey key
   caps, two BOJ pieces) and the ten real figures above, or tighten a test? Each
   loses its figure record; the Rice logos and key caps also put `[formula]` into
   chunk text. Music notation and score excerpts are the one class the six tests do
   not see at all.
3. **Parse time.** Up to about 8-9 s per book (Brief Calculus, Chemistry); fine under
   the 600 s deadline for these books, and it scales with pages that hold pictures.

Not done here: the 2026-09-28 measurement of the report's located formula pictures
against the published chunk text. The library replay (`lib-replay.json`, every
detection with page and box) can seed it.

## Reproduction

Raw outputs, scripts and sheets are in the ignored
`reports/local/2026-09-28-parser-v12-gate/`: `v11/` (copied), `v12/`, `v12m/`,
`extras/` (`v11h/`, `v12/`, `v12m/`), `snapshots/parser-v11` (HEAD's `parser/` at
`6ef13def`), `parser-v12`, `parser-v12m`, `compare-v11-v12.json`, `summary-v12.txt`,
`gate-diff.json`, `extras-diff.json`, `lib-replay.json`, `precision.log` and
`sheets/` (`brief_0`, `eei_0`, `bstat_0`, `extras-other_0`, `gate_0..2`,
`lib-small_0..2`, `lib-mid_0..1`, each with its item list).

```sh
GATE=bench/parsers/reports/local/2026-09-28-parser-v12-gate
S=$GATE/scripts
docker run -d --name capy-kb-parser-v12-gate -p 127.0.0.1:18099:8090 \
  --memory 7g --memory-swap 14g --cpus 4 -e PARSER_TOKEN \
  -e CAPY_MAX_SOURCE_BYTES=536870912 [the builder container's other CAPY_* env] \
  --mount type=bind,source=$GATE/snapshots/parser-v12,target=/app/parser,readonly \
  capy-kb-parser:pilot-v11
PARSER_TOKEN_V12=... uv run --project pipeline python bench/parsers/scripts/gate_parser_fresh.py \
  parse --manifest $GATE/gate.json --arm v12=http://127.0.0.1:18099 --output $GATE
PARSER_TOKEN_V11H=... PARSER_TOKEN_V12=... uv run --project pipeline python \
  bench/parsers/scripts/gate_parser_fresh.py parse --manifest $GATE/extras/gate.json \
  --arm v11h=http://127.0.0.1:18100 --arm v12=http://127.0.0.1:18099 --output $GATE/extras
PYTHONDONTWRITEBYTECODE=1 uv run --project pipeline python bench/parsers/scripts/gate_parser_fresh.py \
  compare --manifest $GATE/gate.json --output $GATE --arms v11 v12 \
  --gold bench/parsers/fixtures/heading-release-gold-2026-09-20.json \
         bench/parsers/fixtures/heading-scope-release-gold-2026-09-20.json \
  --measure-dir data/knowledge-base/opus-intake-2026-09-23/section-paths
uv run --project pipeline python bench/parsers/reports/local/2026-09-24-parser-v10-gate/scripts/gate_summary.py \
  $GATE/compare-v11-v12.json
uv run python $S/pictures_diff.py $GATE v11 v12 $GATE/gate-diff.json
uv run python $S/pictures_diff.py $GATE/extras v11h v12 $GATE/extras-diff.json
uv run python $S/lib_replay.py $GATE/lib-replay.json
uv run python $S/precision.py $GATE v12 $GATE/lib-replay.json
uv run python $S/same_arms.py $GATE v12 v12m
uv run python $S/same_arms.py $GATE/extras v12 v12m
uv run python $S/contact_sheet.py $GATE/extras v12 $GATE/sheets brief 36 brief-calculus
uv run python $S/contact_sheet.py $GATE v12 $GATE/sheets gate 0
docker exec <container> python /tmp/phases.py /app/parser /tmp/src/book.pdf   # timing
```
