# Office round: upstream merge, storage and publication fixes

Date: 2026-09-25. Plan for implementer agents, one work package per run, each followed by a
reviewer run (`human` skill review loop). Every decision this plan implements is recorded in
`human/`; this file only orders the work and says where it goes. If a step here and a record in
`human/` disagree, the record wins and the implementer stops and reports.

## Read first

- Decisions: `human/frontend/office-files.md` (records 3, 10, 13-21), `human/backend-storage-quota.md`
  (the 2026-09-25 quota rule), `human/agentic-retrieval.md` (replace_text span, trimmed effects and
  refresh trigger, descriptor-only summaries), `human/observability-metering.md` (parse fee on first
  parse, platform-paid maintenance), `human/deployment-runbook.md` (ingest host egress and
  LibreOffice profile).
- Upstream merge: `artifacts/2026-09-24-betteroffice-upstream-handoff.md` (keep tables, conflict
  notes, port lists) and `artifacts/2026-09-25-betteroffice-handoff-review.md` (corrections; where
  the two disagree, the review wins).
- Storage: `artifacts/2026-09-25-office-storage/` reports, `patches/` (prototypes against `dfa3f05e`
  or upstream) and `probes/` (reference scripts, not runnable as is).
- Fixtures: `e2e/fixtures/files/rich-content/` and its README.
- Repository rules: `AGENTS.md` (BetterOffice workflow, formatting, test scripts), the `human` and
  `ponytail` skills, and the openwiki page for each domain touched.

## Ground rules

- No production data exists. Old Office states are dropped by the window reset below, so write no
  migrations, version gates or shims for older states, schemas, prompts or tool contracts. Each
  format accepts exactly one fork-owned schema.
- Capy work happens on `main`, one package at a time in the one working tree. Fork work happens in
  a separate clone or worktree of `samyung0/betteroffice`, never inside `vendor/betteroffice`,
  until the pin bump in C5.
- Pushing to the fork (`main`, `capy-ci`) and moving Capy's submodule pin wait for the developer's
  go-ahead. Commit locally; do not open PRs unless asked.
- Tests stay focused: one test per behaviour, delete tests of removed behaviour, update
  `openwiki/test-catalog.md`. Run the root `package.json` scripts and the formatters from
  `AGENTS.md`.
- Anything this plan does not cover and no record decides is a stop-and-report, not a judgement call.

## Order

Two streams run in parallel because their paths are disjoint.

| Stream | Packages, in order | Lands |
| --- | --- | --- |
| Capy `main` | C1 collaboration and editor session, C2 refresh policy, summaries and billing, C3 ingest host, C4 maintenance tooling | On `main` as each passes review. None changes seeds, so none needs the window. |
| Fork branch | F1 upstream merge, F2 fork fixes, F3 storage | On one branch from `origin/capy-ci`; merged to `capy-ci` after review. |
| Join | C5 new pin and Capy storage side, C6 journeys and docs | Ship in the maintenance window. |

C5 changes the stored-state contract, so it must not reach a deployed environment before the window
starts. Keep C5 and C6 uncommitted, or on a local branch the developer approves as an exception to
"work on main", until step 4 of the window.

## C1. Collaboration service and editor session (Capy)

Paths: `collaboration/src/`, `src/features/files/`, `src/office-runtime/` (host side only),
`server/internal/store/source_documents.go` and its HTTP handler.

1. **Office worker** (record 17). In `collaboration/src/officeRuntime.ts` move the queue to the main
   thread with one call in flight, and time each call from send, about 2 minutes. On a
   `WebAssembly.RuntimeError` or a timeout, fail that call, terminate and recreate the worker, and
   run the queue on the new one. Engine refusals (`stale_target`, invalid updates) are normal
   results and never restart it. A save that fails inside the engine reports failure to its callers
   and keeps drafts; `FailedStoreRetryRunner` no longer retries it (`server.ts` near 838).
2. **Per-message cost** (review 1.5, problem 7). In `beforeHandleMessage` stop copying the room per
   message. Check contributor markers on the decoded update (`Y.decodeUpdate`), keep a size
   estimate from the document's `update` events, and compute the exact size only when the estimate
   crosses the cap. Reject an oversized update with a stateless rejection, not a plain `Error`, so the
   client stops reconnecting. The exact limit at save stays. The root allowlist waits for C5 (F2
   exports it from the bundle).
3. **Saves** (problem 8). One running plus one queued save per room; callers await the queued
   promise so failures reach them. The checkpoint response returns only the receipt (checkpoint,
   operation). The browser's locking `source-session` response carries state only, no baseline or
   effects.
