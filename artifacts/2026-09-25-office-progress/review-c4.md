# Review of C4: maintenance window tooling, export-only publishing and reprocessing

Date: 2026-09-26. This is an adversarial review of the uncommitted C4 changes in the working tree on top of `e4db9568`. I checked them against the C4 section of `artifacts/2026-09-25-office-implementation-plan.md`, the store-only record, the maintenance-window record and records 19 and 20 in `human/frontend/office-files.md`, the system-payer record in `human/observability-metering.md`, the "For C4" list in `review-c2.md` and the coding rules in `AGENTS.md`. I ignored the rerank session's hunks in the shared files. I changed nothing in the repository apart from this file. Scratch copies and experiments are in the session scratchpad, and every disposable test container is gone.

## What was run

| Check | Result |
| --- | --- |
| The nine C4 and C2 store tests through `pnpm test:go` | All pass. |
| `pnpm test:go` on `./internal/store`, `./internal/httpapi`, `./internal/agenttools` and `./cmd/...` | All pass except the known `TestColumnLimits` failure on `pdf_annotations.text` and `TestMaterialDeleteTakesCloneFenceBeforeAccountLock`, which passes when run alone. |
| `pnpm test:collaboration` | 22 files, 141 tests pass. |
| Frontend vitest for the source session, provider, drafts and workspace | 15 files, 93 tests pass. None of them covers the pause. |
| Pipeline `test_claim_gating_matrix` and the reprocess parse-fee case, with a scratch `fcntl` stub | Pass. |
| `pnpm typecheck`, `gofmt -l` and `go vet` on the C4 packages | Clean. |

Scratch experiments. The Go ones run in a copy of `server/` in the scratchpad through the same disposable Postgres harness.

- E1 `TestReviewReprocessDeferAndDuplicate`: a stale second scheduler selection, the scheduler's defer, and a reprocess requested while the first job is still queued.
- E2 `TestReviewStoreOnlyExportDropsProcess`: the owner presses Process while an automatic store-only export runs.
- E3 `TestReviewResetTemplateHasNoGuard`: the reset template on today's schema and on a C5-like schema, with the pause off and one file unpublished.
- E4 `TestReviewReadinessCountsUnrelatedJobs`: `OfficeReadiness` after an export-only publication and one unrelated upload.
- E5 `TestReviewTrashedExportFailure`: `FailSourceRefresh` for a system export of a trashed file.
- E6 `TestReviewSchedulerCost`: `EXPLAIN ANALYZE` of HEAD's and C4's scheduler statements over 60,000 idle source rows.
- E7 `TestReviewBlockedOwnerRepublishEndToEnd`: publish-all for an `over_quota_frozen` owner through claim, finalize and publication.
- E8 `evict.test.ts`: a real v3 `HocuspocusProvider` against a v4 server, put through the same eviction an export-only publication triggers.

## Findings, ranked

### 1. High: export-only publication evicts the room without a handoff, so connected editors type into a dead room for about 33 seconds

`server/internal/store/office_maintenance.go:205-223`, `server/internal/store/source_refresh.go:205-214`, `collaboration/src/sourceDocuments.ts:862-930`, `src/features/files/useSourceSession.ts:331-436`.

**Defect.** An export-only publication happens inside `FinalizeSourceRefresh`, which the collaboration service calls right after uploading the export (`sourceDocuments.ts:904`). No handoff runs. Nothing flushes the connected editors, nothing makes them read-only, and nothing sends `source-epoch-changed`. The room goes away through the eviction outbox instead (`enqueue_source_collaboration_eviction($1,'discard')`, line 211). That eviction broadcasts `{"type":"access-changed"}` and closes each document connection. `useSourceSession` ignores `access-changed`, and a document-level close from the Hocuspocus 4 server leaves the v3 provider's socket open, so the session sees no disconnect.

**Evidence.** In E8, after the stateless message and `closeConnections`, the provider reported `isAuthenticated=false` with its websocket still `connected`. An edit typed afterwards never reached the server (`unsyncedChanges=1`). The first `disconnect` arrived 32.9 s after the eviction, when the provider's 30-second message timeout fired. Only then does the session reconnect, get a token for the new epoch and call `replace()`.

