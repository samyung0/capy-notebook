# Office storage without durable parse bundles

Removing the B2 document parse cache reduced the six files' combined published active payload from 1,749,174 to 1,251,716 bytes, **28.44% less**. Including retained B2 copies, the observed total fell from 3,488,561 to 2,493,600 bytes, **28.52% less**. The lecture deck had the largest active reduction, 45.35%.

All six paired live cases passed with byte-identical uploaded inputs, 18 before/after snapshots per release and clean teardown. All 18 native fixtures passed their save/export/rebase checks. The deployed removal is `21a8f996`; the baseline was `a7105895`. [Exact measurements and runtime identities](2026-09-28-office-storage-no-parse-cache.json).

The tables use decimal KB. Active totals include current source, current cache and measured retrieval/editing database values. Observed totals also include retained B2 copies. They exclude whole-database and filesystem overhead, detailed below. Live uploaded sizes are frozen marked copies, while the native table uses the original committed files.

## Published storage including retained B2 copies

| File | Uploaded | New source | Active before | Active after | Reduction | Observed before | Observed after |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| lesson.docx | 37.69 | 38.19 | 52.67 | 50.80 | 3.54% | 129.89 | 126.17 |
| grades.xlsx | 5.61 | 5.73 | 14.77 | 12.84 | 13.10% | 27.90 | 24.05 |
| lesson.pptx | 29.83 | 29.89 | 38.78 | 37.18 | 4.12% | 100.04 | 96.85 |
| exchange-plan.docx | 66.14 | 65.77 | 369.00 | 288.23 | 21.89% | 582.22 | 420.52 |
| course-guide.xlsx | 168.38 | 146.89 | 449.57 | 412.12 | 8.33% | 823.74 | 748.89 |
| lecture.pptx | 313.28 | 313.31 | 824.39 | 450.55 | 45.35% | 1,824.77 | 1,077.12 |

## What remains after publication

| File | New source | Chunks | Chunk columns | Embeddings | Descriptor + content metadata | Editing values before publication | B2 parse cache |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| lesson.docx | 38.19 | 2 | 1.78 | 10.25 | 0.58 | 2.47 | 0.00 |
| grades.xlsx | 5.73 | 1 | 1.38 | 5.12 | 0.60 | 1.38 | 0.00 |
| lesson.pptx | 29.89 | 1 | 1.53 | 5.12 | 0.63 | 1.99 | 0.00 |
| exchange-plan.docx | 65.77 | 23 | 103.93 | 117.85 | 0.67 | 48.12 | 0.00 |
| course-guide.xlsx | 146.89 | 35 | 85.22 | 179.34 | 0.67 | 6.07 | 0.00 |
| lecture.pptx | 313.31 | 21 | 28.98 | 107.60 | 0.64 | 25.91 | 0.00 |

The removed current bundles total 497,550 bytes. Other measured source/database components increased by a net 92 bytes, producing the measured 497,458-byte active saving. Removing both initial and refreshed bundle copies removes 995,053 bytes from the observed inventory; the same 92-byte difference leaves a net 994,961-byte saving. Retrieval chunks and embeddings remain the largest database payloads in the rich files.

## What changed

Document parsing no longer uploads, restores or registers a durable parse ZIP in B2. Migration 0038 releases the existing cache objects through the normal deletion queue and rejects new `parse_bundle` cache rows. Standalone image-caption and audio-transcript caches retain their existing behavior.

The parser still hands ingest a validated local ZIP. Its checksum, manifest, extraction limits and Office page evidence remain checked. Completed receipts still recover interrupted jobs, and compatible database donors can still reuse indexed content. If the local ZIP has expired and no compatible donor exists, the retained source is parsed again.

## Editing storage that remains

The native test appends exactly 20 ASCII bytes, ` Capy storage probe.`, to an existing target. The publication race adds another 18 bytes, ` Later saved edit.`, after export capture. It exercises the native engine, contributor tracking, durable merge, trimmed effects and publication rebase. Every export and rebase is reopened and checked for the expected edits. The live browser tests use their existing fixture-specific edit actions.

