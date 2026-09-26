# Recheck of C4 at 09c946c8

Date: 2026-09-26. This rechecks every finding in `review-c4.md` against commit `09c946c8`, the developer decisions made since (the 2026-09-25 records in `human/frontend/office-files.md` and `human/agentic-retrieval.md`), and the regressions the fixes introduced. I changed nothing in the repository apart from this file, and no test containers remain.

**How I tested the commit.** The shared tree no longer matches `09c946c8`. Another session has uncommitted C5 work (the NULL-state model) in `collaboration/src/sourceDocuments.ts`, `sourceHandoff.ts`, `officeRuntime.ts`, `server.ts`, `office_maintenance.go` and `source_documents.go`. The `vendor/betteroffice` checkout has also moved to `b8ee465c`, while the commit pins `dfa3f05e`. So `pnpm test:collaboration` in the tree now fails two or three tests per run, and those failures come from that work, not from C4. I tested `git archive 09c946c8` copies in the scratchpad instead. The Go copy got a `SELECT 1` placeholder for the rerank session's `0030`, because the migration runner refuses a gap.

| Check, all on the commit | Result |
| --- | --- |
| Go: the fourteen C4 store tests plus `TestSourceRefreshRebasesNewerSavedOfficeState` | All pass. |
| Collaboration: `sourceHandoff`, `sourceDocuments`, `eviction`, `failedStoreRetry` and `provider-compat` tests | 43 pass. The runtime-backed `sourceOfficeRuntime.test.ts` needs the pinned engine build, so I could not run it. |
| Frontend: `sourceCheckpoint`, `sourceProvider`, `sourceDraft` | 7 pass. |
| My review experiments E1 and E2, rerun | Fixed. Details below. |
| New experiments for R1, R2 and R3, and the scheduler plan for R5 | Details below. |

## Findings from review-c4.md

