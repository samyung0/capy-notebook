# OpenDataLoader versus MinerU for Capy

Completed September 8, 2026. Artifacts verified and benchmark containers removed.
No parser deployment changed.

The completed quality evidence favors keeping MinerU as Capy's default parser.
Java-only OpenDataLoader is much faster for embedded text, but loses scans,
some table relationships and vector figures. Its automatic hybrid routing
does not reliably repair the scan problem. Sending every page through RapidOCR
recovers more content, with weaker table and formula extraction and only a
small speed advantage on the intact multilingual corpus. Hybrid output also
assigns unrelated figures to reused image filenames. Embedded output has the
same defect. Four hybrid workers use more memory and swap, with about half
MinerU's digital throughput and similar scan throughput on the capacity fixtures.

## Method and scope

The experiment runs on the idle ingest VM, `159.195.61.195`, with eight AMD
EPYC 9645 vCPUs, about 15 GiB RAM, 24 GiB host swap and no GPU. Each parser
container is limited to eight CPUs, 14 GiB RAM and 28 GiB combined RAM/swap.
Competing configurations run sequentially. Existing data and production model
caches are untouched; test copies live under `/opt/capy-parser-eval-20260908`.

The baseline is MinerU 3.4.5, CPU pipeline, with Capy's current adapter,
`lang=ch`, tables and formulas enabled, and 26-page slices. The retained image
is `sha256:f891c36a6ed55f165672f8ce1ca290a1d8f9af2650f04cbf0138a697e7572843`.
The candidate is OpenDataLoader 2.5.7 with its bundled hybrid backend,
Docling 2.126.0, EasyOCR and RapidOCR 3.9.2. Its image is
`sha256:d8911cfa483a2110eb912461173f6ff495e0881f52ffc82d898f2ba90a970484`.
Standalone Docling, Marker and MarkItDown are excluded.
The measured OCR choices are EasyOCR and RapidOCR. Tesseract, GPU/hosted VLMs
and picture-description generation are outside this comparison. Figure
inspection tests the crops that Capy's separate captioning path would receive.

The frozen corpus has 23 original inputs. Twenty-two ordinary documents total
430 pages; a separate biology textbook has 610 pages. The 64-page screen uses
30 cases: selected pages from those ordinary documents and eight matched
raster versions. It covers English, German, Spanish, French, Japanese,
simplified/traditional Chinese, Office previews, tables, equations and graphs.
The 430-page set includes 82 pages of synthetic slide fixtures and four pages
of Office canaries. It is a diagnostic corpus, not a sample of production traffic.
The synthetic newspaper scan has clipped lines in the source itself; probes
use the visible text. Office canaries on the VM say `EVO`, unlike today's
fixture generator. Every parser receives the same frozen PDF bytes.

The source checks are targeted probes, not a representative accuracy score.
They test visible phrases on their expected source page, values grouped in a
structured table row, and one three-column reading-order example. Matching
normalizes case, Unicode compatibility forms, punctuation and whitespace.
The evaluator also runs Capy's actual 400-token chunker with 50-token overlap
and its 130-by-130-pixel, duplicate-aware figure selection. It makes no caption,
embedding or answer-generation calls. Surviving answer evidence is necessary
for retrieval, but does not establish end-to-end RAG quality.

