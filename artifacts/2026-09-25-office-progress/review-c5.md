# Review of C5 and the C4 recheck fixes (uncommitted, on HEAD 4a47d986)

Date: 2026-09-26. Scope: the files and hunks `c5.md` lists, with the engine at `vendor/betteroffice`
(now `e912e8e0`, which is `b8ee465c` plus the fork's `tiff` build fix). I changed nothing except this
file.

Runs:

- `pnpm test:collaboration`: 22 files, 152 tests pass.
- `go run ./cmd/testdb ./internal/store/...`: everything passes except the known `TestColumnLimits`
  (`pdf_annotations.text`).
- `go run ./cmd/testdb ./internal/httpapi/...`: passes.
- One scratchpad experiment calling `officeUpdateViolation` directly (M1).

Counts: 0 high, 2 medium, 4 low, 6 nit.

## Medium

### M1. The roots check refuses an honest client's typing after a room reload, and sends it to recovery

`collaboration/src/officeRoots.ts:113-114`, `collaboration/src/server.ts:584-601`.

**What is wrong.** An update whose structs point at items that neither the room nor the update holds
is refused as unrecoverable. Plain Yjs would park that update as pending until the missing items
arrive. The Hocuspocus provider (3.4.4) sends local updates as they happen, and it sends updates
queued during a reconnect as soon as the socket opens. The server handles them before the client's
sync step 2, which the client sends only after it receives the server's sync step 1.

**Failure scenario.** A collaboration instance dies (OOM, kill, crash) before it persists a user's
last few seconds of typing. The room reloads from the database without those items. The user is
still typing. The next keystroke's origin is one of the lost items, so the update arrives before
step 2 and is refused with `recoverable: false`. The client disconnects and lands in recovery,
although its sync step 2 was self-contained and would have merged.

I reproduced this with a seed under client 1 and a client that inserted " world", after which the
room reloaded to the seed only:

- the next keystroke is refused ("Office update refers to content the room does not hold");
- the step 2 that would follow passes;
- plain Yjs merges both into "hello world!".

**Fix.** For an unresolved reference, close the connection without the unrecoverable message, so
the provider reconnects and its step 2 carries the missing content. Keep the unrecoverable refusal
for foreign roots and `pptx:meta`. Add a test for this path; none exists now.

### M2. The UAT cleanup still reads `source_refresh_candidates.user_id`, which 0032 drops

`e2e/uat/journeys/cleanup.ts:178`. Related: `e2e/uat/journeys/office.ts:52`.

**What is wrong.** The "Capture owned storage and worker traces before account purge" step selects
`source_blob_path FROM source_refresh_candidates WHERE user_id=ANY(...)`. After 0032 that statement
errors. `recover()` then sets `canPurgeActors = false`.

**Failure scenario.** Every UAT run after the window fails cleanup and never purges its test actors
or their blobs.

Separately, `savedExport` calls `string(row.state)`, which throws on the NULL state that every
publication without later edits now leaves. So any journey that reads the saved export after such a
publication fails. C6 owns the journeys, but C5 introduced the schema change and `c5.md` does not
hand either break over.

**Fix.** Join `files` for the owner (`c JOIN files f ON f.id=c.file_id WHERE f.user_id=ANY(...)`).
In `savedExport`, treat a NULL state as seed(base) through the bundle's `seedOffice`, or as the
Y.Text seed for text.

## Low

### L1. R5 is incomplete: a refresh publication indexes the file without clearing `reprocess_at`

`server/internal/store/source_refresh.go:367` and `:388`, `pipeline/pipeline/store/db.py:1288-1294`.

**What is wrong.** Only the pipeline's `set_file_indexed(True)` clears the mark. Go's
`PublishSourceRefresh` sets `files.indexed=true` itself and leaves `reprocess_at` alone.

**Failure scenario.**

1. A window's export-only publication marks a file.
2. Before its reprocess runs, or during the one-day wait after a failed reprocess, the owner edits
   the file and a normal refresh publishes and indexes it.
3. The mark stays in the past. The reprocess branch of `REFRESH_CANDIDATES_SQL` skips the row
   (`NOT f.indexed`) but still walks past it on `source_documents_reprocess_idx` on every 5-second
   tick, on every instance.

This is the growth R5 was meant to stop.

**Fix.** Add `reprocess_at=NULL` to the Office publication `UPDATE` at `:388`, where the file
becomes indexed.

### L2. Removing the admission and finalize gates lets a near-quota owner pay for a parse that can never publish

`server/internal/store/source_documents.go:531-548`, `source_refresh.go:196-203`.

**What is wrong.** This matches the recorded rule: a candidate is uncharged and publication gates
the net growth. But nothing before the parse checks the part of the growth already known at
finalize.

**Failure scenario.**

1. An owner with 200 KB of headroom edits a DOCX. The saves fit.
2. The export is 1 MB larger than the published file.
3. The refresh is admitted, finalized and parsed, with credits reserved and embedding or LLM calls
   spent.
4. `PublishSourceRefresh` then refuses with `QuotaExceededError`.
5. The next save clears `refresh_error`, and the cycle repeats with another paid parse.

**Fix.** At finalize, for non-system jobs, gate the lower bound of the publication's net growth.
Here `$size` is the finalize request's `SizeBytes`:

```sql
($size - f.size_bytes) + 2 - d.storage_bytes
```

This assumes no later edits (the state returns to NULL and the effects to `[]`). Later saves can
only add to it, so the check never refuses a publication that would have fit. Choice 1's objection
covers a gross-bytes gate, not this net bound.

### L3. Go accepts a rebased DOCX or PPTX state without its baseline, and an XLSX baseline it never uses

`server/internal/store/source_refresh.go:319-327`.

**What is wrong.** Only `baseline != nil && state == nil` is refused.

**Failure scenario.** A DOCX publication that carries `rebasedState` without `indexedBaseline`,
for example from a future caller or a service bug, stores the state with a NULL baseline.
`indexedBaseline()` then derives the baseline from seed(export), whose identities differ from the
rebased state's. Every later save's pending effects are then computed against the wrong identities
and come out wrong: spurious changes or missed ones. An XLSX baseline would be stored and charged
but never read.

**Fix.** Require a baseline exactly when `state != nil` and the format is `docx` or `pptx`, and
refuse one for `xlsx`.

### L4. Test gaps on the new invariants

**What is missing.**

- No test captures a NULL state, saves, and then checks that the claim (and `CAPTURED_STATE_SQL`)
  still returns NULL. That is exactly the case choice 3's `CASE` reader exists for.
  `TestSourceRefreshRebasesNewerSavedOfficeState` covers only a non-NULL capture.
- No test covers the "content the room does not hold" refusal (M1).
- Nothing reconciles `user_storage` after 0032 on pre-existing rows. The migration only ever runs
  on an empty test database. I checked the arithmetic by hand, and it holds (see Verified OK), but
  a regression would go unnoticed.

**Fix.** Add the NULL-capture case to the Go test, and a two-client reconnect case to
`sourceOfficeRuntime.test.ts`.

## Nit

- **`openwiki/frontend/office-files.md:269-271`** says the XLSX save button requests the checkpoint
  and "nothing is serialized". Per choice 7, the XLSX toolbar save still serializes and discards the
  bytes. Say so.
- **`src/office-runtime/officeFonts.ts:75-77`.** The last-resort face registers as a `FontFace`
  under any family a document names, in the runtime iframe's document. A DOCX that names `Inter`
  therefore repaints the runtime chrome (`office-runtime.css:2`, `font-family: Inter, …`) in
  Liberation Sans. Register those faces under a prefixed alias, or skip families the chrome uses.
- **`src/office-runtime/main.tsx:151`.** The replica `clientId` is a random `uint32` that can be 0,
  and 0 is now the DOCX seed client (`SEED_CLIENT_ID`) and the text seed client. Unlike Yjs, Yrs
  does not regenerate a colliding id. Draw from 1 upward. The odds are about 2^-32, but the fix is
  one line.
- **Version skew during the window deploy.** Text editing is not paused, and both APIs are strict
  (`additionalProperties: false`, `DisallowUnknownFields`).
  - While an old collaboration instance talks to the new API, its text first-opens (`initialize`)
    and text publications (`indexedBaseline` with no state, refused at `source_refresh.go:319`)
    fail.
  - In the other order, `seedBytes` is rejected.

  This is transient and data stays in drafts. Deploy both services together, or note it in the
  runbook.
- **`collaboration/src/server.ts:588`.** The first Office update on each instance performs the
  bundle's dynamic import inside `beforeHandleMessage`, whose comment asks for no I/O. A failed
  import stays cached as a rejected promise, so every Office update then fails until restart. Call
  `officeDocumentRoots()` once at boot.
- **Text candidates.** `sourceDocuments.ts` sends `seedBytes` equal to the whole text state for
  text candidates (`seed = state`). Nothing reads it, but the column then holds a meaningless value.
  Send nothing for text.

## Verified OK

- **NULL state.** These paths all handle a NULL state:
  - `load`, `inspect` (nothing saved, no pause dependency);
  - the agent edit (`seedReport(current)` after `load` binds the SHA);
  - the room flush (`stateOf` plus `seedReport`);
  - `exportCandidate` (seed(base), with the SHA computed when unbound);
  - `resolve`, `rebasePublication` (captured NULL becomes `seed(session)`) and the text handoff;
  - the browser editing session (`if (session.state)`) and the viewer (state is returned only when
    `checkpoint > indexed_checkpoint`, which a NULL state never has).

  NULL returns on every Office publication path without later edits:

  - the handoff refresh: Go refuses a NULL state unless `doc.Checkpoint == in.Checkpoint` and the
    effects are empty;
  - the owner export-only publication;
  - the maintenance `publishExportTx`, which supersedes on any later save;
  - the reset.

  Text keeps its state by design and sets its baseline to NULL. Its derived baseline, the decoded
  export, equals `textState(captured)`.
- **Derived-baseline cache.** Seeds and baselines are keyed `format:sha` of bytes that `base()`
  verifies against the SHA. The engine is fixed per process and the epoch does not affect seed or
  baseline, so a wrong baseline cannot be served. The eviction loop and oversized entries behave.
- **Copy-on-write.**
  - Save, claim, finalize and publish all take the per-file advisory lock (`sourceLockTx` /
    `maintenanceLockTx`).
  - The copy and the row update commit in one transaction, and the lock-free TS readers are single
    statements. So a reader sees either (row's state, same checkpoint) or (copy, later checkpoint),
    never another checkpoint's state.
  - A NULL capture copies NULL, and the `CASE` keeps reading NULL.
  - No path changes `source_documents.state` at an unchanged checkpoint without deleting the
    candidate (publication and reset do). A trash restore bumps the epoch only, and every reader
    requires `c.epoch=d.epoch`.
- **0032 ledger.**
  - Office and text rows get a zero formula delta, since `seed_bytes=0` makes new equal old.
  - The text-baseline `UPDATE` is booked by the still-present storage trigger.
  - Candidates are refunded in full (`size_bytes` included) before their trigger and columns go.
  - The resulting ledger equals the new recount in `reconcileStorageUserTx`.
  - `transfer_source_storage_owner` no longer touches candidates.
  - Text rows are charged `effects + state`, exactly as before minus the baseline.
  - No SQL function or Go query references the dropped candidate columns. The only reference left
    is M2.
- **Gates.**
  - The checkpoint growth in `SaveSourceCheckpoint` reproduces the generated column exactly.
  - The publication growth uses `c.seed_bytes` for a rebased state and `d.seed_bytes` for text.
  - The system payer is exempt only at publication, per the window record.
  - The admission and finalize gates are gone, per the 2026-09-25 quota record (see L2 for the cost
    side).
- **0033.**
  - The guard covers unpublished checkpoints, pending effects and in-flight jobs, and it requires
    the pause whenever Office rows exist. It runs under `SHARE ROW EXCLUSIVE`.
  - The body equals the template with the three formats filled in.
  - It bumps the epoch, NULLs state, baseline and `seed_bytes`, empties the effects, releases Undo
    and deletes candidates.
  - A second run is harmless, and a fresh database passes (as the Go test boot shows).
  - `0030` and `0031` are committed at HEAD, and `0032` and `0033` follow in order.
- **Roots check, apart from M1.**
  - Awareness frames never reach it (`inboundYjsUpdate` returns null).
  - Hocuspocus serializes messages per connection (`processMessages`).
  - A self-contained sync step 2 passes, and GC'd references are skipped.
  - `commentFlavor` writes pass, and other `pptx:meta` writes and deletes are refused.
  - Old-epoch clients are refused at authentication.
  - The handoff flush is server-side.
  - The per-update cost is one decode plus a cached walk per new item. `updateFitsRoom` does not
    mutate the size estimate before a refusal.
- **Text seeds under client 0.** Text uses the same fixed client as the DOCX `SEED_CLIENT_ID`. A
  browser Yjs doc that drew 0 regenerates its id when a remote update uses it. Existing text rows
  keep their stored state and lineage, and 0032 NULLs only empty states.
- **R1.** Owner export-only is refused at publication without headroom
  (`TestStoreOnlyExportIsQuotaGated`). A frozen owner's system republish of a 5 MiB export still
  publishes (`TestBlockedOwnerMaintenanceRepublish`).
- **R2 to R6.**
  - R2: only a 409 is stale.
  - R3: the lease is renewed at finalize, and the test asserts it.
  - R4: a writer's authentication after `resume` clears `pausedRooms` and `pauseChecked`. A race
    with a slow query re-pauses on the next tick.
  - R5: the two limited branches (see L1 for the leftover).
  - R6: publish-all refuses without the pause, and both tests pause first.
- **Office hosts.**
  - Exports can't miss pending input: `export` awaits `flush()` (composition and pointers, then the
    host flusher) before calling the exporter, and PPTX flushes again.
  - DOCX and PPTX flushers are now wired in `main.tsx`, and XLSX `save()` settles or throws.
  - Font failures reach `onError` in the editor and fail the viewer worker.
  - The engine's registry evicts failed loads (`retryable`), so a later open retries instead of
    staying broken.
  - The viewer registers the worker's faces before painting and ignores late results after
    cleanup.
  - The Vite and tsconfig aliases do not shadow `@betteroffice/fonts-cjk`.
- **Docs and tests.**
  - `openwiki/backend-storage-quota.md`, `openwiki/frontend/office-files.md` and the test-catalog
    rows match the code, apart from the XLSX nit.
  - No test still uses `initialize`, a checkpoint `indexedBaseline`, a candidate `baseline` or a
    candidate `seed`.
  - The new Go and collaboration tests are focused.