Opening Edit stores no checkpoint. The seed shown in the table is an in-memory representation, not another persistent copy. Saving DOCX or PPTX still writes a full native checkpoint, which PostgreSQL compresses. Later saves replace that row's checkpoint; this is not another permanently retained copy for each keystroke. Quiet publication clears checkpoint, baseline and effects. The native quiet column shows source bytes only and omits the empty five-byte effects value and row metadata; the live tables include the measured editing values. A later save during publication can leave a rebased checkpoint and, for DOCX/PPTX, a stored comparison baseline.

For `exchange-plan.docx`, the original is 65,718 bytes. One save stores a 47,860-byte checkpoint and 776 bytes of effects, bringing source plus editing values to 114,354 bytes. Quiet publication leaves a 65,490-byte source. A save during publication leaves 92,398 bytes of editing values on top of that published source. Removing B2 bundles does not change these checkpoint costs.

The largest relative native jumps remain the text-heavy controls. `book-30p.docx` grows from 47,972 bytes to 120,800 bytes with one save, or 2.52 times the original. Source plus editing after the concurrent publication/rebase is 195,746 bytes, or 4.08 times the original. `deck-50.pptx` goes from 94,191 bytes to 141,567 bytes with one save, then 216,160 bytes after the concurrent publication/rebase. Those totals exclude retrieval data and retained B2 versions.

Existing optimizations remain effective elsewhere. The 1,000-, 10,000- and 100,000-cell workbook controls each add about 1.9 KB of saved editing values in this workload. The image-heavy DOCX adds about 19.8 KB to a 4.19 MB source. The two large multilingual decks add about 0.8% and 1.3% on the first save. The first-save editing totals across all 18 files reproduce the September 27 report within two bytes.

The next storage opportunity is the full DOCX/PPTX checkpoint and retained comparison baseline for text-heavy files. A more compact representation would require a separate persistence and rebase change. This removal preserves their existing behavior.

## Native file and editing payload

| File | Original | In-memory seed | One saved edit | Calculated publication overlap with later save | Published, quiet | Published, later edit rebased |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| lesson.docx | 37.41 | 8.85 | 40.06 | 80.22 | 37.94 | 42.11 |
| grades.xlsx | 5.54 | 1.79 | 6.92 | 13.79 | 5.70 | 7.03 |
| lesson.pptx | 29.34 | 4.29 | 31.08 | 61.96 | 29.35 | 33.15 |
| exchange-plan.docx | 65.72 | 312.98 | 114.35 | 227.76 | 65.49 | 157.89 |
| course-guide.xlsx | 145.43 | 24.31 | 151.48 | 303.90 | 146.57 | 152.59 |
| lecture.pptx | 311.19 | 109.07 | 336.72 | 673.30 | 311.21 | 362.33 |
| feature-rich.docx | 39.17 | 42.28 | 48.55 | 97.48 | 40.09 | 54.92 |
| feature-rich.xlsx | 7.26 | 12.70 | 10.76 | 21.03 | 7.00 | 10.43 |
| feature-rich.pptx | 16.55 | 17.75 | 21.48 | 42.87 | 16.63 | 28.93 |
| book-30p.docx | 47.97 | 259.25 | 120.80 | 243.79 | 50.49 | 195.75 |
| images-10.docx | 4,190.86 | 67.32 | 4,210.64 | 8,420.79 | 4,191.56 | 4,232.35 |
| opaque-objects.docx | 59.24 | 47.88 | 77.98 | 155.14 | 59.80 | 87.26 |
| deck-50.pptx | 94.19 | 161.25 | 141.57 | 282.93 | 94.20 | 216.16 |
| cells-1k.xlsx | 14.64 | 4.19 | 16.55 | 33.03 | 14.77 | 16.64 |
| cells-10k.xlsx | 89.39 | 4.19 | 91.29 | 183.15 | 90.14 | 92.02 |
| cells-100k.xlsx | 836.42 | 4.16 | 838.33 | 1,687.60 | 847.56 | 849.43 |
| jp_llm2.pptx | 24,390.71 | 714.66 | 24,577.45 | 49,152.84 | 24,388.91 | 24,743.48 |
| zh_TW_llm.pptx | 8,756.52 | 479.35 | 8,868.48 | 17,735.01 | 8,754.72 | 8,967.35 |

## Quota and calculated overlap

