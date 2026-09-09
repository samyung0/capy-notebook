# Native PDF geometry inside MinerU

This experiment tests whether trustworthy source text and geometry can remove
model work from MinerU. It follows the [authorized plan](2026-09-09-mineru-native-plan.md).
Production parsing, provider settings and application data are unchanged.

The region shortcut skips detector work, but the intact 430-page run improves
by only 1.1%, below the observed variation between baseline runs, and the 610-page
textbook is 2.7% slower. Region v5 also loses a textbook citation region and an
answer-mark value, and consistent spacing makes the existing chunker suppress
three active agenda entries. The whole-page shortcut separately fails citation
and structure checks. Neither approach supports a maintained MinerU fork on this
evidence.

| Workload | Baseline seconds | Region v5 seconds | Time change | Peak GiB, baseline / v5 |
| --- | ---: | ---: | ---: | ---: |
| 64-page screen | 301.54 | 284.97 | −5.5% | 3.34 / 2.91 |
| 430 intact pages | 919.44 | 909.58 | −1.1% | 10.83 / 9.70 |
| 610-page textbook | 754.66 | 775.25 | +2.7% | 12.43 / 11.20 |
| 26-page digital, three-trial median | 76.38 | 72.93 | −4.5% | 4.54 / 3.36 |

These runs exclude captions. Negative time change means faster. All complete
without swap. Full and long are single fresh-process pairs, not repeated latency
estimates. Source review rejects the candidate despite unchanged anchor scores.
The final row reports the median time and maximum sampled memory across three
warm trials per arm. These trials use one request at a time.

## Method

The VM runs one isolated container at a time, with eight CPUs, 14 GiB memory,
28 GiB combined memory/swap and no network access or exposed ports. MinerU is
3.4.5. The experiment adds PyMuPDF 1.28.2 to the retained parser image. The seven
upstream modules used by the hooks match commit
`fbb1257a555a3fde78ae5aaaa931e3b3f8fb2883` byte for byte. Each measured run saves
the executed scripts, their hashes, source PDF hashes and cumulative work
counters. The image identity and resource limits are in `environment.json`.

The region candidate keeps neural page layout, formula recognition and table
recognition. It supplies source line boxes in eligible text regions, bypassing
OCR detection there. MinerU still performs its normal source-text fill and
document reconstruction. Ambiguous regions retain the original detector.

The page candidate accepts only simple horizontal native prose with conservative
checks for images, drawings, annotations, columns, encoding and mathematical
notation. It supplies paragraph, title and text-line boxes and skips page model
analysis. Pages still render, and MinerU still performs downstream text filling,
paragraph reconstruction and serialization. A PyMuPDF lock serializes source
inspection across parser threads.

The hooks live in benchmark scripts and are installed only in the experiment
process. A maintained MinerU fork was not necessary to measure these ideas.

| Work | Region v5 | Rejected page v5 |
| --- | --- | --- |
| Page rendering | Retained | Retained |
| Neural layout, formulas and tables | Retained | Skipped on accepted pages |
| General text detection | Skipped in accepted digital regions | Skipped on accepted pages |
| Recognition on OCR-classified pages | Retained | Native line text on accepted pages |
| PDFium native filling in digital mode | Retained | Retained |
| Paragraph reconstruction and serialization | Retained | Retained; source of the new citation regression |
| Image captioning | Unchanged; outside timed parsing | Unchanged; outside timed parsing |

The fresh complete-corpus baseline finishes all 22 documents and 430 pages in
919.44 seconds, with 10.83 GiB sampled peak memory and no swap. It passes 40/44
raw and 36/44 chunk probes. Every content list matches the retained baseline
exactly. Its time is 4.6% below the earlier 964.1-second run, so comparisons use
the fresh control rather than crediting normal run variation to a shortcut.
Complete-corpus and long-document runs use fresh processes without warmup and
include lazy model loading; the model-file and operating-system caches remain
available. Digital capacity trials explicitly warm the models first.

