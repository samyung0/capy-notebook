# Java extraction with selective recovery

Java's speed advantage survives selective OCR. On the same mostly digital
430-page corpus,
Java extraction, source inspection, OCR and physical image deduplication took
62.9–63.6 seconds across three complete runs. The earlier MinerU extraction
pass took 964.1 seconds. That is about 15 times faster before captions and
application indexing.

The quality result is less settled. Keeping headers and footers fixes a large
native-text omission. Direct OCR recovers scan text cheaply. Captions recover
useful graph and table relationships, but also introduce confident factual
errors. These experiments support developing a Java fast path; they do not
establish quality equivalence or justify replacing the production parser.

## What was tested

This follows the [frozen recovery plan](2026-09-08-java-recovery-plan.md) and
the [original comparison](2026-09-08-opendataloader-vs-mineru.md). Inputs are
unchanged: 22 intact documents containing 430 pages, a separate 610-page biology
textbook, and a 30-case, 64-page diagnostic screen. The screen includes eight
two-page raster controls in German, English, Spanish, French, Japanese and
three Chinese variants. The intact set includes 82 synthetic slide pages and
four Office canary pages; it is not a representative sample of all uploads.

The CPU work ran on the same idle Netcup host in a new isolated container,
with eight CPU cores, a 14 GiB memory limit and no GPU. Java used
OpenDataLoader 2.5.7, cluster tables and one Java worker. Direct OCR used
RapidOCR 3.9.2, ONNX Runtime 1.29.0, the recorded PP-OCRv6 small detection and
recognition models, and the v2 mobile classifier. Source inspection used
PyMuPDF 1.28.2. Model, script and input hashes are in the raw records.

Caption calls ran from the local machine through DeepInfra with Capy's current
GLM-5.3-Flash image prompt, low reasoning effort and four concurrent requests.
The experimental controls explicitly changed the image-size cap or added
source-language transcription/decorative instructions. All 127 requests and
their receipts were saved, including three 180-second read timeouts. No retries,
application cache, application database, embedding calls or retrieval evaluation
were used. No production code or configuration changed.

## The measured fast path

| Workload | Java extraction alone, earlier pass | Java plus inspection, selective OCR and deduplication | MinerU extraction, earlier pass |
| --- | ---: | ---: | ---: |
| 430 pages | 53.4 s | 63.39, 62.90, 63.60 s | 964.1 s |
| 610-page textbook | 116.3 s | 135.95 s | 752.6 s |

The three intact-set trials OCR six emitted scan images each. Java extraction
takes 53.0–53.6 seconds, inspection 2.4–2.6 seconds, OCR 6.9–7.8 seconds, and
adaptation plus deduplication about 0.23 seconds. Sampled whole-container peaks
are 0.91–1.06 GiB, with no swap. The textbook trial OCRs one image, peaks at
1.93 GiB and uses no swap. Its source inspection costs 15.7 seconds.

These are serial corpus trials with fresh container restarts and warm filesystem
caches, not new concurrent-upload capacity measurements. The MinerU numbers
come from the earlier completed pass, not a newly repeated control. The
large speed gap is clear; the small differences among Java trials are not a
statistical estimate of production latency. Captions, chunking, uploads and
indexing are excluded from this timing table. The per-trial `complete.json`
records are authoritative for combined timing and memory.

The first integrated trial failed because the new inventory helper did not
create its output directory. Its log is retained and excluded from timings.
The three subsequent intact-set trials and the textbook trial completed.

On the intact corpus, Java plus OCR passes 37/44 raw probes versus MinerU's
40/44. Both retain 36/44 after chunking, but fail different examples. Equal
counts here are not equivalent output quality. The earlier Java-only result
was 32/44 raw and 31/44 after chunking; keeping headers raises that to 33/44
and 32/44 before OCR. The textbook's narrow 11-probe set remains 10/11 for
both parsers and does not test all of its missing graph content.

Java's remaining raw failures include two DOCX rows, two French model-table
rows, a Japanese embedded table row, the Hong Kong PDF's clean visible phrase,
and index order. The Hong Kong failure also shows why an embedded-text coverage
check cannot establish that the text is readable or faithful. MinerU's different
failures include page attribution and content lost later by chunking.

Physical deduplication was actually exercised, rather than estimated. The
textbook's 17,821 image placements use 2,322 distinct files and 109,804,440 bytes,
down from 431,954,451 bytes. Every placement remains in the content list. The
deduplication itself takes 1.28 seconds. This removes the previously measured
image-count and image-byte limit violation without discarding source images.

