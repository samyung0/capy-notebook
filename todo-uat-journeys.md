# UAT journeys: handoff (2026-10-14)

Where the UAT Sentry triage and the journey expansion stand, what was decided,
and what to do next. Coverage itself is described in
`e2e/uat/journeys/README.md`; this file is the work queue.

## State at handoff

- The Sentry triage fixes from 2026-10-10 are on main (`10c858e9`) and on UAT
  (release `8b830ad0` on 2026-10-14). None of the 7 open UAT issues (W, T, G,
  S, V, CAPY-WEB-2, R) has been seen since. **Resolve them in Sentry after the
  next green journey run**, so a recurrence shows as a regression.
- Every "Deterministic UAT quality" run on 2026-10-13 failed. The last full run
  (38368795582) passed 10 journeys and stopped at the note journey (a shared
  copy turned mentions into text), fixed by `19a4e8eb`, which is deployed. A
  run started 2026-10-14 01:56 UTC (38498441073) was still in progress.
- UAT capacity row `relace:glm-5.3-flash` = 100 / 80 was added by hand
  (2026-10-10, from `deploy/model-capacities.sql` and the 2026-09-26 bench).
  Prod has no Capy database yet; run that script at the first promotion.

## Committed 2026-10-14, unreviewed (`7a8d7e7a`, merged and pushed as `3f99cf5e`)

Everything below was committed together with other sessions' unfinished UI
work from the shared tree. None of it has run on UAT; review before deploying.


- `e2e/uat/journeys/membership.spec.ts` (new) plus its README and
  `openwiki/test-catalog.md` rows: invited editor → demoted to viewer (through
  the members UI, open note and DOCX editors go read-only) → removed (open
  connection closed, everything 404, edits kept). Typechecked and the UI steps
  ran against MSW; **never run on UAT**.
- `editor_read_only_strip` is now neutral ("This file is read-only now." / zh)
  because it also shows for demoted viewers, who can't delete; the account
  banner explains frozen and full. Paraglide recompiled.
  `openwiki/frontend/plate-editor.md` records this and the removal decision
  below.
