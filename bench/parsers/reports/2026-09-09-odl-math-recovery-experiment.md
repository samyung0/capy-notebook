# Selective formula recognition and independent OCR consensus

Selective MinerU layout and formula recognition recovers six of seven complete
source expressions in the full 11-page NIST accelerometer scan. All six survive
actual production chunking with citations covering the formula image. The
335-page source sweep admits 19 scanned pages and leaves the other 12 documents'
content and chunks exact. The full model work takes 55.032 seconds on the CPU VM.

The first frozen replacement guard fails on a short definition, changing a
correct `M3` to `M8`. A subsequent local guard refinement preserves that source
text while retaining the six recovered expressions. That refinement is a
development result. The independent shot-classifier scan gains no formulas.

This is a MinerU layout-and-formula recovery arm. No production parser,
deployment, provider setting, or original artifact was changed. No Qwen request
was made.

## Sources and experiment order

The development source is the original historical NIST *Calibration of
Accelerometers* scan. Its earlier five-page screening PDF contains original pages
1, 3, 4, 5 and 9. The complete equations and their variable relationships were
visually transcribed before inspecting new recognition outputs. The six earlier
prose fragments and two within-document held-out fragments were retained from
the [existing-OCR experiment](2026-09-09-odl-ocr-disagreement-experiment.md).

The independent source is the eight-page NIST *Studies of the Mattson Shot
Classifier*. It was selected and downloaded by the parent experiment before
candidate parsing. This lane froze the five small formula footnotes below table
5 and three associated prose fragments on original pages 5 and 7. Those source
pages differ from the parent's independent table rubric. Formula bars, roots,
powers, subscripts and grouping matter; recognizing a constant or isolated
symbol is insufficient.

The first formula round used manually reviewed source crops to measure
recognition with a correct region. These are explicitly oracle crops. The next
round used unchanged installed PP-DocLayoutV2 detection on every page admitted
by the previously tested source gate: at least 100 extracted characters, at
least 90% invisible characters, and a raster covering at least 90% of the page.
Detector results, zero/3-point-margin crops, raw model output and timings are
saved separately. A later full-document sweep freezes this developed rule before
examining the six remaining accelerometer pages.

## Installed alternatives and results

The isolated images already contained all dependencies and models. The
OpenDataLoader hybrid server supports forced OCR, selectable EasyOCR/RapidOCR
engines and formula enrichment. Its installed CodeFormulaV2 enrichment model
was called directly on the same formula crops. The second mathematical family
was MinerU's PP-FormulaNet_plus-M. This avoids running a standalone Docling
parser while testing the existing ODL enrichment capability. EasyOCR's English
recognizer and CRAFT detector provided a separate prose recognition family from
RapidOCR's PP-OCRv6 models.

| Recognition strategy | Complete development equations | Finding |
| --- | ---: | --- |
| Native ODL with existing order repair | 0/3 | Equations 1 and 3 missing; equation 2 damaged |
| PP-FormulaNet, oracle crops, 144 dpi | 3/3 | Complete source expressions correct |
| PP-FormulaNet, oracle crops, 288 dpi | 0/3 | Changes variables, denominator punctuation, Greek symbols and powers |
| ODL CodeFormulaV2, oracle crops, 144 dpi | 0/3 | Includes `a`→alpha, wrong cosine text and extra hats/subscripts |
| ODL CodeFormulaV2, oracle crops, 288 dpi | 0/3 | Further structural and symbol errors |
| PP-FormulaNet, automatic crops, 144 dpi, no margin | 3/3 | Transfers the oracle result to detected regions |
| PP-FormulaNet, automatic crops, 144 dpi, 3-point margin | 3/3 | Exact whitespace-normalized agreement with the no-margin results |

Larger raster dimensions are not a dependable quality improvement on these
scans. The successful 144-dpi recognitions preserve the complete fractions,
subscripts and squares. Neither model's output was completed with a source
rubric or a guessed physical formula.

Detection also labelled the variable-definition paragraph as a displayed
formula. Both crop margins produced the same wrong spelling, `frequenery`.
Agreement is therefore not proof of correctness. The first developed replay retains
native regions containing at least six alphabetic words of three or more
letters. This protects the definition paragraph. That guard was chosen after
the development output was reviewed, then frozen for the remaining-page sweep;
it is not an independent validation result.

## Prose consensus

