# Drawing answers: is the marking image readable at 1,568 px? (2026-11-06)

Epo set the marking image at 1,568 px on its longest side (2026-11-06) and asked
whether that is fine for most boards, and whether WebP holds on Safari.

**Method.** Boards built on the dev board (`/dev/drawing`, vite on 5394), one
drawn with the real pen and labels, the rest through the board's API with the
same defaults (labels 24 px Inter, pen width 4). Every image is the real
`toImage()`, shrunk in Chromium with high-quality smoothing to 1,024, 1,568 and
2,048 px and measured in pixels. Readable: letters or digits at least 10 px
tall and strokes at least 1.5 px; marginal: 7–10 px; unreadable below 7 px, or
strokes under 1 px. No model was called. Scripts and images stayed local
(the session's scratchpad `legibility/`).

## Results at 1,568 px

| board | span (units) | after pull-in | toImage px, KB | scale | label px @1024 / **1568** / 2048 | axis digits | thinnest pen | default pen |
|---|---|---|---|---|---|---|---|---|
| 1 small sketch (real tools) | 784×392 | same | 1600×817, 17 | 1.96 | 23 / **34** / 36 | – | – | 4.9 |
| 2 labelled diagram | 1062×792 | same | 2156×1616, 44 | 1.46 | 17 / **26** / 34 | – | 2.2 | 4.4 |
| 3 plane card, line, handwriting | 820×520 | same | 1672×1072, 26 | 1.88 | 22 / **33** / 36 | 16 | 3.2 | 5.9 |
| 3b plane plus working | 1328×520 | same | 2400×957, 42 | 1.17 | 13 / **21** / 27 | 10 | 1.7 | 3.3 |
| 4a timeline | 2410×302 | same | 2400×315, 16 | 0.65 | 8 / **11** / 15 | 12 | 1.1 | 2.0 |
| 4b timeline | 3010×302 | same | 2400×252, 13 | 0.52 | 6 / **10** / 13 | 9 | 0.6 | 1.7 |
| 4c timeline | 3510×302 | same | 2400×216, 11 | 0.45 | 5 / **8** / 11 | 8 | 0.55 | 1.2 |
| 5a four groups far apart | 5960×4835 | 2480×1859 | 2400×1803, 21 | 0.63 | 8 / **12** / 15 | – | 0.8 | 1.9 |
| 5b timeline, no gaps | 5010×302 | same | 2400×152, 7 | 0.31 | 4 / **6** / 7 | 5 | 0.4 | 0.8 |
| 6a dense, 70 strokes | 1953×1008 | same | 2400×1248, 171 | 0.80 | 9 / **14** / 18 | – | 1.2 | 2.4 |
| 6b very dense, 300 strokes | 1771×1279 | same | 2000×1450, 287 | 0.88 | 10 / **15** / 20 | – | 1.2 | 2.7 |
| 7 bar chart, plane, 2 formulas | 1172×573 | same | 2376×1178, 39 | 1.32 | 15 / **24** / 31 | ~11 | 2.0 | 3.9 |
| 7b two charts, plane, 2 formulas | 1877×457 | same | 2400×600, 22 | 0.83 | 10 / **15** / 19 | ~7 | 1.4 | 2.4 |

Above about 784 units the final scale is 1568 ÷ (longest span after pull-in + 16).

| element | readable (10 px) up to a span of | marginal (7 px) up to |
|---|---|---|
| typed label, capitals | about 2,700 | about 3,900 |
| typed label, lowercase | about 2,000 | about 2,900 |
| plane and chart numbers, bar labels | **about 1,330** | about 1,900 |
| formula `\frac` exponent (inline KaTeX) | about 1,190 | about 1,700 |
| handwriting with 36-unit capitals | about 5,600 | – |
| thinnest pen | 1.5 px up to about 1,650 | – |
| default pen | 1.5 px up to about 3,300 | – |

## Findings

- **1,568 px is fine for most boards.** A typical answer (a sketch, a labelled
  diagram, one plane or chart card with working beside it) spans under about
  1,300 units, lands at scale 1.2–2 and weighs 15–45 KB.
- **Cards break first.** Axis and chart numbers and formula exponents fall under
  10 px past about 1,330 units: a card with more than about one card-width of
  other content loses its numbers first.
- **Wide strips break.** A one-line timeline past about 2,700 units, or any
  board past `toImage`'s own 2,400 px cap, loses detail that no resizing brings
  back. Options: 2,048 px for spans of 1,330–2,400; cropping each card into its
  own image; or splitting a wide board into overlapping regions.
- The pull-in of far groups works; the extra shrink of a board past 300 KB is
  not a problem.
- Inline KaTeX makes `\frac` small; display mode would be about 1.4× larger.

## Safari

WebKit was not installed, so this is a code trace plus a replay of Safari's path
in Chromium.

- Safari's canvas answers PNG when asked for WebP; `fitImage` then falls back to
  **JPEG at 0.85** (keeping the PNG only when it is under 300 KB and smaller,
  which happened for the plain plane board alone).
- JPEG of line drawings is 2–3× WebP's size. Most boards are 18–135 KB; the
  70-stroke board reaches 291 of 300 KB. **The 300-stroke board cannot be handed
  in on Safari:** at 2,000 px JPEG runs from 671 KB (0.85) to 370 KB (0.4), so
  `toImage()` throws. A smaller JPEG step (such as 1,568 px) or a lower quality
  floor for drawing images would fix it.
- Safari before 16.4 has no 2D OffscreenCanvas in workers: the capture fails
  there.
- Readability depends on scale, not format. The server already takes WebP, JPEG
  and PNG within 300 KB and 2,400 px. Whatever shrinks to 1,568 should save JPEG
  or WebP, never PNG (a dense board as PNG at 1,568 is about 490 KB).