Saved edits are safe. `publishExportTx` compares the saved checkpoint with the captured one under finalize's row locks and supersedes the job when a save landed after the capture (`TestStoreOnlyAutomaticExport`). A client only gets a receipt after such a save, so no acknowledged edit is dropped.

**Failure scenario.** A user edits a store-only DOCX, passes 3,000 trimmed tokens and stops to read. After 60 idle seconds the scheduler exports and publishes the file. The user starts typing again a few seconds later. The editor stays writable, the status reads "Saving…", and for up to 33 s nothing reaches the server. When the provider times out, the client finds the new epoch, its changes are not covered, and it lands in recovery with "Download it to keep a copy, then discard this draft". Keystrokes typed in the last save interval before finalize end the same way; a save lands 1 s after the last keystroke or through the 2 s hocuspocus debounce, 10 s at most. An idle second editor sees the newer-version banner only after the same 33 s. For parsed files the handoff shows that banner at once and flushes pending input first. The store-only record puts every edited store-only Office file on this path automatically, outside the window, at every 3,000 trimmed tokens or 7 days of saved edits.

**Lazy fix.** The smallest fix is on the client. Treat `{type:'access-changed', fileId}` for the open file like `source-epoch-changed` and call `replace()`. That closes the 33 s blind window, for export-only and for the existing trash and ACL evictions. The complete fix runs the export-only finalize under `SourceHandoff`, the way `publish()` wraps the gateway publish: send `prepare` to flush and lock the room, POST the finalize, then send `complete`, or `cancel` after a supersede. With the flush, keystrokes typed during the export get saved, finalize supersedes, and editors carry on. Only silent editors land in recovery, as record 20 describes for handoffs.

### 2. High: the reset template drops unpublished edits without checking the pause or readiness

`server/migrations/templates/office_window_reset.sql:22-47`.

**Defect.** The template relies on the runbook order alone. The statement never checks that the pause row exists, that no Office source has unpublished edits, or that no refresh is in flight. Whatever database a deploy points at gets reset.

**Evidence.** E3 filled in all three formats. On today's schema the template fails safely, with `null value in column "state" of relation "source_documents" violates not-null constraint`. On a C5-like schema, with nullable `state` and `indexed_baseline` and a `storage_bytes` that counts NULL as 0, it ran with the pause off and reset a row at checkpoint 1 and indexed checkpoint 0. The row came out at epoch 2 with a NULL state. Its edits survive only in `source_state_archive`.

**Failure scenario.** Several routes put the reset in front of unpublished edits. The window's revision gets promoted to production before production's own window. An edit lands between the last `status` and the migration, which is several minutes while the deploy builds. A writer slipped past the pause (finding 9). The client that saved those edits holds a receipt, so after the deploy it reconnects, finds the new epoch, counts its changes as covered and shows "Your changes were saved". The reopened file does not contain them. Getting them back needs an operator, the archive and the old base, and finding 3 shows the base goes away.

**Lazy fix.** Start the template with `LOCK TABLE source_documents IN SHARE ROW EXCLUSIVE MODE;` and a `DO` block that raises when any row in `{{FORMATS}}` has `checkpoint>indexed_checkpoint`, non-empty `pending_effects` or a `running_job_id`, or when such rows exist and `office_editing_pause` is empty. `0015_source_semantic_baseline.sql` already guards a destructive change this way. `applyMigration` runs each file in its own transaction, so the lock, the check and the reset are atomic. A fresh database has no rows, so CI and the test harness still pass.

### 3. Medium: archived states cannot be exported once their base is released, and at reset time they hold nothing the file lacks

`server/migrations/0031_office_maintenance.sql:21-33`, `server/migrations/templates/office_window_reset.sql:26-31`.

**Defect.** Exporting a state needs its base bytes; `exportOffice` takes the base plus the state (`sourceDocuments.ts:874-891`). The archive keeps `base_source_sha256` but not the path, and holds no blob reference. The base lives only while it is still the file's current blob. The first publication after the window replaces it, `blob_unref` queues the delete with no delay, the reaper runs every minute, and the B2 lifecycle removes hidden versions after a day.