Timing is wall time for conversion, artifact writes and the small experimental
adapter. Office normalization and model downloads occur beforehand. Each
screen configuration warms up before measured documents. Candidate conversions launch
a JVM per document, matching independent upload jobs. The initial Java runs use
two page threads; separate one-thread controls check the native default. Its
wrapper describes parallel page processing as experimental, with possible output
variation. Hybrid mode ignores this flag and uses its separate CPU backend.
The main runs set OMP, MKL and OpenBLAS thread limits to two. The installed
hybrid backend also passes that setting to RapidOCR's ONNX intra-operation
thread limit. Separate eight-thread controls test CPU allocation per worker.
Memory measurements sample the container cgroup, including charged file cache,
every 250 milliseconds. They are not model RSS. Short peaks can be missed.
OpenDataLoader uses its default 144 DPI image export. Caption-selection counts
depend on export resolution and exact-byte deduplication as well as which
figures are detected; no image-resolution sweep is claimed.
Full/long runs omit warmup and include lazy model loading; hybrid server readiness
is recorded separately and excluded from conversion time. MinerU uses Capy's
shared-model thread lanes, with the first model load serialized. Capacity runs reuse warm workers and measure
one or four independent 26-page conversions, bypassing HTTP, deduplication and
ingest queues. No mixed-size endpoint load is claimed.
The native long OpenDataLoader request sends 50-page batches sequentially to
one backend. A separate configuration divides the input into Capy's 26-page
units and sends them to four independent backends, all within the same container
resource limit. One backend with four callers is also tested, because the
backend serializes requests; it is not equivalent to four active model workers.

## Completed configuration screen

These are 30-case, 64-page passes. Time is the sum of measured conversion
seconds; model downloads, language-specific server startup and warmup are
excluded. The 57 checks comprise 37 text phrase checks, 19 structured table-row
checks and one reading-order check. They reuse 44 unique probes across native
and raster conditions. Every configuration below completed all 30 cases.

| Configuration | Seconds | Peak cgroup GiB | Raw text /37 | Raw rows /19 | Chunk checks /57 |
| --- | ---: | ---: | ---: | ---: | ---: |
| MinerU auto | 322.7 | 5.73 | 33 | 19 | 49 |
| MinerU txt | 320.4 | 3.05 | 34 | 19 | 50 |
| MinerU ocr | 404.0 | 3.08 | 34 | 19 | 50 |
| OpenDataLoader Java | 33.5 | 0.38 | 22 | 8 | 30 |
| Java, cluster tables | 35.0 | 0.35 | 22 | 11 | 33 |
| Hybrid auto, OCR off | 108.9 | 2.37 | 21 | 10 | 31 |
| Hybrid auto, RapidOCR | 144.3 | 3.21 | 22 | 10 | 32 |
| Hybrid auto, language-aware EasyOCR, completed rerun | 311.8 | 4.97 | 21 | 10 | 31 |
| Hybrid full, RapidOCR | 271.0 | 4.42 | 33 | 12 | 42 |
| Hybrid full, explicit-language RapidOCR | 267.1 | 3.68 | 33 | 12 | 42 |
| Hybrid full, language-aware EasyOCR | 832.5 | 7.01 | 26 | 10 | 33 |
| Hybrid full, forced RapidOCR | 249.6 | 4.19 | 32 | 13 | 43 |

Full routing means all pages visit the backend; it does **not** mean OCR is
forced on embedded text. Forced-OCR variants and language-aware RapidOCR are
separate controls. The initial auto/EasyOCR setup pass is excluded because five
cases lacked required language model files. The completed rerun above uses the
downloaded models and succeeds on all 30 cases.
Formula enrichment exceeded the 600-second execution budget on a two-page
Chinese document after two other cases completed. That incomplete pass is not
an accuracy denominator or a throughput result.
The formula model had initialized during warmup; the timeout occurred in
Transformers inference on three CPU image crops with a 2,048-token ceiling,
not while downloading or loading its weights.
An initial full-corpus MinerU pass used the wrong executor: separate model
processes stalled while shutting down their nested render pools. It was stopped,
marked invalid and excluded. The corrected pass uses Capy's shared-model threads.
This was a benchmark-harness error, not evidence of a production parser failure.
The forced-EasyOCR pass was pruned after three completed CJK cases: its Chinese
raster control retained only 21 text characters across two pages. The unfinished
fourth case is explicitly marked `stopped_by_experiment`, not a parser timeout.
MinerU's `txt` path still recognizes the raster controls; it is not an OCR-off
switch in this version. The smaller later MinerU cgroup totals do not establish
a memory saving from changing modes: charged file cache depends on run history.