The fresh 610-page baseline takes 754.66 seconds, peaks at 12.43 GiB and uses no
swap. Its complete content list also matches the retained baseline exactly. It
passes 10/11 raw and chunk probes, with the index-order probe still failing.

Three fresh warm digital baseline trials take 76.38, 74.72 and 77.43 seconds,
with a 76.38-second median. All three content lists exactly match the earlier
baseline, including the 55 chunks and four passing probes. The maximum sampled
memory is 4.54 GiB, with no swap. These trials warm on the complete 26-page
fixture before measurement, unlike the earlier one-page focused warmup.

## Region v5 on intact documents

The candidate finishes all 22 documents and 430 pages in 909.58 seconds versus
919.44 seconds for the fresh baseline, a 1.1% reduction. Sampled peak memory
falls from 10.83 to 9.70 GiB, with no swap. The screen pair had improved by 5.5%;
that gain does not carry across the complete corpus. A single intact pair with
this small a difference does not establish a general latency benefit.

V5 bypasses 1,982 of 4,668 detector regions, or 42.5%. Native reading records
20.02 seconds and region checks 31.16 seconds. These are accumulated hook
durations, not an additive wall-clock profile. Neural layout, formula and table
work still execute. Safe acceptance itself has a cost.

Raw and chunk probe scores remain 40/44 and 36/44. Seventeen content lists are
identical, and all 325 exported images match byte for byte. The five changed
documents contain source restorations and spacing changes, including punctuation
in chart/table footnotes. Block types, heading levels and geometry are unchanged.
Chunk count increases from 798 to 801 and text from
629,779 to 631,557 characters. The German TOC adds one chunk with every title/page
pair and citation retained. The French heading gains a space before its question
mark. The Chinese changes insert spaces around Latin terms with unchanged chunk
metadata. Source review of the Japanese paper validates 147 insertions restoring
289 non-whitespace characters and three source-correct replacements. It recovers
content such as the 1.5% result, RLHF and IDK. Its two added chunks include one
exact duplicate overlap chunk. Section-level citation regions and all 14
reference flags remain intact, but restored page-2 prose still inherits the
baseline's existing page-1-only attribution. Better text does not repair that
earlier citation defect.

The Japanese slide deck demonstrates why correct raw text is insufficient.
Three agenda bullets describe scaling parameter count, compute and data. Each
recurs on eight pages. Baseline spacing variations leave one copy of each in
retrieval; v5 makes their spacing consistent. Capy's current
`_repeated_across_pages` then treats all copies as page furniture and drops them.
The raw blocks, boxes and roles survive, but three bullets and their page-23,
page-42 and page-59 citation regions disappear from chunks. The frozen anchor
probes do not exercise this loss. This is a parser/chunker interaction, not a
loss of source characters by the native hook. Independent review confirms that
the lost copies are the bold, purple active agenda entries. Those three blocks
are themselves unchanged; changing the spacing of the other seven copies causes
their removal. Detailed teaching content about all three topics survives
elsewhere, so this demonstrates lost source evidence and citations rather than
measured deterioration in question-answer accuracy.

Further eligibility exclusions aimed at incidental detector spacing would be
fragile. Changing Capy's repeated-text policy is a separate application decision,
and the 1.1% intact timing difference does not justify extending this experiment
into a chunker redesign. Region v5 remains a measured benchmark candidate, not a
production-ready optimization.

The separate 610-page textbook takes 775.25 seconds versus 754.66 seconds, a
2.7% increase. Sampled peak memory falls from 12.43 to 11.20 GiB, with no swap.
It skips 5,753 of 9,879 detector regions, or 58.2%. Native reading records 72.02
seconds and region checks 118.88 seconds, again accumulated durations across
concurrent work rather than an additive elapsed-time profile. Skipping more
regions does not guarantee a faster request.