## A Java option fixes the missing slide text

`--include-header-footer` eliminates all 159 pages flagged for low native-text
coverage in the intact set. Those pages include the repeated synthetic decks
and much of the Japanese lecture deck. With the option, the full native pass
takes 52.76 seconds. The earlier cluster-table pass took 53.4 seconds.

The flag is not a general quality fix. It retains repeated furniture too, and
Capy's chunker has its own repeated-text filter. Zero coverage flags means no
page falls below this experiment's 80% character-frequency threshold; it does
not mean every word, reading order, formula or chunk is correct.

Keeping line breaks leaves the screen's checks unchanged at 33/57. Disabling
Java reading order reaches 34/57, recovering the one index-order probe, but
provides no broad evidence that disabling reading order is a safe default.

## OCR is the better scan-text recovery in this test

The 20 scan-image jobs all complete in each direct OCR configuration:

| OCR configuration | Total seconds | Peak GiB | Screen checks retained through chunking |
| --- | ---: | ---: | ---: |
| 1,280-pixel cap, two threads | 37.53 | 0.84 | 46/57 |
| 2,560-pixel cap, two threads | 44.34 | 1.36 | 45/57 |
| 2,560-pixel cap, eight threads | 29.26 | 1.31 | 45/57 |

The cap never upscales an image. OCR at the larger cap is faster with eight
threads, but does not improve these checks. The combined intact trials use
the last configuration. The raster text diagnostics also favor retaining
the smaller-size control as a candidate rather than assuming more pixels
always improve recognition.

On 15 raster pages with embedded text available in the matched original,
character-frequency recall is 0.974 for 1,280-pixel OCR, 0.964 for larger-cap
OCR, 0.988 for native MinerU and 0.733 for ordinary image captions. Mean
ordered text similarity is 0.833, 0.826, 0.884 and 0.501 respectively. These
are transcription diagnostics against PDF text extraction, not human accuracy
scores. Character counts ignore order; ordered similarity penalizes paraphrase,
extra image text and column interleaving. The original Taiwanese page without
embedded text is explicitly excluded. Failed captions contribute empty text.

Direct OCR still lacks layout understanding. Dense columns can interleave,
table lines are not structured rows, and formulas lose relationships. Passing
OCR line boxes back through Java using ten temporary text-only PDFs does not
solve this: it creates false tables and retains column-order problems. The
experiment takes another 10.4 seconds and reaches 45 raw checks but 44 after
chunking. It is not a useful general replacement for a layout parser.

## Captions help, but adding them can make an answer worse

The automatic screen checks use the existing 57 page-scoped probes, comprising
37 text checks, 19 structured-row checks and one reading-order check. There
are 44 unique probes with 13 repeated input conditions. Captions written as
prose do not count as structured HTML rows.

| Output variant | Raw checks | Checks retained through chunking |
| --- | ---: | ---: |
| Java with headers | 33/57 | 33/57 |
| Java with headers and direct OCR, larger cap | 45/57 | 45/57 |
| Java with headers and existing-image captions | 43/57 | 43/57 |
| Java with OCR and captions, plus automatic rendered regions | 45/57 | 45/57 |
| Same, replacing contained tables with caption prose | 34/57 | 34/57 |
| MinerU native | 52/57 | 49/57 |
| MinerU with its existing-image captions | 53/57 | 50/57 |

The unchanged anchor score hides useful visual recovery, so a separate reviewer
checked 24 prewritten questions against source images, raw blocks and actual
Capy chunks on five pages. A pass requires the requested relationship to remain
in one chunk. A direct contradiction is wrong even when another chunk is
correct. This is deliberately a strict chunk-level diagnostic, not a simulation
of an agent that can retrieve several chunks.

| Variant | Pass | Partial | Missing | Wrong |
| --- | ---: | ---: | ---: | ---: |
| Java with headers | 15 | 4 | 5 | 0 |
| MinerU native | 13 | 5 | 6 | 0 |
| MinerU with captions | 21 | 2 | 0 | 1 |
| Java with OCR, image captions and automatic region captions | 19 | 2 | 1 | 2 |
| Same, replacing contained tables | 19 | 2 | 1 | 2 |

These counts have a narrow sample and are not comparative overall accuracy.
The source review found:

- Captions preserve the enzyme graph's marker legend and approximate values at
  substrate concentration 100. Native labels alone do not associate a curve
  with its plotted value. However, every captioned variant adds an unsupported
  non-competitive or Vmax-reducing explanation even though the page explicitly
  calls the inhibitor competitive. This error lies outside the numeric probes.
