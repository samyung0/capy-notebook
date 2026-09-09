# Qwen3.8 Flash and Java page recovery

September 8, 2026 UTC. Follow-up to the
[Java recovery experiment](2026-09-08-java-recovery.md), authorized in the
[Qwen plan](2026-09-08-qwen-java-recovery-plan.md).

Qwen makes caption recovery much faster than the tested GLM service. It does
not make image transcription lossless. Giving the model the original page
helps it associate figures with the surrounding explanation, while an explicit
literal prompt improves several examples and damages others. The remaining
problems include page selection, chemical notation, table headers and chunk
boundaries.

All changes are benchmark code, fixtures and reports. Production parsing,
caption configuration, application caches and databases remain unchanged.

## What was compared

- Replayed the same 83 native-image requests, 64 Java and 19 MinerU, with the
  frozen Capy image prompt, JPEG quality 80, 1,280-pixel maximum edge and
  concurrency four. The jobs contain 72 distinct image hashes. Qwen thinking
  was explicitly disabled. Earlier GLM results are retained controls, not
  contemporaneous randomized measurements.
- Replayed 20 source regions, including 18 automatic crops and two explicitly
  manual equation controls. Repeated them with Qwen thinking enabled and a
  2,048-token thinking budget. Automatic composed variants use only the 18
  automatic crops.
- Selected 25 of the 64 screen pages for original-page context at a real
  2,560-pixel render. A non-scan page is selected when it has a captionable
  image, a flagged vector drawing or a Java table. Scans retain direct OCR.
  Exact-image aliases contribute every page placement. An initial path-only
  24-page selection was retained as an invalidated planning artifact before
  any context requests used it.
- Compared the frozen Capy prompt with a generic literal-record prompt on the
  same 25 pages. The latter requests source-language text, table associations,
  formulas and approximate plotted values without answering exercises or
  inferring mechanisms. No answer keys were sent to either provider.
- Manually selected three previously missed French, Japanese and Hong Kong
  pages. These are capability controls, not automatic recovery successes.
- Froze 16 source questions on eight additional caption pages before calling
  either model. Both received the same full-page images, literal prompt,
  resolution and concurrency. The full PDFs had been parsed previously; these
  are additional caption pages, not unknown-document or random holdouts.
- Ran eight explicit diagnostic requests for the two initially empty Qwen
  responses. These repetitions do not replace first-attempt failures.