User quota is separate from platform payload storage. The measured native rule is source bytes plus checkpoint growth beyond its recorded seed size, nonempty effects JSON text bytes and persisted baseline bytes before TOAST compression. Retrieval data and parse ZIPs are platform costs. This change does not alter user quota.

The native publication-overlap column is calculated as old source plus exported source plus the latest saved state/baseline/effects plus an allowance for the captured checkpoint copy needed after a later save. That allowance uses the separately measured compressed checkpoint size. It is not a live query of the candidate row; TOAST decisions can vary with row layout.

The live reparse component sum adds the saved-edit active payload and the published active payload. It is an allowance for separate old/new source and index generations plus one saved editing state. Sharing or deduplication can reduce actual overlap. The successful live publication had no later concurrent save, so this sum does not add another captured checkpoint. Neither overlap table is a sampled peak. Retained B2 versions, temporary conversion files, local parser ZIPs and database operational overhead are outside those sums.

## Native quota for the application files

| File | Original charge | Charge after one edit | Quiet publication | Publication with a later edit |
| --- | ---: | ---: | ---: | ---: |
| lesson.docx | 37.41 | 38.00 | 37.94 | 41.97 |
| grades.xlsx | 5.54 | 6.06 | 5.70 | 6.16 |
| lesson.pptx | 29.34 | 29.73 | 29.35 | 34.73 |
| exchange-plan.docx | 65.72 | 68.24 | 65.49 | 179.37 |
| course-guide.xlsx | 145.43 | 145.95 | 146.57 | 147.04 |
| lecture.pptx | 311.19 | 311.54 | 311.21 | 391.42 |

## Paired live payload

| File | Phase | Before | After | Saved | Removed bundle |
| --- | ---: | ---: | ---: | ---: | ---: |
| lesson.docx | initial | 52.16 | 50.34 | 1.82 | 1.85 |
| lesson.docx | edited | 54.68 | 52.81 | 1.87 | 1.85 |
| lesson.docx | reparsed | 52.67 | 50.80 | 1.87 | 1.84 |
| grades.xlsx | initial | 14.61 | 12.72 | 1.89 | 1.91 |
| grades.xlsx | edited | 15.99 | 14.10 | 1.89 | 1.91 |
| grades.xlsx | reparsed | 14.77 | 12.84 | 1.94 | 1.94 |
| lesson.pptx | initial | 38.68 | 37.12 | 1.55 | 1.60 |
| lesson.pptx | edited | 40.67 | 39.12 | 1.55 | 1.60 |
| lesson.pptx | reparsed | 38.78 | 37.18 | 1.60 | 1.64 |
| exchange-plan.docx | initial | 369.36 | 288.60 | 80.77 | 80.93 |
| exchange-plan.docx | edited | 417.48 | 336.71 | 80.77 | 80.93 |
| exchange-plan.docx | reparsed | 369.00 | 288.23 | 80.77 | 80.94 |
| course-guide.xlsx | initial | 471.06 | 433.61 | 37.45 | 37.40 |
| course-guide.xlsx | edited | 477.13 | 439.68 | 37.45 | 37.40 |
| course-guide.xlsx | reparsed | 449.57 | 412.12 | 37.45 | 37.40 |
| lecture.pptx | initial | 824.40 | 450.54 | 373.86 | 373.82 |
| lecture.pptx | edited | 850.31 | 476.45 | 373.86 | 373.82 |
| lecture.pptx | reparsed | 824.39 | 450.55 | 373.84 | 373.80 |

## Reparse component sum

| File | Before: two index generations, sources and saved state | After: same components | Reduction |
| --- | ---: | ---: | ---: |
| lesson.docx | 107.34 | 103.61 | 3.74 |
| grades.xlsx | 30.76 | 26.93 | 3.82 |
| lesson.pptx | 79.44 | 76.30 | 3.15 |
| exchange-plan.docx | 786.48 | 624.94 | 161.54 |
| course-guide.xlsx | 926.70 | 851.80 | 74.90 |
| lecture.pptx | 1,674.70 | 927.00 | 747.70 |

## Cleanup timing