Twelve native paragraphs on the screening pages were cropped at both 144 and
288 dpi and recognized by RapidOCR and EasyOCR. The frozen consensus rule only
permits one-to-one word substitutions where both engines at both scales agree,
keeping native punctuation and geometry. None of the twelve paragraphs met
that condition. Three independent source fragments also produced no accepted
substitutions. The conservative arm has no demonstrated prose improvement.

RapidOCR correctly reads several damaged mass/wire/distance labels, but the two
scales also consistently turn the already-correct `Aeronautics` into
`Aeronauties`. EasyOCR's transcriptions of this scan are substantially worse
and do not supply useful confirmation of the desired corrections. Thus a
same-engine two-scale vote would still accept a known regression, while the
independent-engine rule abstains. These are different selection/recognition
tests from the previously rejected confidence-only replacement.

A further local replay allowed word positions within equal-length replacement
spans instead of requiring a singleton span. It selects exactly one correction,
the distance label `I` to `D`, from agreement among all four saved recognitions.
The eight development fragment scores improve only for that distance sentence,
from one normalized edit to zero, and the three independent fragments admit no
changes. The old extra closing parenthesis remains. This is an exploratory
selection refinement, recorded in `balanced-consensus-local/`, and is separate
from the frozen full formula sweep. It is not implemented in the selected helper.

On the independent shot-classifier fragments, native normalized edit counts are
2, 0 and 3. RapidOCR at 144 dpi gives 8, 3 and 2; at 288 dpi, 21, 2 and 1.
EasyOCR gives 35, 13 and 31 at 144 dpi, then 47, 20 and 49 at 288 dpi. These
counts compare small source fragments with a contiguous transcription substring;
they are not full-page accuracy percentages. The native zero-edit diameter-ratio
fragment is harmed by all four fresh OCR variants. The consensus arm preserves
it.

## Screening document's actual chunks

The selected screening replay has 19 production chunks, the same count as its
order-repaired baseline. It inserts two missing formula blocks and replaces only
the source-aligned damaged equation-2 substring. Every other original native
dictionary, text and geometry remains exact. Reapplying the recovery produces
identical output. Different PDFs are rejected by source hashes; a digital source
fails the OCR-layer gate; disagreeing crop predictions abstain.

- Equation 1 is complete in chunk 5, followed by its original equation number
  and variable-definition text.
- Equation 2 is complete in chunks 5 and 6, with the original `(2)` retained.
- Equation 3 is complete in chunk 6 beside its initial-frequency/coasting
  discussion and the original equation number.
- All eight frozen prose fragment scores and their exact-chunk matches are
  unchanged, including the previously repaired page-9 frequency paragraph.

Existing prose defects remain: the variable `S` in the definition paragraph is
still `$`, the prose angle theta is still `6`, and the initial-frequency prose
contains damaged `S_0` text. Equation 1's existing label remains `(i)`. Complete
formula recovery does not certify complete mathematical exposition.

## Independent scan limit

The detector finds no displayed formulas on any of the eight shot-classifier
pages. The five small mathematical footnotes also fail direct PP-FormulaNet
recognition at both tested scales. Some expanded crops include adjacent formula
lines; these failures cover both crop isolation and recognition limits. They do
not justify calling the source mathematics absent.

Fresh whole-document ODL baseline and extended output have 37 and 39 chunks.
The three frozen prose checks have the same edit counts under both outputs,
4, 0 and 3. The diameter-ratio fragment is exact in baseline chunk 30 and
extended chunk 31. The difference from the earlier source-text definition count
comes from ODL's further extraction damage. With no detected formula records,
the hybrid helper preserves both native documents exactly. The five footnote
formulas remain unresolved.

## Full sweep and failed frozen guard

Before the remaining six accelerometer pages were tested, the source gate,
detector, 144-dpi recognizer, two crop margins and initial prose guard were frozen
in `full-sweep-protocol.json`. All seven complete expressions and their source
relationships were frozen in `full-formula-checks.json`. Those pages were reviewed
from source before the full detector or recognizer output was inspected.

The fresh VM sweep audits all 335 pages across 13 documents. Only the 11
accelerometer pages and eight shot-classifier pages pass the hidden-OCR source
gate. The other 316 pages include English and multilingual digital controls.
The unchanged detector returns nine regions, producing 18 formula calls.

