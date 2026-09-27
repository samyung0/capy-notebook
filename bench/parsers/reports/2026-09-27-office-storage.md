# Office storage after the September 27 fixes

The native measurements use Capy `50302c8e` and BetterOffice `99d5bcc4`. The additional Chinese presentation was measured at `15c0dbe0`, which changes only a workspace browser-test assertion. All sizes below use decimal KB, 1 KB = 1,000 bytes. Exact bytes, source hashes and component measurements are in [the JSON record](2026-09-27-office-storage.json).

The six application fixtures are the first six of 18 rows. The Japanese presentation also exists at a second repository path with an identical SHA-256; it is measured once. The remaining committed fixtures cover styles, opaque objects, images, long documents, larger decks and up to 100,000 spreadsheet cells. All 18 source paths were verified with Git, including `zh_TW_llm.pptx` under the RAG directory named `local`. These are current measurements, not the pre-optimization numbers in the September 25 investigation.

## File and editing storage

This table measures source-object bytes plus PostgreSQL's stored state, baseline and effect values in an isolated payload table. PostgreSQL 16.15 with `pglz` was used locally, matching UAT's server version and compression setting. The local server is ARM64 and UAT is x86-64. A different row layout can change which borderline-size values PostgreSQL compresses. These are attributed payload values, not an allocation of shared database pages, indexes, WAL or backups. Live application rows and parse/index additions are accounted separately below.

The edit appends the 20-byte ASCII text ` Capy storage probe.` to one existing text target or cell. The overlap branch saves another 18-byte suffix, ` Later saved edit.`, after export capture. Both edits pass through the native engine, the actual contributor tracker, durable-snapshot merge and effect trimming. Exports and rebases are reopened and asserted to retain the measured edits.

Opening Edit without changing content leaves state and baseline NULL, so its retained file/edit payload is the original file alone plus small row metadata. The seed column is computed in memory at that point. The first real save stores a complete native checkpoint, even though XLSX's checkpoint itself contains only topology and overrides.

| File | Original | In-memory seed | After one saved edit | Old + new files and states during publication, with a later save | Published, no later edits | Published, with later edit rebased |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| lesson.docx | 37.41 | 8.85 | 40.06 | 80.22 | 37.94 | 42.11 |
| grades.xlsx | 5.54 | 1.79 | 6.92 | 13.79 | 5.70 | 7.03 |
| lesson.pptx | 29.34 | 4.29 | 31.08 | 61.96 | 29.35 | 33.15 |
| exchange-plan.docx | 65.72 | 312.98 | 114.35 | 227.76 | 65.49 | 157.89 |
| course-guide.xlsx | 145.43 | 24.31 | 151.48 | 303.90 | 146.57 | 152.59 |
| lecture.pptx | 311.19 | 109.07 | 336.72 | 673.29 | 311.21 | 362.33 |
| feature-rich.docx | 39.17 | 42.28 | 48.55 | 97.48 | 40.09 | 54.92 |
| feature-rich.xlsx | 7.26 | 12.70 | 10.76 | 21.03 | 7.00 | 10.43 |
| feature-rich.pptx | 16.55 | 17.75 | 21.48 | 42.87 | 16.63 | 28.93 |
| book-30p.docx | 47.97 | 259.25 | 120.80 | 243.79 | 50.49 | 195.75 |
| images-10.docx | 4,190.86 | 67.32 | 4,210.64 | 8,420.79 | 4,191.55 | 4,232.35 |
| opaque-objects.docx | 59.24 | 47.88 | 77.98 | 155.14 | 59.80 | 87.26 |
| deck-50.pptx | 94.19 | 161.25 | 141.57 | 282.93 | 94.20 | 216.16 |
| cells-1k.xlsx | 14.64 | 4.19 | 16.55 | 33.03 | 14.77 | 16.64 |
| cells-10k.xlsx | 89.39 | 4.19 | 91.29 | 183.15 | 90.14 | 92.02 |
| cells-100k.xlsx | 836.42 | 4.16 | 838.32 | 1,687.60 | 847.56 | 849.43 |
| jp_llm2.pptx | 24,390.71 | 714.66 | 24,577.45 | 49,152.84 | 24,388.91 | 24,743.48 |
| zh_TW_llm.pptx | 8,756.52 | 479.35 | 8,868.48 | 17,735.02 | 8,754.72 | 8,967.35 |

