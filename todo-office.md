# Office (DOCX, XLSX, PPTX) backlog

The single list of open Office work, as of 2026-10-05. It replaces
`todo-office-bench-and-uat-hardening.md` and the open lists in the older
handoffs under `artifacts/`, which are now history. Decisions live in
`human/frontend/office-files.md`; current behaviour in
`openwiki/frontend/office-files.md`. Anything that needs a behaviour choice gets
a developer decision recorded in `human/` before it is built (`human` skill).

Where things stand: everything from the 2026-10-01 DOCX follow-up (items 1–6),
the toolbar, perf and header tracks, DOCX copy/cut and the runtime-reload fix
is on main and UAT. On 2026-10-04 the DOCX editor-vs-save round and perf round 2
landed too (fork `capy-ci` 7d6a3bf2): nested-field shown text, `w:ptab` kept and
drawn, line breaks and comment references in continued tails, text left in a
field after its last link stays until publication, the Office benchmark and a
bounded collaboration stress test in the manual Performance workflow, and the
screen-reader mirror settling 300 ms after scrolling.

## Collaboration capacity, saving and offline (2026-10-04/05)

All of this is on main and UAT (UAT green at dbfcf809). Decisions are in `human/` (search 2026-10-04 and 2026-10-05); the
reports below hold the numbers.

**Landed:** edit-loss fixes; refused saves to copy-only recovery (no download
or discard, Reload only, every recovery path); slow save failures stay
editable with backoff, a persistent closeable "Saving is delayed" banner, a
client warning when an edit stays unconfirmed (45 s Office, 25 s notes) and
recovery after 5 min (`SLOW_SAVE_LIMIT_MS`); a 401 on a source save (service
secret) is a slow failure, logged as `service_secret_rejected`; offline
editing into one IndexedDB store (`capy-edit-drafts` v2, `src/lib/editDrafts.ts`)
with the "Can't connect to Capy" banner and lineage checks; stuck-room fix;
CPU fixes (validate note updates from their structs, fixed-guid scratch docs,
Hocuspocus awareness and provider echo pnpm patches, stores from encoded
bytes); 30 ms `flushDelay` and 50 ms Plate cursor throttle; Redis extension
removed; per-minute `collab_health` log line (lag, messages/s, store p95,
engine worker queue); note updates the room cannot place are refused and
resynced like source rooms (no room copy); Office saves take their change from
the merged document (28% less main-thread time); storage charging fixes
(migration 0054: captured edits not charged twice during a pending rebuild,
text publications move `seed_bytes`).

**Reports:** `bench/collaboration/reports/2026-10-05-prod-capacity.md` (prod
box, 4 vCPU: two big rooms pass at 2×130 people; rooms of 5 pass at 80 rooms on
1 core, 160 on 2; one Office engine worker saturates at ~20 large-file rooms;
10k idle connections ≈ 294 MiB and a quarter core; before/after of the note
resync and Office save fixes at the end); `bench/parsers/reports/2026-10-05-office-storage-charging.md`;
harness notes in `/Users/sam/web/capy-docx-review-harnesses/2026-10-0{4,5}-*`
(load errors, Yjs research, save-failure research across apps, offline design).

**Engine cache and prod pin (landed 2026-10-05, 2400641b, fork `capy-ci`
71e61f59):** each XLSX room keeps its opened workbook between saves
(`OFFICE_REPLICA_BUDGET_BYTES` 1 GiB estimated at 20× the unzipped size; a new
replica only evicts ones idle for `REPLICA_IDLE_MS`, 2 min). XLSX only: PPTX
replicas held ~90 MB for 0.3 s a save, DOCX opens are a small part of a save.
A large-gradebook save went 7 s → 1.4 s and 20 large rooms stay under engine
saturation (save p95 45 s → 2.4 s, collab RSS 1.3 → 1.9 GiB); report
`bench/collaboration/reports/2026-10-05-office-engine-replicas.md`. Production
pins collaboration to cores 2–3 (`docker-compose.prod.yml`
`COLLABORATION_CPUSET`, set by `scripts/env/config.py`; runbook §1.1 has the
check); it applies at the first promotion.

**Open:**
- **Live document per Office room** (one more full pass off each save): the
  engine cache added ~0.6 GiB at 20 large rooms and Epo is fine with memory;
  decide whether the extra document per room is worth it after the XLSX
  effects fix.
- **XLSX effects without a full recalculation** (BetterOffice): computing a
  save's pending effects only reads the Yjs document, but applying any update
  (a 127-byte delta or the full state alike, ~0.5 s on the gradebook) rebuilds
  and recalculates the whole workbook. A read-only effects path would remove
  the remaining ~1.4 s per save and shrink the replicas. Start from
  `xlsxPendingEffects` and the room replica code in
  `vendor/betteroffice/shared/office-checkpoint.ts` (tests in
  `shared/office-replicas.test.ts`).