| # | Finding | Verdict | Evidence |
| --- | --- | --- | --- |
| 1 | Export-only publication evicted rooms without a handoff | **Fixed**, with residuals R2, R3 and R6 | Automatic store-only exports now publish through `SourceHandoff.publish`: `sourceDocuments.ts:967-980`, the handoff flag at `:1040`, and `server.ts:1659`. That means a flush, the room lock, a rebase of later saves and `source-epoch-changed` on `complete`. Finalize keeps the candidate as a running `source_refresh` (`source_refresh.go:230-237`). `PublishSourceRefresh` publishes it through `applyExportTx` (`source_refresh.go:287-349`, `office_maintenance.go:243-274`). `TestStoreOnlyAutomaticExport` (`office_maintenance_test.go:234`) publishes a later save's rebase and enqueues no outbox eviction. Maintenance export-only still publishes inside finalize with a discard eviction (`source_refresh.go:205-215`), which is safe only while paused. |
| 2 | The reset template had no guard | **Fixed** | `office_window_reset.sql:21-31` takes `LOCK TABLE source_documents IN SHARE ROW EXCLUSIVE MODE`. It refuses when a row of the formats has unpublished edits, pending effects or a `running_job_id`, and when such rows exist without the pause row. `TestOfficeWindowResetTemplate` (`office_maintenance_test.go:653`) covers both refusals and the reset. One leftover: the comment at `:12-14` still lists "no source_refresh, parse or ingest job in flight", which is the old readiness rule. |
| 3 | Archived states could not be exported once their base was gone | **Superseded by decision** | The archive is gone. `0031_office_maintenance.sql` has no archive table, the template keeps no copy, the trash worker has no purge, and no archive reference remains in `openwiki`, `human`, the plan or the code. |
| 4 | A client that missed `source-editing-paused` stayed editable under a raw error | **Fixed** | `useSourceSession.ts:75` adds `maintenancePaused`, which recognises the gateway's `office_editing_paused` code and the service's reason. The token callback calls `replace(true)` on a 423 (`:471`), and `onAuthenticationFailed` does the same for the paused reason (`:322`). A paused room refuses late writers with the paused message (`server.ts:546-556`). The recovery branch keeps `m.source_edit_recovery()` (`:300`). The only test is the classifier (`sourceCheckpoint.test.ts`); nothing tests the `replace(true)` wiring. |
| 5 | Runbook step 5 could not run while paused | **Fixed in the runbook** | `openwiki/deployment-runbook.md:2487-2491` now resumes before the Edit check. The plan's window section still has the old order (`artifacts/2026-09-25-office-implementation-plan.md:321-324`). |
| 6 | Readiness waited on every job and ignored the pause | **Fixed, per decision** | `office_maintenance.go:192` counts only `sourceRefresh` or system-paid jobs on non-text source rows. `Ready()` requires the pause (`:164-166`). `status` prints the pause state and exits 1 until ready (`main.go:73-92`). E4 rerun: the unrelated PDF upload is no longer counted. |
| 7 | Reprocess duplicates, the defer shortening the daily retry, the scheduler scan | **Duplicates and defer fixed. Scan not fixed; see R5** | `reprocessTx` answers 409 while a parse or ingest job is queued (`office_maintenance.go:287-292`). `REPROCESS_DEFER_SQL` adds `AND reprocess_at<=now()` (`sourceDocuments.ts:82-83`). E1 rerun: the defer leaves the day in place (23h59m59s), and a request while the first job is queued gets 409, with no second job. `TestReprocessSelection` covers both (`:583-596`). |
| 8 | Process during an export-only publication was dropped | **Fixed** | `upgradeExportTx` (`office_maintenance.go:327-349`, called at `source_documents.go:494`) turns the job into an owner-paid refresh, charged as a first parse when the file never parsed, before or after finalize. The export's own publication is then refused. E2 rerun: `desired_manual` stays true and the job continues as a parse. `TestProcessDuringExportOnlyIsKept` (`:307`) covers it. |
| 9 | Gaps in the pause | **Fixed**, residual R4 | Rooms that load later are paused on a later tick, keyed per document, skipping rooms mid-publication (`server.ts:1672-1700`). Late writers are refused (`:546`). Agent edits and Undo refuse where they commit (`source_documents.go:290`). A publication prepare waits for the room's pause (`sourceHandoff.ts:192`), and the pause resets only its own entry (`:317`). The command now says "within about 15 seconds" (`main.go:45`). Tests: the persist failure, silent writer and prepare-during-pause cases in `sourceHandoff.test.ts`. |
| 10a | A never-parsed file got a free first parse in the window | **Fixed, per decision** | Publish-all routes `NOT f.ever_parsed_successfully` export-only (`office_maintenance.go:105`). Reprocess requires `ever` in Go (`source_documents.go:462`) and SQL (`sourceDocuments.ts:70`). `applyExportTx` marks only files that parsed before (`office_maintenance.go:260`). |
| 10b | The gross storage gate at finalize for the automatic export | **Regressed; see R1** | `source_refresh.go:197` now skips the gate for every export-only job. The publication gate (`:332-339`) nets out the candidate, so it never fires either. |
| 10c | `AssertOfficeEditable` ran before authorization | **Fixed** | It now runs after `SourceSession` in both handlers (`huma_source_documents.go:127-130`, `:169-171`). |
| 10d | The fallback export's bytes differed from the timed-out candidate's | **Fixed** | The export seed is now `sha256(fileId:epoch:checkpoint)` (`sourceDocuments.ts:932`), so one saved state always exports the same bytes and the quarantine key matches. |
| 10e | Agent inspect failed during the pause | **Fixed** | `load(…, unsavedSeed)` keeps the seed in memory on a 423 (`sourceDocuments.ts:476-481`). A 423 maps to `office_editing_paused` (`server.ts:1230`), and Go treats 423 as a refusal (`collaboration_documents.go:112`). |
| 10f | `0031` needs `0030` | **Accepted** | Unchanged, as the coordinator noted. |
| 10g | Other sessions' hunks | **Included in the commit** | `09c946c8` also carries `f3-docx.md`, `f3-merge.md`, `f3-xlsx.md`, the array-formula record rewrite and the WASM-size todo. None of it is C4 content. Confirm that was intended. |
| 11 | Risky paths lacked tests | **Mostly fixed** | Added: the reset template, a blocked owner end to end (`:379`), a trashed export failure (`:450`), the duplicate and defer cases, Process during an export, the pause's failure modes, the handoff path in the scheduler, and moves. Still missing: the `replace(true)` wiring on the client, and anything that would catch R1 or R2. |

## The new decisions