- Two agents were still writing when the session ended; their changes may be
  in the tree, unreviewed:
  - **Model round + scripted tool calls**: done. Never run on UAT; pipeline
    offline tests (1112), `tsc`, biome, `test:deployment`,
    `test:uat:verifier` and `--list` pass.
    - **Captioning:** the text journey in `files.spec.ts` (now "text and
      image") uploads a 96 px PNG generated per run. It asserts exactly one
      `image_caption` call on the `captioning` default row, charged and
      settled.
    - **Jev:** `study.spec.ts` grades one open-part quiz in the browser. Jev is
      typesafe.ai's grader, called from Go, not EliteLLM. The workspace's only
      usage row must be `llm`/`quiz`/`typesafe`/`jev-1.13.0`.
    - **Chat:** new `chat.spec.ts`. One real browser turn must finish
      `complete` on the `chat` default row.
    - **Scripted tools:** in a scripted turn, search makes one query embedding
      and one rerank on their default rows. Then a scripted tool turn with no
      provider call covers the read tools (`list_sources`, `search_workspace`,
      `read_skill`, `read_document`, `capture_page`, `read_study_progress`,
      `list_trashed_files`, `inspect_document`) and the write tools
      (`create_material`, `add_questions`, `edit_document`,
      `add_open_question`, `add_question_media`, `trash_file`,
      `restore_file`).
    - **Skipped tools:**
      - Library and bank tools: no `LIBRARY_DATABASE_URL` locally.
      - `create_deck` / `write_slide`: a deck triggers a paid parse.
      - `resolve_source_change`.
    - **Switch** (`pipeline/pipeline/retrieval/scripted.py`): a chat message
      starting `[uat-scripted-tools]` followed by JSON steps replaces the
      model's responses. The tools still run through `tools.run` with every
      normal check. Gates (reviewed):
      - `RETRIEVAL_UAT_SCRIPTED_TOOLS` must be exactly `true` or unset;
      - every pipeline process refuses to start with it unless
        `SENTRY_ENVIRONMENT=uat`;
      - `env-manifest.json` limits the variable to UAT;
      - with the switch off, the marker is plain text.
    - **Before these journeys can pass:**
      - set `RETRIEVAL_UAT_SCRIPTED_TOOLS=true` (deploy/.env.uat → GitHub env →
        Coolify);
      - run `GRANT SELECT ON model_configs TO capy_uat_verifier;` on UAT. It's
        already in `scripts/uat/verifier-role.sql`, but the existing role needs
        it by hand.
    - **Unfinished:**
      - the switch is not documented in `openwiki/agentic-retrieval.md`,
        `deployment-runbook.md` or `uat-activation-checklist.md`;
      - unverified live: whether Playwright returns the full streamed chat
        body, the chat panel labels, the question tools reporting "edited",
        and Jev's exact model name.
  - **Quota grace/frozen**: done, as `storageLifecycle.spec.ts`. Never run on
    UAT; typecheck, biome, `--list` and `test:uat:verifier` pass.
    - **Sequence** (one account): clock 21 days back, Pro live → four 26 MB
      store-only `.bin` files → immediate cancel → **frozen** → resubscribe →
      clock to 3 days back, cancel → **grace** → purge a trashed file → active
      on Free.
    - **Checks:** owner and member, in both workspaces, through the browser and
      the API.
    - **Other files changed:**
      - `providers.ts` (shared `advanceStripeClock` / `stripePeriodEnd`);
      - `billing.spec.ts` (uses those helpers, no behaviour change);
      - `files.ts` (`invite()` takes an optional inviter).
    - **Assumptions that will fail loudly if wrong:**
      - Stripe stamps `ended_at` with the clock's time.
      - The sandbox accepts a subscription on a 21-day-back clock.
      - The server runs in UTC (`graceEndsAt` is compared exactly).
      - Uploading an unknown `.bin` through the dialog works.
    - **Cost:** about 104 MB of B2 uploads and +10–13 min per run.
  - **Journey count:** the README and `test-catalog.md` say "nineteen", but with
    `chat.spec.ts` `--list` shows 20 tests plus one fixme. Set the number from
    `--list` at the end.
  Review all diffs fully before committing; other sessions share this tree.

## Decisions (Epo, 2026-10-14)

- **Model round**: one real call per slot, inside the flow that uses it:
  image captioning (ingest), chat (also search + rerank), Jev (study grading of
  an open question). Only validates the catalogue/config and the URL + elitellm
  adapter: assert the call reached the slot's configured provider/model and
  settled; never assert response content. Embedding and the ingest LLM are
  covered by the Office/text/PDF journeys already. No model-capacity test (the
  missing GLM row was a one-off).
- **Tool calls**: deterministic, injected by the test through a UAT-only switch,
  not chosen by a model.
- **Frozen without waiting**: Stripe test clock started in the past (option a).
  The UAT sandbox accepts `frozen_time` 45 days back (verified, clock deleted).
- **Removed member** sees the file-missing panel, not "no access": the app never
  says whether something unreachable is blocked or gone.
- **Shared pages** never show an interactive block's View source.
- Ops dashboard: out of scope (unused).

## How grace and frozen are decided

`server/internal/store/account_state.go` `applyQuotaState`: Pro is live only
while a subscription is entitling **and** `current_period_end > now()` in real
time. After a Pro subscription closes, the lapse is the latest closure
boundary, in Stripe's timestamps (which follow the test clock). Over the Free
limit (100,000,000 bytes) the account is grace until lapse + 14 days, then
frozen. So the journey advances the past-started clock until a renewal ends in
the real future (Pro live), then cancels immediately while the clock is ≥14
days behind (frozen) or a few days behind (grace).

| | Grace | Frozen |
|---|---|---|
| Read, download, chat, trash | yes | yes |
| Uploads (storage growth) | no | no |
| Content this account pays for | view-only for everyone | view-only for everyone |
| Editing in others' workspaces | **yes** | **no** |
| Create workspace, invite, promote, join shared | yes | no |
| Organize/share own items | yes | only narrowing exposure |
| Study progress, ratings | yes | yes |

## Next journeys

1. **Account deletion with content** (proposed, not approved yet): owner with an
   Office file, a note with an image, a member, and a clone held by another
   user. During the deletion grace the member gets 404 on the owner's items;
   after Clerk deletion the owner's objects are reaped, used bytes go to zero,
   and the clone keeps its objects and charge.
2. **Reprocessing** (plan below, verified 2026-10-14):
   - J1 (corrected) and J2 now;
   - J3 with the F2 fix;
   - J4 after the note-indexing fix;
   - J5 (text) after the restore fix and the text hold.

   Open questions for Epo (more are under "Fix plan"):
   - Notes have no manual Process: with auto process off they wait until it is
     on again, but `agentic-retrieval.md` says they wait for the owner's
     Process. Add a Process for notes, or fix the doc?
   - J1+J2+J4 add ~25–30 min against the 90 min `globalTimeout`. Raise it or
     split the suite into two workflow jobs?
3. Smaller fixes found in the journey inventory: preflight doesn't check
   `toc/report.docx` (the refusal journey's fixture); README says a 45 min
   budget (config is 90 min suite / 150 min job) and claims the rich-content
   journeys cover IME composition (they don't); the Sentry gate's `file_id`
   scope misses notes/materials and `files.thumbnail_key` is not in the cleanup
   B2 sweep.

## Reprocessing lifecycle (research, 2026-10-14)

UAT runs the Rust collaboration server (`collaboration-rs/`).

**Office**: saves append `source_document_updates` on the current base A. The
5 s scheduler (`collaboration-rs/crates/sources/src/refresh.rs`) makes a file
due after 60 s idle plus ≥3,000 net tokens, 7 days, or a `rebuild_refusal`
(owner's Process skips the gates). Admission writes the job,
`source_refresh_candidates` and a provider session; the claim exports the
capture to `sources/source_<id>` (uncharged; growth only gated). Parsed files
then parse/ingest; export-only files skip it. Publication is deferred:
`files.blob_path` = B, `revision`+1, `rebuild_pending`, `published_state`; the
editor stays on A with no banner; edits after the capture become
`pending_effects`. When the room empties, the rebuild rebases onto B (new
epoch, update rows deleted, A unreffed with delay 0 and reaped within a
minute). A refused rebase records `rebuild_refusal` and forces a republication.
Settled state: one `source_documents` row, no candidate, B with 2 refs, A gone,
one `rag_contents` row.

**Notes**: projection 30 s after typing stops (`materials.content`,
`size_bytes`, `index_dirty_at`); the scheduler admits dirty notes 15 s later
(`server/internal/store/note_index.go`); the worker chunks, attaches, embeds.
Only `kind='note'` in a workspace is indexed. No B2 objects.

**Text** (text, code, CSV/TSV; verified 2026-10-14, `REPORT-text.md`):
- **Save:** saves append `source_document_updates`, the first row whole with the
  seed included. They write `files.preview` when it changes.
- **Refresh:** the scheduler makes a file due 15 s after its last refresh request
  with any net change. There is no idle window (`refresh.rs`).
- **Export and ingest:** export writes the text to `sources/source_<id>`. Ingest
  re-chunks it, with no parse, and embeds only chunks whose `indexed_text`
  changed. It regenerates the descriptor once the accumulated change reaches 2%.
- **Publication keeps the epoch and the rows; there is no swap and no rebuild:**
  - base, blob, `revision`, alias and `seed_bytes` move;
  - the old blob and its `rag_contents` row go at once;
  - saves after the capture stay a residual.
- **Fold:** the fold on unload drops deleted text bytes but keeps the history.
- **Charge:** file bytes + effects JSON + `max(0, state + log − seed_bytes)`.
- **UAT:** 50 refreshes, median 5.9 s from admission, each one embedding call
  and one descriptor call.

**Charge**: `files.size_bytes` + `source_documents.storage_bytes` (effects +
state/log beyond `published_state` while a rebuild is pending); candidates,
the old base while a rebuild is pending, note Yjs and `rag_*` rows are
uncharged. Oracle: `used_bytes + Σ user_storage_deltas` = `storageRecountSQL`
(`server/internal/store/storage.go`) = `/api/billing.storageUsedBytes`. Don't use
the drift report (compares without pending deltas; recount doesn't lock
`source_documents`).

**Covered today**: save + exact charge (`richContent`), held capture with a
later edit (`officeRefusal`), deferred publication under an open editor,
NULL-state rebuild. **Gaps**: a rebuild that rebases a non-NULL state never
runs; old base/candidate reaping never asserted mid-run; no exact charge while
`rebuild_pending` or after the rebuild in parsed journeys; no edits between
publication and rebuild; the Office files journey purges before its rebuild;
note indexing entirely uncovered.

**Plan**:
- Helpers: `ledger()` (recount = billing), `blobState()/reaped()` (refs,
  `not_before`, B2 delete marker), `contentGone()`, `stats()`,
  `refreshSettled()`; raise the rebuild poll to ~7 min (sweep backoff is 5 min).
- **J1** extend `officeRefusal` (parsed DOCX, ~0 spend, +5 min): during the
  hold the candidate object exists and is uncharged, file still on A; after
  each publication the old content is gone and the old base reaped; after the
  final rebuild the charge equals exactly the new file's B2 size and nothing is
  left running. Plus a separate "save during parse" test that fails until F2 is
  fixed.
- **J2** new `officeLifecycle.spec.ts` (store-only DOCX, export-only, $0, ~13
  min): edits before capture, during the hold, after publication; both leave →
  rebasing rebuild; a viewer sees all edits; exact charge each step; old base
  reaped; one edit in the new epoch.
- **J3** optional (+3–4 min per format): in the `files.spec.ts` Office loop:
  1. The outsider saves a line while the job is in `parse`.
  2. Assert one lease group and no superseded job (this exposes F2 today).
  3. The published bytes lack the line, and the effects hold it.
  4. The outsider leaves, and the rebuild carries a non-NULL state.

  Today that loop publishes while the outsider still has the editor open, then
  purges with `rebuild_pending`, so its rebuild is never reached
  (`files.spec.ts:144-159`).
- **J4** note indexing (after the note fixes below), new `noteIndex.spec.ts`
  (~8 min). Auto process on, an API note with three headed sections:
  1. **Created → indexed:**
     - one job `done` on the expected `release_sha`;
     - `index_job_id`/`index_dirty_at`/`index_error` null;
     - the alias names a ready `note:` content with 3 chunks and 3 vectors;
     - one embedding call on the workspace pin, settled,
       `credit_micros = tokens × micros_per_input_token`, paid by the owner.
  2. **An editor changes one section in the browser:** a second job with
     `chunks_embedded = 1` and fewer input tokens than the first; the old
     content row is gone.
  3. **Auto process off (Indexing tab), then edit.** After 75 s:
     - the note is dirty and has no job;
     - `pendingNotes = 1`;
     - a scripted `search_workspace` still finds the old text.

     Turn it back on: indexed within 60 s, `pendingNotes = 0`, and search finds
     the new text.
  4. **Trash:** search drops the note; rows and charge stay. **Purge:** alias,
     content, chunks and vectors are gone.
  5. **Every step:** `ledger()` holds and indexing adds 0 bytes. At the end: no
     `processing` content, `user_credits.reserved_micros = 0`, and no Sentry
     event on the jobs' traces.
- **J5** text reprocessing, new `textLifecycle.spec.ts` (~12–15 min, <0.4
  credits). Fixture `reprocess.md`: 8 KB, 4 sections, 8 chunks.
  1. **One-word edit:**
     - the preview follows the save;
     - only the edited chunk's `indexed_text` changes;
     - one refresh paid by the owner, embedding tokens under a third of the
       upload's, no LLM call;
     - the old content row and the old blob are gone;
     - exact charge.
  2. **Owner and editor type at once:**
     - a viewer reads the saved text;
     - a save during ingest (needs the UAT hold extended to text) leaves a
       residual that a second refresh publishes;
     - no failed or superseded job.
  3. **Everyone leaves:** no deleted-text bytes are left in the state or the
     rows; exact charge.
  4. **Auto process off:** the preview follows, there is no refresh for 45 s,
     `fileChanges` shows `waiting`, and an editor's Process answers 403. **On:**
     published within 45 s.
  5. **New section, trash, restore, purge:**
     - a new section makes one descriptor call;
     - trash while a refresh runs, then restore: the saved edit is indexed
       without another edit (fails until the restore fix);
     - purge leaves nothing behind.
  6. **A 200-row CSV:** a cell edit and an append re-embed at most one chunk. A
     mid-table insert re-embeds every later chunk until `table_units`.

  Assert outcomes, not mechanics. The epoch, rows and `seed_bytes` checks are
  the only ones a text compaction would change. After every step run
  `refreshSettled()`: no job pending over 2 min, no candidate, no
  `refresh_error`.
- **CI side of J4/J5:**
  - text rows in `TestRefreshSchedulerQuery`;
  - a Rust `rooms.rs` test of a text room saving across a publication;
  - the note pipeline and Go tests listed under the note bug.
- **Verifier grants (operator; add to `scripts/uat/verifier-role.sql`):**
  - needed: `rag_material_contents`, `agent_edit_inverses`, `edit_incidents`;
  - recommended: `user_credits`;
  - optional: `material_yjs_documents`;
  - not needed: `material_yjs_updates`;
  - plus the pending `model_configs` grant.

  The search checks need `RETRIEVAL_UAT_SCRIPTED_TOOLS=true`.
- **Plan corrections** (verified 2026-10-14, `REPORT-office.md`):
  - **J1:**
    - A deferred publication keeps the old base A (`base_blob_path`) until the
      rebuild.
    - At the republication, assert that the previously published file B is
      reaped.
    - A goes only after the rebuild.
  - **Save during parse** (one test, in J3, for docx and xlsx):
    - click Process, then save;
    - assert the save landed while `source_refresh_candidates.content_id IS NULL`;
    - assert one lease group and no superseded job.

    It fails until F2 lands.
  - **J2:** a hold on a store-only file blocks the refresh scheduler while it
    lasts, so release it promptly.
  - **Charge:** after a rebasing rebuild the exact charge is size + effects +
    state bytes. "Charge = B2 size" holds only for a NULL-state rebuild.
  - **Rebuild waits:**
    - a room unload rebuilds at once;
    - the sweep backs off 5 min when busy and 10 min after an error;
    - on timeout, fail with diagnostics.
  - **F1 coverage:**
    - a `refreshSettled()` teardown in every Office and text journey: no pending
      or running refresh, parse or ingest job for the run's files; no candidate;
      `running_job_id` NULL; no open ingest provider session for the run's
      actors; reserved credits 0;
    - a canary: no `source_refresh` job pending for more than 10 min;
    - in `membership.spec.ts`, demote an editor holding an unsaved DOCX edit and
      assert an `epoch_reset` incident.
- Also missing:
  - the refusal journey never settles its republication spend;
  - the Indexing tab's `fileChanges` / `pendingNotes` are never asserted.
- **Budget:** J1–J4 together add 35–40 min, J5 another 12–15. Run J2–J5
  under their own `--grep` dispatch, or raise `globalTimeout`.
- Doc fixes beyond the chips:
  - `plate-editor.md`: the pending-projection idle threshold is 30 s, not 5 s.
  - `agentic-retrieval.md` says worker and reaper parks count in
    `pendingNotes`. Today they don't, because admission already cleared the
    dirty mark. The release trigger in the fix plan makes the doc true, so fix
    the code, not the doc.

## Product bugs (task chips created 2026-10-14; verified read-only 2026-10-14)

Verification reports, with file:line evidence, UAT queries and reproductions:
`C:/WEB/capy-harness/2026-10-06-rust-round/uat-claims/` (`REPORT-notes.md`,
`REPORT-office.md`, `REPORT-text.md`). **Work is paused: nothing below is
fixed yet.** The fix order and open questions are in "Fix plan" below.

- **Note indexing never succeeds on UAT:**
  - **State:**
    - 245 note jobs, none done. 244 (2026-10-08 → 10-12) were cancelled
      0.06–1.7 s after their claim with "ingest source identity is invalid".
    - The 2026-09-19 job failed on an ingest release without note support.
    - All 181 live workspace notes hold a failed `index_job_id`; 180 are no
      longer dirty.
    - `rag_material_contents` is empty, and the Indexing tab shows them waiting
      forever.
    - No provider spend happened.
    - No CI or e2e test covers note indexing end to end. The chat journey
      already creates a note that gets stuck.
  - **Cause:**
    - `_pipeline_source_cancellation` (`pipeline/pipeline/store/db.py`) only
      knows file payloads, and a note payload has no `fileId`/`sourceRevision`.
    - Embedding admission refuses the first call ("no source file"). The retry's
      claim fence (`_requeue` → `lock_pipeline_claim_boundary`) then calls the
      note superseded, and `cancel_pipeline_jobs` fails the job.
    - The same check would also cancel any note job at its first 30 s heartbeat.
    - Neither cancellations (including `cancel_user_async_work` on account
      deletion) nor edits clear `materials.index_job_id`, so the note is never
      admitted again.
  - **Latent:**
    - `attach_material_content` moves the alias before the new content is ready,
      so migration 0024's trigger deletes the old content first. Result: no
      vector reuse (measured 0 of 3 vs 2 of 3), the note is unsearchable during
      every re-index, and it loses its index on failure.
    - The note path never abandons its `processing` row, so a later job with the
      same text is blocked.
- **Source refresh F1** (Office **and text**; never seen on UAT, reproduced on a
  scratch database):
  - `ResetSourceEpoch` (and `RestoreFromTrash`) move the epoch but leave the
    refresh captured under it. A queued or lease-expired `source_refresh` job
    then 409s at every claim (`d.epoch=c.epoch`).
  - The Rust loop drops the 409 without reporting it, and nothing cleans the job
    up. Consequences:
    - the file never publishes or rebuilds again;
    - its provider session stays open, using one of the owner's 20 ingest leases;
    - maintenance readiness never clears;
    - the export query's `LIMIT 2` means two such jobs stop every source refresh
      on the environment, text included.
  - A live export during the reset parks the file with `refresh_error`
    ("Source candidate changed").
  - Text causes it too: any discard with unsaved text resets the epoch.
- **Source refresh F2** (Office only):
  - The pipeline attach check (`retrieval/store.py:286`) requires
    `d.checkpoint=c.checkpoint` for Office files. Any save between admission and
    the content claim (UAT median 8–12 s, max 53 s) discards the parsed refresh.
  - Lost: the parse and the publication. There is no provider spend.
  - The file republishes once a refresh gets through without a save. An owner's
    Process while still editing nearly always hits it.
  - Text is exempt: later text saves become a residual.
- **Restore after a trash during a refresh** (Office and text): the trash
  trigger cancels the refresh as failed (`refresh_error='source deleted'`), and
  `RestoreFromTrash` never clears it. The restored file's saved edits wait for
  another edit, and the Indexing tab shows `failed`.
- **The UAT publication hold skips text** (`handoff.rs` publish returns from the
  text branch before the hold), so J5 can't save during ingest.
- **Reconciliation** (the recount in `storage.go`) doesn't lock
  `source_documents` or `agent_edit_inverses`, and its drift report compares
  without the pending deltas.
- **Reconnect message**: a removed member's open editor shows file-missing; by
  decision that stays.
- **CSV limit**: see the next section. Every CSV save re-chunks the whole table
  at the 15 s text cadence, which adds to the quadratic-chunking risk.

## Fix plan (recommended 2026-10-14; Epo approved all recommendations 2026-10-14, `human/` df7c54f5)

1. **Note indexing, pipeline (one ingest release):**
   - give `_pipeline_source_cancellation` a note branch (workspace and owner
     lifecycle, no file or revision);
   - accept and compare `materialId` in `_lock_ingest_provider_boundary` and
     `lock_pipeline_claim_boundary`;
   - abandon the claim on failure in `_process_material_index_bound`;
   - move the alias only in a new `publish_material_content` step that marks the
     content ready;
   - record `chunks_created`/`chunks_embedded` on the attempt.

   Tests:
   - offline heartbeat, requeue and admission for a note payload;
   - an integration note job through the real admission with only
     `elitellm.embed_batch` stubbed;
   - an integration test where an edit embeds only the changed chunk and a
     failure keeps the old index.
2. **Note indexing, migration:** a trigger on `jobs` releases the note when its
   index job ends:
   - failed: `index_error` set, and the note stays dirty and counted in
     `pendingNotes`;
   - done: job and error cleared.

   Then delete the redundant Python clears. Go tests: `cancel_pipeline_jobs`,
   `cancel_user_async_work` and `done` each release the note.
3. **F1 (Go only):**
   - in `ResetSourceEpoch`, when the epoch moved, call `cancel_pipeline_jobs`
     on the old epoch's candidate jobs with
     `'superseded','superseded','source_superseded','Editing moved to a new epoch'`;
   - do the same in `RestoreFromTrash`;
   - optionally, let `ClaimSourceRefresh` supersede a stale job instead of
     answering a bare 409.

   Test: `TestSourceEpochResetSupersedesItsRefresh`, with queued, expired-claim,
   live-claim and restore cases, plus text. Add a stale-jobs-never-hold-the-queue
   test.
4. **F2 (pipeline only):** in `_lock_source_candidate`, use
   `d.checkpoint>=c.checkpoint`, as the heartbeat check does. Test: attach with a
   newer checkpoint for docx, xlsx, pptx and text. Land it with J3, because
   rebasing rebuilds become common.
   Progress 2026-10-14: steps 1, 2 and 4 landed (Editor `notes` track): note jobs pass the pipeline boundary, migration 0082 releases a note when its index job ends, the alias moves only when new content is ready, a busy provider re-pends a note job like a file's, F2 attaches after newer saves. Deploy: Go (0082) first, then ingest. The recovery SQL and its precondition are in `C:/WEB/capy-harness/2026-10-06-rust-round/wave-1014/REPORT-notes-r2.md`.
5. **Restore** (Epo's call): clear `refresh_error` in `RestoreFromTrash`.
6. **UAT hold covers text:** run the hold before the text branch.

   Progress 2026-10-14: steps 3, 5 and 6 landed (Editor `refresh` track), plus the 30 s text idle window and the step 7 docs for refresh. Deploy: Go and the collaboration server, either order, no migration. J5 should allow about 90 s for the second automatic refresh (text is now due 30 s after the last save).
7. **Docs:**
   - `agentic-retrieval.md`: notes have no Process (with auto process off they
     wait until it is on); the vector-reuse sentence; parked notes count; the
     scheduler SQL lives in `refresh.rs`; a claimed refresh can stick until F1.
   - `office-files.md`: an epoch reset supersedes the refresh; saves before the
     attach stay pending.
   - `backend-storage-quota.md`: the charged size comes from migration 0075 and
     includes `log_bytes`; correct what reconciliation sums and locks.
   - `thumbnails.md`: text previews follow saves.
   - `plate-editor.md`: the pending-projection idle threshold is 30 s, not 5 s.
8. **Recovery of the 181 UAT notes** (Epo's call, after 1 and 2 are on UAT):
   - set `index_job_id=NULL, index_error=NULL,
     index_dirty_at=COALESCE(index_dirty_at, now())` on live workspace notes
     whose job is terminal;
   - clearing `index_job_id` alone re-admits only 1 note;
   - cost: about 1.07M characters, roughly 13–54 credits on the owner of
     `ws_28b4c9d279`.
9. **Then the verifier grants and the journeys:** J4, J1 corrected, J3, J2, J5.
10. **Later:** reconciliation locks and drift with pending deltas; optionally move
    export-only publications off the 5 s scheduler loop.

**Questions for Epo:**
1. Recover the 181 UAT notes, or delete them, or leave them?
2. Should parked notes count in `pendingNotes` (recommended, per the 2026-09-18
   decision)?
3. Notes Process: fix the doc (recommended), or add a Process?
4. Notes parked by transient failures: wait for their next edit, or be
   re-admitted later (which needs a backoff)?
5. Should a restore clear the `refresh_error` the trash left (recommended)? And
   should other errors whose cause has gone away (credits bought, space freed)
   also clear?
6. F1: also cover `RestoreFromTrash` (recommended)? And add the claim-time
   self-heal?
7. J3 cost: all three Office formats, or docx and xlsx only (+3–4 min each)?
8. Text refreshes every ~15 s with no idle window, and on small files nearly
   every refresh regenerates the descriptor (~0.09 credits on UAT). Keep that,
   or add an idle window or a minimum interval for descriptors?
9. Is extending the UAT publication hold to text OK?
10. Reconciliation fixes: now, or with the storage backlog?

## CSV/TSV ingest limits (separate session, uncommitted)

Session "Replace CSV comma count with a column cap" has uncommitted work in the
main tree. It replaces `_TABULAR_MAX_CELLS = 100_000` (raw delimiters across
the whole file) in `pipeline/pipeline/ingest/source_text.py` `tabular_text`
with a 1,000-columns-per-row cap. The cap is counted on raw lines before
`csv.reader` builds the row; a single 30 MiB row otherwise peaks at 546 MiB.
The limit code is renamed `tabular_column_limit` end to end:
- migration `server/migrations/0081_tabular_column_limit.sql`;
- `enums.go`, openapi and generated types;
- fixture `e2e/fixtures/files/basic/column-limit.csv` (the `git mv` is
  **staged** in the shared index);
- the UAT `files.spec.ts` test and the docs.

Pipeline offline, Go store and vitest pass.

Findings:
1. **Blocker for shipping the column cap alone: CSV chunking is quadratic.**
   - **Why:** `tabular_text` joins rows with single newlines, so
     `chunk_markdown` sees the whole table as one paragraph. Then `_split_long`
     (`pipeline/pipeline/retrieval/chunking.py:418`) re-runs `estimate_tokens`
     on, and slices, the remaining text for every chunk it cuts.
   - **Measured:** 1k rows take 0.5 s and 2k rows 2.2 s. So 10k rows take
     about a minute, and a 30 MiB CSV would hold the shared ingest host
     (prod/UAT/dev) for a very long time. The old cell cap was what kept this
     bounded.
   - **Fix:** emit one block per row, e.g. join rows with blank lines, and bump
     `CAPY_TABULAR_TEXT_VERSION`. With that, 200k rows chunk in 28 s.
2. **The cost is ingest's projection, not the UI.** `CsvView` previews at most
   50 columns × 500 rows, in a worker. Ingest writes `Row N: Header=value | …`.
   Measured:

   | Table | Tokens | Chunks |
   |---|---|---|
   | 10k × 11 | ~681k | 1,862 |
   | 2k × 200 | ~2.8M | 8,003 |
   | 200k × 11 (13 MB) | ~13.9M | ~40k |

   Nothing caps chunks per file; the only bound is
   `_TABULAR_MAX_OUTPUT_CHARS` (64 MiB).
3. **Proposed restrictions, awaiting Epo's pick:**
   - keep the 1,000 columns-per-row cap, the same number as the XLSX packer's
     "table is too wide" (`packing.py:102`);
   - cap the projection by indexed tokens, about 1M tokens / ~2,500 chunks,
     instead of 64 MiB of characters. That is roughly a 1,400-page PDF (an
     estimate, not measured).
4. **Optional: switch CSV to the XLSX `table_units` format.** That format
   writes the header once per chunk and pipe-separated rows, with no `Row N`.
   - About 3× fewer tokens: 10k × 11 becomes 235k tokens and 592 chunks.
   - Inserting a row no longer changes the text of every chunk.
   - It needs a linear rewrite first: 200k rows took 124 s, because it
     re-estimates the growing chunk text on every row.

**Open questions for Epo:** do 1–3, or 1–4? And what token budget?

The column-cap change was committed to main with everything else on
2026-10-14. **Don't deploy it to UAT/prod before finding 1 (chunking) is fixed**:
without the old cell cap, a large CSV can hold the shared ingest host.
