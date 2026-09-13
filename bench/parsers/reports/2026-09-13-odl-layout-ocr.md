# ODL OCR layout experiments, September 13, 2026

The strongest tested OCR improvement is learned page-region order with explicit
abstention when the layout detector misses text. It fixes the annotated column
order on four diagnostic pages. It is an experimental candidate, not a production
change or a general accuracy certification.

The companion [native repair experiment](2026-09-13-odl-native-improvements.md)
investigates source-table extraction, replacement admission and double overprints.

## What ran

Seventeen page images went through real local CPU inference. Twelve initial
diagnostic cases were followed by five different documents, with the model,
assignment rule and whole-page guard unchanged. Source images and reading-order
rubrics were reviewed and frozen before each batch's model output. The first
batch contains ten known corpus pages and two newly rendered negative controls.
The second batch contains dense tables and infographic layouts.

These are known benchmark sources. The second batch is separate from the first
batch's source documents, but neither batch is an untouched holdout. Training-set
overlap for the pretrained models was not measured. Digital originals were
rasterized to exercise the OCR path; these numbers are not improvements to the
normal native parser route for those PDFs.

The experiment uses the production `parser/odl/ocr.py` functions directly:
PP-OCRv6 small detection and recognition, mobile angle classifier, 2,560-pixel
long edge, eight ONNX threads and text score 0.5. All arms receive identical
recognized text, scores, line boxes and page numbers. Every reordered output is
asserted to be a permutation of the original lines, then passed through the real
`pack_blocks` implementation. Chunk JSON is retained for inspection.