MinerU and full-route RapidOCR both preserve 30/37 text probes through the
chunker. Ignoring table structure and order, generic answer-anchor presence
in eligible chunks is 49/57 for MinerU and 48/57 for full-route RapidOCR.
That weaker diagnostic shows why the row result must stay distinct: words and
numbers can survive while their relationships are wrong. Full-route RapidOCR
shifts the hominid table's brain-size values into adjacent species rows and
flattens the XLSX canary into prose. This is not a general 49-versus-42 RAG score.
The three common raw-to-chunk failures are artificial newspaper marker-plus-title
checks. Both parsers emit the marker and article title as sibling headings;
Capy's chunks retain the article title in their section path but omit the earlier
marker. The article body remains. These failures do not demonstrate lost article
answers, and none of MinerU's 19 passing table-row probes is lost by chunking.
Forced RapidOCR recovers the tested biology index order and the Japanese raster
Qwen row, but loses the German raster phrase check. These are single screen
passes; their small timing differences are not a statistical ranking.

The repeated probes must also be separated by input condition:

| Configuration | Original-page checks /44 | Matched raster checks /13 |
| --- | ---: | ---: |
| MinerU auto | 40 | 12 |
| Java, cluster tables | 33 | 0 |
| Hybrid auto, RapidOCR | 31 | 1 |
| Hybrid auto, EasyOCR, completed rerun | 31 | 0 |
| Hybrid full, RapidOCR | 35 | 10 |
| Hybrid full, forced RapidOCR | 36 | 10 |
| Hybrid full, EasyOCR | 35 | 1 |

These columns count raw, page-scoped checks. The original-page group includes
the supplied scans and mixed slide deck; the raster group is the eight deliberately
rasterized pairs. It is not a native-only versus all-scans split.

## Intact documents and extraction defects

The completed intact-document passes use all 22 originals, totaling 430 pages:

| Configuration | Seconds | Peak cgroup GiB | Text checks /27 | Table-row checks /16 |
| --- | ---: | ---: | ---: | ---: |
| MinerU auto | 964.1 | 11.78 | 24 | 16 |
| Java, cluster tables | 53.4 | 0.59 | 21 | 11 |
| Hybrid full, RapidOCR | 919.8 | 10.71 | 23 | 10 |
| Hybrid full, forced RapidOCR | 971.8 | 9.77 | 23 | 10 |

Full RapidOCR is about 5% faster than MinerU in this one intact-corpus pass,
compared with about 16% in the selected-page screen. Neither used swap. Its
structured-row losses persist with complete source documents. The full-corpus
checks have 27 text probes, 16 row probes and one separate order probe. Only
forced RapidOCR passes the order probe. Its text and row results match
ordinary full RapidOCR, but it takes slightly longer than MinerU on the full
corpus, despite being faster on the selected-page screen.
Including backend startup and shutdown, the RapidOCR configuration takes
926.2 seconds versus MinerU's 964.1 seconds, about a 4% difference. This single
pass is not enough to establish a small, repeatable speed advantage.

All four returned without parser exceptions on every document. This does not mean
every extraction is useful: Java's synthetic 40-page repeated slide deck has an
empty native JSON tree and empty Markdown. MinerU's full Hong Kong document recovers the
clean visible phrase that its selected-page sample missed. On the Spanish
paper, however, text physically on page 13 is merged into a paragraph attributed
to page 12. The WikiNER page-attribution failure also persists in the intact
document. Both retain the answer text, so counting words without checking their
page would miss the problem. On the full mixed deck, MinerU retains the synthetic
marker in all 40 digital-page blocks, but Capy's chunker removes it through its
repeated-furniture filter. This differs from the sibling-heading behavior in the
selected-page newspaper checks.

Full RapidOCR fails those Spanish and WikiNER passage checks for a different
reason: the expected passages are missing from its native output. A matching
name in a bibliography is not the missing body passage. On the Japanese slide
check it extracts `並列計算` but drops the adjacent `量子化` box and exports no
image block for that page. Source location and artifact inspection distinguish these
losses from MinerU's page-attribution errors and image-only representations.

