# Page selection and structural recovery

The benchmark candidate recovers all 57 frozen screen probes, compared with
46 after native extraction, scan OCR and source-confirmed encoding repair.
The complete-document replay recovers all 44 probes, compared with 36 in the
native/OCR control. These are known-page text probes. Source review still finds
incorrect graph descriptions, abbreviated headers and relationships split
between chunks. The result does not justify a production parser change.

All new caption requests used Qwen3.8 Flash. Production parser routing,
chunking, model settings and persisted data are unchanged.

## What changed

The selector now uses source table layout, source-text gaps and damaged text
encoding as well as extracted images, native tables and vector drawings.
Previously, a table flattened into plain text could avoid recovery entirely.
The added source layout signal finds the French nine-column results table and
the Japanese table with grouped headers. PyMuPDF cell extraction clipped some
values on these pages, so its output is used only to select pages.

Scans first retain their saved OCR. Wide nearly empty OCR lines, repeated numeric
columns and two-column prose can then trigger a page caption. Six of twenty
screen scans trigger recovery; fourteen stay on OCR. This catches the Hong Kong
page where a full line became `( )`, and the Chinese CIL pages where OCR mixed
the two columns. These rules use source geometry and OCR output, with no answer
strings or document names in the selector.

The Hong Kong digital PDF has compatibility-radical/ordinary-character pairs
where the second glyph has zero width. The candidate removes only pairs verified
on that source page, preserving the ordinary character. It performs 174 such
replacements across the screen corpus. Broad Unicode cleanup would be unsafe
and is not part of the experiment.

Typed recovery separates text, tables and figures. Tables have one explicit
leaf header per column and rows of matching width. The adapter rejects malformed
records. It accepts a whole JSON object, a whole array of typed blocks, or an
enclosing JSON code fence without editing the values. This distinction matters
because valid JSON alone does not establish a usable table.

The candidate chunker composes explicit HTML header spans, repeats those headers
for subsequent row groups and keeps figure paragraphs together where they fit.
An individually oversized table row must still split, but each piece now repeats
the explicit headers. This is not a guarantee that every row fits one chunk.
Supplied figure titles accompany splits. Short numbered headings stay with the
following paragraph. Native prose keeps the production packing rules, and
whole-page generated content has whole-page citations without inheriting an
unrelated native heading. Exact same-page recovered/native paragraph duplicates
can be removed. Approximate matches, formulas and model claims are not rewritten.

## Selection and executable probes

| Corpus | Earlier selected page captions | New page plan | Executed in this follow-up |
| --- | ---: | ---: | --- |
| Screen, 30 cases / 64 pages | 25 digital pages | 28 digital + 6 scan pages | All 34 selected pages have saved new structured responses |
| Intact, 22 documents / 430 pages | 179 digital pages | 196 digital pages | Offline reuse on 36 pages with identical PNG bytes; 160 selected pages have no new structured response |

The full plan leaves all six intact scans on OCR. The added 17 digital pages
come from source table signals. The initial plan also selected encoding-only
pages; source-confirmed repair removes the need for those caption calls.
Selection is deliberately conservative and has false positives. The Spanish
linguistic-bias page is ordinary prose whose layout triggers the table detector.
There is no labeled all-page precision/recall result.

| Screen arm | Raw probes | Chunk probes | Chunks | Chunk characters |
| --- | ---: | ---: | ---: | ---: |
| Native/OCR + encoding repair | 46/57 | 46/57 | 206 | 150,612 |
| Add 30 digital structured responses + exact deduplication | 52/57 | 52/57 | 297 | 211,318 |
| Final selection, 28 digital + 6 scans | 57/57 | 57/57 | 322 | 225,313 |

The middle arm includes two encoding-only digital captions that the final arm
does not need. Exact deduplication removes 93 paragraphs in that middle arm and
86 in the final arm. OCR/native content remains alongside generated recovery,
so conflicts and non-exact duplication can still reach retrieval.

| Intact saved-output arm | Raw probes | Chunk probes | Chunks | Chunk characters |
| --- | ---: | ---: | ---: | ---: |
| Native/OCR, production packing | 37/44 | 36/44 | 994 | 700,505 |
| Encoding repair, candidate packing | 38/44 | 37/44 | 1,162 | 704,737 |
| Add 36 image-identical cached pages, production packing | 44/44 | 44/44 | 1,078 | 791,352 |
| Same recovered blocks, candidate packing | 44/44 | 44/44 | 1,272 | 785,371 |