The added model is PP-DocLayoutV3 through RapidLayout 1.2.1, ONNX Runtime 1.29.0,
four inference threads, default confidence and IoU thresholds of 0.5. The model
returns labeled regions in predicted reading order. It does not transcribe text
or produce a table cell grid. See the primary [RapidLayout repository](https://github.com/RapidAI/RapidLayout)
and [PaddlePaddle model documentation](https://huggingface.co/PaddlePaddle/PP-DocLayoutV3).

Three arms were frozen before the first inference:

- **Baseline:** production row-major OCR order with fixed 12-unit vertical bands.
- **Partial layout:** assign a line to the region covering at least half its
  area, preferring greater coverage and then the smaller region. Reorder assigned
  lines by model region order, preserving baseline order inside each region.
  Unmapped lines retain their original output positions. This arm is rejected.
- **Strict layout:** apply that permutation only when every recognized line maps
  to a region. Otherwise retain the baseline page. Table contents stay together
  in their model region; there is no letter-versus-number heuristic.

The score counts inversions between OCR lines whose centers lie in different
source-annotated regions with an explicit order. It measures recognized-line
ordering only. It does not score transcription, omitted text, complete table
meaning, formulas, all within-region order, or final answer correctness. No
annotated region was empty and no line crossed two scored regions by the recorded
20% overlap diagnostic. Independent infographic panels use fragmentation counts
instead of an arbitrary mutual ordering.

## Initial results

| Page | Baseline wrong pairs | Partial layout | Strict layout | Strict applies |
| --- | ---: | ---: | ---: | --- |
| ResNet 1 | 324 / 1,505 | 1 | 324 | No |
| BERT 2 | 1,190 / 2,400 | 0 | 0 | Yes |
| CamemBERT 4 | 452 / 3,011 | 0 | 0 | Yes |
| CamemBERT 7 | 0 / 1,841 | 0 | 0 | No |
| Chinese zh-CN 7 | 473 / 3,038 | 0 | 0 | Yes |
| Biology sample 5 | 0 / 494 | 0 | 0 | Yes |
| Japanese LLM slide 4 | 0 / 56 | 6 | 0 | No |
| Synthetic newspaper 1 | 0 / 57 | 0 | 0 | Yes |
| Synthetic newspaper 2 | 0 / 57 | 0 | 0 | Yes |
| NIST accelerometers 1 | 258 / 708 | 0 | 0 | Yes |
| Unit-bearing table | 0 / 181 | 0 | 0 | No |
| Alternating outline | 0 / 36 | 0 | 0 | Yes |

The strict arm removes 2,373 of 2,697 inversions, 88.0%, across 13,384 checked
line-pair relations. The mean page error falls from 11.51% to 1.79%. It applies to
8 of 12 pages and introduces no errors on these checks. There are 765 recognized
lines, of which 650 participate in the source-region annotations.

Coverage is narrower on pages with figures and side annotations: 72 of 101
ResNet lines, 36 of 53 Biology lines, 95 of 132 Chinese lines, 12 of 24 Japanese
slide lines and 52 of 67 NIST lines. The remaining visible material was not
certified by the inversion score. CamemBERT 4 uses a left-table-plus-caption,
then right-table-plus-caption convention. Both tables are independent panels,
so their relative global order is convention-sensitive. Later infographic
checks avoid imposing a mutual panel order.

This is substantial for the measured column-order defect. The example reading
sequence on BERT changes from alternating left/right lines to complete left
column followed by complete right column. On CamemBERT 4, the two independent
tables and their captions stop interleaving. Their cell semantics are not proved
by that result.

The partial arm's aggregate looks better, 7 inversions, but it causes a new error
on the Japanese slide. Keeping unmapped lines in their old positions while moving
the rest breaks their relationship to surrounding text. On ResNet, the missing
author region leaves one author before the title. The strict guard abstains on
both pages. A detector score alone is not a correctness guarantee.

The unit-bearing negative control contains eight destination/mass rows with
values such as `1,000,000 kg`. Neither arm transposes those rows. The two newspaper
fixtures are synthetic, single-column repeated text clipped at the source right
edge. They do not provide real newspaper-layout coverage.

The unit-bearing table is an unchanged-preservation control: its 18 table lines
share one model region, and the strict page arm abstains. It does not demonstrate
repairing an incorrect grid or establishing cell/header semantics. A separate
scorer sensitivity check deliberately transposed its actual label/value OCR
lines into columns and produced 28 of 181 wrong pairs. Thus the source-row rubric
can catch that failure, but this one model prediction does not establish that
other tables will also be recognized and protected correctly.

## Additional source documents

| Page | Baseline wrong pairs | Partial layout | Strict layout | Strict applies |
| --- | ---: | ---: | ---: | --- |
| Japan migration 16 | 448 / 218,461 | 448 | 448 | No |
| Spain in figures 8 | 0 / 1,218 | 18 | 0 | No |
| Hong Kong in figures 13 | 0 / 11,831 | 0 | 0 | Yes |
| Attention 6 | 0 / 1,603 | 0 | 0 | Yes |
| German education 9 | Panel cohesion only | See below | Unchanged | No |

Strict layout applies to only 2 of these 5 pages. It introduces no scored
regression but delivers no improvement on this batch. The permissive arm reduces
fragmentation of German infographic panels from 71 runs to 22, with six perfectly
grouped panels requiring six runs. In Spain it groups the four annotated panels
from 21 runs to four, but simultaneously moves right-column article content out
of source order, causing 18 inversions. Those gains do not justify accepting it.

This batch puts a practical limit on the first result. Whole-page abstention
protects difficult layouts but gives up useful repairs when only a small label,
author or footer is unmapped. A safe local-region admission rule remains to be
established; simply retaining unassigned positions is disproved by two sources.

## Rejected table-row extension

After inspecting the dense Japanese table, a separate development arm attempted
to improve order within detected tables. It kept strict page ordering, admitted
only contiguous table lines without intersecting foreign/unmapped text, and
grouped lines sharing a common vertical interval before sorting each row by x.
This used the same saved OCR and layout outputs and the unchanged source rubrics.

It does not fix the Japanese table: the unit label overlaps the detected table
boundary and causes abstention. More seriously, it introduces four row inversions
in the Attention mathematical table. Expanded OCR boxes for adjacent formula
rows overlap, so interval grouping combines text from different rows. The result
is retained as a failed development experiment. No follow-up thresholds were
tuned to make these cases pass.

An outer table box is not enough to establish cells, row spans or header scope.
The next OCR table experiment should compare actual table-structure predictions
against source cell/row/header checks. More row-gap cutoffs would repeat the
failure mode this review set out to avoid.

## Cost and limits

The initial run spent 58.31 seconds in OCR and 13.16 seconds in layout inference.
Layout added a median 1.104 seconds per page, range 0.999 to 1.169 seconds, plus
0.974 seconds to load the layout model. The five additional pages took 1.11 to
1.22 seconds each for layout. The extra model file is 130,502,330 bytes, about
124.5 MiB. Initial-process peak RSS was about 1.08 GiB for OCR, layout and packing
together. This does not isolate incremental model memory.

The machine was macOS 15.3.1 on arm64, Python 3.12.7. These are single local runs,
with no ingestion queue, no shared-host capacity test and no latency guarantee
for the Linux ingest host. No paid model API or shared ingest service was used.

The current production parser remains unchanged by these experiments. Before
promoting layout ordering, freeze a broader source-separated corpus with full
line coverage and table semantics, test malformed/rotated/low-resolution scans,
and measure the actual OCR route on the ingest runtime. Preserve a complete
abstention count as well as accuracy; a high score on a handful of activated
pages would conceal the same coverage problem found in the native repairs.

An independent Luna max review reproduced the frozen initial counts and all
line permutations. It also verified that each unique OCR block's page/bbox
occurs in the packed chunk regions on all initial pages and found no lost unique
OCR block. The four changed pages' minimum final chunk sizes were 63 to 278
estimated tokens, above the current 40-token cutoff. A separate whole-line
substring check across all 17 pages found no newly absent text in strict chunks.
These checks exclude repeated-occurrence and sentence-continuity guarantees.
Production selective routing, merging with native blocks, frozen furniture,
heading retention and confidence scoring were not exercised together here.
The native experiment's short-tail loss remains a required integration check.

## Reproduction and evidence

The executable is [`experiment_odl_layout_ocr.py`](../scripts/experiment_odl_layout_ocr.py).
The source-defined rubrics are [`odl-layout-ocr-checks.json`](../fixtures/odl-layout-ocr-checks.json).
Input PDF/image hashes, model hashes, exact package versions, source-code snapshots,
recognized lines, assignments, text, actual chunks and annotated layout images
are retained under `bench/parsers/reports/local/2026-09-13-odl-layout-ocr/`.

- `run-r1/`: initial 12 pages, original frozen script and checks.
- `validation-inputs/`, `validation-r1/`: five additional source pages and frozen checks.
- `development-r2/`, `validation-r2-development/`: rejected local table-row replay.
- `scorer-verification.json`: current formatted scorer reproduces all 34 saved
  case results and permutations, including exact rejected r2 behavior.
- `line-presence-in-chunks.json`, `table-metric-sensitivity.json`: bounded text
  retention and injected-transposition diagnostics.

On this workstation the isolated interpreter and model directory are under
`/private/tmp/capy-odl-quality-20260913/`. Use new output directories for inference
or replay. The scoring command needs no models:

```sh
/private/tmp/capy-odl-quality-20260913/py312/bin/python \
  bench/parsers/scripts/experiment_odl_layout_ocr.py score \
  bench/parsers/reports/local/2026-09-13-odl-layout-ocr/run-r1

/private/tmp/capy-odl-quality-20260913/py312/bin/python \
  bench/parsers/scripts/experiment_odl_layout_ocr.py run \
  bench/parsers/reports/local/2026-09-13-odl-layout-ocr/validation-inputs \
  /private/tmp/odl-layout-validation-new \
  /private/tmp/capy-odl-quality-20260913/models
```

`prepare-controls` renders the two deterministic text/table layouts before a new
run. `table-rows PREVIOUS NEW_OUTPUT` reproduces the rejected development arm
without another OCR/model call. Source snapshots under reports are evidence;
execute the maintained script under `scripts/`.