| Eligible source pages | Detected regions | Source-reviewed outcome |
| --- | ---: | --- |
| Accelerometers 1, 2 | 0 | No displayed-equation recovery |
| Accelerometers 3 | 4 | Equations 1, 2 and 3 correct; definition paragraph has an OCR typo |
| Accelerometers 4, 5, 6 | 0 | No displayed-equation recovery |
| Accelerometers 7 | 4 | A-squared and B-squared correct; equation 4 has a wrong mass subscript; one short definition also has a wrong subscript |
| Accelerometers 8 | 1 | Equation 5 correct |
| Accelerometers 9, 10, 11 | 0 | No displayed-equation recovery |
| Shot classifier 1, 2, 3, 4, 5, 6, 7, 8 | 0 | Five frozen footnote formulas remain missed |

Both crop margins agree exactly after whitespace removal for every region,
including the incorrect ones. Equation 4 changes its denominator's first `M3`
to `M2`; the existing unique native-text alignment requirement rejects it.
The short definition `d=initial deflection of M3` is more dangerous. Its native
text aligns, but the model changes `M3` to `M8`, and the frozen six-word prose
guard permits replacement. `full-replay-r1/` preserves that failed arm. It also
converts the already-correct acceleration definition into unnecessary LaTeX.

The local refinement protects any native region containing an alphabetic word
of at least four letters. This rejects both short definitions and the earlier
definition paragraph. It retains the five selected regions containing six
complete expressions. The new guard was chosen after the failure, so the
remaining-page test is development evidence for this guard. It has no new
independent positive validation. Detector and recognizer functions remain
identical to the frozen versions. The rule does not read expected expressions
or select named equations.

## Full document chunks and source citations

The final replay is `full-replay-v3/`. It uses the exact saved native content
and source bindings in the frozen 13-document protocol, then runs the real
bounded native production chunker. The baseline reproduces the canonical saved
chunks exactly before recovery. This is an offline composition with previously
measured ODL output; it is not a newly timed whole-parser run.

The accelerometer document remains at 37 chunks. Three missing formula blocks
are inserted and two original formula substrings are replaced. All other
original blocks and geometry remain exact. Every other document's content and
chunk objects are unchanged, including the independent scan. All eight frozen
accelerometer prose checks retain their previous scores. Recovery is idempotent,
and records tied to another source PDF are rejected.

| Complete source expression | Final zero-based chunk indices | Result |
| --- | --- | --- |
| Equation 1, original page 3 | 9 | Correct |
| Equation 2, original page 3 | 9, 10 | Correct |
| Equation 3, original page 3 | 10 | Correct |
| Equation 4, original page 7 | None complete | Unresolved; wrong model subscript rejected |
| A-squared definition, original page 7 | 22 | Correct as printed |
| B-squared definition, original page 7 | 22 | Correct as printed |
| Equation 5, original page 8 | 28 | Correct |

The A-squared and B-squared expressions preserve the source's printed grouping,
including the radical outside the preceding factor. No physical or dimensional
correction was inferred. Equations 1 and 5 have the same formula shape but
different source meanings for `S` and `D`; scoring is scoped to the original
page, and each equation retains its surrounding native context.

Two damaged native OCR boxes covered only part of the restored equation.
The final helper expands those two boxes to include the detected formula region.
Inserted formulas use the detector's source coordinates. The actual final chunk
citation regions now fully contain all five selected regions on the correct
source pages. `full-verification-v3.json` records their coordinates, chunk
indices, exact original edits and conservation checks. The intermediate
`full-replay-v2/` keeps the prior, under-covered citation result for inspection.

Unrepaired mathematical prose and inherited damaged heading metadata remain.
The short native `M2` and `M3` definitions are preserved, but this lane does not
claim that all variable relationships are transcribed correctly.

## Composition with the latest native refinements

The same saved model records were subsequently applied to both fresh refined
native variants. Each replay reproduces that variant's stored NIST baseline
chunks before recovery, then uses bounded native chunking and heading retention
for the changed document. Other documents retain their original content and
chunk files byte for byte. No model was called again.

| Native input | Hybrid artifact | NIST chunks before/after | Complete expressions |
| --- | --- | ---: | ---: |
| `refined-cluster-r1` | `composed-hybrid-r1` | 36 / 36 | 6/7 |
| `refined-nofooter-r1` | `composed-hybrid-r2` | 34 / 34 | 6/7 |
| Selected `refined-final-r1` | `composed-hybrid-final` | 36 / 36 | 6/7 |

