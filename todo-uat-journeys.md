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
2. **Reprocessing** (plan below): J1 + J2 now, J4 after the note-indexing fix,
   J3 optional. Open questions for Epo:
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
- **J4** note indexing (blocked on the fix below): create → indexed; edit →
  re-indexed, only the changed chunk embedded; auto process off → waits; on →
  indexed; trash → index gone; exact charge.
- Verifier grants needed: `rag_material_contents`, `material_yjs_documents`,
  `material_yjs_updates`, `agent_edit_inverses`; optionally `user_credits`
  (`reserved_micros` back to 0).
- Also missing:
  - the refusal journey never settles its republication spend;
  - the Indexing tab's `fileChanges` / `pendingNotes` are never asserted.
- **Budget:** J1–J4 together add 35–40 min. Run J2–J4 under their own
  `--grep` dispatch, or raise `globalTimeout`.
- Doc fixes beyond the chips:
  - `plate-editor.md`: the pending-projection idle threshold is 30 s, not 5 s.
  - `agentic-retrieval.md`: worker and reaper parks clear the dirty flag, so
    those notes don't count in `pendingNotes`.

## Product bugs (task chips created 2026-10-14)

- **Note indexing never succeeds on UAT** (verified read-only): all 245 note
  index jobs since 2026-09-19 failed with "ingest source identity is invalid";
  all 181 notes sit on a failed `index_job_id` and are never retried;
  `rag_material_contents` is empty. Causes: note payloads have no file identity
  but the provider boundary requires one; the 30 s heartbeat cancels note jobs;
  the alias moves before the new content is ready (old content deleted, no
  vector reuse); terminal failure leaves a `processing` content row. Recovering
  the 181 stuck UAT notes needs Epo's call.
- **Office refresh**: F1, an epoch reset leaves queued refreshes that 409 at
  claim and never finish (two stall every export); F2, any save between
  capture and attach throws away a parsed refresh. Plus smaller leaks and
  stale docs listed in the chip.
- **Reconnect message**: a removed member's open editor shows file-missing; by
  decision that stays.
- **CSV limit**: see the next section.

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