- **XLSX agent inspect/edit cost and memory** (xlsx-engine track): each agent
  call opens the workbook afresh and builds the whole projection (twice in
  `apply`, once in `locate` and `inspect`; `xlsxProjection` in
  `vendor/betteroffice/shared/office-checkpoint.ts`), minutes at 100k cells,
  and grows the XLSX engine to ~1.9 GiB on the large gradebook, resident on
  Linux afterwards. Read the target with `cellJson` and the sheets with
  `sheetInfoJson`, then remeasure memory.
- **Second collaboration instance** with document-sticky routing (the gateway's
  collaboration-token response already returns the WebSocket URL) only when
  one main thread runs out. First the contributor-marker check
  (`collaboration/src/contributors.ts`): it knows only this instance's marker
  client, so a crafted delete of another instance's markers isn't rejected;
  design the trade-off (rejecting honest resends after a room reload) first.
- **Store CPU off the main thread** (a save worker holding a replica) or a Rust
  server: shelved unless prod shows saves still stall rooms.
- **Load generator limits:** at 2×100+ peers the generator saturated its own
  two cores; split peers across machines for bigger shapes.
- **Text source history** is not compacted (see `openwiki/backend-storage-quota.md`,
  "Yjs storage growth"); compact past a size threshold while the room is empty
  only if it ever matters.
- **Lock options B/C/D** were measured and not landed (no difference at 5–20
  editors); patches in `2026-10-04-stress-locks/lock-options/`.

## Open from the 2026-10-04 rounds

- **Server errors under collaboration stress** (projection deadlock 40P01, store
  statement timeouts, source-access 500 at 20 local peers) came from runs on
  the overloaded event loop before the 2026-10-04 lock and CPU fixes; none
  showed in the 2026-10-05 prod runs. Recheck only if `collab_health` or Sentry
  show them again (`ProjectMaterialContent` still doesn't retry 40P01).
- **View-mode memory** creeps: the 2026-10-04 open/close probe measured about 0.5 MB of JS heap per
  open and close (WASM back to 0 and no closed frame alive after each close;
  an earlier manual run saw 2 MB per round); cause unknown, not the font loading. `bench:office` now
  records the heap over two full view-mode passes per file (`*-view-heap`) and
  after each of five closes (`*-open-close-heap`, with the live document
  count), both report-only.
- **Stale shown text after a two-peer half-link delete.** Two peers each
  deleting half of the last link of a field with a nested field
  (`[REF|[PAGE|7]L(AA)]`) leave the editor showing `REF=` until publication; the
  save is right. Known matrix rows. Fix: after applying a remote update, run
  `refresh_shown` on fields whose links fall in the changed ranges.
- **Field result running into a later paragraph.** After two Enters and a
  Backspace in `L(AA)y,z` the editor shows `REF=y`, the seed `REF=`: the rejoin
  folds tail text back into the field. Needs trimming and renumbering in the
  rejoin.
- **Enter before a nested field after a link** (`[REF|L(AA)[PAGE|7]yy]`): the
  half-link before the split leaves the field.
- **Positional-tab alignment.** `w:ptab` now survives and draws as an ordinary
  tab (next tab stop), not aligned to the margin as Word does; layout work.
- **Two peers on the nested shape** (one Backspaces while the other types in
  P2): editor `yy`, reopened `7yy`; the accepted concurrent-join class.
- **Clean stress build in CI.** The stress job's build without prebuilt images
  wasn't verified locally (Docker Hub timed out); check the first CI run.

## Queued tracks (each needs its own decisions and a visual checkpoint)

- **Pause standard** (decided 2026-10-05): handoff, replaced, recovery and
  discarding and connecting keep today's disabled menus; Select all stays
  enabled in every pause state (with the office-polish agent).
- **Order after the 2026-10-05 batch:** one optimization round (Yjs save
  latency, typing latency, memory; Office and Plate), then heap/latency
  ceilings from the largest allowed files, then a prod-box stress run for the
  live document per room, a new storage-bytes run, then UAT hardening.
- **Final optimization review (Epo 2026-10-05):** after the optimization round,
  one read-only review of the performance and load work by a Fable 5.1
  subagent (Agent tool `model: "fable"`) before setting the ceilings.
- **Office size limit** (decided 2026-10-05): refuse oversized Office files at
  upload, per format on the unzipped package size; numbers come from the
  optimization round. Edits that would make a file oversized are refused too,
  as notes do: a cheap per-update estimate in the incoming-update check
  (`updateFitsRoom` beside the 100 MB state cap), the exact unzipped size at
  save as the backstop.
- **Legacy DOC/XLS/PPT (deferred):** today store-only. Convert to
  DOCX/XLSX/PPTX with the ingest host's LibreOffice so they become ordinary
  Office files. Decide first: replace the original or keep it, when the
  conversion runs (upload or first open), who pays.
- **Shortcut map:** map and consolidate keyboard shortcuts across the app
  (Office print shortcut waits for it).
- **Header:** DOCX ruler as a View toggle (Google Docs); Chinese text mixes
  weights in the header (CJK falls back from Fustat to the system font).
- **DOCX view-mode copy.** View mode draws pages on a canvas
  (`DocxDisplayListViewer`) with no selection. Add a selectable text layer over
  the pages, as PDF viewers have, so text can be selected and copied. Approved
  2026-10-03.
- **PPTX presenter view.** Show speaker notes while presenting. Notes are
  already hidden by default and toggled in edit and view mode.
- **PPTX parity with Google Slides** (decided 2026-10-05): lists, indent and
  the other common text operations Capy's PPTX lacks, Edit › Select all, the
  toolbar arranged after the DOCX/XLSX toolbars and Google Slides. List keys
  follow Google Slides: Enter on an empty bullet ends the list, Backspace at
  the start of a bulleted line first removes the bullet (today both differ).
- **PPTX comments UI (parked):** comments are kept on save
  (`crates/pptx-edit/src/comments.rs`) but Capy shows none; after the parity
  track, start from a mock.
- **DOCX Insert/Update table of contents.** An engine track; the menu item is
  hidden until it works.
- **DOCX table-menu items.** Vertical alignment, table alignment, header row,
  distribute columns, auto-fit and no-wrap. Hidden until the engine supports
  them.
- **XLSX view-mode zoom.**
- **Unplaceable sync step 2 (lowest priority).** A client whose own sync step 2
  the room cannot place (it holds content out of order) is closed after 2 tries
  (`resyncUnheld`, `collaboration/src/officeRoots.ts`) and then reconnects
  forever with its edits unsent. The fix is a new stateless signal that makes
  the client call `replace()` and enter recovery with a download. Build it only
  if `source_step2_unplaced` ever shows up in the collaboration logs.

## Unverified or small

- **DOCX paragraph edits lost on save** (docx-paragraph-save track, with
  `w:rFonts w:hint`): indent, line spacing, tabs, borders and shading set in
  the editor are dropped for every paragraph whose source had paragraph
  properties; `paragraphAttrsToFormatting`
  (`packages/docx/src/yrs/saveFormatting.ts`) overrides only a few. `w:hint`
  is parsed but no run mark carries it (a seed change, taken 2026-10-05).
- **Chat can't describe an image added to an Office file** (decided
  2026-10-05): attach the image to the next model request as `capture_page`
  does and remove the source-change caption path (`captioning_spec()` needs
  ingest job pins the retrieval service never sets; the test mocks it).
