# Vector figure records and the thin-image filter

Decision 2026-09-23 (`human/agentic-retrieval.md`): the knowledge-base figure
stage drops parser image records 2 units or thinner on the 0-1000 page grid and
adds records for clustered vector drawings, measured on a sample of books
before the commit. Published books keep their records; new books and the
re-run of Euclidean Plane and its Relatives get the new ones.

Code: `figure_records` and `drawing_records` in
`bench/rag/scripts/knowledge_base_pilot.py`, called by `parse` and by
`refresh-figures` (the builder's figures stage). Tests:
`bench/rag/scripts/test_knowledge_base_pilot.py`.

## What changed

- **Thin filter.** Image and chart blocks with a bbox side of 2 units or less
  are no longer figure records. In Euclidean Plane these are 1,195 of its 1,196
  records: fraction and radical bars, the edges of the end-of-proof box and the
  rules of framed boxes, all drawn as 1x1 stencil images the parser reports as
  image blocks.
- **Vector records.** PyMuPDF clusters each page's visible paths. A cluster
  becomes a record with `geometry_kind: "vector_drawing"` unless one of the
  rules below skips it. The id is `fig_<source_id[:14]>_p<page>_<x0>_<y0>`
  (rounded top-left corner), so it never matches a block-index id and changes
  only when the drawing's box does. `block_index` is the last parser block
  that starts above the drawing, and the record takes that block's section
  path, so `build_excerpts` links it the way it links parser images: its box
  against chunk regions, or the same section path. `original_caption` is empty.
  Existing records keep their ids and content. `refresh-figures` still refuses
  repaired books, and it now also checks the PDF's sha256 against the book.

## Rules and thresholds

A cluster is skipped when any rule applies, in this order.

| Rule | Constant | What it removes | Evidence |
| --- | --- | --- | --- |
| Paths never drawn | `_inked` | Fills or strokes that are transparent or white. Game theory draws every exercise in a transparent box; without this each exercise became a "figure". | Seen on every page of Introduction to Game Theory. |
| Clustering gap | `DRAWING_GAP = 8` pt | At 3 pt (PyMuPDF's default) a figure splits into pieces: bars of one histogram, rows of the sampling-balls figure. At 12 pt, fraction bars of stacked formulas join into formula "drawings". | 12 sample books, early rules: records on pages holding more than one record fell from 317 (3 pt) to 240 (8 pt) and 201 (12 pt). Across all runs, 115 of the 12-pt records had no 8-pt counterpart, mostly merged formulas. |
| Small | `DRAWING_MIN_SIDE = 30` units | Accents drawn over vector symbols, curved mnemonic arrows, licence icons, shaded single code lines, stray pieces of larger figures. PyMuPDF already drops clusters thinner than the gap, which removes running-head and footnote rules. | Labelled set: raising it to 40 loses 4 of 75 real figures, lowering it to 20 changes nothing. |
| Margin band | `DRAWING_MARGIN = 100` units | Drawings wholly inside the top or bottom tenth of the page: cover logos, a heading box, clipped formula outlines. | Across all 117 runs, 28 clusters. None of the 9 inspected with the early rules was a figure. |
| Parser overlap | `DRAWING_OVERLAP = 0.2` | Drawings with over a fifth of their area inside one parser table block or image record: ruled tables the parser found, frames around screenshots ("A YouTube element has been excluded"), boxes around formula images, vector marks on raster figures. | Labelled real figures overlap at most 0.9% (tiny images inside charts). Frames around images start at 20.8%. At 0.5, 4 more non-figures survive. |
| Text frame | `DRAWING_TEXT = 0.2`, `DRAWING_FRAMED_TEXT = 0.02` | Word boxes cover over 20% of the drawing, or over 2% when a rectangle (square or rounded, at most 8 path items) spans 90% of it or every path is a level line or rectangle: callout and example boxes, code blocks, quotation boxes, ruled tables the parser missed, payoff matrices. | Of the 30 drawings with curves and a word share of 0.12 to 0.35 in the sample books, the real figures reach 0.17 (labelled geometry) and 0.19 to 0.21 (charts with in-plot notes), and rounded callout boxes start at 0.20. At 0.15, six of those real figures drop and no non-figure goes; at 0.25, the labelled set keeps 6 more non-figures and 3 more real figures. At 0.04 for framed drawings, 1 more non-figure survives. |
| Glyph outlines and empty boxes | `DRAWING_GLYPH = 45` pt | Apart from its frame, the drawing holds only fills no taller than 45 pt or thinner than 2 pt: formulas set as outlines (Physics, Operations Management, Mathematics for Elementary Teachers), publisher logos, licence badges, empty boxes. | In Physics, 470 clusters pass every other rule, nearly all formulas; 3 records remain. Across all runs, 30 to 45 pt removes 29 records: 28 formulas, logos, badges and blank boxes, and one real figure (a filled sine wave). 45 to 60 pt removes 2 logos; 60 to 90 pt starts removing real figures (a Euclidean figure). |

The thresholds were fitted on 293 hand-labelled clusters: 110 from 12 of the
sample books and 183 from 93 books across the library (two per book). The set
holds 75 real figures, 13 decorative graphics (logos, covers, badges) and 205
non-figures. The final rules keep 67: 66 real figures and one table drawn with
filled rules (Organizational Change in the Field of Education Administration,
page 94). They miss 9 of the 75 real figures (see Limits).

## Gate

Old records come from `figure_records` at HEAD; new records from the working
tree's `figure_records` plus `drawing_records`. Both ran in memory over each
run's `parsed/content_list.json`, the stored corpus and the source PDF; nothing
under `data/` was written. "Linked" counts records that `build_excerpts` puts
on at least one excerpt. "Small" counts clusters under 30 units; the other
skip columns count larger clusters by the first rule that applies. A feature-based replica of the rules matched
`drawing_records` exactly on all 13 books.

| Book | Pages | Old records | Thin dropped | Vector added | Linked | Skipped: small | margin | overlap | text frame | glyphs | Seconds |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Euclidean Plane and its Relatives | 204 | 1,196 | 1,195 | 175 | 175 | 1 | 0 | 8 | 15 | 2 | 1.4 |
| Ordinary Differential Equations | 146 | 12 | 0 | 54 | 52 | 0 | 0 | 8 | 0 | 0 | 0.6 |
| Introduction to GNU Octave | 182 | 127 | 0 | 1 | 1 | 0 | 0 | 10 | 8 | 0 | 0.8 |
| Marine Ecology Notes | 192 | 385 | 0 | 0 | 0 | 0 | 0 | 3 | 2 | 0 | 0.3 |
| Media Studies 101 | 151 | 47 | 0 | 0 | 0 | 1 | 0 | 15 | 4 | 0 | 0.2 |
| Introductory Business Statistics | 95 | 415 | 0 | 0 | 0 | 1 | 0 | 2 | 18 | 0 | 0.5 |
| Physics | 875 | 609 | 0 | 3 | 3 | 1,801 | 0 | 95 | 234 | 467 | 11.4 |
| Principles of Financial Accounting | 318 | 47 | 0 | 0 | 0 | 2 | 0 | 321 | 163 | 0 | 3.5 |
| Transitions to Professional Nursing Practice | 134 | 38 | 0 | 0 | 0 | 4 | 0 | 13 | 0 | 0 | 0.3 |
| Introduction to Game Theory | 121 | 0 | 0 | 6 | 6 | 0 | 0 | 36 | 42 | 0 | 1.0 |
| Private Pilot ACS | 87 | 1 | 0 | 0 | 0 | 0 | 0 | 12 | 0 | 0 | 0.5 |
| Learning Statistics with R | 792 | 32 | 0 | 132 | 130 | 552 | 0 | 51 | 340 | 0 | 5.1 |
| Electromagnetics Volume 1 | 240 | 249 | 15 | 87 | 87 | 39 | 0 | 41 | 292 | 0 | 2.8 |
| **Total** | 3,537 | 3,158 | 1,210 | 458 | 454 | 2,401 | 0 | 615 | 1,118 | 469 | 28.4 |

Four records link to no excerpt. Two are in ODE, whose run already carries
section-path repairs, so the block paths no longer match the repaired chunk
paths (`refresh-figures` refuses that run anyway). The other two are Learning
Statistics charts whose axis labels the parser read as a heading, so no chunk
shares their box or section path.

### Visual check

Crops were rendered to the session scratchpad (not committed) with the record
box outlined.

- **Random 60 of the 458 added records** (seed 20260923; Euclidean 24,
  Learning Statistics 18, Electromagnetics 11, ODE 7): all 60 are real figures.
  One is a single panel of a multi-panel figure (Electromagnetics page 86).
  False positives: 0 of 60, so under 5% at 95% confidence.
- **Every added record in the books with few records** (Physics 3, Game Theory
  6, Octave 1): the 6 Game Theory plots and the Octave house graph are real.
  Physics keeps its cover (page 1, decorative) and two non-figures: a unit
  conversion whose cancel strokes are stroked paths (page 36) and an exercise
  whose vector arrows are drawn over letters (page 213). That makes 2 known
  false positives plus 1 decorative graphic among the 458 records.
- **Known diagrams:** all found.
  - Euclidean page 158 set-square: `fig_e2be64228dc4ea_p158_671_121`, box
    [671, 121, 847, 213].
  - ODE page 29: `fig_e9eabfaee2c680_p29_233_250`.
  - ODE page 35: two records, Figure 3.1(b) [232, 214, 494, 326] and Figure 3.2
    [235, 420, 500, 607]. The phase line of Figure 3.1(a) is 8 units tall and
    gets no record.
  - ODE page 50: `fig_e9eabfaee2c680_p50_243_485`.
- **Dropped thin records.** No real image among them:
  - All 15 in Electromagnetics Volume 1: 14 are 2-unit dot markers inside the
    page 169 figure, and one is a minus bar on page 87.
  - 24 in Euclidean Plane (12 random, the 6 widest and the 6 tallest): bars,
    end-of-proof box edges and box rules.
  - The 12 others in the library: Electromagnetics Volume 2 page 194 is a
    raster cut into 15 strips, and its 6 thin strips drop while the 9 others
    stay records. Also two dots in Brief Calculus, formula bars and dots in the two
    Fundamentals books and Intro to Logic, and a cover strip in Liquidity,
    Markets and Trading.

### Beyond the sample

Across all 117 runs the rules add 1,451 records in 31 books; 993 of them are
in 24 books outside the gate. Evidence-based Software Engineering has 455,
Electromagnetics Volume 2 93, Online Statistics Education 91, Java Java Java
83, Fundamentals of Compressible Fluid Mechanics 72, Open Logic Project 70 and
Mathematics for Elementary Teachers 20.

A random 48 of those 993:

- 46 are real figures; 4 of them are parts of a larger figure.
- One is a standalone arrow shape (Overview of Healthcare Compliance, page 93).
- One is a non-figure: a brace annotating a statement (Intermediate Financial
  Accounting, page 560).

`drawing_records` takes 101 s on Evidence-based Software Engineering, which
has pages of up to 189,000 paths. The other books took 0.2 to 14 s.

## Limits

- **Missed figures.** The labelled set lost 9 of 75:
  - Three Octave diagrams. Octave draws their slanted lines with LaTeX
    picture-mode line fonts, which are text, not paths, so what remains looks
    like level lines around words.
  - Five diagrams with over 20% of their area in words: concept circles,
    chevron and structure diagrams made of text in boxes, an annotated
    statement form, and one Euclidean figure whose box takes in the text
    beside it.
  - One bar chart made only of level lines, with value labels inside.
  - Outside the labelled set, the glyph rule also drops drawings made only of
    fills under 45 pt: the two parallelograms on Euclidean page 164 (the 2
    glyph skips in its row) and a filled sine wave in a music book.
- **Boxes cover paths only.** Axis tick labels and titles set as text sit
  outside the box of R and matplotlib plots, so a crop cut to the box loses
  them.
- **Fragments.** Multi-panel figures give one record per panel, and a piece
  farther than 8 pt from the rest of its figure becomes its own record.
- **Two records for one figure.** A vector chart with a `Figure N:` caption line
  and no image block now has a `caption_page_reference` record (whole page)
  and a `vector_drawing` record. Scope workers will see and label both.
- **Clipping.** PyMuPDF reports paths without their clip, so paths clipped out
  of view can form clusters. The margin and glyph rules removed the ones seen
  (hidden formula outlines in Online Statistics Education).
- **Section path.** The path comes from the last block that starts above the
  drawing. On a two-column page, that block can be in the other column.
