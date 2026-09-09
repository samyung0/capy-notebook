# OpenDataLoader accuracy, second pass

The additional native repairs improve section context, scanned-page reading
order and several difficult tables. The unchanged font rule also succeeds on
another PDF. Fresh Java runs confirm that the earlier four repairs cost about
8% over baseline parsing and chunking on 254 pages. Adding source-based heading
and hidden-text ordering brings the final measured total to 27.92
seconds, versus 23.50 seconds baseline. No OCR or caption model is used by this
combined candidate.

The table geometry arm is promising but remains separate from that measured
candidate. It passes automatic replacement for seven of eight reviewed tables,
with an explicit abstention on the remaining Chinese table. These targeted
results do not establish general MinerU parity. Production code, provider
configuration and deployments remain unchanged.

## Results worth keeping

| Experiment | Source-based result | Boundary of the claim |
| --- | --- | --- |
| [Unchanged font-rule transfer](2026-09-09-odl-font-transfer.md) | A second paper improves from 0/66 to 66/66 exact numeric cells; all six numeric row sequences occupy one chunk. All 24 pages remain pixel-identical. | Two neighboring papers from the same publisher were selected before download. The rule selects one and abstains on the other. This is not independent validation across producers. |
| [Source-confirmed heading context](2026-09-09-odl-heading-context-experiment.md) | 12/12 section checks pass, up from 3/12. German chapter and subsection scope is correct on the checked passages; English/French continuations lose stale page-number headings. | Six original non-German controls, five German development checks and one later German development follow-up. Complete document outlines were not scored. |
| [Native order on existing OCR layers](2026-09-09-odl-ocr-disagreement-experiment.md) | NIST's 800/350-cycles-per-second comparison changes from an interrupted sequence to exact text in one chunk. Other checked column continuations join without changing characters. | One historical scanned document. Damaged OCR characters and all three checked equations remain unresolved. |
| [Source table geometry](2026-09-09-odl-table-geometry-experiment.md) | Attention preserves exponents and shared training costs; four Hong Kong tables preserve complete rows, headers, years and units. Revised COT geometry preserves SDS/MDS row groups. | Integration uses eight deliberately reviewed tables. The other accepted source regions have not received complete precision review. COT became development data after its first transfer failure. |

The font rule has now audited ten intact documents, 299 pages, and selected
two contradictory Latin fonts. The other eight documents remain unchanged by
font repair. This narrow rule is still the clearest improvement because the
embedded glyph names supply exact replacement evidence independently of OCR.

## Fresh combined parsing measurements

[measure_odl_native_pipeline.py](../scripts/measure_odl_native_pipeline.py)
processes the original eight PDFs, 254 pages, from unchanged source bytes in
every run. Each document gets a fresh Java process. The runner then applies the
chosen native repairs, adapts content and produces actual document chunks.

| Arm | Three observed seconds | Median | Chunks |
| --- | --- | ---: | ---: |
| Baseline Java, adaptation and production packing | 23.504, 23.566, 23.143 | 23.504 | 973 |
| Four earlier repairs | 25.617, 24.869, 25.374 | 25.374 | 1,049 |
| Also heading context and hidden-text column order | 31.705, 30.988, 31.101 | 31.101 | 1,048 |
| Same output, omit unused embedded image payload during heading inspection | 32.357, 32.007, 31.236 | 32.007 | 1,048 |
| Final candidate, also skip disjoint source boxes before overlap calculation | 27.923, 28.503, 27.240 | 27.923 | 1,048 |

The earlier four repairs add 1.87 seconds to the median, about 8%. The expanded
candidate adds 4.42 seconds with the final source reader, about 19%. Its outputs
are exactly identical to both preceding expanded arms.
Skipping embedded image payload did not reduce observed elapsed time; it must
not be described as a measured latency improvement.

Profiling then found that most span-intersection calculations compared unrelated
boxes. A small prefilter skips clearly disjoint positive-area spans before the
unchanged 60% PyMuPDF overlap test. Empty and inverted spans keep the prior
behavior. Local source inspection over 167 pages falls from 2.971 to 0.968
seconds in three alternating pairs. On the VM, the median heading phase falls
from 4.124 to 1.370 seconds over 254 pages. The final complete-candidate runs
also reproduce every source-evidence record and chunk.

All runs execute sequentially in the existing
`capy-java-native:20260909` image on the ingest VM, capped at eight CPUs and
14 GiB memory with network disabled and no published ports. The image contains
OpenDataLoader 2.5.7, PyMuPDF 1.28.2 and pypdf 6.18.0. Baseline/native order is
counterbalanced across pairs; the expanded variants run afterward. There are
three observations per arm, not a statistical latency certification. Filesystem
and OS caches are not flushed.

The total includes Java startup/extraction, optional source audit and temporary
font repair, adaptation, source inspection, one final chunk pass, diagnostic
artifact writes and sampler shutdown. The common conversion helper also writes
an initial adaptation before the chosen adaptation. Imports, source hashing
and provenance snapshots occur before the timer. This is a native-core benchmark,
not an application ingest latency. OCR, Qwen captions, embeddings, indexing,
network queues and retrieval are excluded. No new matched MinerU run was made.

Sampled cgroup memory stays below 0.71 GiB across these runs and no swap is
observed. Resource CSVs retain the measurements. Source flags, repair receipts,
phase timings, runtime versions and exact code snapshots accompany every run.
Image payloads remain in the complete VM outputs; compact local archives of the
expanded runs omit image files, while the baseline/native local archive is full.