- **File descriptors cut mid-phrase** (retrieval): the prompt asks for one
  ~50-word sentence and `_truncate_words` cuts at word 50, the only bound on
  that call (no `max_tokens`). Decided 2026-10-05: cap at ~80 words plus
  `max_tokens` on the call.
- **CJK refresh trigger:** `effectTokens` counts a CJK character as a token and
  each effect carries 40 characters of context on each side in `before` and
  `after`, so a small CJK edit counts ~160 tokens against ~41 in English (the
  3,000 trigger after ~19 edited paragraphs instead of ~73). Decided
  2026-10-05: context counts at the Latin rate in every script (TS and Go).
- **Recovery logging** (decided 2026-10-05): log each draft from another epoch
  entering copy-only recovery (no late merge), in the `edit_incidents` table.
- **Editing incident log** (decided 2026-10-05, with the optimization round):
  `edit_incidents` table written by collaboration and by the browser through a
  small endpoint; slow-save, slow-engine-call and room load/unload lines in the
  machine's logs (`human/observability-metering.md`).
- **Citation after a runtime reload.** `load` carries the citation, but no e2e
  checks the highlight comes back (no mock chat cites an Office file).
- **DOCX highlight picker** never ticks the current highlight; the editor
  doesn't report it.
- **XLSX keyboard selection off screen.** Arrow keys to a cell outside the
  viewport don't scroll the grid there, and typing into that cell is silently
  dropped (no in-cell editor, no edit). Repro at 1280x800 with the side panel
  open: open `course-guide.xlsx` in Edit, click B4 on `CC info`, press
  ArrowRight six times and ArrowDown once; the name box shows H5 but the
  column is off screen, and typing `7` then Enter leaves H5 at 2.
  `bench:office` types into F5 for this reason.
- **XLSX/PPTX edit-mode first paint.** Their editors send no `ready`, so
  `bench:office` times View to Edit to `collaboration-ready` from outside.
  Timing the first painted frame needs a first-paint callback from
  BetterOffice's `XlsxEditor` and `PptxEditor` (as the DOCX editor's
  `docx-pages-presented`), which `XlsxEditorHost`/`PptxEditorHost` would turn
  into `ready` with timings.