Readiness is zero at reset time, so every archived state is a post-publication state. An export-only file stores the seed of its export, and a republished file stores the rebased state with no later edits. In E3 the published file's archive row holds `seed-e` with sha `eeee…`, the seed of the file's current bytes. In the intended flow the archive adds nothing beyond the file blob. It matters only when the reset dropped edits it should not have (finding 2), and only until that file's next publication. It also cannot undo the old engine's export losses in publish-all, because publication already replaced the pre-publication state and base.

**Failure scenario.** A week after the window someone finds edits the reset dropped, on a file the owner has since edited and published. The archive row exists, but its base sha names an object the reaper deleted days earlier.

**Lazy fix.** Add `base_blob_path text NOT NULL` to `source_state_archive`, fill it in the template, and attach `account_blob_refs('base_blob_path')` to the archive table. The base then stays referenced until the 30-day purge, and the purge's `DELETE` releases it through the same trigger. If the archive is meant to recover export losses, it has to be written at publication time instead. That is a developer decision.

### 4. Medium: a client that misses `source-editing-paused` stays editable under a raw token error

`src/features/files/useSourceSession.ts:160-171`, `:310-321`, `:448-462`, `src/features/files/useOfficeRuntime.ts:274-288`.

**Defect.** Only a client that answers ready and then receives `source-editing-paused` gets the read-only paused banner. Every other client comes back through a reconnect, and the gateway answers its token request with `423 office_editing_paused`. HocuspocusProvider catches the failed `token()` in `sendToken` and reports `authenticationFailed` with the reason `Failed to get token during sendToken(): ApiError: 423 Locked — office editing is paused for maintenance`. The session maps only the collaboration service's `office-editing-paused` reason, so it calls `fail()` with that raw English string. `fail()` sets status `error`, and `set-capabilities` keeps the editor writable for every status except `recovery` and `connecting`.

Three groups take this path. A writer whose pending input does not flush within the 10 s ready window is closed with 4408. Every writer of a room whose flush persist fails, because `pause()` then skips the paused message. And any tab that was asleep or offline when the pause started reconnects into the refusal. Under a normal handoff the first group lands in recovery, per record 20. Under the pause it lands on an editable page.

**Failure scenario.** A laptop sleeps through the pause and wakes during publish-all. The editor shows the technical error, stays editable, and every keystroke sets "Saving…". The edits go to local drafts only. After the reset those drafts belong to the old epoch, so they return as recovery and nothing merges.

A client that does get the message but is not covered goes to recovery with "Editing is paused for maintenance. Try again once maintenance is over." (`useSourceSession.ts:289-291`). That text replaces the recovery message telling the user to download the draft, and "try again" misleads, since the draft cannot merge after the reset.

**Lazy fix.** In the `token` callback, catch `isApiError(error) && error.code === 'office_editing_paused'` and call `replace(true)` before rethrowing. In `onAuthenticationFailed`, call `replace(true)` for the `office-editing-paused` reason instead of `fail()`. Keep `m.source_edit_recovery()` in the recovery branch.

### 5. Medium: runbook step 5 cannot run while editing is paused

`openwiki/deployment-runbook.md:2485-2488`; the plan has the same order at `artifacts/2026-09-25-office-implementation-plan.md:321-324`.

**Defect.** Step 5 opens a file of each format in Edit, makes an edit and publishes it, and only step 6 resumes. While the pause row exists, `getSourceSession` and `createSourceCollaborationToken` call `AssertOfficeEditable` and answer 423 for every Office file (`server/internal/httpapi/huma_source_documents.go:123`, `:164`). The check cannot run in that order. Since the plan has the same order, this was a stop-and-report item for the implementer.

**Failure scenario.** The UAT rehearsal reaches step 5 and every Edit open fails with the paused error. The operator resumes to get on with it, which on production would let users back in before anyone has checked the new engine.

**Lazy fix.** On UAT, swap steps 5 and 6. For production, either accept that order or let the operator's account past `AssertOfficeEditable`. That needs a decision.

### 6. Medium: readiness waits on every job in the system and never checks the pause

`server/internal/store/office_maintenance.go:160-191`, `server/cmd/office-maintenance/main.go:73-87`.

**Defect.** The in-flight list holds every pending or running `source_refresh`, `parse` and `ingest` job in the system (line 178). That is what the plan says, but the reset drops only Office states. Uploads of other files, text refreshes and plain reprocess parses, which index the file's blob, do not touch anything it drops. It gets worse after a fallback. An export-only publication sets `reprocess_at=now()`, so from its next run the scheduler queues a system-paid parse for each fallback file of an active owner, eight per run, and the deploy then waits for those parses as well. `status` also never says whether the pause is on.