The provider returned `qwen3.8-flash`. The Alibaba workspace model inventory and
request/response options are retained. Alibaba's
[vision documentation](https://www.alibabacloud.com/help/en/model-studio/vision)
and [thinking documentation](https://www.alibabacloud.com/help/en/model-studio/deep-thinking)
were checked before the calls. All calls used synchronous OpenAI-compatible
chat completions, an 8,192-token output limit and no automatic retries.

## Caption latency and cost

These are complete batch wall times, with encoding and requests included.
They exclude native parsing and subsequent chunking. Per-request medians
include every recorded attempt, including incomplete responses.

| Batch | Complete responses | Batch seconds | Median request seconds | Observed/estimated USD |
| --- | ---: | ---: | ---: | ---: |
| Qwen, original 83 images | 81/83 | 189.73 | 7.71 | 0.02026 |
| Prior GLM, same 83 images | 81/83 | 1,566.71 | 65.55 | 0.01308 |
| Qwen, 20 regions | 20/20 | 52.22 | 8.48 | 0.00587 |
| Prior GLM, same 20 regions | 20/20 | 256.59 | 29.36 | 0.00387 |
| Qwen, 20 regions with thinking | 20/20 | 76.00 | 14.06 | 0.00863 |
| Qwen, 25 full pages, Capy prompt | 25/25 | 93.98 | 11.78 | 0.01524 |
| Qwen, 25 full pages, literal prompt | 25/25 | 84.21 | 11.16 | 0.01452 |
| Qwen, eight additional pages | 8/8 | 28.23 | 12.67 | 0.00533 |
| GLM, same eight additional pages | 8/8 | 125.01 | 53.10 | 0.00588 |

The matched original-image batch was 8.26 times faster with Qwen. The newer
same-input eight-page comparison was 4.43 times faster. These are observed
service measurements, not model-wide latency guarantees. The eight-page arms
ran sequentially in the same session and were not randomized or repeated.

Qwen cost uses the supplied USD rates per million tokens: 0.113 uncached input,
0.014 explicitly reported cached input and 0.382 output. Reasoning tokens are
part of reported completion tokens and are not charged twice in the estimate.
GLM values use its response `estimated_cost`. This is token accounting, not an
invoice. Tokenization and image-token accounting differ between providers.

The complete follow-up made 375 Qwen requests and eight GLM control requests.
Qwen returned 372 nonempty complete responses and three empty responses across
the primary runs and explicit controls. Estimated Qwen cost is **USD 0.16977**;
GLM control receipts total **USD 0.00588**. The 179-request intact run accounts
for USD 0.09443 of the Qwen total. Qwen reported 761,828 input tokens, including
46,976 cached tokens, and 231,238 completion tokens across all runs.

### Empty responses remain a problem

Two original Qwen image requests returned HTTP 200, `finish_reason: stop`, an
empty answer and nonzero completion usage. They are counted as incomplete,
not successful captions. Both depict the sports newspaper scan. They were
not timeouts. The composed Java/OCR paths do not use those scan captions.

Two exact-request repetitions per image returned nonempty captions. A literal
prompt control still produced one empty response in two calls; two thinking
controls returned nonempty text. The evidence demonstrates nondeterminism,
not a reliable fix. Cached input was reported on the second exact repetition.
A nonempty response also does not establish faithful transcription of repeated
newspaper prose. Automatic retry behavior was not added to production.

## Content and chunk checks

The existing 57 executable probes retain their original meaning. A table-row
probe requires a structured HTML row and its survival through the real Capy
chunker. Correct prose does not earn a structured-table pass.

| Screen variant | Raw probes | Chunk probes |
| --- | ---: | ---: |
| Java with headers and direct scan OCR | 45/57 | 45/57 |
| Same, Qwen native-image captions | 45/57 | 45/57 |
| Same, Qwen image and automatic-region captions | 45/57 | 45/57 |
| Same, regions with Qwen thinking | 45/57 | 45/57 |
| Java/OCR and Qwen full-page context, Capy prompt | 46/57 | 46/57 |
| Java/OCR and Qwen full-page context, literal prompt | 46/57 | 46/57 |
| Literal context plus three manual page controls | 47/57 | 47/57 |
| MinerU and Qwen native-image captions | 53/57 | 50/57 |
| Prior MinerU and GLM native-image captions | 53/57 | 50/57 |

All seven new variants contain 30 screen cases and use the actual current Capy
chunker. Captions supplement native text/tables. They do not overwrite a valid
table. Existing invalid native structures can therefore coexist with a correct
caption. The automatic context variant recovers the previously failed four-anchor
biology index order check, which does not certify the full index's order.

### Graphs, formulas and relational questions

A separate reviewer inspected five source pages and 24 existing questions
across all six Qwen variants. A pass requires explicit raw support and one
actual chunk preserving the relationship. A conflicting claim counts as wrong
even when correct native text also survives.

| Qwen variant | Pass | Partial | Missing | Wrong |
| --- | ---: | ---: | ---: | ---: |
| Java/OCR, native images | 15 | 4 | 5 | 0 |
| Java/OCR, images and automatic regions | 21 | 3 | 0 | 0 |
| Same, regions with thinking | 20 | 3 | 0 | 1 |
| Java/OCR, page context and Capy prompt | 22 | 1 | 1 | 0 |
| Java/OCR, page context and literal prompt | 20 | 2 | 1 | 1 |
| MinerU and Qwen images | 16 | 3 | 1 | 4 |

Page context with the existing Capy prompt performs best on these questions.
It recovers the enzyme endpoints, reversible equation and both cosine operands.
The remaining partial answer is the CIL workflow split across chunks. The
missing answer is an explicit statement that the photosynthesis graph has no
numeric rate scale; the model does not invent a numeric rate.

The counts still miss errors outside the exact questions. The ordinary region
caption infers noncompetitive or mixed inhibition even though the source says
competitive. The thinking variant says raising temperature from 15 to 20 degrees
raises the plateau, contradicting the shared experimental line. The literal
page prompt drops both subscript 3s in the ethanol/ethanal equation, introducing
a conflict with correct native text. The Capy-prompt page caption also describes
parts of the photosynthesis line geometry inaccurately despite retaining the
checked plateau relationships.

For MinerU images, Qwen confuses plateau labels, counts ten CIL skill boxes
where the source has eight, and reverses the keyword-extraction arrow. Its
fourth wrong judgment comes from an inherited native MinerU `T_p`/`T_D`
discrepancy, not a Qwen caption. These are composed-output scores, not pure
model accuracy. Qwen is cautious about individual unlabeled skull images;
whole-table captions retain the seven brain-size associations.

### Previously missed tables and text

The DOCX page is selected automatically. Both prompts correctly recover Biology
with 92 and History with 88; the literal prompt keeps separate rows. The native
HTML rows remain malformed, so the strict table probes still fail.

On the manually selected French page, Qwen correctly transcribes the complete
LARGE and OSCAR rows with their column headings. The automatic page rule does
not select this page. This establishes model capability and a selection miss.

The manually selected Japanese page retains the checked Qwen3 row numbers, but
collapses grouped role/qualifier headers into an inconsistent Markdown table.
The full mapping from each role to its score is still unreliable. The Hong Kong
control recovers the Tong 1999 study, 159 students and social-identity direction;
its page is also missed by automatic selection. Some odd wording already
exists in the PDF and was not attributed to the model.

### Eight additional pages

Both models preserve all 16 frozen facts in raw captions. Each keeps 15 complete
answers together in one self-contained chunk. Qwen splits the French 100k/500k
comparison from its reported improvement. GLM separates the Japanese cost row
from its column headings. Multi-chunk retrieval could recover that context;
retrieval was not measured here.

These scores miss substantial errors outside the selected questions:

- GLM invents a long sequence of repeated German words and then explicitly
  claims the repetition appears in the source.
- GLM replaces a Chinese equation with the decorative-return instruction from
  the prompt and changes part of the clustering explanation.
- Qwen transcribes the German graph's axes and legend but omits the plotted
  observations. It drops a Chinese character in prose and inaccurately places
  the peak of the French NLI curve.

The source review is AI-reviewed evidence against the actual page pixels,
not human-certified accuracy. Its per-question verdicts and additional errors
are retained separately from the 57 executable probes.

## Intact-corpus execution

The preliminary results justified one additional 179-request run on all 22
intact files, 430 pages. The initial 240-call plan explicitly allowed expansion
when quality and latency warranted an intact trial. The expansion decision was
recorded before the run; it does not approve production use.

The new isolated ingest-host container has eight CPUs and a 14 GiB memory limit.
It performs fresh Java extraction with headers, source inspection, direct OCR
for six scan images, physical image deduplication, fresh 2,560-pixel page renders,
Qwen calls at concurrency four, and caption attachment/artifact adaptation.
The execution uses a frozen automatic 179-page plan from this same corpus.
It does not measure how well the routing rule generalizes to unseen PDFs.
PDF hashes bind the plan; fresh render hashes bind the actual requests.

The complete execution took **480.64 seconds**, with 179/179 captions applied.
Peak container memory was 1.21 GiB and peak swap was zero.

| Phase | Seconds |
| --- | ---: |
| Java, inspection, OCR and initial artifact adaptation | 65.00 |
| Fresh page renders | 24.60 |
| Qwen requests | 390.66 |
| Caption attachment and final artifact adaptation | 0.39 |

The outer timing includes process and sampler shutdown overhead. The nested
native run measured 53.30 seconds of Java extraction, 2.34 seconds of source
inspection and 8.38 seconds of OCR. It completed all 22 files and six OCR jobs.
The caption-inclusive path is about 2.01 times faster than the earlier 964-second
MinerU extraction baseline, while Java/OCR alone retains the larger speed gain.
This is one measured full execution using the literal prompt, not a repeated
latency distribution or a timing measurement of the Capy-prompt variant.

On the intact corpus's 44 existing probes, Java/OCR passes 37 before chunking
and 36 after. Adding Qwen page captions yields **38/44 before and after**.
The earlier MinerU run passes 40/44 before chunking and 36/44 after, with
different failures. Captions recover the index anchor order and the Japanese
slide-topic chunk. The remaining six failures concern two French rows, a
Japanese embedded table, a Hong Kong phrase and two DOCX rows.

All image files are present and artifact limits pass. The 532 inherited
out-of-bounds native boxes remain visible in the diagnostics. Page captions
use whole-page citation boxes, so they lose the precision of a tight figure
crop. Caption addition increases chunks from 994 to 1,287 and chunk characters
from 700,505 to 1,036,336. That duplication has an indexing and retrieval cost
not included in the measured eight minutes.

Chunking, embeddings, indexing, object storage and application job orchestration
are outside this timing boundary. Earlier MinerU extraction time excludes its
own captioning stage, so it is not a full-pipeline comparison.

## Recommendation after testing

Keep Java with header retention and direct OCR as the extraction candidate.
Qwen is worth pursuing for selected visual recovery: its measured latency is
far more practical than the tested GLM service. The best current quality arm
uses the existing Capy prompt on original pages, preserving native text and
tables. It passes 22 of the 24 relational checks, but still makes untested
geometric claims and splits a workflow across chunks.

Do not infer that a model swap alone fixes retrieval quality. Native-image
captions leave Java's vector-only graphs absent, and Qwen introduces some new
diagram mistakes on MinerU crops. Thinking adds latency without a consistent
quality gain. The literal prompt is useful for some text/table controls but
corrupts chemical notation; it is not a demonstrated default improvement.

The remaining implementation work is concrete: capture pages missed by the
selection rule, preserve grouped table headers, keep a figure's essential
relationships together through chunking, and handle empty provider answers as
failed recovery. Those changes require a separate production decision. This
experiment does not change the application or claim that its remaining content
errors are acceptable for students.

## Reproduction and evidence

The [parser benchmark README](../README.md) describes the commands. Relevant
additions are `bench_java_recovery.py context-pages`, its explicit provider
configuration, and `measure_java_page_context.py`. The production caption
prompt is frozen in raw artifacts; the experimental prompt is
[`image-record-literal.txt`](../fixtures/image-record-literal.txt).

Raw responses, manifests, hashes, options, timing and source reviews are under
[`local/2026-09-08-qwen-java-recovery/`](local/2026-09-08-qwen-java-recovery/).
The earlier frozen corpus and OCR/native controls remain in their verified
archives. No provider credentials belong in the report or archive.

## Verification and cleanup

`pnpm run fmt:py`, scoped Ruff checks, the saved-recovery offline check and the
OpenDataLoader adapter/citation/chunk check pass. The recovery check includes
provider options, returned-model mismatch, response credential redaction and
an injected native failure that produces a failure receipt without a success
receipt. No production tests or services were changed.

Independent review verified all 204 local request receipts and 210 screen
records. A separate post-copy check verified every one of the 179 integrated
responses against its job, PDF hash, actual render hash and returned model.
Of the fresh VM PNGs, 156 match the prior local-render byte hashes and 23 differ;
actual request hashes are retained for all of them. The page plan binds source
PDF pages, not identical cross-platform raster bytes.

The successful VM run used the retained execution snapshot. Later provenance
guards and failure receipts were checked offline; the post-copy verification
covers every actual VM request. A fresh
[closing review](local/2026-09-08-qwen-java-recovery/review/qwen-java-final-review.md)
found no material numerical, attribution, correctness or scope errors.

The verified VM archive contains 3,233 manifest entries and is 285,348,534 bytes.
Its SHA-256 is `53a209e16d1db6c7631c8b0dfdd866d0626d5c9ad4fea18881e5e923067d9ad3`.
The verified analysis archive contains 2,598 entries and is 152,367,761 bytes.
Its SHA-256 is `8b76dd2db3b2d770ee2e3364bca6f7914d8454f1f83de81bc3cc1862d59cd299`.
Both manifests verify every content hash, including exact-image hardlinks.
The analysis archive includes local request inputs, responses, source reviews,
chunk evaluations and source-code snapshots. The separate VM archive holds
native/execution artifacts. This final report and subsequent closing-review
note are separate from those archives.

Only `capy-qwen-recovery-eval` was removed, after local VM archive verification.
No Docker containers remained on the host at cleanup. VM result directories
were preserved. Both temporary credential copies were removed; scanning 1,625
written text artifacts found no copy of the supplied key. Cleanup and archive
verification receipts are retained in the raw result directory. No commit or
pull request was created.