- An automatic photosynthesis-region caption puts experiment 2 above experiment
  1. The source shows a shared plateau and its body text says the line did not
  change. The whole-page pilot and MinerU's figure caption get that relationship
  right. Crop choice and a single generation can change the answer.
- The CIL flow captions preserve the question-to-answer sequence and the weak
  LLM's role, but call eight skill boxes ten while listing eight. Java keeps
  equations 4 and 5; equation 6 is fragmented and loses the full cosine
  relationship from a useful chunk. MinerU preserves all three equations.
- A whole-page hominid-table caption preserves all seven brain-size rows,
  including `unknown`. Both native tables are also accurate. Their Homo erectus
  row is split across chunks, which the whole-page caption helps with. Separate
  unlabeled skull crops invite unsupported species guesses that conflict with
  the table positions.

Replacing valid native tables with captions is therefore a poor trade here.
Adding captions can improve coverage while adding contradictory searchable
text. Counts of recovered words or successful calls would miss that harm.

## Caption size, latency and cost

Eight matched second raster pages were tested at both image-size caps. The
larger cap preserves emitted image edges of 1,518–2,001 pixels; these are not
eight new 2,560-pixel renders. Raising the cap alone does not reliably fix
transcription. A control that explicitly requests source-language transcription
improves character-frequency recall on those eight pages from 0.879 to 0.953,
but ordered similarity remains 0.581 versus direct OCR's 0.831 at the smaller
cap. The larger-cap original-prompt batch also has one timeout. These one-shot
results do not isolate image size from generation or provider variability.

| Caption batch | Requests / successful | Batch seconds at concurrency four | Receipt cost, USD |
| --- | ---: | ---: | ---: |
| Four page pilots | 4 / 4 | 76.71 | 0.001617 |
| Existing Java and MinerU images | 83 / 81 | 1,566.71 | 0.013078 |
| Rendered regions, including two manual controls | 20 / 20 | 256.59 | 0.003869 |
| Eight scan pages, larger cap | 8 / 7 | 232.98 | 0.003247 |
| Same scans, source-language instruction | 8 / 8 | 104.89 | 0.003708 |
| Four decorative-instruction controls | 4 / 4 | 155.08 | 0.000437 |

Total observed receipt cost is $0.0259548 for 124 successful responses, with
138,394 input tokens and 62,301 output tokens. The three timed-out calls have
no usage receipt, so their billing is unknown. These are provider-returned
estimated costs, not invoice reconciliation.

The 83-image batch consists of 64 Java requests and 19 MinerU requests, with
72 unique image hashes across both sets. It intentionally bypasses application
caching, so repeated image bytes are billed and timed more than once. Java's
successful receipts total $0.0101634 and MinerU's $0.0029141. Java's median
request is 68.15 seconds versus 41.57 seconds for MinerU's smaller image set.
These subset medians are not independent end-to-end batch measurements.

The actual prompt encourages faithful transcription but does not request a
`DECORATIVE` response. Adding that instruction suppresses one decorative sample,
while another still receives a descriptive paragraph. Filtering decorative
fragments after generation has already paid their latency. Image selection is
part of the remaining work.

## What selection can and cannot do

The scan heuristic uses fewer than 100 embedded text characters and a source
image covering at least half the page. All eight raster controls emit usable
full-page images from Java, so they need no figure rediscovery. This heuristic
has not been validated for small scanned panels beside native text or for PDFs
with misleading hidden OCR text.

For missing vector figures, source drawing inspection finds the known
photosynthesis and enzyme graphs. Filled page backgrounds make a naive
all-drawings detector select almost every textbook page. Using sufficiently
large stroked drawing clusters is more selective, but can miss filled-only
figures. Java table boxes provide additional crop candidates. The experiment
uses full-width horizontal bands with 36 points of vertical padding so nearby
legends survive better than with tight drawing bounds.

After retaining headers, these rules select 18 automatic recovery bands in the
screen, 96 across the intact corpus and 324 in the textbook. The latter two
cover 86/430 and 279/610 pages respectively. Selection counts are workload
estimates, not measured detector precision or recall. Only the screen bands
were captioned. Two hand-picked equation crops are recorded separately and
excluded from automatic-recovery claims. Full-corpus caption trials were not
expanded because the screen already exposed quality and latency problems.

