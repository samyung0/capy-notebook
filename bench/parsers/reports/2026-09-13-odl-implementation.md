# ODL repair implementation and local verification

The approved work covers short-chunk retention, new-source validation, native
table repairs, guarded fresh-OCR ordering, and local application/runtime checks.
Implementation is in the shared uncommitted main worktree. No UAT deployment,
shared ingest-host change, live database operation or paid model call was made.

## What changed

The chunker now keeps unique short source prose and omits tails containing only
carried overlap. The unused minimum-chunk setting is removed. Furniture is
handled before packing. The parser classifies isolated decimal and Roman folios
only when PDF text, font, position and ordinal offset agree on at least three
pages. Proven folios lose heading metadata, preventing heading retention from
adding them back. The saved-bundle regression keeps the 200-chunk historical
golden intact.
Of those, 198 chunks remain unchanged; two page-45 chunks lose only duplicate
prefixes and boxes incorrectly carried across intervening oversized tables.
The source-backed page-13 heading and page-45 exclusion note are checked
separately, giving 202 final chunks. A source-independent three-page case
checks that earlier overlap cannot jump past an oversized block.

Native table recovery now handles mixed text/value columns, explicit source
header/group scope, body-only replacement bounds, captions, units, footnotes
and literal source styles. Existing native and supported numeric tables remain
protected. Raw HTML keeps source values; checked row/column metadata supplies
literal bold and gray-background notes to the corresponding packed cells.
Ambiguous ownership leaves source text in its native form.

Fresh OCR uses the pinned PP-DocLayoutV3 model to order regions. Each OCR line
must overlap exactly one region by at least half its area. Missing or competing
regions cause whole-page abstention. Within-region ordering, text, scores and
boxes remain unchanged. No table-row clustering or partial reordering is used.
The 17 earlier source geometries are retained as regression checks, including
the cases that made partial ordering unsafe.

Parser/client identity is `odl-2.5.7-refined-rapidocr-v3`; chunker identity is v9.
The requirements lock adds only `rapid-layout==1.2.1`; the layout model is
hash-pinned in the image. Actual non-root container startup exposed and fixed
an existing Docker copy-permission problem: the ODL package directory needed
execute permission, not the file-only `0644` mode.

## Evidence and boundaries

Development comparisons and the new source-family validation are separate.
The initial native port recovered all 39 labelled Chinese/French rows plus five
BERT rows. Independent review found nearest-row attachment of loose text,
excessive caption attachment, competing OCR-region ownership and a missing
Traditional Chinese note label. All four corrections passed source-independent
PDF/geometry repros and an independent 84-test recheck. The safer final native
pass preserves 34/39 development rows as structured tables, plus all five BERT
rows. It abstains on five French genre rows whose wrapped cells lack a proved
anchor association, preserving all 11 intersecting native blocks unchanged.
All 39 retained structured rows stay in source order and all 53 source style
cells retain their literal scope. Seven table-pass controls remain unchanged,
including 14 Hong Kong and four CCL numeric-table recoveries. These are
development/replay results, not unseen-source accuracy.

The new validation freeze has four publisher families, 67 native pages, 12
selected pages, 41 checked table rows, four derived raster controls and four
deliberate negative controls. Its manifest SHA-256 is
`3c5a6271b3624bc3638b264bc79609eeb594a1d304093a38e9ea67d6e6f0c7e7`.
Source pages and gold were recorded before Java or candidate output was viewed.
The raster controls reuse those pages and are not independent samples.

The definitive comparison uses production-matched Java flags and repacks the
saved candidate blocks with the final chunker. Both arms match 38/41 checked
rows and 238/256 checked cell texts. The three MDPI rows remain flattened.
The 21 Scientific Reports row checks cover six of each table's 12 columns;
the remaining columns are unscored.
Both have 12/52 wrong source-region pairs and 18/61 wrong final-chunk region
pairs; the Frontiers side-by-side table continuation remains in the wrong
order. The four fresh raster controls show no measured ordering gain or
regression. Header association and OCR character accuracy are unscored.
The source/gold was not retuned. These are preservation and failure-detection
results, not a new-source improvement claim. The
[validation report](2026-09-13-odl-repair-validation.md) records the original
baseline mismatch, corrected comparison, source/runtime hashes, ambiguous
annotation boundaries and the distinct image-dedup versus text-scoring scope.

The opt-in local integration test passed again on the final image in 15.38
seconds against actual parser HTTP and a
disposable Postgres/Redis pair. It validated creator-owned bundle receipts,
worker chunking and OCR confidence, SQL indexing and both hybrid-search legs,
guarded source JPEG capture, image injection, and used-only citation numbering.
All 24 source style cells survived the native test page; six chunks were stored.
The OCR-spanning chunk carried confidence 0.5 and the OCR reason. A first test
incorrectly assumed the chunk began on page 2; the retained page-1 folio made its
correct source span pages 1–2. That failed run is preserved.

The integration test uses deterministic model and object-store substitutes. It
does not claim model-answer quality, browser navigation, gateway upload HTTP,
chat HTTP, or a live worker job-claim/commit run. Separate SQL tests cover the
durable state operations and metering contract. The captured JPEG was visually
checked against the generated source page.