Both compositions preserve the native paragraph-role fixes on original pages 4
and 5, including each opening and its following text in the actual chunk body.
All eight prose checks remain unchanged, the other 12 documents remain exact,
and recovery is idempotent. The same five selected source regions are fully
covered by their final chunk citations. Only the two original formula
substrings and their citation boxes change; three formula blocks are added.

For the variant omitting headers and footers, final zero-based chunk indices
are 8 for equation 1, 8 and 9 for equation 2, 9 for equation 3, 19 for both
A-squared and B-squared, and 25 for equation 5. Equation 4 remains unresolved.
These indices differ from the earlier canonical extended replay above because
the native input and its section structure changed.

Both complete replays are under `reports/local/2026-09-09-odl-third-pass/`.
Each retains the source/model/input hashes, per-document outputs and decisions,
actual citation receipts, paragraph continuation checks and a command snapshot.
The first attempt used an incomplete local source-path assumption and is
retained as `composed-hybrid-path-attempt`; the completed runs resolve the
previously frozen exact-source manifest. Local replay and verification took
5.471 and 4.937 seconds respectively. The previously measured 55.032-second
model component remains separate; neither composition is a fresh integrated
native-plus-model latency measurement.

The final selected native configuration retains headers and footers, propagates
explicit footer ancestry and includes the reviewed heading-presence fix. The
variant omitting headers and footers above is retained as a rejected global
experiment. `composed-hybrid-final/` is the final hybrid composition artifact.
Its source hashes and NIST native content/chunks exactly match the earlier
`refined-cluster-r1` NIST input. The local replay reran formula, citation,
conservation and prose checks against the fresh final base and reproduced the
earlier hybrid NIST output byte for byte. The other 12 documents are byte-exact
copies of the final native output. Both native and hybrid corpora have 1,401
chunks, including 36 for NIST. Final NIST formula indices are 9, 9/10, 10, 21,
21 and 27 for equations 1, 2, 3, A-squared, B-squared and 5 respectively.

Final replay and verification took 4.219 seconds locally. It made no model
calls. `final-identity-verification.json`, `verification.json`,
`paragraph-chunk-verification.json`, `replay-provenance.json` and the preserved
command bind these results to the selected native run and the original model
outputs. The 55.032-second model cost remains a separate component measurement.

## Matched MinerU formula comparison

The parent's fresh 335-page MinerU run provides a same-source comparison for
the seven frozen accelerometer expressions. Manual source review finds two
complete expressions correct, equations 2 and 5. Equation 1 changes Latin `a`
to Greek alpha. Equation 3 adds bars, hats and a spurious star and changes a
subscript. Equation 4 uses `M0` where the source has `M3`. The A-squared radical
and B-squared prefactor each contain an incorrect `M5`.

The selective hybrid therefore has six of seven correct on these specific
checks, versus two of seven for the matched full MinerU output. This is a
formula-subset result. It is not a whole-document parser ranking. Raw MinerU
blocks, their indices and hashes are retained in `mineru-full-source-review.json`.
The matched MinerU output also gets none of the five frozen shot-classifier
footnote expressions completely correct. Its table footnotes lose or change
summation symbols, bars, powers, subscripts and the cube-root index. Both parsers
therefore leave that independent mathematical subset unresolved.

## Measured component cost

All model jobs ran sequentially with eight CPU cores, 14 GiB memory and network
access disabled on the ingest VM. Package versions and model SHA-256 values are
in each run's `run.json`. The initial component timings below exclude the full
ODL parse and interpreter/container startup.

| Phase | Calls | Inference | Model construction |
| --- | ---: | ---: | ---: |
| Development PP-FormulaNet oracle crops | 6 | 5.543 s | 12.585 s |
| Development CodeFormulaV2 oracle crops | 6 | 45.604 s | 5.283 s |
| Independent PP-FormulaNet oracle crops | 10 | 26.148 s | 12.142 s |
| Automatically detected PP-FormulaNet crops | 8 | 13.121 s | 12.475 s |
| Development RapidOCR prose crops | 24 | 10.512 s | 0.504 s |
| Development EasyOCR prose crops | 24 | 16.147 s | 4.288 s |
| Independent RapidOCR prose crops | 6 | 2.656 s | 0.540 s |
| Independent EasyOCR prose crops | 6 | 5.424 s | 3.858 s |

