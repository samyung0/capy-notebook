# Existing OCR-layer detection and recovery

The useful result is a source-gated reading-order repair that needs no new OCR.
It reconnects the NIST paper's broken column continuations while preserving every
native block. New RapidOCR sometimes fixes damaged text, but it also changes
already-correct prose. Even a 99.5% confidence threshold admitted an incorrect
replacement, so automatic prose replacement is rejected for this candidate.

The earlier [font repair](2026-09-09-odl-font-recovery-experiment.md) remains a
separate successful strategy. Production, providers and the original benchmark
artifacts were not changed. No Qwen requests were made.

## Sources and frozen checks

The positive document is the original historical scan of
[Calibration of Accelerometers, NIST 1948](https://nvlpubs.nist.gov/nistpubs/jres/041/5/V41.N05.A01.pdf).
It already contains damaged invisible OCR text; it is not a generated raster
control. Five selected original pages, 1, 3, 4, 5 and 9, are the same immutable
screening input used by the earlier Java and MinerU runs. The original PDF has
SHA-256 `64e632778f0bf38409575a82fb8115f9c4a451c3caa275118cec7a5973a1ae7a`;
the screening PDF has SHA-256
`474257fbbad8bcead3a356b8dec7a7dbff6473352b94e293f3fc3a17f159b665`.

The source audit also covers 35 digital pages from the seven other documents in
the [eight-document corpus](2026-09-09-java-new-documents.md). These include
English, French, Chinese, Spanish, Japanese, German and Traditional Chinese.
The Chinese CCL paper is a known font-mapping failure, so these are 35 digital
controls, not 35 examples of perfect extraction.

The prior complete NIST formula, plot and prose
[source rubric](../fixtures/beijing-ocr-new-documents.json) was copied and hashed
before OCR. Six short prose fragments on pages 3 and 5 were transcribed from
source PNGs before their candidate text was inspected. Two further fragments on
pages 1 and 9 were frozen after developing the replay strategy on pages 3 and 5,
but before reading the held-out pages' candidate body text. These are held-out
pages within one known document, not independent validation documents.

Fragment scores count alphanumeric edits against the best contiguous candidate
substring after removing whitespace and punctuation and ignoring case. This
isolates lexical/order problems from line wrapping; it does not certify complete
page fidelity, formatting, mathematics or figure meaning. Source tables, equations
and named relationships received separate visual review. No aggregate document
accuracy percentage is reported.

## Detecting the existing OCR layer

All five NIST pages have a full-page raster and 100% invisible extracted text.
All 35 digital pages have visible extracted text. The tested source gate requires
at least 100 extracted characters, at least 90% invisible characters and one
raster covering at least 90% of the page. It selects all five NIST pages and none
of the digital controls.

Image coverage alone would fail: German pages 5 and 9 have raster backgrounds
covering 81% and 98% of the page respectively, with legitimate visible text.
The hidden-text condition distinguishes them here. This identifies an existing
OCR layer, not whether that layer is inaccurate. A high-quality historical OCR
layer could pass the same gate.

Small OCR probes were less useful than expected. Each probe rendered the first
four lines of the largest native text block at 288 dpi. Native clipping often
included a fifth line, giving clean English and French probes about 20% naive
text disagreement. Comparing the shorter string against a contiguous substring
of the longer eliminates these boundary errors for English, French, German,
Japanese and Hong Kong probes. A Spanish probe still disagrees by 6.25%; the
known CCL font corruption disagrees by 33.55%.

The NIST page 3 probe then disagrees by only 0.83%, below the initially frozen
2% trigger, even though that page has three unresolved equations elsewhere.
Page 5's native geometry also clips a probe line badly. One small probe cannot
certify a page, and disagreement does not establish which transcription is right.
The final candidate uses source evidence to limit reading-order repair; it does
not use a probe threshold to approve OCR replacement.

## Strategies and measured cost

Twenty-six OCR jobs ran successfully in the isolated
`capy-java-native:20260909` image on `159.195.61.195`, with eight CPUs, 14 GiB
memory and network access disabled. The existing PP-OCRv6 small detection and
recognition models, with the existing orientation model, ran through RapidOCR
and ONNX Runtime with eight threads. Model hashes and package versions are in
`r1/ocr/run.json`. No new dependency or model was installed.

| Strategy or phase | Measured time | Result |
| --- | ---: | --- |
| Five NIST probes | 2.410 s | Cheap but neither reliable corruption detection nor a correctness decision |
| Five full pages, longest edge 1280 | 5.557 s | Some prose corrections; new errors and interleaved columns |
| Five full pages, longest edge 2560 | 7.395 s | Similar tradeoffs; doubling resolution did not yield consistent fidelity gains |
| Four half-page column crops, longest edge 2560 | 3.780 s | Rejected: page midpoint cuts the right column because scan margins are asymmetric |
| All 26 OCR calls, including seven digital probes | 23.368 s | Includes input decoding/resizing and inference |
| Whole OCR runner | 36.881 s | Also includes model load, comparison calculations and artifact writes |

Model construction took 0.187 seconds. The runner's pure-Python full-page edit
comparisons add noticeable overhead and are diagnostic work, not a proposed
production step. Peak memory was not sampled in this run.

The successful refinement reuses existing text geometry. It finds a separated
pair of paragraph columns and computes the actual gutter, about 44.5% to 45.6%
of page width on the reviewed prose pages. Full-width blocks retain their place
between column groups. The native arm only reorders existing blocks. Separate
OCR arms reorder the already-saved full-page OCR boxes at the same gutter, so
they require no additional recognition requests.

On the local Windows machine, a separate checked audit of all 40 source pages
took 0.483 seconds, and native reordering of the five NIST pages took 0.0018
seconds. These are local component timings, not VM or integrated parsing times.

## Source results

| Frozen fragment | Original native edits | Native reorder edits | OCR 1280 edits | OCR 2560 edits |
| --- | ---: | ---: | ---: | ---: |
| Page 3 measurement method | 0 | 0 | 1 | 1 |
| Page 3 paired masses | 1 | 1 | 1 | 2 |
| Page 3 0.44-inch / 117-cycles-per-second result | 0 | 0 | 1 | 1 |
| Page 5 mass-support description | 1 | 1 | 0 | 0 |
| Page 5 release wire and pawl | 1 | 1 | 0 | 0 |
| Page 5 distance D | 1 | 1 | 0 | 0 |
| Held-out page 1 abstract | 0 | 0 | 6 | 5 |
| Held-out page 9 800/350-cycles-per-second comparison | 62 | 0 | 1 | 2 |

Page 9's 62 original edits mainly reflect unrelated figure material interleaved
into a continuous source paragraph. Reordering restores its exact normalized
sequence without changing a character. New OCR introduces lexical errors into
that recovered sequence. Page 1's already-correct abstract likewise becomes
worse under both OCR resolutions.

OCR does repair source page 5's `M1` misread as `Mi`, release wire `G` misread
as `0`, and distance `D` misread as `I)`. These are real gains, but confidence
alone cannot select only those gains. The exploratory selective arm required
three matched lines, 99.5% mean OCR confidence, 0.5% to 8% native/OCR disagreement
and 80% to 120% relative text length. It selected one paragraph on page 1:
`developed lor the Bureau of Aeronautics` became
`developed for the Bureau of Aeronauties`. The score was 99.75%. One typo was
corrected while the proper noun became wrong. This arm is rejected.

The saved MinerU auto output is retained as a comparator. It restores the page 5
support relationship and page 9 frequency paragraph, but introduces errors in
page 3's measurement text and turns some ordinary labels into unnecessary
mathematical notation. Its fragment edit counts can include that notation, so
they are not a clean character-accuracy comparison between OCR engines. The
complete earlier [MinerU source review](2026-09-09-beijing-ocr.md) remains the
reference for its broader strengths and defects; no new MinerU run was made.

## Actual production chunks and remaining gaps

The native reorder changes the five-page screening document from 18 to 19
production chunks. All original blocks and their original page/bounding-box
metadata survive unchanged. Reapplying the repair produces identical output.
Source pages here map to screening pages 1 through 5; chunk indices below are
zero based.

- Source page 3's continuous-calibration sentence now joins the left-column
  ending to `accelerometer output on an oscillograph...` in chunk 6. The original
  chunks do not contain that continuation together.
- Source page 5's explanation now joins `point of engagement of the pawl` to
  `C, with the seven-position ratchet...` in chunk 12. The original order reverses
  those parts.
- Source page 9's complete 800/350-cycles-per-second fragment is exact in chunk
  17, under `V. Comparison of Results`. It is absent as a complete sequence from
  the original chunks.
- Source page 1's abstract remains exact in chunk 1. Page 3's already-correct
  measurement fragment remains exact in chunk 5; its range fragment remains
  exact in chunk 8.

Page 4 review confirms that Figure 3 and Figure 4 captions now stay with their
left-column material before the Figure 5 traces and right-column prose. Existing
misspellings and the `.063` versus source `.053` caption error remain. Neither
native reorder nor OCR reconstructs the plots' relationships.

All three equations on source page 3 remain unresolved under the selected native
candidate. OCR recovers some symbols, but does not preserve all fractions,
subscripts, squares and associations. Recognizing `14.2g` or `m = 2M cos` does
not establish a correct formula. The source-review artifact flags these gaps;
no guessed formula or invented completion is inserted into chunks. MinerU's
second equation is better, but its first and third equations still have defects.

The small-fragment checks do not certify every word or every new adjacency.
Only one historical scanned document was tested. Preserve the narrow source
gate and verify more genuine OCR-layer documents before considering this a
general reading-order policy.

## Reproduction and reusable function

[experiment_odl_ocr_disagreement.py](../scripts/experiment_odl_ocr_disagreement.py)
contains the source gate, OCR experiment and replay. Its reusable entry point is:

```python
eligible_pages = {index for index, page in enumerate(pdf) if source_facts(page)["eligible"]}
blocks, decisions = recover_hidden_ocr_order(blocks, eligible_pages)
```

The helper only changes block positions for eligible pages with a supported
gutter and complete bounding-box metadata. Other pages stay exactly positioned.
It preserves all block contents and verifies idempotence internally.

```sh
python experiment_odl_ocr_disagreement.py prepare --root /data --output /output/r1 --checks /checks.json
python experiment_odl_ocr_disagreement.py ocr --output /output/r1 --models /models
uv run python -X utf8 bench/parsers/scripts/experiment_odl_ocr_disagreement.py replay --output bench/parsers/reports/local/2026-09-09-odl-ocr-disagreement/r1 --replay-output NEW_REPLAY_DIRECTORY
uv run python bench/parsers/scripts/experiment_odl_ocr_disagreement.py check
uv run --with ruff ruff check --isolated bench/parsers/scripts/experiment_odl_ocr_disagreement.py
```

`prepare`, `ocr` and `replay` require fresh output directories. The first two
commands run in the pinned Java image with the old corpus and model directories
mounted read only. Replay expects the saved `native.json`, `mineru.json`,
`source-fragments.json` and `heldout-fragments.json` beside `r1`. The focused
source-order/protected-page/idempotence checks and isolated Ruff check passed.

Local artifacts are under
`bench/parsers/reports/local/2026-09-09-odl-ocr-disagreement/`. They include
all source renders, hashes, frozen checks, OCR images/boxes/confidence/timings,
rejected midpoint crops, source-fragment alignments, saved comparator inputs,
`r1/replay-final/` content and production chunks, and final helper verification.
The executed OCR-phase snapshot and final helper snapshot are separate. VM
artifacts remain under `/opt/capy-odl-ocr-disagreement-20260909/r1`; later local
replays are local artifacts. The experiment container exited and was removed.