For this exact workload, the 18 originals total 39.14 MB and source-plus-editing payload after one save totals 39.70 MB, an increase of 1.45%. The large presentations dominate that sum. Individual text-heavy files behave differently: `book-30p.docx` reaches 2.52 times its original size after the measured save. The aggregate percentage is not a general capacity multiplier.

The overlap column is a measured sum of simultaneously live payloads: old source + exported source + latest saved state/effects + captured checkpoint. Without a later save, the captured checkpoint is not copied, so subtract that file's `captured_state_stored` from the JSON record and use `one_edit` in place of `during_refresh`. Transaction old tuples, the next baseline being written, parse/index overlap and deferred object deletion can make the host's instantaneous disk usage higher.

Empty `[]` markers and fixed row metadata are excluded from the source-only steady columns; the exact measured marker is five bytes.

When publication completes without a later edit, state, baseline and effects are cleared, leaving one exported source. The final column covers another save landing during export or parsing. DOCX/PPTX retain the baseline mapped to that rebased checkpoint; XLSX retains no baseline. This can occur during normal active editing while a parse runs. A subsequent publication with no later save clears it again.

## What the owner is charged

Quota is logical accounting. It does not equal either uncompressed checkpoint bytes or compressed disk use:

`source bytes + max(0, checkpoint bytes - recorded seed bytes) + nonempty effects JSON text bytes + persisted baseline bytes before TOAST compression`

Opening alone adds zero editing charge. The engine's seed is a platform cost; a transient candidate is uncharged. Publication gates the net increase, not the temporary overlap. The recorded seed is a byte count, not another saved copy of the seed.

| Application file | Original charge | Charge after one edit | Charge after quiet publication | Charge after publication with a later edit |
| --- | ---: | ---: | ---: | ---: |
| lesson.docx | 37.41 | 38.00 | 37.94 | 41.97 |
| grades.xlsx | 5.54 | 6.06 | 5.70 | 6.17 |
| lesson.pptx | 29.34 | 29.73 | 29.35 | 34.73 |
| exchange-plan.docx | 65.72 | 68.24 | 65.49 | 179.37 |
| course-guide.xlsx | 145.43 | 145.95 | 146.57 | 147.04 |
| lecture.pptx | 311.19 | 311.54 | 311.21 | 391.42 |

The late-edit baseline matters. For example, the rich DOCX's small edit costs about 2.5 KB above its source before publication, but the rebased branch retains a full semantic baseline. That larger charge is the current recorded policy, not seed bytes accidentally charged again.

## Parsing and reparsing

The live UAT collection completed all three phases for all six application fixtures: processed before editing, a saved browser edit, and successful publication/reparsing. The basic DOCX and XLSX triples were measured at `15c0dbe0`; the basic PPTX and all three rich files were measured at `2f54d84a`. Both use the same native engine `99d5bcc4`. The later React pending-input change does not alter its checkpoint encoding or seed output.

These are complete file triples from three runs, never a mixture of phases from different uploads. Every contributing run finished cleanup with `failed: []` and verified ingest identity before and after. Incomplete files from the earlier interrupted runs are excluded. Exact run IDs, revisions and measurements are recorded under `live` in the JSON.

Active payload below is source bytes + current-source parse/caption cache bytes + measured chunk, vector, descriptor, content and editing database values. The last column instead sums all observed current and hidden versions of each recorded B2 key once, plus the same database values. It includes old source, staging and earlier bundle copies still retained after publication. It does not add the logical source/cache bytes a second time.

The uploaded copies contain fresh markers and are repacked to force actual parsing. Their sizes differ from the committed files, most visibly the rich spreadsheet's 145.43 KB original versus its 168.38 KB test upload. Publication exported that live spreadsheet to 146.89 KB. This difference is part of the measurement workload, not a claim that a one-cell edit removes 21 KB from the original.

| File | Committed original | Actual uploaded copy | Processed, before editing | Saved edit | Published/reparsed, active payload | Observed after publication, including old B2 versions |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| lesson.docx | 37.41 | 37.69 | 52.14 | 54.61 | 52.64 | 129.86 |
| grades.xlsx | 5.54 | 5.61 | 14.60 | 15.98 | 14.77 | 27.90 |
| lesson.pptx | 29.34 | 29.83 | 38.72 | 40.71 | 38.80 | 100.06 |
| exchange-plan.docx | 65.72 | 66.14 | 369.54 | 417.66 | 369.18 | 582.40 |
| course-guide.xlsx | 145.43 | 168.38 | 471.00 | 477.07 | 449.51 | 823.68 |
| lecture.pptx | 311.19 | 313.28 | 824.39 | 850.30 | 824.37 | 1,824.76 |