- **The archive is dropped, and the reset guard is the only protection.** Verified. See findings 2 and 3. Runbook step 3 tells the operator to keep the pause on and fix a stuck file on the old engine, or `resume` without deploying (`deployment-runbook.md:2466-2475`).
- **Automatic store-only export goes through the normal handoff.** Verified. See finding 1. The record lists flush, rebase of later saves and banner, and `TestStoreOnlyAutomaticExport` publishes a rebased later save.
- **Readiness counts only publication and reprocess work and requires the pause.** Verified. See finding 6. `TestOfficeReadiness` (`:601`) checks both the paused and unpaused cases.
- **Never-parsed files go export-only and stay manual.** Verified. See finding 10a. `TestPublishAllOfficeSourcesRoutesSpecialGroupsExportOnly` passes.
- **Moves carry no text and count 0 tokens.** Verified in both languages. `trimEffect` drops `before` and `after` for a move, and `effectTokens` skips it (`sourceDocuments.ts:228`, `:261`). Go `sourceEffectTokens` skips moves (`source_caption.go:27`). Admission lets a moves-only Office list through only on the 7-day rule (`source_documents.go:470`, `:482-485`), and the scheduler selects it on the same terms (`sourceDocuments.ts:74-78`). `pending.py:61` tells the model a move carries no text. `TestSourceEffectTokensSkipMoves` passes. The DOCX runtime test in `sourceOfficeRuntime.test.ts` could not run on the commit.

## Regressions the fixes introduced

### R1. Medium: the automatic store-only export skips the storage quota entirely

`server/internal/store/source_refresh.go:197` and `:332-339`.

**Defect.** Finalize no longer gates export-only jobs, but it still writes the export's size, seed and baseline into the candidate, and the candidate's storage trigger charges them to the owner. Publication then computes growth net of `c.storage_bytes`, which already contains the export, so the result is negative and the gate never runs. `openwiki/backend-storage-quota.md:205-208` says this export "is gated on that net change at publication, like a refresh". It is gated nowhere.

**Evidence.** R1 left the owner 1 MB of headroom under a 100 MB limit and ran an automatic export with an 8 MB result. Finalize and publication both succeeded, and the owner ended 7,339,877 bytes over the limit. An ordinary refresh finalizing the same export was refused with `storage quota exceeded … requested=8388656`.

**Failure scenario.** An owner near the limit inserts pictures into a store-only DOCX, which the save gate allows. The next automatic export makes the grown file the file's bytes, and after publication the file and the seed of the export both count. The owner lands over quota, and nothing checked the export's growth along the way. This path now runs for every edited store-only file, whatever the auto-reparse setting.

**Lazy fix.** Gate non-system export-only jobs at finalize again, by changing `!job.system && !job.exportOnly` to `!job.system`. The candidate now stays alive through the whole handoff, just like a refresh candidate, so the gross check that refreshes pass is the correct one. My finding 10b was written for an export that published inside finalize, and that design is gone. Add one test like R1.

### R2. Medium: a refused handoff publication retries on every scheduler tick, with no backoff

`collaboration/src/sourceDocuments.ts:985-988`, and `FailSourceRefresh` at `source_refresh.go:452`.

**Defect.** Any `SourceRequestError` from `publish` is reported as `stale`. `FailSourceRefresh` then clears `refresh_error` and sets `desired_checkpoint=checkpoint`. The Office branch of the scheduler statement does not look at `last_refresh_requested_at`. So the next 5-second tick admits the file again, exports and uploads a new candidate, and flushes the room once more.

**Evidence.** In R2 three rounds in a row each failed stale, left `refresh_error` NULL, and had the file selected again at once. Every round left one more candidate object queued for deletion a day later.

**Failure scenario.** A persistent refusal repeats forever, for example `503 An editor has uncommitted changes` from a room whose persist keeps failing on an engine error while the editor keeps the tab open. Each round runs a full engine export, a B2 upload of the whole file (kept a day) and a handoff that puts every connected editor under "Updating the file…". Before the fix, an export failure parked the file until its next save.

**Lazy fix.** Report `stale` only for a 409, which is a genuine supersede, and let other publication failures set `refresh_error` as before. Or stamp `REFRESH_DEFER_SQL` on a stale failure and require a few minutes since `last_refresh_requested_at` in the Office branch.

### R3. Low: the export-only job keeps the claim's 5-minute lease through the whole handoff

`source_refresh.go:143` sets the lease, and `:237` keeps it for export-only jobs (`requeue=false`).

