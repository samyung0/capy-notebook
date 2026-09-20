# Prince math-loss geometry experiment

Date: 2026-09-20. Benchmark only. No production parser, pipeline, library-builder,
or live-corpus files changed. No OCR or provider calls.

The geometry probe can flag omitted inline ink and attach source regions to raw
chunks. It does not recover the formula, and the current chat header suppresses
all 17 warnings because their text-layer agreement scores remain at least 0.976.
The probe also misses standalone equations and mistakes some small illustrations
for math. Prefer the source's tagged alternatives when they exist; this experiment
does not read `/Alt`, `/ActualText`, or corrected corpus text.

## Reproduce

From the repository root:

```powershell
uv run --frozen python bench/parsers/scripts/experiment_prince_math_loss.py
```

The command requires the existing local source PDF and cached raw parse named in
[the fixture](../fixtures/prince-math-loss.json). It does not download or reparse
the source. Outputs go to the ignored
`bench/parsers/reports/local/2026-09-20-prince-math-loss/` directory.

`summary.json` records identity, timings, counts, and propagation checks;
`cases.json` carries every frozen result; `detections.json` carries page-point
ink boxes and source character anchors; `affected-chunks.json` contains the raw
chunk text, agreement score, reasons, existing citation regions, separate loss
regions, and actual `Passage.location()` header; `unmatched.json` lists evidence
that could not be attached. The `v1/` directory preserves the first run and its
script. Rendered pages and eight detection overlays are local review artifacts.

The source is OpenStax *Physics*, 875 pages, producer `Prince 16.2`, SHA-256
`a3f75487411ef13d0270c65fc801ceff2b28e6b339afed9b407fe477f7e8453e`.
Cached `content_list.json` SHA-256 is
`a99e0056d5cdab1109871012686d90782f24bd3babba2423f4c3bdd3b1d52d5b`.
The parse manifest identifies
`odl-2.5.7-refined-rapidocr-v4+b3fa048946997fb598ed024fd4c2675b6d2e7139`.
PyMuPDF is 1.28.2. The experiment packs and scores 3,106 raw chunks through the
current production helpers, with the cached furniture decisions. It does not
load `corpus.json`, so the builder's corrected text cannot influence detection.

## Frozen cases and one bounded revision

Before implementing the detector, I rendered the six handoff pages and selected
independent pages 32, 46, 55, 82, 172, 248, 500, 687, 5, 6, 8, 31, 77, 100, and
104. I also inventoried small raster images across the book and reviewed their
four pages, 326, 653, 676, and 753. The resulting fixture contains 37 regions on
24 pages. Its SHA-256 was frozen before detector implementation and remains
`89f35683317ff14586fd681d7b798bcd78185a23045ed0658f7a26e5ec5242cb`.

These are purposive source witnesses, not a random sample, a human-certified
benchmark, or an estimate of book-wide error prevalence. A positive result means
at least one detected region intersects the frozen witness. It does not mean
every formula in that witness was found.

| Frozen region category | Cases | First run detected | Final run detected |
| --- | ---: | ---: | ---: |
| Missing inline vector math | 12 | 11 | 12 |
| Missing standalone vector math | 5 | 0 | 0 |
| Negative regions | 20 | 2 false positives | 2 false positives |

The first run grouped vertically adjacent formula paths into one component on
page 98, then rejected its height. One change capped component height during
grouping. The fixture and thresholds otherwise stayed fixed. The final result
is 12 true-positive, 5 false-negative, 2 false-positive, and 18 true-negative
regions. The independent inline case on page 172 is detected; the three
independent standalone cases on pages 46, 77, and 172 are missed.

Visual review of the page 98 overlay shows a narrower result than the region
count: choices c and d are flagged, while fractional choices a and b are still
missed. The warning nevertheless reaches their shared raw chunk 347. This is a
post-run diagnostic, not a newly added scored case or a tuned exception.

## Rule and its limits

The script reads native character boxes, filled vector paths, and image boxes.
It keeps small dark paths outside native characters and image regions, groups
nearby paths, and requires at least two paths plus a nearby native character on
the same line. Small raster boxes use the same text-anchor requirement and are
rejected when a native text layer already covers much of the box. There is no
wording-specific match, equation recognition, or PDF producer check.

The evidence reason is deliberately qualified:
`possible math missing from text layer (vector ink beside text)` or its raster
equivalent. Geometry shows unrepresented ink, not what the ink means.

The two false-positive witness regions are the circuit answer illustrations
beside a/b on page 653 and the emission-spectrum strip beside question 72 on
page 753. Those are legitimate illustrations, not omitted prose math. Table
rules, ordinary prose, the selected large diagrams, logos, and contents spacing
do not trigger within the frozen negative regions. Other detections outside
those regions have not all been independently labeled.

The point-size bounds, dark-fill requirement, horizontal text restriction,
component grouping, and native-anchor requirement are conservative experiment
limits. Colored formulas, single-path glyphs, rotated pages, large formulas,
and diagrams made from tiny dark paths need separate validation. The detector
is not suitable as an automatic transcription selector on this evidence.