**Evidence.** In E4, after one export-only publication and one PDF upload, `OfficeReadiness` listed no unpublished file and two in-flight parse jobs: the scheduler's reprocess and the unrelated upload. `status` exits 1 until both finish.

**Failure scenario.** On an environment with users, uploads keep the count above zero, and each fallback file adds a full parse, possibly OCR, before the deploy can start. An operator who has watched `status` for an hour will be tempted to deploy anyway. And after a mistaken `resume`, `status` can print zero with the pause off while nothing stops the deploy (finding 2).

**Lazy fix.** Count as in flight only jobs with `payload->>'sourceRefresh'='true'` whose file has a non-text `source_documents` row; finalize keeps that key when it turns the job into `parse` or `ingest`. Print the pause state, and exit 1 while it is off.

### 7. Low: the reprocess branch can queue a duplicate job, and the scheduler's defer can cut the daily backoff to an hour

`server/internal/store/source_documents.go:459-463`, `server/internal/store/office_maintenance.go:243-275`, `collaboration/src/sourceDocuments.ts:71-72` and `:950-954`.

**Defect.** `reprocessTx` inserts a plain parse or ingest job, which never sets `running_job_id`. The only guard against a second job is `reprocess_at`, and nothing looks for a parse or ingest job already queued for the file. The scheduler's catch also defers every failed reprocess row by an hour, including a 409 that only means the row was reprocessed a moment ago.

**Evidence.** In E1 the first automatic request created a job and set `reprocess_at` about 24 h ahead. A second request from a stale selection got 409, and the scheduler's defer moved `reprocess_at` to 59 minutes ahead. With the first job still pending an hour later, a third request created a second job, leaving two pending parse jobs for one file.

**Failure scenario.** Two collaboration instances overlap during a rolling deploy and both select the row, or the ingest host is down for a day. Every time `reprocess_at` passes, another system-paid job for the same bytes joins the queue.

**Lazy fix.** Guard `reprocessTx` with `NOT EXISTS(SELECT 1 FROM jobs WHERE payload->>'fileId'=$1 AND type IN ('parse','ingest') AND status IN ('pending','running'))`, and add `AND reprocess_at<=now()` to `REPROCESS_DEFER_SQL` so it never pulls a fresh day back to an hour.

The same branch made the scheduler scan the whole table. The reprocess predicate is ORed with the refresh predicate, so the partial `source_documents_pending_idx` no longer applies. In E6, with 60,000 idle rows, HEAD's statement took 0.03 ms through that index and C4's took 19 ms as a parallel sequential scan. It runs every 5 s on each instance and grows with every file anyone has opened. A partial index on `reprocess_at IS NOT NULL` and a `UNION ALL` of the two branches bring back index scans.

### 8. Low: the owner's Process during an export-only publication is dropped silently

`server/internal/store/office_maintenance.go:222`, `server/internal/store/source_documents.go:485-490`.

**Defect.** `publishExportTx` clears `desired_manual`. A Process request that arrives while the export-only job runs is recorded only as `desired_manual`, and the gateway answers 202 with the export's job id.

**Evidence.** In E2, Process during an automatic store-only export returned the export job's id and set `desired_manual=true`. After finalize the row had `desired_manual=false`, no `reprocess_at` and no queued job, and the file was still never parsed and not indexed. Publish-all does the same to a store-only file with a pending Process.

**Failure scenario.** The owner presses Process to pay for the first parse. The UI shows the request accepted. The file ends up stored, unindexed, with nothing queued.

**Lazy fix.** When a manual request finds a running job whose payload has `exportOnly`, answer 409 so the client asks the owner to try again once publishing ends.

### 9. Low: gaps in the pause's coverage