| Stored item | When it is released | What can remain afterward |
| --- | --- | --- |
| Successful upload staging | Promotion deletes the staging key immediately. | B2 keeps the hidden version until its one-day noncurrent lifecycle expires. |
| Abandoned upload staging | Existing cleanup and the `incoming/` one-day expiry apply. | Hidden versions also have the one-day lifecycle. |
| Replaced source | Publication releases the old source when its last reference disappears. | The minutely reaper hides the object; old versions expire through lifecycle. |
| Earlier parse bundle before this removal | Publication released the cache row when no file, editing base or refresh candidate still named the old source hash. | The object waited for the 15-minute reader grace and reaper, then noncurrent lifecycle. |
| Latest reusable parse bundle before this removal | It could outlive file deletion until the previous 90-day cache sweep. | Deletion still used the normal B2 lifecycle. |
| Document parse bundle after this removal | No B2 bundle is created. Migration 0038 releases existing registered bundles. | Existing hidden versions wait for lifecycle; there is no new document-cache generation. |
| Temporary local parser ZIP | Eligible after six hours; an idle ingest worker sweeps every five minutes. | Active jobs protect their paths. Continuous work can postpone the idle sweep. |
| Downloaded local source | Committed success or terminal failure removes it; abandoned files have a two-hour TTL. | Active jobs remain protected. |
| Unreferenced refresh export after failure | Existing cleanup gives the exported candidate a one-day deletion safety delay. | B2 noncurrent retention starts after it is hidden. |
| Saved editing state | Quiet publication clears it. | A newer save survives through rebase, along with the required comparison baseline. |

The local handoff table sums the exact initial and refreshed ZIP sizes in parser receipts. It measures bytes produced, not filesystem block allocation or simultaneous host occupancy. Those temporary ZIPs remain for bounded local recovery/reuse; the durable B2 copies have been removed.

The immediate baseline snapshots include the earlier B2 bundle while its reader grace is still running. They do not mean both generations are permanently retained after publication. The observed totals also include two old-source-sized copies, the hidden upload staging object and the hidden replaced source.

## Temporary local handoff bytes

| File | Before: initial + refreshed ZIP | After: initial + refreshed ZIP |
| --- | ---: | ---: |
| lesson.docx | 3.69 | 3.69 |
| grades.xlsx | 3.85 | 3.85 |
| lesson.pptx | 3.24 | 3.24 |
| exchange-plan.docx | 161.87 | 161.87 |
| course-guide.xlsx | 74.79 | 74.80 |
| lecture.pptx | 747.61 | 747.61 |

Migration 0038 released 82 registered UAT bundles totaling 16,735,471 bytes. At 17:16:11 UTC the deletion queue and live references were both empty. At 17:16:41 UTC all 82 keys had zero current B2 objects, and the entire parse-bundle prefix had no other current objects. There were 16,736,697 noncurrent bytes on those keys, including 1,226 bytes already hidden before migration. They remain billable until the observed one-day noncurrent lifecycle expires; physical expiry was not claimed or forced.

## Reading the measurements

All table sizes use decimal KB, where 1 KB is 1,000 bytes. The accompanying JSON contains exact bytes, source hashes, native runtime hashes and ingest image identities.

**Active payload** is the current source object, current-source cache/caption objects and measured PostgreSQL values for chunks, embeddings, descriptors, content metadata and saved editing. **Observed payload** instead adds every current and hidden version of the recorded B2 keys once, plus those database values. It includes upload staging and replaced sources awaiting lifecycle expiry. Source and cache bytes are not added twice.

These are attributed payload measurements. They exclude PostgreSQL tuple and TOAST-chunk overhead, table and index pages, free space, dead tuples, WAL, replicas and backups. In particular, the HNSW index stores another vector representation and graph links beyond the embedding values shown here. Shared structures do not have a unique per-file allocation. Local conversion files and parser ZIPs are described separately. These totals must not be presented as complete server disk usage or a measured disk peak.

The native table uses the original committed files. The live comparison uses six marked copies frozen before the baseline, with identical SHA-256 hashes and byte counts in both runs. Marking repacks the Office ZIP; the rich workbook's marked input is larger than its committed original. The native original and live uploaded-size columns therefore describe different bytes.

## Method and limits