**Defect.** Nothing renews the lease between claim and publication. The export, the upload, finalize, the 60 s acknowledgement wait and a rebase of up to 120 s all have to fit into 5 minutes.

**Evidence.** In R3 the lease after finalize equalled the lease at claim. Past it, publication and the stale failure both returned conflict. The re-claim succeeded as the job's second attempt; a third claim would park the file with "Source export exceeded its two-attempt limit".

**Failure scenario.** A large store-only workbook whose export takes a few minutes, or a handoff that waits the full minute on a silent editor, never publishes and gets parked until its next save.

**Lazy fix.** Renew the lease in finalize for export-only jobs with `lease_expires_at=now()+interval '5 minutes'`, since the handoff starts right after.

### R4. Low: `pausedRooms` outlives `resume` by up to 5 seconds

`collaboration/src/server.ts:546-556` and `:1678-1682`.

**Defect.** The refusal set is cleared only on the first tick that sees the pause row gone. Authentication is back as soon as the row goes.

**Failure scenario.** A room that stayed loaded through the pause, for example because a reader kept it open, gets a writer within 5 seconds of `resume`. That writer's first update is refused with `source-editing-paused`, and the client lands in recovery.

**Lazy fix.** `onAuthenticate` already queries `sources.editingPaused` for every writer. When that answers false, delete the loaded document from `pausedRooms` there, before the writer can send anything. `beforeHandleMessage` itself must stay free of I/O. Or accept the 5-second gap.

### R5. Low: the scheduler statement goes back to full table scans as soon as any file has been reprocessed

`collaboration/src/sourceDocuments.ts:63-79`, `server/migrations/0031_office_maintenance.sql:17-18`.

**Defect.** Nothing ever clears `reprocess_at`; `office_maintenance.go:260` and `:315` are its only writers. Once one file has a past `reprocess_at`, the `picked` union estimates its `checkpoint>indexed_checkpoint` branch at 20,000 rows, the default selectivity for comparing two columns. The planner then hash-joins full scans of `files` and `source_documents`.

**Evidence.** I measured 60,000 idle source rows plus 20 files with a past `reprocess_at`. HEAD's statement took 0.07 ms. The committed statement took 37 ms, and between 27 and 84 ms across runs, doing parallel sequential scans of both tables. With no marked file at all it took 0.15 ms. A variant with two branches, each ordered and limited to 8 on its own partial index and then merged, took 0.24 ms. The statement runs every 5 seconds on each instance, and any file one window exported and reprocessed marks it for good.

**Lazy fix.** Split the statement into those two limited branches, or clear `reprocess_at` once the file is indexed.

### R6. Low: publish-all does not require the pause, but maintenance export-only relies on it

`server/cmd/office-maintenance/main.go:49-72`, `office_maintenance.go:216-220`.

**Defect.** The system export-only path publishes inside finalize with a discard eviction. It assumes "editing paused, so no writer to flush". `status` checks the pause, but `publish-all` never does.

**Failure scenario.** An operator runs publish-all before `pause`, for example during the rehearsal. Every trashed, never-parsed or suspended-owner file with a live editor goes through the old flow from my finding 1. The editor gets no flush and no banner, and its unsaved typing lands in recovery.

**Lazy fix.** Make `publish-all` exit with an error unless `OfficeReadiness().Paused`.

## Summary

Findings 1, 2, 4, 5, 6, 8 and 9 are fixed, and finding 3 is gone by decision. Finding 7 is half fixed: the duplicates and the defer are fixed, the scan is not. Finding 10 is fixed apart from the storage gate, which regressed (R1), the `0030` dependency, which is accepted, and the other sessions' files. Finding 11 is mostly fixed. The five new decisions are implemented as recorded. The reset guard, the handoff for automatic store-only exports, the paused client paths, the reprocess duplicate guard and the Process upgrade all hold up under the tests and my reruns.

Two regressions need fixing before the window. R1: the automatic store-only export now skips the storage quota entirely. That is a one-line revert of my own suggestion, which the move to the handoff made wrong. R2: a failed export-only publication retries every 5 seconds with a full export, an upload and a flush of the room, with no backoff. R3 to R6 are small, and so are the leftovers: the template comment and the plan's step order, the untested client wiring, and the other sessions' files in the commit.