The textbook retains 10/11 raw and chunk probe passes, all 10,106 block types
and boxes, all 873 image files, 633 captionable images and 1,463 chunks. Only 17
pages change content. Full source and chunk review is required despite those
matching counts; unchanged geometry does not establish unchanged attribution.

Source review confirms three regressions. A 189-character continuation printed
on physical page 506 moves into a page-505 block, leaving the page-506 block
empty. Its citation region disappears from two chunks. A four-mark answer value
on page 578 is dropped, and a closing parenthesis on page 407 disappears. Thirteen
other substantive changes restore source characters. All 19 changed chunks
retain their section paths and reference flags, but the global citation-region
set loses the page-506 continuation box. No new duplicate chunk or furniture
filtering change explains these losses.

The long result closes this branch of the experiment. Further exclusions would
reduce skipped work while the broader tests already show little or negative
latency benefit. The failures also show that checking line fill is insufficient
to guarantee downstream paragraph and citation behavior. Solving those contracts
is a larger parser change, rather than another small eligibility adjustment.

Three warm digital candidate trials take 72.93, 75.05 and 71.20 seconds, with a
72.93-second median versus baseline's 76.38 seconds. The observed median gain is
4.5%; the ranges overlap at 74.72–75.05 seconds. Maximum sampled memory falls
from 4.54 to 3.36 GiB, with no swap. The trials ran sequentially in separate arm
groups, not randomized interleaved pairs. This is one 26-page fixture, not a
general throughput or capacity estimate.

All three candidate content lists exactly match the source-reviewed focused v5
output. Each retains 330 blocks, 55 chunks, all images and citation metadata,
with the same restored question number and 4/4 raw and chunk probes. Each skips
179 of 316 detector regions. Across the three measured calls, native reading
and region checks total 12.13 accumulated seconds, excluding the full-document
warmup. This is a modest gain on that fixture, below the earlier single focused
pair's 11.1% result.

## Region revisions and screen tests

On the retained 26-page digital capacity fixture, the first native-region
candidate took 69.38 seconds against a fresh 77.79-second baseline. Measured
peak cgroup memory fell from 3.60 to 2.98 GiB, with no swap in either run. This
is one warm pair, not a repeated estimate.

Both outputs contain 330 blocks and 55 chunks and pass all four existing source
probes. Direct comparison nevertheless finds a semantic regression on page 24:
`4πr<sup>2</sup>` becomes `4πr 2`. This is a failure even though normalized text
and anchor probes pass. The second candidate rejects native superscript/subscript
flags and overlapping native line bands so these ambiguous regions keep OCR
detection. Its focused check includes exponents written both within one PDF text
object and as separate text objects.

The first candidate's process counters include the one-page warmup: 120 of 318
regions bypassed detection, while 191 were rejected for raster-image overlap,
five had no usable native text and two had unexplained visible ink. Source
reading took 1.11 seconds and region checks 0.72 seconds. A page can contain
both accepted and rejected regions; page counters are not disjoint.

The second region candidate took 70.73 seconds and produced exactly the same
content list, including boxes, as the baseline. The third changed the raster
guard to account for pale, colored and thin visible strokes and allowed white
image tiles behind text. It took 67.26 seconds but split a separate `(2)` score
marker between two overlapping layout regions. The fourth region revision
keeps the original detector for both sides of a region overlap. A separate
source-confirmed change restored an omitted question number and was retained
as an improvement, rather than forcing byte equality.

The third region revision's complete 64-page screen took 282.3 seconds against
301.5 seconds for the fresh baseline. Both scored 52/57 raw and 49/57 chunk
probes. Direct comparison rejected the candidate: ordinary PPTX and Spanish
prose acquired false superscript/subscript markup, and a Spanish paragraph lost
whole phrases. Eight cases changed. Some changes improved Japanese text and
biology-index grouping, but those improvements do not compensate for lost prose.
The failed output remains in `screen-native-text-v3`. Its measured digital case
bypassed 183 of 316 regions; 185/318 includes warmup.