The parser bundle, chunk text/metadata, embeddings and descriptor are platform costs. Store-only files have none until their owner chooses Process. No separate caption objects were created in these six runs; their measured caption storage is zero. Embedded and extracted media still contribute to the source and bundle values.

| File | Chunks before / after | Parse bundle before / after | Chunk columns before / after | Embeddings before / after | Descriptor + content metadata before / after |
| --- | ---: | ---: | ---: | ---: | ---: |
| lesson.docx | 2 / 2 | 1.85 / 1.84 | 1.78 / 1.78 | 10.25 / 10.25 | 0.57 / 0.57 |
| grades.xlsx | 1 / 1 | 1.91 / 1.94 | 1.36 / 1.38 | 5.12 / 5.12 | 0.60 / 0.60 |
| lesson.pptx | 1 / 1 | 1.60 / 1.64 | 1.53 / 1.53 | 5.12 / 5.12 | 0.64 / 0.61 |
| exchange-plan.docx | 23 / 23 | 80.93 / 80.94 | 103.93 / 103.93 | 117.85 / 117.85 | 0.69 / 0.69 |
| course-guide.xlsx | 35 / 35 | 37.40 / 37.39 | 85.22 / 85.22 | 179.34 / 179.34 | 0.66 / 0.66 |
| lecture.pptx | 21 / 21 | 373.82 / 373.79 | 29.02 / 28.98 | 107.60 / 107.60 | 0.67 / 0.67 |

The following is a derived reparse allowance: the measured before and after parse/index components added together. The last column also adds their old/new sources and the saved editing values, equivalently the previous table's saved-edit plus published-active columns. This is a component sum, not an observed instantaneous peak. The live workload had no later edit during publication, so it did not need a copied captured checkpoint. The earlier native table measures that separate later-edit branch. Add temporary conversion files, retained object versions and shared database overhead when sizing the host; they are not hidden inside this allowance.

| File | Parse/index before | Parse/index after | Sum of both generations | Both generations + old/new sources + saved editing state |
| --- | ---: | ---: | ---: | ---: |
| lesson.docx | 14.45 | 14.45 | 28.90 | 107.25 |
| grades.xlsx | 8.99 | 9.04 | 18.03 | 30.76 |
| lesson.pptx | 8.89 | 8.90 | 17.80 | 79.51 |
| exchange-plan.docx | 303.40 | 303.41 | 606.80 | 786.84 |
| course-guide.xlsx | 302.61 | 302.61 | 605.22 | 926.58 |
| lecture.pptx | 511.11 | 511.06 | 1,022.16 | 1,674.67 |

The raw per-chunk embedding datum is 5,128 bytes: 2 × 2,560 dimensions plus its 8-byte header. Live UAT stores these values externally through TOAST; the first measured rows report 5,124 bytes each through `pg_column_size`, excluding the four-byte outer datum header. The live totals below use the measured stored values. PostgreSQL's HNSW index contains a further copy of the vector and graph links. GIN and B-tree indexes, row headers, alignment, TOAST chunk tuples and page free space also occupy disk. A shared index or database page has no unique exact per-file allocation; these cannot honestly be represented as a fixed multiplier of the original Office file.

During reparse, the old published source/index remains available while the candidate file, parsed bundle and new index are built. Publication switches the source/index atomically, then releases the old source and old parse-cache references once nothing else uses their hashes. A failed candidate preserves the old published data and is cleaned separately. A duplicate within one workspace can share canonical chunks and embeddings. A cross-workspace donor or clone copies index rows into the destination workspace, even when its source or parse-cache blob is physically shared. Those remaining references can legitimately keep old objects alive.

An unchanged source with the same parser fingerprint reuses its bundle. The fingerprint includes source hash, route, parser implementation, release SHA and artifact schema. Reparsing under a different fingerprint can therefore retain multiple cache objects for the same source until unused-cache cleanup. The default unused-cache age is 90 days; releasing an unreferenced replaced source is a separate path.

## Storage outside the main table