The first detector sweep audits 48 pages, admits 13 historical-scan pages and
rejects 35 digital pages. Its complete measured phase takes 5.919 seconds,
including 0.379 seconds of model construction. The six successful automatic
equation-crop calls take 5.814 seconds; the two rejected definition calls account
for the remaining 7.307 seconds. This saving has not been measured as an
integrated pre-recognition gate. Cold model construction is material; a warm
selective service would have a different cost profile.

The final full sweep also measures complete Python-process work with Linux
`getrusage`, including imports, model construction, source audit, inference and
artifact writes. It excludes container creation, ODL parsing and local chunk
replay.

| Full sweep process | Wall time | Peak resident memory |
| --- | ---: | ---: |
| Audit all 335 pages, layout on 19, render 18 crops | 14.423 s | 993.6 MiB |
| Recognize all 18 formula crops | 40.609 s | 2993.2 MiB |
| Sequential total | 55.032 s | 2993.2 MiB maximum |

Within the recognition process, model construction takes 12.661 seconds and
inference takes 27.038 seconds. The detector's measured phase takes 10.430
seconds, including 0.224 seconds of model construction. These totals include
the rejected definition crops; no assumed pre-recognition saving is subtracted.
The final local replay spends 0.306 seconds in the recovery helper across all
13 documents and 9.142 seconds including diagnostic chunking, scoring and I/O.
Those local times are not VM ingest timings. The 55.032-second model cost is an
additive component measurement, not measured end-to-end ODL-plus-model latency.

## Reproduction and artifacts

The runnable implementation is
[experiment_odl_math_recovery.py](../scripts/experiment_odl_math_recovery.py).
It supports `prepare`, `detect`, `recognize`, `replay` and `replay-full`, with fresh output
directories. The reusable `recover_formulas` helper consumes raw detected-crop
predictions bound to the exact source PDF SHA. All formula checks are evaluation
inputs; the helper never reads them.

Artifacts are under
`bench/parsers/reports/local/2026-09-09-odl-math-recovery/` and the isolated VM
directory `/opt/capy-odl-math-recovery-20260909/`. `frozen-checks.json`,
`holdout-checks.json`, source PNGs, jobs, raw outputs, model provenance and
timings remain separate. `replay-verified/` is the final screening replay;
`verification.json` records content conservation, source binding, idempotence,
negative-source rejection and focused consensus checks. The earlier
`replay-final/` is retained as a development replay. Isolated Ruff lint and
format checks pass.

The final API is `recover_formulas(blocks, pdf, records)`, returning a new block
list and per-region decisions. Pass the source `Path` and this document's raw
recognizer records. It verifies source hashes, the hidden-OCR source gate,
matching crop margins, prose protection and unique native-text alignment.
Use fresh output storage for the full replay:

```powershell
uv --native-tls run --with pymupdf==1.28.2 python -X utf8 bench/parsers/scripts/experiment_odl_math_recovery.py replay-full --root bench/parsers/reports/local/2026-09-09-odl-math-recovery --output FRESH_OUTPUT_DIRECTORY
```

Final script SHA-256 is
`0e68204da20903d671704d726b47f5f874da91297d88a33aed65e6d5fb11eaf8`.
The fresh VM detection and recognition executed frozen script SHA
`24052165ba4e98e9d887d9d8a50adbfb3d406776073c7b20c31b94c73ff62b4b`.
`frozen-function-hashes.json` and `full-verification-v3.json` confirm that the
inference functions did not change. The later helper changes are the prose guard
and citation expansion described above, plus full replay verification.

Full VM stages are `results/detected-full335/`, `results/formula-full335/` and
`results/full335-{detect,formula}-process.json` beneath the isolated directory.
Their local copies omit the `results/` prefix. `source-review-full.json` covers
all 19 eligible pages and every recognized region. `full-replay-r1/`,
`full-replay-v2/` and `full-replay-v3/` retain the failed and corrected arms.

`full-sweep-executed-commands.txt` records the successful commands, with the
measurement wrapper preserved as `measure-process.py.snapshot`. The earlier
`full-sweep-commands.txt` is retained as an attempted command: `/usr/bin/time`
was absent on the VM and the initial script had CRLF line endings. That attempt
exited before inference. The successful commands used LF and a Python standard
library measurement wrapper. Original corpus and model mounts were read-only.