The intact replay binds each cached response to the new PDF hash and page while
retaining its original request and response provenance. Reuse requires identical
PNG bytes and the same image-only request, not a guessed page correspondence.
These pages overlap the screen experiment, so 44/44 is not unseen-document
accuracy. It also shows that recovery, rather than the new packing alone, fixes
these executable probes. Candidate packing creates more chunks, with a retrieval
and embedding cost that has not been measured here.

## Source review and figure boundaries

An independent AI reviewer checked nine source page images against actual
content and chunks. The existing 24 questions were unchanged. Four extra
table/text checks are reported separately.

| Arm | Pass in one chunk | Partial | Missing | Wrong |
| --- | ---: | ---: | ---: | ---: |
| Earlier Capy prompt, candidate packing with 800-token figures | 23 | 0 | 1 | 0 |
| New structured prompt, 400-token figures | 22 | 1 | 0 | 1 |
| New JSON-object mode, 400-token figures | 22 | 1 | 0 | 1 |
| New JSON-schema mode, 400-token figures | 20 | 1 | 3 | 0 |

Raw content passes 90 of these 96 judgments. Requiring one self-contained chunk
reduces that to 87. All three new arms separate the measurement example's two
15 m means from its 1.9 m versus 5.0 m standard deviations. The structured and
JSON-object captions also reverse the CIL skill-generation branch. Schema mode
omits three numeric enzyme endpoints. No value was corrected after review.

For the four extra checks, every new arm correctly composes the Japanese
table's eleven headers and retains the Qwen3 row. The prior caption leaves its
two header tiers ambiguous. The plain structured French response abbreviates
its nine headers; JSON-object and schema responses preserve them. The DOCX
Course/Score table and Hong Kong social-identity passage pass in every arm.

The earlier CIL caption benefits from an 800-token figure allowance. One chunk
then contains the complete question, keyword, matching, selection and answer
path, including the separate strong-LLM branch. At 400 tokens that relationship
was split. The old caption still misdescribes photosynthesis curve geometry
outside the frozen answers. Increasing the allowance does not repair that error.
The new typed arm has identical chunks with 400- and 800-token figure allowances:
its relevant content is already divided among different typed blocks.

On eight additional pages, 16 frozen questions were reviewed for each of three
arms. After fixing heading attachment, the prior literal caption passes 16/16
in a single chunk. New structured and schema arms each pass 15/16, with a partial
CIL stage-description answer. That is 46 passes and two partial judgments in
48 comparisons, in both raw content and single chunks. These are additional
pages from known documents, not a held-out document distribution.

Source checks outside those questions still find omissions and errors, including
German observations, French curve interpretation, a Chinese formula index,
Japanese title wording and invented arrows. The raw source-review receipts list
them. Structured output is useful for preserving relationships that were read
correctly; it does not make model interpretation trustworthy.

The six selected scan pages also received separate source review. Three of six
structured responses pass the page-level fidelity check, and two of six pass
the actual-chunk check. The rest are partial, with none missing. The biology
caption assigns a merged t-test value to one treatment column. The Japanese
caption puts sample-size metadata inside a condition header. One Chinese
cross-column sentence remains split between chunks. The Hong Kong identity
sentence is restored, but a later negation is corrupted and the damaged OCR
copy still exists. French Table 4 and the second Chinese CIL page pass. These
page-level judgments are separate from the 57 anchor probes and the 24 earlier
source questions.

## Requests, time and cost

| Request arm | Calls | HTTP/nonempty successes | Typed records accepted | Batch seconds | Estimated USD |
| --- | ---: | ---: | ---: | ---: | ---: |
| Structured prompt, screen | 30 | 30 | 30 | 111.7 | 0.02010 |
| JSON-object mode, screen | 30 | 30 | 29 | 118.7 | 0.01229 |
| JSON-schema pilot | 4 | 4 | 4 | 19.8 | 0.00274 |
| JSON-schema mode, screen | 30 | 30 | 29 | 119.7 | 0.01892 |
| Structured prompt, additional pages | 8 | 8 | 8 | 45.8 | 0.00604 |
| JSON-schema mode, additional pages | 8 | 8 | 8 | 36.2 | 0.00597 |
| Selected scans, structured prompt | 6 | 6 | 6 | 38.0 | 0.00505 |
| Total | 116 | 116 | 114 | | 0.07111 |