## What survives in actual combined chunks

All three runs of every arm produce identical content and chunk hashes. The
fresh four-repair outputs also exactly match all eight previously reviewed
combined-replay chunk files. The expanded candidate preserves every native
block field except the intended heading levels and block order, including
table values, style annotations, page numbers, citation boxes and native IDs.

The executable [combined scorer](../scripts/score_odl_native_pipeline.py)
checks the saved artifacts rather than inferred parser quality:

- All twelve section checks pass on actual expanded chunks, including every
  overlapping copy of each checked passage.
- The earlier Chinese 64-value chunk remains exact in chunk 39.
- All 48 Japanese rows and 384 native numeric cells retain their headers,
  2025 title and person unit. All eight complete source-transcribed rows pass.
- The French table retains all 49 values, fifteen yellow annotations and its
  significance caption together in chunk 24. Surrounding prose is repacked;
  the claim concerns the complete table and caption.
- Both earlier German column continuations remain together in chunks 5 and
  116 with their original source regions.
- NIST's source-page-9 frequency comparison is exact in full-document chunk
  30. Its source-page-1 abstract and source-page-3 measurement/range fragments
  remain exact. The full-document source gate changes order on ten NIST pages
  and none of the other seven documents; only the five screening pages received
  the detailed source review described in the OCR report.

Indices are zero based and belong to these saved full-document outputs. The
NIST report's different indices refer to its five-page screening document.

NIST's distance-D fragment remains split across chunks in both full-document
arms, with the same one-character defect in the raw text. Joining overlapping
chunks gives 25 versus 26 fragment edits because the boundary repeats text.
The scorer retains those values separately from raw-text accuracy and
single-chunk checks. It does not count this passage as repaired.

## Useful failures

RapidOCR fixes some real NIST errors, including `M1`, release wire `G` and
distance `D`. It also damages already-correct prose. A selective replacement
with 99.75% mean recognition confidence corrects `lor` to `for` while changing
`Aeronautics` to `Aeronauties`. Confidence and disagreement are insufficient to
choose the correct transcription, so automatic OCR replacement is rejected.
The tested small probes also miss equation defects elsewhere on a page.

The first frozen geometry transfer got COT's 66 values and eleven numeric
headers right but failed SDS/MDS row scope. A later source-rowspan rule repairs
that failure. Its success is development evidence, with the earlier failed
transfer preserved. The clean children-document table was already readable in
baseline chunks and counts as a control, not a new accuracy gain.

CCL's geometry reconstruction recovers the original table's nested headers,
64 values and eight bold cells. Automatic replacement still abstains because
two native watermark blocks partly cross the table boundary. Only the separate
manual-override arm replaces those blocks. Seven of eight reviewed tables
therefore integrate automatically; eight of eight require that override.

Hong Kong exposes a downstream interaction. Replacing its page-13 tables changes
document-wide furniture frequency and reintroduces the literal note label in
two later chunks. Other native blocks, text and section paths are preserved.
This prevents claiming that every outside-page chunk is unchanged. The geometry
report also records a corrected source-transcription asterisk separately from
candidate accuracy.

## Next evaluation

Keep the narrow font repair and source-confirmed order/context rules in the
candidate. For table geometry, score every accepted region in a genuinely new
set of ruled numeric tables before enabling automatic corpus-wide replacement.
Source watermark separation and stable furniture handling are the remaining
integration work exposed by this run.

NIST still needs a way to select genuinely better OCR for damaged prose and
equations. The present tests do not justify automatic replacement, and visual
descriptions still depend on captioning. Qwen settings and the earlier caption
plan were not rerun or tuned in this pass.

## Evidence and reproduction

The linked lane reports retain source hashes, frozen check timing, failed arms
and reproduction commands. New raw directories under
`bench/parsers/reports/local/` end in `odl-font-transfer`, `odl-heading-context`,
`odl-ocr-disagreement`, `odl-table-geometry` and `odl-native-measured`.

VM measurement artifacts are at `/opt/capy-odl-native-measured-20260909`.
The measured source is mounted as `/source` and a runtime snapshot as `/eval`:

```sh
python /eval/bench/parsers/scripts/measure_odl_native_pipeline.py /source /eval/NEW_OUTPUT --variant extended
uv run --with pymupdf==1.28.2 python -X utf8 bench/parsers/scripts/score_odl_native_pipeline.py bench/parsers/reports/local NEW_VERIFICATION.json --extended-prefix extended-prefilter
```

Use the default scorer prefix `extended` to inspect the first expanded arm.
Use the recorded code snapshots to reproduce historical timing arms; current
source excludes embedded image payload and prefilters disjoint span boxes.
The scorer verifies actual artifact hashes, repeat identity, source conservation
and all listed combined checks. `verification.json` and
`verification-textonly.json` retain the earlier results; `verification-prefilter.json`
records the final candidate. Profiling, before/after source snapshots and local
equivalence checks are in `heading-optimization/` within `odl-native-measured`.

An independent Astra-high reviewer reproduced the font audit and pixel checks,
heading and OCR replays, geometry extraction and strict/manual integration,
and checked the combined results and timing claims. The final review and
aggregate source/evidence manifests are under
`bench/parsers/reports/local/2026-09-09-odl-accuracy-second-pass/`. The manifest
binds 3,374 raw evidence files and 29 source/documentation snapshots. Complete
experiment outputs remain available on the VM.
Focused checks, isolated Ruff checks and `pnpm run fmt:py` pass. Experiment
containers exit after each run, with artifacts retained on the VM.