| Component | Where and when it exists | Quota and retention |
| --- | --- | --- |
| Upload staging object | Incoming B2 object and promoted stable source can overlap during finalize | Full source bytes reserved before upload, then charged once; staging cleanup waits out the presigned URL |
| Source package | One current DOCX/XLSX/PPTX object in B2 | Charged by the source's compressed archive bytes; clones can share the physical object |
| Seed and derived baseline | Collaboration memory caches, generated from the exact source | Uncharged; seed bytes are not persisted until a real edit, baseline normally stays derived |
| Live checkpoint | PostgreSQL bytea; the room and browser also hold replicas | Only growth beyond seed is charged; PostgreSQL TOAST compresses large values |
| Pending effects | PostgreSQL jsonb | Nonempty JSON text counts; text effects keep the changed span plus 40 UTF-16 units of context per side |
| Refresh candidate | PostgreSQL metadata and candidate B2 source | No quota charge; captured state is copy-on-write and only the new seed's byte count is retained |
| Rebased baseline | PostgreSQL bytea for DOCX/PPTX if later edits survived publication | Full baseline bytes charged; removed on the next publication without later edits |
| Original embedded images/media | Within the compressed source package | DOCX/PPTX source media is referenced, not base64-copied into the seed |
| Newly inserted media | DOCX data URL or PPTX binary shape payload until publication | State growth is charged; DOCX base64 adds roughly one third before database compression; later publication puts media in the new package |
| Rebase package overlays | Only changed XLSX/PPTX parts needed by later edits | Stored in the rebased state, never another full old source archive |
| Browser recovery drafts | IndexedDB stores one source base per actor/file/hash and one latest full checkpoint per unacknowledged editing session | Device disk, uncharged; writes coalesce at 250 ms; durable checkpoint acknowledgment or explicit discard clears matching drafts and any unused base; unresolved older lineages remain recoverable |
| Native Undo/Redo | Open editor memory | No durable server history; publication clears it at the new epoch |
| AI edit Undo | Inverse/guard rows when a chat agent performs an edit | Separately charged while available; the normal browser edit measurements contain none |
| Durable parse bundle | Optional fingerprinted ZIP in B2, containing structured text/metadata and relevant images | Platform cost; no persistent Office preview PDF; replaced-base caches are released when unreferenced |
| Ingest local spool | Downloaded source and parser ZIP on the shared ingest host | Platform disk; source removed after success/terminal cleanup, abandoned-source default TTL 2 hours, ZIP default TTL 6 hours, in-flight artifacts protected |
| Conversion work files | Temporary Office-to-PDF conversion, extraction directories and per-job LibreOffice profile | Platform temporary disk; conversion output is excluded from durable Office cache |
| Retrieval index | PostgreSQL text, duplicated indexed text, regions, lexical vectors, embeddings, descriptor and indexes | Platform cost; old/new generations can overlap during reparse, shared canonical content is reference-counted |
| Caption reuse | B2 caption JSON and resource associations | Platform cost, shared by authorized references; retained reuse caches can outlive a particular file |
| Deferred object deletion | B2 objects waiting in the deletion outbox or hidden object versions | Physical cost until deletion/lifecycle expiry; quota may already be released. UAT's actual bucket policy expires noncurrent versions after one day |
| Database operational space | Heap/index free pages, MVCC dead tuples, WAL, replication and backups | Host-level capacity; VACUUM makes space reusable but generally does not shrink the database files |
| Browser and engine assets | Downloaded WASM/fonts/JS, runtime heap, export Blob and browser cache | Shared application/runtime cost, not durable storage per uploaded file |

On the browser, recovery payload is approximately `one source base + sum(latest checkpoint for each unacknowledged session)` per actor/file/hash, before the browser storage engine's own overhead. The rich DOCX therefore needs roughly 379 KB of raw recovery payload for one session with the measured edit, compared with its 65.7 KB original. Two sessions share the base but keep separate checkpoints. Biology 101 MSW samples deliberately skip this real-account IndexedDB persistence; explicit recovery scenarios use a separate database. Base64 in HTTP state fields affects transfer size and memory, not a second base64 copy in PostgreSQL.

There is no full document revision archive. Trashing retains the file and its charge until permanent deletion. A seed-changing engine upgrade first publishes pending edits on the old engine, then resets the affected editing states under the maintenance pause; it does not archive the discarded checkpoints.