The fifth region revision preserves PDFium's original line boundaries before
filtering characters into regions. It also replays MinerU's own text-fill
assignment before accepting a shortcut: each intended character must be owned
once, with no invented superscript/subscript role, and the resulting text must
match the source line. This checks the actual downstream contract rather than
assuming native boxes are interchangeable with detector boxes.

The focused v5 run takes 69.12 seconds on the digital fixture, 11.1% below the
fresh 77.79-second baseline. Its 330 blocks differ only in the restored question
number. The original PPTX and Spanish failures now match baseline JSON exactly;
the mixed Chinese/English sample differs only in two spaces around Latin terms.
Measured digital work skips 179/316 detector regions; native reading and checks
cost 3.47 seconds. The remaining guards protect demonstrated failure boundaries,
so eligibility tuning stopped at v5 before the broad run. The full and long
results above subsequently ruled out promotion.

The complete v5 screen takes 284.97 seconds against 301.54 seconds, a 5.5%
reduction in this pair. Sampled peak memory falls from 3.34 to 2.91 GiB, with
no swap. Scores remain 52/57 raw and 49/57 after chunking. Twenty-five of 30
content lists are exactly equal. All non-text blocks and all 71 exported image
files are identical. The five changed cases contain restored German TOC
leaders, restored Japanese prose and spacing changes. The TOC creates two extra
chunks, but each title/page-number pair stays together and existing body chunks
are unchanged. The screen grows from 185 to 187 chunks. Its full source review
is retained separately from the sparse probes.

This arm has a limited speed ceiling. The earlier matched digital logs put
general text detection at roughly 15–16 seconds of a 79-second parse. About
25–26 seconds of layout, 13–15 seconds of formula recognition and 15–16 seconds
of table work remain. These rounded stage logs are not an additive CPU profile,
but they explain why bypassing part of text detection cannot close the Java gap.

## Whole-page coverage and review

The page guard's first revision accepted 12 real intact-document pages. Better
paragraph grouping and narrow source-word joining raised that to 26. Explicit
clipping, transparency-group and widget checks reduced it to 24. All these
counts additionally contain 80 repeated synthetic slide pages. The v4
eligibility inventory has 104/430 intact pages accepted, but only 24/348 pages
after excluding the two lecture fixtures, or 6.9%. Its three accepted screen
pages are synthetic. Eligibility is not a quality or speed result.

An independent reviewer reproduced a coordinate mismatch for PDFs with
`/UserUnit 2`: PyMuPDF doubled the page and text boxes, while this PDFium release
retained the original coordinates. Native-page v4 rejects non-unit UserUnit
values. The reviewer independently verified that fix and the region-overlap
fallback. The remaining partial-visibility guard is a heuristic: a partially
occluded word can pass. That has not been shown to differ from MinerU's own
native filling and is not counted as a demonstrated new regression.

The actual v4 focused run rejects this revision as a general optimization.
Four German Putnam pages bypass models and retain all 33,801 non-whitespace
body characters; all 44 chunks keep the same text ignoring whitespace, and two
cross-page chunk ranges improve. Ten Japanese pages bypass models but damage
structure: running headers enter body text, subsection headings lose their role,
and reference-marked chunks fall from 14 to six. Equal source-probe scores would
miss these failures. Eight eligible Chinese pages do not actually bypass in v4
because MinerU classifies the complete document as OCR.

V5 rejects unresolved paragraph fragments, hanging indents and ambiguous heading
styles, including short numbered subsections. All Japanese pages now retain the
original models. It additionally supplies inspected MuPDF line text on eligible
pages already in OCR mode; digital pages still use PDFium filling. The Chinese
document's OCR classification originates in a dotted table-of-contents page,
which the page guard independently rejects. This does not override the document
mode or force native extraction on rejected pages.