OCR adds line-level boxes, while a caption cites the whole image or rendered
band. A long caption's individual claims do not gain cell-level coordinates.
The verified screen retains 77 out-of-bounds Java blocks, including 71 image
placements, versus none for MinerU. OCR recovery does not cure those existing
coordinates. All verified screen variants have their referenced image files
and fit the measured artifact limits.
The complete selective outputs also fit those limits and have no missing image
files. They retain 532 out-of-bounds blocks in the intact corpus and 2,451 in
the textbook, so deduplication resolves storage size rather than citation geometry.

## Recommendation

The useful next implementation candidate is Java with cluster tables and
headers retained, byte-deduplicated images, and direct OCR on clearly scanned
pages. Its measured extraction cost stays close to Java alone. Preserve native
text and tables. Use captions only for visual content that needs explanation,
with crops that include the relevant labels and context.

Quality equivalence still needs evidence for dense tables, equations, reading
order, caption contradictions and source-coordinate correctness. A page-level
route to a stronger parser may be worthwhile for those cases, but this
experiment does not establish a reliable automatic routing rule. The older
hybrid parser's image-collision defect also remains outside this Java-only
experiment. Production behavior is unchanged.

## Evidence and reproduction

- [Raw experiment directory](local/2026-09-08-java-recovery/).
- [Verified existing-image evaluation](local/2026-09-08-java-recovery/evaluation-images-verified/evaluation.json),
  [verified region evaluation](local/2026-09-08-java-recovery/evaluation-regions-verified/evaluation.json),
  and [verified OCR evaluation](local/2026-09-08-java-recovery/evaluation-ocr-verified/evaluation.json).
- [Integrated-trial quality and resource records](local/2026-09-08-java-recovery/evaluation-integrated/evaluation.json).
- [Source and chunk review](local/2026-09-08-java-recovery/review/java-recovery-source-quality-review.md),
  [machine-readable verdicts](local/2026-09-08-java-recovery/review/java-recovery-source-quality-review.json),
  and [question fixture](../fixtures/java-recovery-checks.json).
- [Caption receipts summary](local/2026-09-08-java-recovery/caption-usage-summary.json),
  [matched raster diagnostics](local/2026-09-08-java-recovery/raster-transcription-diagnostics.json),
  and [larger-image diagnostics](local/2026-09-08-java-recovery/hires-transcription-diagnostics.json).
- [Runnable instructions](../README.md#java-with-selective-recovery).

The semantic fixture's CIL-flow expected answer was corrected after the initial
pilot: the weak LLM answers the question, while the strong LLM builds the skill
library. The source crop confirms that correction. No expected answers were
sent to a caption model. Exact run-time script snapshots and later benchmark
guard/metadata corrections are retained separately; quality evaluations were
repeated after those corrections without rerunning provider calls.
The image-reuse check matched all 19,301 header-option image files to the
earlier frozen Java image bytes before those files were reused for captions;
the local hash verification found zero mismatches.

The Python formatter and scoped Ruff checks pass, as do the saved-recovery
check and existing adapter/table-chunking check. The latter requires `pypdf`;
its successful invocation was `uv run --with pypdf python
bench/parsers/scripts/check_opendataloader_adapter.py`. An independent bounded
review verified the benchmark provenance and failure-handling corrections.
A [fresh closing review](local/2026-09-08-java-recovery/review/java-recovery-final-review.md)
found no material correctness issue or misleading claim in the final benchmark
or report.

The complete VM archive is 319,208,136 bytes, using archive hardlinks for
43,958 byte-identical image copies. Its SHA-256 is
`da23380e8aabc06e6cd385c2dd0c03d027cf7db8db5723576a839479042ee63b`.
The local download matches the remote hash; all 48,542 members were extracted
and their file sizes or hardlink targets verified. After that verification,
the single experiment container was removed. No containers remained at cleanup;
the experiment directories, outputs, model assets and earlier experiment remain.
See [archive verification](local/2026-09-08-java-recovery/vm-archive-verification.json)
and [cleanup receipt](local/2026-09-08-java-recovery/cleanup.json).

The separate local analysis archive is 266,855,041 bytes with SHA-256
`65370869101ba20afde775ac5c9d55e66061f36ec5767f7c1709e28c46989a51`.
All 12,479 manifest entries were verified, comprising 5,946 regular files and
6,533 identical-image links. It retains caption receipts, local quality outputs,
source-review evidence and code snapshots. The complete CPU archive remains
separate. See the [analysis manifest](local/2026-09-08-java-recovery/analysis-manifest.json)
and [analysis archive verification](local/2026-09-08-java-recovery/analysis-archive-verification.json).