- **Fork icons left over** in the print preview, find/replace and shortcut
  dialogs, toasts and placeholders.
- **Chrome/Edge 111–118:** dialog buttons and tooltips have no colour fallback
  for missing relative colour syntax (menus and dropdowns have one).
- **Fork typecheck noise:** `usePagesPointer.note.test.ts:539` (docx-react) and
  `.at()` errors in `pptx-react/src/PptxEditor.test.tsx`.
- **Office budgets in the gate:** `bench:office` heap figures stay report-only
  until the ceilings exist (after the optimization round; per format, view vs
  edit; measure open/close growth from about the 10th open, not the first);
  then Office joins the production promotion gate with a scroll benchmark once
  its budgets hold for a few runs. The small DOCX key p90 (188 against 195 ms)
  is the closest.

## After the optimization round (decided 2026-10-05)

The 2026-09-25 storage probes stay in `artifacts/2026-09-25-office-storage/`
(reference only).

- **Storage-bytes run:** rerun `bench/parsers/scripts/office_storage.ts` and
  `office_storage_charging.spec.ts`; compare with the 2026-09-28 and
  2026-10-05 reports in `bench/parsers/reports/`.
- **WASM sizes:** the 2026-09-26 upstream merge grew the viewers 10–50%
  (`artifacts/2026-09-25-office-progress/c5.md`); DOCX viewer 7.6 MB, DOCX
  editor 10.3 MB, PPTX viewer 2.1 MB. Find what the viewers carry that view
  mode never calls, and print each module's bytes in the `bench:office` report.
- **Mass reconnect:** every client of a busy collaboration service
  reconnecting at once after a restart or deploy; `bench:stress` only drops
  peers one at a time.
- **Maintenance window rehearsal on UAT** with Office rows present (pause,
  publish-all, status, seed-manifest, reset, resume), including an editor that
  goes silent during the maintenance handoff. Needed before production holds
  Office data.
- **Safari and Firefox pass:** DOCX ⌘C/⌘X rely on `beforecopy`/`beforecut`
  for WebKit, and the menu bar's edge fades were checked in Chromium only.

Dropped 2026-10-05: parser-tolerant XLSX binding, compact XLSX keys and
values, compression at rest and the DOCX style table (states are small changes
over the seed); `bench/office` as a directory, the per-update cost (measured in
the prod report), the 100k XLSX save serialization and publication under a
slow editor (no handoff outside maintenance since the deferred rebuild).

## How to work on Office changes

- **Worktrees:** create fork branches from `origin/capy-ci` in a worktree under
  `/Users/sam/web/capy-docx-worktrees/` (durable; `/private/tmp` is wiped by
  reboots) and keep notes and patches in
  `/Users/sam/web/capy-docx-review-harnesses/<date>-<topic>/`. Symlink
  `node_modules`. Never edit `vendor/betteroffice` or the Capy tree directly,
  never `git stash`, and never `pnpm run`/`pnpm exec` in a worktree with
  symlinked `node_modules` (it can wipe the shared modules). Capy worktrees need
  `git -c submodule.recurse=false` for checkouts.
- **Bun 1.3.14:** `PATH=/Users/sam/.npm/_npx/60c3515df86f25b1/node_modules/.bin:$PATH`.
  Rebuild before tests: `bun run build:wasm`, then
  `bun scripts/build-office-checkpoint.ts`; `build:css` when styles change.
- **Tests first,** asserting content against an oracle (the original text plus
  what was typed), not only editor-vs-save agreement; add a two-peer case for
  anything collaborative.
- **Before landing:** `bun run test:matrix` (no worse class, no new `silent`
  row), `bun run test:golden` (report any seed hash change: it means a
  maintenance window), the package suites (`bun test --isolate` for xlsx/pptx),
  cargo with `--features wasm`, clippy and fmt. Run every Capy e2e spec that
  touches Office, not just the one you changed.
- **Review:** loop a read-only reviewer after each round until clean.
- **Landing:** fast-forward `capy-ci`; pin the exact SHA in Capy with a separate
  `GIT_INDEX_FILE` and `commit-tree` on `origin/main` (other sessions keep
  uncommitted work in the tree; three-way merge files they touched); update
  openwiki, the test catalog and code references in `human/`. Then CI, then
  `deploy-uat.yml`, `deploy-ingest.yml` (`environment_name=uat`, same revision,
  always) and `uat-quality.yml` with the browser suite and critical paths.
  Nobody else uses UAT. Never touch production.
- **Shell traps:** no `timeout` (use `perl -e 'alarm N; exec @ARGV' …`); in zsh
  write `${C}:refs/…`; stop processes by PID only; watch the disk (each fork
  worktree's `target` grows to several GB).