## Container measurements

Local Docker has 1.93 GiB RAM and 1 GiB swap. The first runs used a 1600 MiB
container limit, no swap, four CPUs and a 1 GiB JVM heap. These limits differ
from the ingest host's configuration and do not establish its capacity.

The four-document OCR burst returned four 200 responses and one 429 capacity
refusal. Exactly one document executed at a time; three waited. End-to-end
latencies were 41.09, 79.64, 119.02 and 160.74 seconds, including FIFO wait.
The fifth request was refused in 4 ms. Peak cgroup memory was 1,418,641,408 bytes,
with no OOM in the burst.

The 610-page, 26,964,227-byte textbook failed in the warm no-swap container after
97.59 seconds. The kernel killed a child; the supervisor returned `parse_oom`,
quarantined the active fingerprint and exited. A cold no-swap run reached OCR
after Java/refinement, then the kernel killed Python itself at 152.75 seconds.
That run exposed an in-process watcher defect: a killed API process could not
write quarantine. The raw failures remain part of the evidence.

The parser now keeps queue/deadline/OOM supervision in the API and runs parse
work in a persistent spawned child. The child has a separate process group and
Linux OOM preference; temporary files avoid large pipe copies. The API can
quarantine an unfinished document even when Python OCR itself is killed. A
repeat of the cold 610-page no-swap case returned 422 `parse_oom` and wrote the
correct marker after 171.77 seconds, replacing the unclassified exit 137.
The final image also defers repair imports into the child, leaving startup
process RSS around 115 MB. The runtime also keeps admission and deadlines
alive when an executing
multipart caller cancels; queued cancellation removes only the waiting work.
Persistent loops release the previous source/result before accepting another
document. Twenty-three runtime tests cover these cancellation cases, process
reuse, timeout termination, current-only quarantine and ordinary child death.

Before image deduplication, the parser completed extraction of the cold
textbook in 172.02
seconds when allowed 1,000 MiB of additional swap. It read two pages through
OCR and recorded no OOM events. Peak cgroup memory was 1,677,725,696 bytes and
peak swap was 1,013,829,632 bytes. Bundle publication then returned HTTP 500
`parse artifact contains too many entries` at 178.04 seconds. The existing
4,096-entry cap remains unchanged. This failed run exposed repeated image
files. The service remained usable, and the small integration passed afterward.

Lossless deduplication then resolved the publication failure. The final rebuilt
container returned HTTP 200 for all 610 pages in 167.12 seconds. Its 29,488
blocks retain all 17,821 image occurrences, backed by 2,322 distinct image
files. Every image reference resolves. The complete bundle is 111,249,108 bytes
and has 2,326 entries, below the unchanged cap. Peak memory was 1,607,802,880
bytes and peak swap 7,163,904 bytes, with no OOM events. The production
pipeline client also validated identity, checksums, all byte
limits and all 2,326 entries, then extracted the 29,488 blocks in 1.10 seconds.
This measures local parser publication and bundle integrity; it does not
index the textbook or
evaluate answers about its contents. Every occurrence keeps its source box and
its exact original image bytes; no distinct image was dropped.

Final offline verification passed 688 tests; 122 integration tests were
deselected. The separate disposable SQL suite passed 121 tests earlier, and
the opt-in real-parser integration above accounts for the remaining test.
Model replay passed four cases. Python formatting and applicable Ruff checks
passed. The final depth-2 warm queue burst, after the textbook run, returned
200, 200
and 429. Latencies were 47.99 and 93.47 seconds with the second request waiting
47.84 seconds in FIFO; the refusal took 2.6 ms. Exactly one document executed
at a time. The service lifetime peak over this sequence was 1,677,721,600 bytes
of memory and 323,190,784 bytes of swap, with no OOM. The earlier warm burst
that still retained the previous large result failed and is preserved; it
returned 422 for the executing document, 503 for waiting work and 429 for
overflow, with quarantine only for the executing fingerprint.

A final-image cold test with a one-second document deadline returned 422
`parse_hard_timeout` in 1.13 seconds, wrote quarantine, published no artifact
and exited with code 1. The container reported no OOM. The ordinary 600-second
deadline remains unchanged in production configuration.

A separate final-image run limited to 384 MiB with no swap forced a cgroup
OOM. The API returned 422 `parse_oom` in 4.09 seconds, wrote the active
fingerprint's quarantine marker and published no artifact. This is a negative
supervision check, not a supported operating resource configuration.

The tested image is
`sha256:01f28e7fcdb35a3fb7ea48013cb5a3617a7f8c92cb48bc82a81cbaa64ef37a14`.
All 23 parser Python source hashes in that image match the final worktree
snapshot. The release label is the existing HEAD
`c8595d50c87bd04562d24a0a7235ffa939a5e88d`; it does not identify the uncommitted
patch by itself. `final-build-identity-r3.json` and
`final-image-source-hashes-r3.json` preserve the actual tested source identity.
Disposable parser and SQL/Redis containers were removed after verification.

Raw receipts are under
`bench/parsers/reports/local/2026-09-13-odl-implementation/`; source-family
receipts have their own `2026-09-13-odl-repair-validation/` directory.