## Reported failures and propagation

| Source witness | Final detection | Raw chunk receiving reason |
| --- | --- | --- |
| p97 inline slope values and first answer options | Yes | 344 |
| p98 velocity answer formulas | c/d only, enough to flag witness | 347 |
| p99 35 meters, 18 meters, 26 meters, 79 m | Yes | 350 |
| p103 diameter and displacement values | Yes | 365 |
| p262 `g = GM/r^2` worked substitution | No | None |
| p616 inline capacitance and charge | Yes | 2224 |
| p616 standalone voltage calculation | No | None |

Page 262 has other inline detections in its practice problems. Those do not
count as finding the missed worked equation.

Detection alone was insufficient for chunk association. In the first run,
11 of 74 detections had no intersection with any surviving chunk region.
For the final simulation, attachment accepts an intersection with either the
ink box or its actual native-character anchor. That is source evidence, with
no nearest-paragraph guess. It produces 76 attachment records for 76 detections
on the selected pages: 65 by ink intersection and 11 by native-anchor
intersection. Two detections have no owner and two others have multiple owners,
so attachment count happens to equal detection count. Seventeen chunks receive
a reason. The two unassigned detections are the c/d option values at the top of
page 97, whose surrounding option labels did not survive as chunk regions.

The experiment calls `score_chunks` first and attaches reasons afterwards;
that function assigns both the score and reasons, overwriting earlier reasons.
Assertions confirm that the simulation preserves every raw chunk's text,
score, and citation regions, while changing canonical content identity through
the new reason metadata. Loss boxes remain separate, in
`page-1000-topleft` coordinates, including boxes outside the old citation crop.
This is a local serialization and header check, not a database write or a live
capture test.

All 17 affected chunks score between 0.976 and 1.0. The actual
`Passage.location()` implementation shows zero new reasons, because it prints
confidence metadata only below the current 0.9 threshold. The chat capture
instruction also keys on that threshold. A numeric cap such as 0.89 would be a
new policy, not a measured probability; the experiment does not invent one.
Production use needs an explicit route for visual-loss evidence to request
capture, and a policy for preserving its loss region. Merely appending a reason
does not provide that route.

## Raster and image-only coverage

An inventory of image boxes 3–28 points high and 3–220 points wide found seven
small images in the whole source. They are tool, circuit, battery, or spectrum
illustrations. There is no natural raster inline-formula positive in this set.

Four separate synthetic checks rasterize the real page 99 `35 meters` crop and
place it into controlled in-memory pages. Inline raster math next to native
prose is detected. A centered raster formula with no adjacent text and an
image-only page both escape the detector. A raster placed over native math text
does not trigger. These checks verify mechanism and scope only; they provide
no natural-source precision or recall estimate.

The existing OCR routing for nearly empty text layers is separate coverage.
This experiment adds no OCR and does not verify that route. It leaves both
image-only pages and display math on otherwise text-rich pages to other evidence.

## Runtime and verification

On this developer PC, the final 24-page geometry pass took 2.31 seconds total,
44.8 ms median per page, and 406.8 ms on the slowest selected page. Packing,
heading retention, and scoring all 3,106 raw chunks took another 10.39 seconds.
The first run measured 2.70 seconds for geometry; this is one run per variant,
not a throughput or memory-capacity benchmark.

A separate measured whole-book pass is reproducible with:

```powershell
uv run --frozen python bench/parsers/scripts/experiment_prince_math_loss.py --whole-book --output bench/parsers/reports/local/2026-09-20-prince-math-loss/whole-book
```

That pass took 144.36 seconds for geometry over all 875 pages, 76.7 ms median
and 1.54 seconds maximum per page. It produced 2,820 candidate detections,
annotated 777 chunks, and left 50 detections unassigned. Six of those chunks
already had scores below 0.9 and therefore display the new reason; the other
771 do not. The original frozen case results were unchanged. These whole-book
counts are unadjudicated candidates, not confirmed losses or a recall estimate.
No full-book runtime was extrapolated from the selected pages. The measured
cost is a reason to avoid adopting this implementation wholesale.

The runnable checks assert the controlled raster outcomes, retained text and
scores, valid propagation, and changed canonical identity. The selected-source
run completed, and targeted Ruff formatting and checks passed. Full repository
formatters were not run because this task owns only the new benchmark files.

Relevant current contracts are in
[`confidence.py`](../../../pipeline/pipeline/retrieval/confidence.py),
[`chunking.py`](../../../pipeline/pipeline/retrieval/chunking.py),
[`packing.py`](../../../pipeline/pipeline/retrieval/packing.py),
[`search.py`](../../../pipeline/pipeline/retrieval/search.py),
[`indexing.py`](../../../pipeline/pipeline/retrieval/indexing.py), and the
[`chat capture instruction`](../../../pipeline/pipeline/prompts/chat.py).
The original proposal is
[`artifacts/2026-09-20-parser-handoff.md`](../../../artifacts/2026-09-20-parser-handoff.md).