Final source eligibility is 92/430 pages, including the 80 repeated synthetic
slides. Real coverage is only 12/348 pages (3.45%): five German and seven Chinese
pages. The actual v5 focus finishes in 151.92 seconds, versus 192.03 seconds for
the same three documents within the fresh full baseline. It skips four German
pages and seven Chinese OCR pages; all 247 Japanese output blocks are exactly
equal to baseline. These focused times do not establish a full-corpus gain.

V5 is rejected despite the gain. The Chinese paragraph beginning “In terms of
theoretical contributions” crosses physical pages 9–10. V5 retains its words
but puts the continuation in a page-9 block, leaves the page-10 block empty and
removes the page-10 citation region from the corresponding chunks. A source
render confirms that the continuation is printed on page 10. The other Chinese
changes are source-correct typography and spacing. German v5 matches baseline
text and chunk page ranges, with tighter boxes; the incidental v4 cross-page
improvements are no longer present. Correct text alone is insufficient.

This is the stopping point for the page arm. Reverting OCR-mode bypass would
leave only five real German pages. A simple guard requiring complete paragraphs
at both page edges rejects all remaining real eligible pages. Preserving useful
coverage would require deeper ownership of MinerU's paragraph reconstruction
and citation propagation. That complexity is disproportionate to the measured
coverage, and relaxing the existing guards reopens earlier heading/reference
failures. V5 remains a frozen rejected experiment.

No page qualifies in the 610-page textbook or either 26-page capacity fixture.
The textbook has images on 609 pages and insufficient text on the remaining
page. Any gain on those inputs must come from the region shortcut.

## Improved Java comparison

The fresh Java run uses the same 430-page corpus and resource ceiling. Native
extraction, basic inspection, selective OCR and image adaptation/deduplication
take 62.44 seconds, with 1.13 GiB sampled peak memory and no swap. The phase
receipt is `java-full-r1/complete.json`: 53.33 seconds native, 2.39 seconds basic
inspection, 0.02 seconds OCR job preparation, 6.47 seconds OCR and 0.23 seconds
adaptation. A separate fresh structural inventory takes 43.77 seconds. It is
not included in 62.44 seconds. Structural page selection/rendering, caption
requests, response adaptation and chunking are additional work.

Fresh structural selection and rendering take 28.26 seconds and select 212
pages. These three executed preprocessing stages sum to 134.48 seconds before
captions; they were measured as separate invocations, not one complete pipeline
request. The previous final plan selected 196 pages. The 16 extra selections
are image-triggered pages in the Japanese slide deck; no prior selected page is
removed. This comes from missing files in the earlier selector input: its local
Japanese output had 158 image records but no external image files. The old VM
archive and fresh output contain exactly the same 785 blocks and 158 image
placements when image paths are compared by file hash. Restoring the files
exposes 67 unique images, including one repeated image on all 16 added pages.
The Java parser did not newly extract those images. All 196 common PDF hashes
match, but only 173 rendered PNG hashes match.
Equal PDF hashes, renderer versions and image dimensions do not establish exact
request identity.

Fresh native outputs with the existing encoding repair and structural packing
pass 38/44 raw and 37/44 chunk probes. The previous structural Java result
reported 44/44 after replaying only 36 matching cached page responses; 160 of
196 selected intact-document pages still had no executed caption. That result
does not establish complete-caption quality or current end-to-end latency.

Of those 36 cached responses, only 30 match the fresh renders. The new replay
verifies the original request/response bindings, source PDF and image hashes,
and target PDF and image hashes before applying them. Six old matches are
rejected; 182 of 212 freshly selected pages remain uncaptioned. Java still
passes 44/44 raw and chunk probes with these 30 pages, showing how little of the
full request set the known probes exercise. Applying the same 30 page responses
with the same structural packing to fresh baseline MinerU gives 43/44 raw and
39/44 chunk probes. Region v5 gives the same 43/44 and 39/44 on that identical
30-page replay. These are offline quality controls, not complete executions
with current provider latency.