4. **Drafts**. Store the base once per source SHA in its own IndexedDB store (version 2 to 3),
   encode and write the draft at most every 250 ms latest-only, and skip a write that a receipt
   already covers so a saved draft never returns as a false recovery prompt
   (`useSourceSession.ts` near 395, `sourceDraft.ts`).
5. **Contributor markers** (record 18). Write them under a dedicated marker client id, as in
   `pptx-and-shared-overhead.md` 5.4. One vitest: the room keeps its client id, every update carries
   its marker, a colliding update moves the marker id.
6. **Handoff always completes** (record 20). Client: on `source-handoff-prepare` go read-only, flush
   pending input into the document, wait until the provider has no unsynced changes, send ready.
   No `save()` wait. Server (`sourceHandoff.ts` `handle`): after the 10 s window close the writable
   connections that have not answered and continue; a disconnect no longer fails the handoff;
   persist once, then acknowledge. The 4-attempt 409 rebase loop stays. Tests in
   `sourceHandoff.test.ts`: a silent editor and a disconnecting editor both end in a completed
   publication, and the silent editor's client lands in recovery.
7. **Banner instead of remount** (record 19). On `source-epoch-changed` disconnect, keep the current
   view read-only, and show a persistent banner (paraglide strings) saying a newer version is
   available and whether this client's changes were saved; its button calls
   `window.location.reload()`. A client with unsaved changes keeps today's recovery path. Remove
   the generation remount for epoch changes.

Done when: `pnpm test:collaboration`, the Go tests for the changed handlers, the frontend vitest
suites and `e2e:slow` for the Office journeys pass; `openwiki/frontend/office-files.md` describes
the handoff, banner and draft behaviour.

## C2. Refresh policy, summaries and billing

Paths: `collaboration/src/sourceDocuments.ts` (effects, scheduler), `server/internal/store/`
(admission, usage), `pipeline/pipeline/` (indexing, tools, prompts, worker),
`server/internal/agenttools/`, `server/migrations/`.

1. **Trimmed effects** (agentic-retrieval, trimmed effects). Trim each text effect's `before` and
   `after` to the changed span plus 40 characters on each side, after `compareBaselines`. Token
   counts in the service and in Go follow automatically because both count the stored strings.
   Update the pending-change instruction in `pipeline/retrieval/pending.py` so the model knows the
   texts are excerpts.
2. **Trigger**. Threshold 3,000 trimmed tokens after 60 s idle, or saved changes with no edit for
   7 days, under the existing automatic guards (workspace auto-reparse, prior successful parse,
   active owner, credits). Change both places that encode it: the scheduler query
   (`sourceDocuments.ts` near 859) and Go admission (`source_documents.go` near 423). A refused
   file gets `refresh_error` and is skipped until its next save, as today, except the owner's
   concurrent ingest-job limit, which retries on the next scheduler run. Named constants.
3. **Descriptor-only summaries with a reuse gate** (agentic-retrieval, summaries). Drop the detailed
   tier: `summarize_file` writes the descriptor only, the summary column and
   `describe_documents` go (Python handler, Go contract in `agenttools.go`, the chat prompt line
   near `prompts/chat.py:46`, the mention in `pending.py`), and `SUMMARY_VERSION` moves. Add the
   gate in `index_file`: compute the net text change between the published content and the
   candidate with the reflow-ignoring diff (`probes/delta/delta.py` `text_changes`, about 70
   lines), keep the running share next to the descriptor, reuse below 2% of the document, and
   regenerate from the complete content at 2% or more, on a `summary_version` change, or when no
   previous descriptor exists. A regeneration failure raises as today.
4. **Parse fee on the first parse only** (observability-metering). Refresh parse jobs record their
   pages for metering with no credit charge; admission reserves only the provider-call estimate
   (embeddings of changed chunks, a summary when the gate regenerates). The credit check stays for
   those.
5. **Platform payer**. A job-level payer mode that only the maintenance command in C4 sets: no
   owner credit reservation or debit, and provider usage recorded against the platform in
   `usage_events`.

Done when: pipeline tests cover reuse below 2%, regeneration at 2%, version change and first
summary; Go tests cover the 3,000 and 7-day admission and the refresh parse charge; the removed
tool's tests are gone; `openwiki/agentic-retrieval.md` and `openwiki/observability-metering.md` match.

## C3. Ingest host conversion hardening