The UAT B2 lifecycle was read directly on September 27. The global rule deletes noncurrent versions after one day and aborts incomplete multipart uploads after one day. The two incoming prefixes also expire current staging objects after one day. Current source and cache objects have no blanket expiry. A reaper delete can therefore release quota immediately while a hidden version remains billable until the bucket lifecycle runs. This is an intentional bounded retention cost, not another current source reference.

## What the previous size work achieved

- The 100,000-cell workbook's current seed is 4,162 bytes. The 1,000- and 10,000-cell fixtures are both 4,187 bytes. Topology and cell overrides replaced per-cell seed copies; there is no stored XLSX comparison baseline.
- The image-heavy DOCX has 4.19 MB of source bytes but a 67.3 KB seed. Its images remain in the package. The earlier study measured a roughly 5.67 MB seed for its image-heavy control.
- The 24.39 MB Japanese presentation has a 714.7 KB seed. Its 20.95 MB of uncompressed media is absent from that state. The earlier study recorded roughly 22.71 MB of state before source package/media removal.
- Unedited opens and quiet publications retain NULL state. Candidate capture avoids copying a checkpoint unless another save replaces it. The previous approach charged and stored full seeds/baselines much earlier.
- Contributor markers use one dedicated client identity per room rather than rotating the room identity on every update. This bounds the avoidable per-update metadata growth.

The historical report used an older engine and some differently generated control files. Its numbers establish the size of the prior problem; they are not a byte-for-byte A/B run against today's fixtures.

## Method and limits

Run `pnpm office:prepare`, start an isolated local PostgreSQL 16 database, and run `OFFICE_STORAGE_DATABASE_URL=postgresql://... pnpm exec tsx bench/parsers/scripts/office_storage.ts OUTPUT_DIRECTORY`. The script refuses a non-loopback database and uses only a temporary table. Its default set is all 18 committed sources. Pass explicit file paths after the output directory to measure a subset or additional sources. It imports the shipped engine and actual contributor/effect code. It checks every export and rebase for the inserted text. The database is queried after INSERT so TOAST has run, rather than estimating compression from gzip.

The live parse companion is `pnpm exec playwright test --config bench/parsers/scripts/office_storage_ingest.config.ts`, with the existing authorized UAT environment, expected revision, fresh run ID and verifier tunnel. It uses the existing disposable actors, real browser upload/edit, provider checks and global cleanup. It runs serially and is excluded from ordinary CI and UAT journeys.

The live cases replace `UAT_RUN_MARKER` with a unique marker and repack the ZIP. That proves a fresh parse instead of donor reuse, but changes the upload's byte size. Their uploaded and published byte counts must therefore be read separately from the exact committed-file sizes in the first table. Their edits use the existing browser journey actions, rather than the native probe's fixed suffixes.

The suffix workloads are defined samples, not worst-case bounds. Large pasted text, inserted media, edits to many distinct targets, repeated updates and long-running sessions change checkpoint/effect size. An original archive's compression ratio alone cannot predict those changes. The app caps a checkpoint at 100 MiB; source upload limits remain 10 MiB Free and 30 MiB Pro. Maximum whole-host disk use also depends on concurrency, shared references, reaper timing, spool TTL, WAL retention and backups.

## Implementation references

The accounting expression is in [migration 0033](../../../server/migrations/0033_office_storage_rule.sql). [SourceDocumentStore](../../../collaboration/src/sourceDocuments.ts) owns NULL state, seed/baseline caches, checkpoint merge, effect trimming and publication rebase. [Source refresh publication](../../../server/internal/store/source_refresh.go) owns the atomic swap and replaced-cache release. [The checkpoint engine](../../../vendor/betteroffice/shared/office-checkpoint.ts) owns native seed, sparse XLSX effects and rebase. [The parser client](../../../pipeline/pipeline/parse/parser_client.py) owns the PDF-free bundle and spool cleanup; [blob storage](../../../server/internal/store/blobs.go) owns reference-safe object deletion and cold-cache expiry. [Browser draft storage](../../../src/features/files/sourceDraft.ts) and [session receipts](../../../src/features/files/useSourceSession.ts) own device recovery copies and their removal. The schema's [retrieval tables](../../../server/migrations/0001_init.sql) and [descriptor migration](../../../server/migrations/0029_descriptor_summaries_system_payer.sql) define the index payload.