For a controlled screen comparison, the retained native-image caption replay
contains 19 placements of 18 unique images, all matched by source PDF and PNG
hash and bound to recorded responses. The fresh MinerU baseline reaches 53/57
raw and 50/57 chunk probes with these captions, versus 52/57 and 49/57 without
them. A separate common-page replay applies the same 34 selected placements
(33 unique PNGs) used by the final Java structural screen. Baseline MinerU then
reaches 55/57 raw and 52/57 chunk probes; Java reaches 57/57 for both. The common
page set was chosen by Java's recovery policy and is a controlled replay, not
a newly optimized MinerU caption policy or fresh provider measurement.
The Java source review still finds incorrect graph descriptions, abbreviated
headers and relationships split between chunks. Perfect anchor scores do not
establish faithful extraction. Reusing the same responses preserves those
limitations in both parsers.

Repeating both saved-caption comparisons on v5 gives the same probe scores as
baseline MinerU. Its 19 native-image jobs are independently verified against the
new output's PDF and image hashes before replay. The extra two TOC chunks remain;
caption replay does not remove that indexing cost.

The older 480.64-second Java/Qwen run contains 390.66 seconds of Qwen work, but
uses the older literal prompt and request set. Adding that historical Qwen time
to new extraction measurements would not produce a measured complete result.
Captions remain expensive, but Java page recovery and MinerU figure captions
have different scopes and counts. The fresh full MinerU output selects 164
native image artifacts across its 22 documents; Java selects 212 whole-page
placements. These selection counts are not executed request measurements, and
the image dimensions and requested content also differ. Their costs are not
automatically equal.

## Recommendation

Keep production parsing unchanged. The guarded region hook reduces memory and
helps this repeated digital fixture, but it does not remove enough total work
to produce a consistent broad speedup, and it introduces source and citation
losses. The page hook skips the expensive models more directly, but conservative
real-page coverage is low and its reconstruction failures remain unacceptable.
Version-bound benchmark hooks were sufficient to establish this; a maintained
fork was unnecessary for the experiment and is not justified by its outcome.

Java with selective recovery remains the stronger performance direction. Its
fresh measured preprocessing stages total 134.48 seconds for the same 430 pages,
versus 909.58 seconds for region v5, before captions in both cases. Java's total
is a sum of separate invocations, and the improved full-page caption plan has
not been executed completely. Its perfect known-probe replay score is therefore
neither complete-caption validation nor general extraction accuracy. Further
work should target recovery selection, caption fidelity and preservation of
source relationships through chunking, with those limitations measured directly.

## Evidence locations

Raw output is retained locally under
`bench/parsers/reports/local/2026-09-09-mineru-native` and on the VM under
`/opt/capy-mineru-native-20260909`. Each run uses a new name. Failed revisions
remain part of the record. Model-free checks are
`check_mineru_native_text.py` and `check_mineru_native_page.py`; saved outputs
use the existing `evaluate_opendataloader.py` and the actual Capy chunker.

The full-run closing review and confirmed agenda loss are in
`diagnostics/native-closing-review.md`. The complete Japanese-paper review is
`diagnostics/text-v5-full-japanese-review.md`; the other changed full documents
are covered by `diagnostics/text-v5-full-review.md`. Source renders and complete
before/after records accompany those reviews. `full-v5-furniture-routing.json`
checks the changed furniture decisions across all 22 documents and identifies
exactly the three agenda entries. `diagnostics/text-v5-long-review.md` classifies
every substantive textbook change and includes the source crops and actual chunk
comparisons supporting its three regressions.

Both focused model-free checks and the required Python formatting/lint checks
passed. Saved execution-source hashes, source PDF hashes and replay bindings
were verified. Independent source review found the regressions described above;
passing the focused checks is not a production-quality approval. All measured
containers exited, and the shared host has no remaining benchmark workload.

The source probes are sparse and do not establish all-page fidelity. Content
diffs and source review are required in addition to their pass counts.