Record: `human/deployment-runbook.md` (2026-09-25). Paths: `parser/odl/document.py`,
`deploy/ansible/ingest-host/templates/nftables.conf.j2`, parser tests, `openwiki/deployment-runbook.md`.

- Each conversion gets a per-job `UserInstallation` whose `registrymodifications.xcu` disables link
  updates and macros and blocks untrusted referer links. Check the enum values against the
  installed 7.4 schema; Writer and Calc differ.
- Start `soffice` with `start_new_session=True` and kill the process group on timeout.
- Every caller shares the function: ingest, `/capture_page`, Drive and OneDrive imports.
- nftables: reject new outbound connections from uid 10001 except loopback to the parser ports.
- Tests: a document whose linked image points at a local listener gets no request, and an
  `INCLUDETEXT file://` field does not pull the file's text into the output.
- Applying the ansible change on the host is the developer's step.

## C4. Maintenance window tooling (Capy, old pin)

Record 21. This must be deployed and tried on UAT before the window, on the current pin.

1. **Pause switch**. A database flag that operators flip without a deploy. While it is set, Go
   refuses Office edit sessions and agent edits and seeding with a clear `office_editing_paused`
   error, the collaboration service refuses writable source-room connections, and turning it on
   runs the handoff flush from C1.6 for every loaded source room, persists, and closes writable
   connections with a stateless message the client shows as a read-only maintenance banner.
   Viewing keeps working.
2. **Publish all**. An operator command that requests a refresh with the C2 platform payer for
   every Office source whose checkpoint is ahead of its indexed checkpoint or whose pending effects
   are not empty, clearing stale `refresh_error`. Per record 21 every such file publishes, blocked
   owners included: the maintenance path skips the credit check, the storage gates and the
   owner-state check. Store-only files, trashed files and files of owners pending deletion or
   suspended publish export-only instead: export the saved state, make it the file's bytes, drop
   the file's index, and call no parser or provider. A maintenance republish that fails for good
   falls back to export-only; an engine export failure holds the deploy for the operator.
   Export-only publishing marks the file for reprocessing. The refresh scheduler (the same query
   as C2.2) reprocesses a marked file with the platform payer, regardless of workspace
   auto-reparse, once its owner is active and it is out of the trash; store-only files stay
   manual. A failed maintenance republish retries once a day, except when its parse timed out or
   ran out of memory, which waits until the file's bytes or the parser version change (the
   parser's quarantine key). The summary gate applies to all of these like any refresh; an
   export-only file has no published descriptor left, so its first reprocess regenerates it.
   Outside the window, store-only Office files also publish export-only automatically under the
   C2.2 trigger, regardless of workspace auto-reparse (record 2026-09-25); Process stays the
   opt-in first parse.
3. **Readiness check**. An operator command that prints every Office source still unpublished and
   every `source_refresh`, `parse` or `ingest` job in flight. The deploy waits for zero.
4. **Reset migration template**. One statement per window that, for the formats whose golden seeds
   changed, copies each state it drops into an archive table kept 30 days (with the old engine's
   pin), bumps `epoch`, drops the state and the stored baseline, empties pending effects and
   deletes refresh candidates, the same shape as `trash.go` near 405. C5 instantiates it.
5. **Runbook**. A window section in `openwiki/deployment-runbook.md` with these steps and the
   commands.

## F1. Upstream merge (fork)

Record 13 and `AGENTS.md`. In a clone of the fork:

1. Pick the upstream commit: `c0fa7262`, which the review covered. A later commit means reading its
   new commits for seed changes first.
2. Fast-forward the fork's `main` to it (push waits for the developer), branch
   `capy/upstream-merge` from `origin/capy-ci`, and `git merge` it. Never rebase this branch.
3. Resolve the 31 conflicts with the handoff's keep tables and conflict notes, applying the review's
   corrections (1.4, 2, 3, 4). Regenerate the `.d.ts` bindings and take upstream's `Cargo.lock` and
   `bun.lock`, letting cargo add the three view crates. Keep upstream formatting in upstream files.
4. Semantic fixes the merge needs: the XLSX schema-7 table in the handoff (preserved row markup,
   column styles, tables, array formulas; the listed stopgap where one exists), the DOCX
   projection row with the `ownerParaId === segment.paraId` guard, our comment handling in
   `handleSave`, and the PPTX merge traps. PPTX and DOCX seeding may go straight to the F3 design
   while resolving `deck.rs`, `lib.rs` and `seed.rs`, since F3 rewrites the same functions.