The native run covers 18 fixtures with BetterOffice `64bbde82`, PostgreSQL 16.15 and `pglz` compression on ARM64. The live run covers the six application fixtures on UAT PostgreSQL 16.15 with `pglz` on x86-64. The twelve native-only controls do not have claimed live retrieval totals. Native code at `1e50b8a9` is identical to `21a8f996` for the measurement script, collaboration implementation and pinned engine; the report assembler checks those paths with Git.

The old UAT runtime was `a7105895`; the new runtime is `21a8f996`. Each live run checks public application, Office, gateway and collaboration markers at preflight, and all five ingest image identities before and after. Each file requires successful real parsing, saved-edit confirmation, publication, reindexing and quota checks. The new checks require no document cache row and no exact-key B2 bundle versions, including hidden versions and delete markers.

The baseline uses complete three-phase results for DOCX and XLSX from `office-storage-before-20260928-a7105895-v2`, and four complete files from `office-storage-before-20260928-a7105895-v3`. Both ran on the unchanged old UAT release and passed resource cleanup. No file combines phases from different runs. An earlier copied test setup lacked the vendor runtime symlink and contributed no results.

The first baseline PPTX attempt exposed a test timing assumption. Its initial embedding call timed out after 121.420 seconds; the next attempt succeeded in 3.353 seconds. The parent session settled while the earlier call remained uncertain until its stored deadline. The normal reaper closed it at 16:26:55 UTC with `receipt_timeout`. The probe now waits for the existing receipt policy and preserves all final accounting assertions. This was a premature assertion, not an application accounting failure. The failed file's incomplete data is excluded.

Differences between the removed bundle's size and the total measured savings are the measured changes in the other source/database values. These are one paired storage workload, not a latency distribution or parser-quality benchmark. Production was not used.

## Verification and release evidence

The removal and receipt-wait fix passed [CI 36333573665](https://github.com/samyung0/capy-notebook/actions/runs/36333573665), including 1,090 Python tests, 39 Docker browser cases and 77 editor browser cases. Three Python tests and one editor case were intentionally skipped; no browser retry was reported. Local checks covered the real migration/refcount/deletion grace, retained paid caches, parser handoff validation, receipt continuation, donor/retry behavior, verifier accounting, and the stopped-consumer deployment sequence.

[Deploy UAT](https://github.com/samyung0/capy-notebook/actions/runs/36335068075) and [Deploy ingest](https://github.com/samyung0/capy-notebook/actions/runs/36335505652) both succeeded for `21a8f996`. Previous UAT parse/ingest consumers were stopped before migration and kept stopped until matching activation. Four public release markers and five ingest image identities match. Production was untouched.

The storage rerun `office-storage-after-20260928-21a8f996` passed all six cases in 26.1 minutes, including teardown. Cleanup reported no failures and no Sentry events for its actors. The full [UAT quality gate](https://github.com/samyung0/capy-notebook/actions/runs/36335617678) passed smoke checks, nine authenticated browser checks and 13 lifecycle journeys. Its cleanup finished at 17:35:30 UTC with no failures, and all five ingest image/container identities were unchanged. The retained objects follow the recorded account, provider and B2 lifecycle policies.

The [Astra xhigh reviews](../../../artifacts/2026-09-25-office-progress/review-parse-cache-astra-xhigh-2026-09-28.md) found no remaining actionable issue. The measurement reviewer independently hashed the inputs, matched all 36 snapshots, regenerated identical JSON and table rows, and reconciled the storage totals and migration cleanup. Public-marker verification is at preflight; the before/after identity comparison covers ingest containers.

The release error audit matched the sole Sentry event to the deliberate oversized-CSV terminal-failure test. Four HTTP error records were explicitly marked client-aborted. Collaboration logged one 409 from the unchanged-document receipt path, which had no contributors and no matching live file/epoch; existing handling rejects that room. The log does not identify the particular file. The parser recorded two empty-text-detection warnings. The post-cleanup observation from 17:35:40 through 17:46 UTC recorded no new application errors, ingest warnings/errors or Sentry events. All observed services were running, with no restarts or OOM kills. Office editing remained enabled with no unpublished or in-flight work. [Aggregate rollout and audit evidence](../../../artifacts/2026-09-25-office-progress/parse-cache-rollout-2026-09-28.json).