All runs use Qwen3.8 Flash, thinking disabled, maximum output 8,192 tokens,
concurrency four and a 2,560-pixel maximum image edge. There are no automatic
retries. The two rejected responses remain in the artifacts: one returns strings
instead of typed blocks, the other has inconsistent table row widths. The
initial request ceiling of 80 was expanded to 110 for the format comparison,
then 130 for scan recovery; the recorded decisions precede those requests.

Cost uses the supplied USD-per-million rates of 0.113 for uncached input, 0.014
for cached input and 0.382 for output, applied to response usage receipts. This
is a usage estimate, not an invoice. Batch times include different cache states
and are not model-speed rankings.

Source inspection of all 494 pages took 34.73 seconds locally. Final plan
rendering took 6.07 seconds for the screen and 27.99 for intact documents. The
five-arm intact replay took 9.68 seconds locally. No VM workload ran in this
follow-up, and there is no measured combined production-ingest latency for this
candidate. The previous eight-minute captioned pipeline result must not be
reused as its timing.

## Reproduction and limits

Run `uv run python bench/parsers/scripts/check_structured_recovery.py` for the
focused structure check. The existing Java recovery and OpenDataLoader adapter
checks also pass. `pnpm run fmt:py` passes; the seven changed benchmark scripts
additionally pass explicit isolated Ruff formatting and checks because the
repository Ruff configuration excludes this benchmark directory.

Code review found four artifact-integrity gaps. The evaluator now resolves
images from its selected native output, or an explicitly declared image root,
and records their hashes. OCR routing checks image bytes and all jobs on a
page. New receipts bind to the exact run manifest, including prompt, model and
options. Historical receipts need a separately pinned run/response manifest;
that retrospective binding does not establish provenance absent from the
original receipt. Duplicate job IDs are rejected before execution. Focused
checks cover changed prompts, changed archived responses, swapped OCR hashes,
multiple scan images and duplicate IDs. Replaying with these checks produces
identical selections, content and chunks.

After the oversized-row fix, recomputing 156 screen/intact case-arm chunk lists
produced no changes to the measured corpus outputs. The synthetic long-row
check confirms that every split retains its headers. The fresh closing review
found a duplicate trailing header in this edge case. That defect is fixed, and
the strengthened check requires exactly one header per fragment and complete
row-text reconstruction through a final sentinel. The original reviewer
confirmed the fix and directly affected edge cases, with no regression found.

Raw outputs live in `reports/local/2026-09-09-structural-recovery/`. Key records
are `request-summary.json`, `context-screen-verified/jobs.json`,
`context-full-verified/jobs.json`, `evaluation-verified-screen/evaluation.json`,
`evaluation-full-verified/cache-reuse.json` and the source reviews under
`review/`. Earlier inputs and controls are retained in the September 8 Java,
Qwen and OpenDataLoader archives. Failed and superseded attempts remain visible.
The [raw-evidence archive](local/2026-09-09-structural-recovery.tar.gz) is
221,942,696 bytes. Verification covered all 18,859 entries, including 17,163
hardlink entries representing identical content. Its SHA-256 is
`27c17b92ed6586531225eca56fffc692a409ec91e30cff42f9dd8b3ff6551346`.
The [archive receipt](local/2026-09-09-structural-recovery.tar.verification.json)
records the check. Source snapshots include the candidate scripts, prompts,
frozen questions and the production chunking dependencies used by the replay.
The [final source and review supplement](local/2026-09-09-structural-recovery-final.zip)
holds the corrected source snapshots, final reviews and the 156-case-arm
equivalence recheck. The main raw archive remains unchanged. Its separate
[verification receipt](local/2026-09-09-structural-recovery-final.verification.json)
pins every supplemental file and the ZIP hash.
No VM or container was touched during this follow-up. The temporary local
credential was removed, and a scan of 4,353 text artifacts at that point found
no copy of it. No further provider calls were made after cleanup.

The strongest next step is a new-document validation set with complete table
and graph judgments, followed by a measured intact execution only if source
fidelity holds. This run supports the routing and explicit-header work. It does
not support silently replacing native content with generated page transcriptions.

References: [PyMuPDF table detection](https://pymupdf.readthedocs.io/en/latest/page.html#Page.find_tables),
[Alibaba structured output](https://help.aliyun.com/en/model-studio/qwen-structured-output),
[prior Qwen comparison](2026-09-08-qwen-java-recovery.md).