On the intact 610-page textbook, MinerU and Java with cluster tables each pass
10 of the 11 targeted text/row/order checks, including all five row checks. Both
miss the index order. MinerU takes 752.6 seconds with an 11.93 GiB sampled peak
and no swap. These checks inspect a few selected locations, not the whole
book's accuracy. Java's missing graph crops still fail the separate visual
inspection.

The long-document resource comparison is:

| Configuration | Conversion time | Peak cgroup GiB | Peak swap GiB |
| --- | ---: | ---: | ---: |
| MinerU, 26-page slices, four shared-model lanes | 12 min 33 s | 11.93 | 0 |
| Java, cluster tables, two page threads | 1 min 56 s | 1.83 | 0 |
| Full RapidOCR, one backend, serial 50-page batches | 33 min 57 s | 7.61 | 0 |
| Full RapidOCR, 26-page slices, four backends | 19 min 36 s | 14.00 | 4.75 |

Four hybrid backends improve completion time, but remain 56% slower than
MinerU and exhaust the container's 14 GiB RAM allocation. The single-backend
result's lower memory use does not carry over to that parallel configuration.
The cgroup records memory-limit pressure but no OOM kill. Total CPU use also
rises from 5,543 core-seconds for one hybrid backend to 8,812 for four, versus
4,516 for MinerU. These counters do not isolate model work from slicing,
JVM startup or memory-management overhead.

Both hybrid long-book configurations pass all five text probes, two of five
row probes and fail the index-order probe, for seven of 11 checks before and
after chunking. Slicing improves runtime without improving these checks.
The two hominid checks fail because species and brain-size values are split
across adjacent rows. The measurement-table check is narrower: `16` and `18`
remain paired, but the `Measurements` label moves into an extra units row.
That table also merges the separate `14 | 19` and `13 | 10` observations into
`14 13 | 19 10`. These are structure failures, not missing numeric text. See
the [measurement-table source](local/2026-09-08-opendataloader/review/bio-measurements.png).
Its 488 image files total 81.0 MB and fit the measured artifact limits, but
reused filenames overwrite unrelated figures as described below. Capy's
selector retains 370 unique captionable images versus 633 from MinerU. These
counts include the damaged image references and cannot establish figure coverage.
The sliced result has 639 references to 492 files. It preserves the inspected
photosynthesis graph, but the enzyme and magnesium graphs are overwritten by
an 84-by-82-pixel icon and a 13-by-41-pixel strip. The native output of the
26-page slice already reuses `imageFile1.png` and `imageFile2.png` for those
graphs and later images. Prefixing filenames while merging slices cannot
repair a collision that has already happened inside one slice.

- Java with cluster tables completes the 430-page corpus in 53.4 seconds and
  the 610-page textbook in 116.3 seconds. The textbook exports 17,821 image files
  totaling 431,954,451 bytes (412 MiB). Preserving those images would exceed
  Capy's 4,096-entry and 256 MiB image limits with the tested adapter. Exact-byte
  deduplication reduces them to 2,322 files and 109,804,440 bytes (105 MiB), which
  would fit these two limits after rewriting references to shared files. That
  adapter change was measured as an inventory reduction, not implemented in Capy.
  It does not recover the missing vector graphs. The intact textbook's pages
  364 and 365 also export decorative strips and a blank bitmap, without either
  graph. See the [full-book crop check](local/2026-09-08-opendataloader/review/java-full-book-graphs.png).
- The experimental adapter converts OpenDataLoader's bottom-left PDF-point
  boxes to Capy's top-left 0..1000 coordinates without silently clamping them.
  The full Java corpus has 213 out-of-page boxes; 101 exceed a boundary by at
  most one unit. The long Java book has 1,030, of which 968 are within one unit.
  Those small overruns must not be described as 968 separate localization
  failures. Full RapidOCR has nine out-of-page image boxes and 12 zero-width
  text boxes, mostly mathematical accents. Capy's chunker drops the latter
  regions. MinerU's full and long outputs pass these structural geometry checks;
  the checks do not establish that every otherwise valid box covers its text.