5. Carry Visio and redaction as source; the prepare script still builds only the three formats.

Done when the fork's Rust and Bun suites and `test:poc` pass (the review notes `rust:check` clippy
failures that predate the merge), and the handoff's port lists, used as a checklist, are either
present or listed as known gaps in the branch notes.

## F2. Fork fixes on the merge branch

1. **Fonts, engine side** (record 16). Split the DOCX viewer's `open` so the worker can register
   fonts from the engine's requirements before layout (`layout_font_requirements_json`,
   `register_measure_font`, `createRustMeasureSource`). Add the request fields the review lists
   (1.1) plus one parity test against `buildResidentRegionLayoutRequest`. The Capy wiring is C5.
2. **replace_text** (agentic-retrieval). DOCX uses the engine's `replaceRange` on the changed
   middle and refuses paragraphs with tracked insertions; PPTX takes the style of the run holding
   the first replaced character and caches `paragraphId -> storyId` once per call
   (`shared/office-checkpoint.ts`).
3. **XLSX**. `serde_json` `float_roundtrip` with upstream's
   `canonical_cell_formats_preserve_high_precision_theme_tints` test, if the merge did not bring
   them; the single-materialize patch from the handoff's Appendix A plus the review's three-op test
   (three `PatchRangeStyle` then a `SetCell` using a newly interned style).
4. **DOCX opaque drawings** (record 14). Seed `w:pict`, `w:object` and `mc:AlternateContent` runs
   as raw-XML embeds keeping their `r:id`s, and write them back, alongside upstream `4bf205b5`.
   `e2e/fixtures/files/rich-content/exchange-plan.docx` has two native charts;
   `opaque-objects.docx`, generated by `probes/storage/gen_files.py`, covers text boxes, VML and OLE.
5. **PPTX comments** (record 15) come with the merge; make sure seed, snapshot and save cover
   them, and that the remote-write rule allows `commentFlavor`.
6. **Engine guards**. DOCX gets the update size cap PPTX has; PPTX rejects unknown roots and remote
   writes to `pptx:meta`. Export each format's allowed root list, `__capy_pending_contributors`
   included, from the checkpoint bundle for C5.

## F3. Storage changes in the fork (records 10 and 18)

1. **XLSX schema 8**, from `patches/xlsx-lazy-cells.patch` and `xlsx-lazy-cells.md`: skeleton seed;
   `contents` and `styles` hold overrides keyed by the stable identity; a cleared source cell
   stores the empty marker; writing the source value removes the override; projection lays
   overrides over the parsed source through the live axes; source formulas bind once per session.
   Concurrent clear and set of a source cell resolve by client order. Keep today's source binding.
   Pending effects come from the overrides: one per changed cell, one per row or column insert or
   delete, one per formatting range; no stored baseline. Publication rebases edits made after the
   capture as overrides over the export, verifies the projection equals the latest model and fails
   the publication with an error otherwise; delete the `xlsx:rebase` parts overlay. Tests: clear
   marker, revert, undo over a source cell, concurrent clear and set, hidden-sheet formula
   validation, the rebase with inserts and deletes after the capture, and a verification failure.
2. **PPTX**, from `patches/pptx-no-package-json.patch`: one schema, no `packageJson` and no media in
   Yjs, validation against the session's package, opening requires the source, inserted pictures
   stay binary on their shape, and rebase overlays store changed parts, media included, as bytes.
   Delete the migrations and the source-free open.
3. **DOCX**, from `patches/docx-boundaries-on-upstream.patch`, `docx-boundaries-and-image-refs.patch`
   and `docx-image-refs-bundle.patch`: `media:<part>` references for source images, resolved at
   lowering and in the baseline, left alone by the rebase, and rebound by the serializer when an
   image moves between parts (the `RelationshipsIndex` change the report designs); user-inserted
   images keep data URLs until the next publication, when the rebase turns them into references;
   the run-boundary cache only for paragraphs with tracked formatting changes, note marks, breaks or
   empty runs; seeding under a fixed client id so seeds and baselines are byte-deterministic.
4. **Golden seed and state-size tests** for all three formats on the rich-content fixtures and the
   storage fixtures: a hash of each seed, so a seed change fails CI and triggers a window, and a
   size budget per fixture so a regression in bytes fails too.

Done when the fork's suites pass, seeds are byte-identical across two runs for every fixture, and
the numbers in the storage reports' "after" columns are met within 10% on the same fixtures.

## C5. New pin and the Capy storage side (ships in the window)