- `collaboration/src/server.ts:1653-1671` runs the flush once, on the transition, for rooms already in `hocuspocus.documents`. A room still loading at that tick arrives later, and a writer who authenticated before the flag keeps writing until its 5-minute token expires. Lazy fix: while paused, each tick also closes writable connections in any Office room.
- `EditDocument` checks the pause before posting to the authority, and the collaboration service's edit path does not check it. An agent edit that passed the check just before the pause still lands; publish-all then sees it as unpublished.
- `SourceHandoff.pause` and a publication handoff for the same room share `this.local` without coordinating. A publication prepare during the pause flush calls `reset()`, which makes the writers writable again and drops the pause's waiting entry. The pause's 10 s timer then closes every writer with 4408 and sends them down finding 4's path, and the pause's final `reset()` drops the publication's entry.
- The command prints "within 5 seconds" (`main.go:45`). Noticing the flag takes up to 5 s and the flush up to 10 s more. Running publish-all right away only costs a second run.

### 10. Low: smaller defects

- A file whose first parse failed keeps `parse_mode` `fast` or `ocr` with `ever_parsed_successfully=false`. Publish-all republishes it with `parseFee=false`, and once exported (trashed, for example) it reprocesses as system, so its first parse is free. Only `parse_mode='none'` counts as store-only (`office_maintenance.go:103`, `source_documents.go:457`). The C2 review flagged this case.
- For the automatic store-only export, finalize gates storage on the gross growth, export size plus seed plus baseline (`source_refresh.go:196-201`), although the export replaces the file bytes and the state in the same transaction. A near-quota owner's store-only file is refused and parked until its next save, even when the net change is negative.
- `AssertOfficeEditable` runs before authorization, so during the pause an actor with no access gets 423 instead of 404 for an Office file id.
- The fallback export's seed comes from its own job id, so its bytes, and with them the quarantine key, can differ from the timed-out candidate's. If they do, the first reprocess runs the parser to its hard timeout once more before the quarantine holds.
- Agent `inspect` of a never-opened Office file seeds and saves through `load()`. During the pause Go refuses that seed with 423, which reaches the tool as the authority being unavailable.
- `0031_office_maintenance.sql` needs the rerank session's `0030_rerank_slot.sql` committed first. The migration runner refuses a numbering gap and an out-of-order file.
- `human/frontend/office-files.md` also carries another session's rewrite of the array-formula record. The C4 commit needs HEAD plus the C4 hunks only, as do the openwiki pages it shares with the rerank work.

### 11. Low: the risky paths lack tests

- No test fills in and runs the reset template. E3 is a starting point, and it would pin the guard from finding 2.
- The system republish of a blocked owner is tested only at admission. E7 ran it end to end for an `over_quota_frozen` owner. The owner-paid request was refused as locked, and the system job passed claim, a 5 MB finalize and publication to epoch 2 with nothing left unpublished. That run belongs in the suite.
- Nothing tests the client side of the pause: `source-editing-paused`, the 423 when opening Edit and the 423 on reconnect.
- `pause()` with a failing persist, a silent writer during the pause and the reprocess defer race are untested.
- `FailSourceRefresh` on a trashed file, newly possible since C4 dropped the trash filter, has no test. E5 shows it parks `refresh_error` as intended.

## The implementer's open questions

- Question 1, the automatic store-only export skipping the flush. Confirmed, and the window is wider than capture to finalize. A save after the capture supersedes the export, so saved edits are safe. Keystrokes not yet saved at finalize are lost to the server, and so is everything typed during the roughly 33 s before the evicted provider notices. Both end in recovery. See finding 1.
- Question 3, whether archived states need their base. Yes. An archived state can only be exported with its base, and the archive neither stores the base path nor holds a reference to it. After a correct window the archived states are only seeds of the current bytes. See finding 3.
- Question 6, readiness counting unrelated jobs. Yes. E4 lists an unrelated PDF upload as in flight, and the scheduler's immediate reprocess of fallback files adds more. The reset only needs the pause on, no Office refresh work in flight and no unpublished Office edits. See finding 6.

## Checked, nothing wrong found