- Java alone is fast but cannot OCR our scanned controls. Hybrid `auto` also
  routes portrait image-only pages to Java with `JAVA=2, BACKEND=0`, even with
  RapidOCR enabled. The text is absent although conversion succeeds. The
  [upstream issue](https://github.com/opendataloader-project/opendataloader-pdf/issues/619)
  describes the same scan-routing problem. The full-backend passes above
  bypass that routing decision.
- The hybrid backend already sets `TableFormerMode.ACCURATE`. The table errors
  were observed with that setting, rather than a fast table model.
- Formula quality is a material part of the speed tradeoff. On the Chinese
  paper's [page 6](local/2026-09-08-opendataloader/review/chinese-paper-page-6.png),
  MinerU preserves the set product in equation 4, `argmax` in equation 5 and
  `cos` in equation 6 as LaTeX. Full RapidOCR without formula enrichment splits
  operators into separate text fragments, followed by a variable-only equation
  block. The characters survive, but their mathematical order and structure do
  not. Forced RapidOCR rejoins the operators in these examples, while still
  flattening subscripts and misreading the `argmax` domain. These are manually
  inspected formula examples, outside the text/table probe totals. The enriched candidate
  exceeded its 600-second limit on this two-page screen input, so its faster
  unenriched timings do not represent equivalent formula recognition.
- Neither stack is reliable on every mathematical symbol. In the biology
  enzyme question, MinerU and selective RapidOCR omit the reversible-reaction
  arrow. Forced RapidOCR emits a one-way arrow instead. The source sentence
  still says the reaction is reversible; the extracted equation itself is wrong.
- In these pinned versions, RapidOCR's requested English, Chinese, traditional
  Chinese, Japanese, German, French and Spanish language codes all resolve to
  the same multilingual PP-OCRv6 small recognition checkpoint. With the offline
  artifact paths used here, language flags select the same model files. The
  explicit-language pass is a configuration control, not a comparison of
  separate language-specialized recognizers. Its 30-case result matches every
  raw and chunk probe from default full RapidOCR.
- Java alone exports bitmap objects rather than complete vector figures. On
  biology sample pages 8 and 9 it emits decorative fragments and misses two
  graphs. The full-book hybrid output has usable crops of these graphs, as
  MinerU does. The eight-page hybrid sample has image filename collisions:
  later skull crops overwrite both graph files in full routing. In automatic
  routing, the graph files survive but earlier protein illustrations point to
  those same graph files. The native JSON already contains the reused paths;
  this is not introduced by Capy's adapter. The full-book hybrid output has
  639 image references and 488 files; four inspected reused paths also contain
  unrelated images from different pages. File existence alone therefore does
  not establish figure integrity. The embedded-output control reproduces both
  failures: full routing embeds the exact skull-image bytes in the two graph
  nodes, while automatic routing embeds graph bytes in the earlier protein
  nodes. The full-routing sample has eight nodes but six distinct images in
  both output modes. The
  additional decorative images remain relevant: across the 64-page screen,
  Java selects 64 captionable images, hybrid RapidOCR selects 56, and MinerU
  selects 19 after Capy's filters. These are uncached requests implied by the
  outputs, not measured caption bills. Full routing with either OCR engine
  reduces that count to 22. Candidate count is a workload proxy, not a measure
  of figure coverage; coverage statements apply only to the inspected graphs.

  The pinned source explains this collision: native `ImageChunk` exports use
  the shared layout counter, while `SemanticPicture` uses a separate hybrid
  counter. Both write `imageFileN` into the same directory. Embedded mode keys
  its byte cache by that same filename. See the
  [image writer](https://github.com/opendataloader-project/opendataloader-pdf/blob/9311d1091b19f8fea763033bc9108b7d7db2123e/java/opendataloader-pdf-core/src/main/java/org/opendataloader/pdf/utils/ImagesUtils.java#L113-L130)
  and [hybrid picture counter](https://github.com/opendataloader-project/opendataloader-pdf/blob/9311d1091b19f8fea763033bc9108b7d7db2123e/java/opendataloader-pdf-core/src/main/java/org/opendataloader/pdf/hybrid/DoclingSchemaTransformer.java#L384).
- MinerU's biology index output interleaves the three columns. Its WikiNER
  output appends text from the second selected page to a paragraph attributed
  only to the first page and its box. The text survives, but the expected page
  citation fails.
- Capy's current chunker drops three MinerU `code` blocks from the two Japanese
  inputs. The raw results contain a prompt example and two optimizer configuration
  examples in `code_body`; the chunker logs the unrecognized block type. This is
  an integration gap after extraction, separate from the parser's OCR quality.
- The Hong Kong source has duplicated embedded characters that are absent
  from the visible page. Native text extraction preserves the defect in both
  engines. The raster control and clean visible phrase probe are evaluated
  separately; embedded-text agreement would reward the wrong result here.
- The structure-tree control uses three intact tagged PDFs, totaling 45 pages.
  Java with and without tags passes the same two of three source checks, in
  4.8 and 4.5 seconds respectively. Tags change block boundaries and expose
  152 table-of-contents items in the mixed Chinese document, but do not repair
  the Hong Kong document's duplicated characters. These three probes do not
  establish a general quality ranking for tagged-PDF extraction.
- The first EasyOCR pass lacked Chinese and Japanese model files. Those are
  experiment-setup failures, not parser-quality findings. The completed rerun
  retains 31 of 44 original-page checks and none of the 13 matched-raster checks.
  Installing the models resolves the setup errors, but does not make automatic
  hybrid routing reliable on these scan controls.
- Full-route EasyOCR still loses substantial CJK scan content with the models
  installed. Direct EasyOCR on the same Chinese page rendered at 216 DPI
  recognizes 2,137 characters with quantization and 2,138 without it. Applying
  its 0.5 confidence cutoff to the direct result retains about 1,750 characters.
  Those controls do not explain the near-empty output of the packaged PDF path;
  its precise failure mechanism remains unisolated. The matched rasters use 150 DPI,
  JPEG quality 85 and a 0.25-pixel blur; this is one scan condition, not a claim
  about every scan resolution or the OCR engines on other runtimes.

## Capacity measurement

The warm-burst comparison uses three repeats after warmup. Each burst requests
one or four independent 26-page parses. Throughput divides all requested pages
by the burst's elapsed time only when every request succeeds. Request latency,
peak cgroup memory and swap are retained separately. Runs with one shared hybrid
backend and four independent backends are distinct configurations.

Capacity content checks remain separate from corpus accuracy. Every timed
digital output is checked against four textbook probes on page 11; scanned
outputs reuse two newspaper checks on pages 1 and 25. The latter are repeated
instances of the same source page, not four independent accuracy examples.
Native text and rendered-page hashes verify that these retained stress inputs
match the frozen source pages. The experiment bypasses Capy's upload admission,
HTTP service and ingest queue, so these are parser-capacity measurements.

The capacity runs are below. Throughput is the median of three
successful bursts; memory and swap are the largest sampled values across them.

| Input | Concurrent requests | Burst time range, seconds | Median pages/second | Peak cgroup GiB | Peak swap GiB |
| --- | ---: | ---: | ---: | ---: | ---: |
| Digital, MinerU auto | 1 | 78.6–81.6 | 0.329 | 5.55 | 0 |
| Digital, MinerU auto | 4 | 116.0–125.0 | 0.851 | 11.85 | 0 |
| Digital, full RapidOCR, one backend | 1 | 79.3–80.5 | 0.326 | 4.61 | 0 |
| Digital, full RapidOCR, one backend | 4 | 309.6–320.3 | 0.333 | 5.61 | 0 |
| Digital, full RapidOCR, four backends | 4 | 233.0–258.5 | 0.414 | 14.00 | 2.46 |
| Scan, MinerU auto | 1 | 116.8–117.2 | 0.222 | 4.30 | 0 |
| Scan, MinerU auto | 4 | 195.0–207.7 | 0.516 | 12.04 | 0 |
| Scan, full RapidOCR, one backend | 1 | 89.3–92.2 | 0.287 | 3.96 | 0 |
| Scan, full RapidOCR, one backend | 4 | 358.1–365.6 | 0.285 | 4.32 | 0 |
| Scan, full RapidOCR, four backends | 4 | 190.1–206.3 | 0.520 | 14.00 | 2.56 |

All 15 MinerU digital outputs retain all four probes before and after
chunking. All 15 MinerU scanned outputs retain the four repeated raw
probe instances, but none survives chunking. The scan repeats the same two
pages 13 times, triggering Capy's repeated-furniture filter. That synthetic
duplicate removal is separate from parser extraction quality.

All 30 hybrid digital outputs, including the eight-thread controls below,
retain three of four probes
before and after chunking. They reproduce the measurement-table row failure
described above. Similar request times therefore do not imply equivalent
table extraction.

Four callers to one hybrid backend provide almost no throughput improvement
over one caller. The last request in each burst takes 310–320 seconds; the
first takes 81–85 seconds. MinerU's four-request digital throughput is about
2.6 times higher. With four independent hybrid backends, digital throughput
remains about half MinerU's. Scan throughput is similar, with overlapping
burst-time ranges. Both four-backend configurations fill the 14 GiB RAM limit
and use swap; their cgroups record memory-limit pressure but no OOM kill.

On the repeated scan, one hybrid request has about 29% higher median throughput
than MinerU. All 30 hybrid scanned outputs, including four-backend and
eight-thread controls, retain both repeated body-check instances, but
omit the marker and headline, leaving two of four raw checks. The native JSON
contains only the 26 body paragraphs. The two-page version retains its headings,
so this difference is sensitive to the repeated-page condition; it is not
evidence that the OCR engine cannot read the headline. None of the four checks
survives Capy's duplicate filtering. These raw and chunk results remain
separate from the corpus quality totals.

All 99 timed requests across 15 capacity configurations succeeded. No capacity
output exceeds the checked artifact limits or references a missing image file.
File existence does not establish image identity; the separate collision
findings still apply.

## CPU-thread controls

For one active hybrid request, raising the CPU thread limit from two to eight
helps the repeated scan and slows the digital fixture. These are medians of
three successful warm requests under the same eight-CPU container limit:

| Input | Two threads, seconds | Eight threads, seconds | Eight-thread pages/second | Eight-thread peak GiB |
| --- | ---: | ---: | ---: | ---: |
| Digital, 26 pages | 79.7 | 89.9 | 0.289 | 4.82 |
| Scan, 26 pages | 90.5 | 62.5 | 0.416 | 4.44 |

Neither uses swap. The eight-thread scan control has about 45% higher
throughput than the two-thread hybrid control, with unchanged source-check
results. This establishes a useful single-request tuning option. The
four-backend tests use two threads per worker to share the host's eight CPUs.
MinerU remains the current production configuration in this comparison.

Java with cluster tables takes a median 6.48, 6.42 and 6.44 seconds at one,
two and eight page threads on the same digital fixture. Those small differences
do not establish a benefit from page parallelism. All nine outputs retain
the four digital probes before and after chunking, with no swap and peaks
below 0.54 GiB.

The default one-thread Java controls also cover the complete screen and intact
documents:

| Java configuration and input | Two page threads, seconds | One page thread, seconds |
| --- | ---: | ---: |
| Default tables, 64-page screen | 33.5 | 33.8 |
| Cluster tables, 64-page screen | 35.0 | 32.7 |
| Cluster tables, 430-page corpus | 53.4 | 53.6 |
| Cluster tables, 610-page textbook | 116.3 | 117.7 |

All 83 one-thread cases succeed. Each paired case has identical source-probe
outcomes, adapted block and image counts, image-byte totals, geometry diagnostics
and artifact-limit flags. The default thread setting therefore leaves the
extraction findings unchanged. These individual passes do not establish a
small timing advantage for either setting.

The selected 14-page full-EasyOCR control also improves from 285.5 to 206.7
conversion seconds at eight threads. Its seven of 16 raw/chunk probe results
are unchanged, including the Japanese and Hong Kong raster failures. This
four-case control is separate from the complete 64-page screen.

## Recommendation

Keep MinerU as Capy's default parser. OpenDataLoader's Java path offers a large
speed advantage for embedded text, but the missing scans and vector figures
make it unsuitable for Capy's general study-material imports. Table associations,
equations, figures and source-page citations matter to the study tools; a fast
successful conversion can still remove or misrepresent that evidence.

Full-route RapidOCR is the strongest candidate tested here. It recovers much
more scan content than automatic routing, and eight CPU threads improve its
single-request scan latency. Those benefits do not outweigh its table/formula
losses, native image-identity corruption, and resource cost under parallel load.
The intact-corpus speed difference is small and comes from a single pass; the
long-book and repeated digital-capacity results favor MinerU. EasyOCR, forced
OCR, language flags and the tested CPU allocations do not resolve the combined
quality and capacity problems.

A future replacement trial should first verify corrected native image identities,
scan routing, table relationships and practical formula extraction on these
same sources. MinerU also needs follow-up for the observed page-attribution
errors, index order and Capy's omitted code blocks. These are findings for
separate implementation work; this experiment changes no production parser.

## Reproduction and artifacts

The plan is in [the frozen scope](2026-09-08-opendataloader-plan.md). Runnable
scripts and instructions are in [the parser benchmark README](../README.md).
The source probes are in
[`opendataloader-checks.json`](../fixtures/opendataloader-checks.json).
Raw inputs, source-page renders, native outputs, logs, resource samples and the
evaluation JSON are retained locally under
`bench/parsers/reports/local/2026-09-08-opendataloader/`.
The [corpus/control CSV](local/2026-09-08-opendataloader/comparison.csv) contains
30 runs and 582 case records, including the explicitly excluded setup failures
and partial passes. The [capacity CSV](local/2026-09-08-opendataloader/capacity.csv)
summarizes 99 timed requests across 15 configurations; the
[burst CSV](local/2026-09-08-opendataloader/capacity-bursts.csv) retains all 45
measured bursts. The [evaluation summary](local/2026-09-08-opendataloader/evaluation-summary.txt)
and CSVs are regenerated from the final JSON with the retained
[`summarize_results.py`](local/2026-09-08-opendataloader/summarize_results.py).
The invalid initial MinerU full-corpus attempt remains in the raw archive and
is excluded from evaluation.

The final archive's SHA-256 verifies after download. All 27 input files,
110 prepared files and 22 script files match the VM manifest locally; model
files remain on the VM with 236 manifest entries. The
[verification receipt](local/2026-09-08-opendataloader/archive-verification.json)
records the archive digest and checked file groups. Figure-review artifacts
are also retained locally from the verified intermediate archives.
Both experiment containers were removed after verification; the
[cleanup receipt](local/2026-09-08-opendataloader/logs/cleanup.json) confirms that
no containers remain on the VM. The experiment directory, source/model copies,
raw outputs and container images are retained there. Original caches and data
were left untouched.

Useful inspection files include the
[biology table source](local/2026-09-08-opendataloader/review/bio-table.png),
[equation source](local/2026-09-08-opendataloader/review/bio-equation.png),
[MinerU figure crops](local/2026-09-08-opendataloader/review/screen-mineru-auto-figures.png),
[Java figure fragments](local/2026-09-08-opendataloader/review/screen-odl-java-figures.png),
and [hybrid auto figure crops](local/2026-09-08-opendataloader/review/hybrid-auto-figures.png).