1. **Pin**. After the developer merges `capy/upstream-merge` into `capy-ci`, pin that commit, run
   `pnpm office:prepare`, and fix the Capy side: DOCX and PPTX host-controlled save
   (`48849242`, `2eb2c553`) replacing today's discarded Cmd+S serialization, the XLSX editor save
   API (`5206ccf3`: flush becomes settle or throw, the host calls `api.save()`), and any API breaks.
   Record the WASM sizes against the previous pin.
2. **Fonts** (record 16): `configureDefaultFonts` at `DocxEditorHost` module scope with a Vite alias
   for `@betteroffice/fonts`, the viewer worker registering fonts through the F2 split, FontFaces
   under the Office family names in the runtime iframe for DOCX and PPTX, and an explicit error when
   a font fails to load.
3. **Derived baselines**. A NULL `indexed_baseline` means "derive from the base": text decodes the
   blob, Office runs the engine on seed(base). The service caches it by base SHA. It is stored only
   after a publication that rebased later edits. Candidates stop storing `baseline(B)`; Go accepts
   NULL.
4. **NULL state**. A NULL state means seed(base) until the first edit: loading, viewing and agent
   `inspect` persist nothing, the first save stores the state and its seed size, and a publication
   with no later edits returns the state to NULL.
5. **Copy-on-write candidates**, as in `pptx-and-shared-overhead.md` 5.3: the candidate starts with
   a NULL state, `SaveSourceCheckpoint` copies the captured state before replacing it when the
   checkpoints match, readers use `COALESCE`.
6. **Quota rule** (backend-storage-quota): a migration redefines the generated `storage_bytes` as
   pending effects plus `max(0, state - seed size)` (plus a stored baseline when one exists),
   candidates count zero while transient, and reconciliation (`storage.go` near 609) follows.
7. **XLSX effects** come from the engine's override effects in `SourceDocumentStore.effects`.
8. **Roots**. Enforce F2's exported root lists per format on decoded updates in the service,
   `pptx:comments` included, and the `commentFlavor` rule.
9. **Reset migration** for this window, from the C4 template, all three formats.

Done when `pnpm test`, `pnpm test:collaboration`, `pnpm test:office`, `pnpm typecheck`, `pnpm
test:go`, the fork's `test:poc` and `e2e:slow` pass, and `openwiki/frontend/office-files.md`,
`openwiki/backend-storage-quota.md` and `openwiki/test-catalog.md` describe the new model.

## C6. Journeys and fixtures

- Let the fixture helper in `e2e/uat/journeys/files.ts` read a named set, so journeys can use
  `rich-content`.
- One two-actor journey per rich-content file with the checks its README lists: charts and their
  embedded workbooks, tables, footer, pictures and CJK text (DOCX); shared formulas, the chart,
  merges, conditional formatting and hyperlinks (XLSX); table, comments, notes, connectors and
  pictures (PPTX).
- Publication with a connected editor: the banner appears, the view does not remount, the button
  reloads, and the saved message is right.
- Quota after first Edit open equals the source alone, and grows only with pending effects and
  state growth after edits.
- Remove journeys and tests of removed behaviour (remount, `describe_documents`, schema
  migrations).

## The window (UAT first; it is also the rehearsal)

1. Deploy C1-C4 on the old pin beforehand, and dry-run the pause and readiness commands.
2. Turn on the pause. Connected editors flush and go read-only.
3. Run publish-all, then the readiness check until it prints zero. Old-engine export losses in these
   publications (charts, opaque drawings) are known and accepted for UAT data.
4. Commit and push C5 and C6 (pin bump, Capy changes, reset migration). The deploy runs the
   migration while editing is still paused.
5. Check: open one file of each format in Edit, make an edit, publish it, and confirm quota and
   `source_documents` rows match C5's rules.
6. Turn off the pause. Tabs from before the deploy get 403 on reconnect and go to recovery or the
   banner.

## Not in this round

Parser-tolerant XLSX binding (deferred until after the merge by record 18), compact XLSX keys and
values, compression at rest, style-table DOCX formatting, the XLSX agent-edit projection cost,
the descriptor truncation side fix, `bench/office` and UAT stress work
(`todo-office-bench-and-uat-hardening.md`), late merge of old-epoch edits (offline editing), a
PPTX comments UI, and the two filed tasks (DOCX export dropping paragraph and language properties;
chat captioning of edited Office images). Upstream's `SourceImport` passes, proposal store, search
API and `pptx-raster` stay unported.