- Who can pause, publish all or pay as system. Only `cmd/office-maintenance` calls `SetOfficeEditingPaused`, `PublishAllOfficeSources` and `OfficeReadiness`. The system payer comes only from `requestSourceRefresh` called by publish-all and from `reprocessTx`, which needs a `reprocess_at` that only a system export-only publication sets. Claim, finalize, publish and fail read `system` and `exportOnly` from the immutable job payload, and no request field reaches them. The automatic branch overrides `exportOnly` with `storeOnly && !manual` and keeps both `sourceLockTx` with edit access and the storage gate. The command runs with the gateway's database credentials inside the `server` container, like `reconcile`.
- Blocked owners. For system jobs, claim, finalize and publish use `maintenanceLockTx`, which takes the same advisory lock and user row lock as `sourceLockTx` without refusing a locked account. The storage gates at request, finalize and publication skip system jobs. In the pipeline, `_account_allows_ingest` skips the storage and credit checks for system jobs at every stage, while `_pipeline_source_cancellation` still stops suspended, deletion-pending and trashed files. Publish-all sends exactly those groups export-only, so Go and the pipeline agree. E7 confirms the whole path.
- Parse fee. `_parse_fee` returns false for system jobs, and every `_finish_ok` call that can carry parse usage passes it. The donor-reuse call runs before any parse.
- Export-only publication. The handler checks the uploaded object's size and ETag before finalize. `publishExportTx` bumps the epoch, stores the export's seed and baseline, empties pending effects, drops the search alias (a trigger removes the orphaned content) and the caption associations, releases AI Undo and the old parse cache, deletes the candidate and marks the job done. It enqueues the eviction before the epoch bump, so the payload names the old room. A superseded export clears `running_job_id`, leaves `refresh_error` NULL and releases the uploaded object a day later. Store-only files stay unmarked.
- The pause on the Go side. Edit sessions and tokens answer 423 with `office_editing_paused`, seeding refuses after authorization, agent edits and Undo refuse with the tool code, and saves of open rooms still land. The collaboration service refuses only writers at authentication. Pausing an idle room adds no checkpoint, because `storeSnapshot` returns without saving when the snapshot has no contributor marker, so the pause never makes an untouched file look unpublished.
- Scheduler selection. The reprocess predicate in the SQL matches Go's condition, Go's `sourceLockTx` adds the active-owner check, and a refused reprocess row moves an hour ahead, so it cannot starve other rows. The store-only branch matches Go admission. `TestReprocessSelection` and `TestRefreshSchedulerQuery` run both statements verbatim.
- Migration 0031. Go reads the pause table in `AssertOfficeEditable` and in the seeding check of `SaveSourceCheckpoint`, the collaboration service in `editingPaused` and the pause timer, and only the command writes it. `publishExportTx`, `reprocessTx` and the defer write `reprocess_at`, and admission and the scheduler read it. Workspace clone and transfer do not copy `source_documents` rows, and storage reconciliation sums only `source_documents`, so the archive stays off the owner's usage. Ops roles use per-column grants, so ops cannot read the archive's `state`. Archive rows cascade with their file, and the purge in the trash sweep uses the `archived_at` index. `//go:embed *.sql` does not reach `templates/`.
- The template's CTEs. The archive insert reads each state before the update (E3), and the Undo release matches `invalidateEditInversesTx`.
- The C2 review's "For C4" list. Everything is handled apart from the failed-first-parse case in finding 10.

## Open questions for the developer

1. Should export-only publication go through the handoff coordinator, as parse publications do under records 19 and 20, or is a client-side banner on `access-changed` enough?
2. What is the archive for? Recovering the old engine's export losses needs the pre-publication state and base captured at publication time. A safety net for the reset needs the base blob pinned.
3. From C4's deploy until the window, the automatic store-only export runs on the old pin, and each publication replaces the store-only file's bytes with an export that drops charts and opaque drawings. The window accepts that loss for UAT data. Is it also accepted for this automatic path, or should the path wait for the new pin?
4. Should a file whose first parse failed republish for free in the window, or go export-only like a store-only file?
5. For runbook step 5, resume before the check, or give operators a way past the pause?

## Summary

C4 implements all five plan items. Billing and authorization hold up: only the command pauses the system or pays as system, blocked owners' files publish end to end, and an export-only publication never drops a saved edit.

Two things need work before C4 ships. Export-only publication skips the handoff, so anyone who types into a store-only file right after an automatic publication keeps typing into an evicted room for about half a minute and then lands in recovery. That happens in everyday use, not just during the window. The reset template trusts the runbook, so nothing stops it from dropping unpublished edits, and the archive meant to cover that loses its base at the file's next publication. Both fixes are small. The rest is the paused client's reconnect path, a runbook step that cannot run while paused, a readiness check that waits on unrelated work, a reprocess duplicate and missing tests.
