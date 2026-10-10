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
- **Live document per Office room** (superseded 2026-10-06 by delta saves in
  the Rust server; kept for its numbers) (one more full pass off each save): the
  engine cache added ~0.6 GiB at 20 large rooms and Epo is fine with memory;
  for now the optimization round moves the save's rebuild into a worker
  instead (Epo 2026-10-06); revisit after the prod-box stress run if saves
  still stall.
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
- **Rust/yrs collaboration server** (decided 2026-10-06): full rewrite with
  delta saves and native Office engines, in progress in the rust round
  (`capy-harness/2026-10-06-rust-round/PLAN.md`).
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
- **Text typed between the halves of a split field, then the join**
  (pre-existing for every split shape, 2026-10-05 probe `E,typeQ,BS`): the join
  keeps the split as decided, but the editor shows the field ending before the
  second half while the save keeps it all in the result (`REF=` vs reopened
  `REF=Qyy`). Not in the matrix.
- **Enter before a nested field holding a link** after the split point keeps
  the old Enter (the half-link before the split leaves the field).
- **Two peers on the nested shape** (one Backspaces while the other types in
  P2): editor `yy`, reopened `7yy`; the accepted concurrent-join class.
- **Page numbers after a right or centre tab.** A PAGE or NUMPAGES field after
  a right or centre `w:ptab` or tab stop (the usual footer "…⟨tab⟩Page {PAGE}")
  is measured with its cached text, and each page paints its own number at
  its own width while the tab keeps the gap measured. With a cached "1"
  (Arial 12pt), pages 10–99 end ~9 px past the right margin and a centred
  number sits ~4.5 px off centre. Fix: shrink that tab by the resolved minus
  the cached width (half for centre) on each page
  (`docx-layout/src/display_list.rs`, tab width vs per-page field width).
- **Clean stress build in CI.** The stress job's build without prebuilt images
  wasn't verified locally (Docker Hub timed out); check the first CI run.

## Queued tracks (each needs its own decisions and a visual checkpoint)

- **After the rust round, Office gaps in this order (Epo 2026-10-10;
  evidence in `capy-harness/2026-10-06-rust-round/parity-survey/`, then
  `bench/parity/`):** (1) XLSX column/row resize, sheet-tab rename/delete and
  fill down (engine operations exist); (2) XLSX sort and fill handle; (3) PPTX
  SmartArt from the cached drawing, duplicate slide and object; (4) DOCX rich
  paste; (5) co-editor cursors in all three formats (the Rust server already
  relays presence per room; the client bridge passes document changes only);
  then conditional formatting and equations. Open behaviour questions for
  those tracks: XLSX filters per person or shared; honour XLSX sheet
  protection or let Capy permissions replace it; PPTX cut; spell-check
  languages and dictionaries.

- **Order after the 2026-10-05 batch:** one optimization round (Yjs save
  latency, typing latency, memory; Office and Plate), then heap/latency
  ceilings from the largest allowed files, then a prod-box stress run for the
  live document per room, a new storage-bytes run, then UAT hardening.
- **Final optimization and security reviews (Epo 2026-10-09, replaces the
  Fable 5.1 review):** after every rust round track lands and before the
  ceilings, Opus 5.5 agents measure Office and Plate user-side network
  requests, bundle sizes, memory while editing and per event, time to first
  paint and layout shifts, and server RAM, CPU, storage and processing speed;
  a security review runs beside it.
- **Optimization round (in progress 2026-10-06):** plan in
  `capy-docx-review-harnesses/2026-10-05-office-batch/opt-survey/PLAN.md`;
  tracks plate, clients-bench (bench fixes land first, incl. the stress job's
  upload path broken by 8c7d7199), office-save, docx-editor, xlsx-editor.
  Epo widened it the same day: any measure, client or server, extreme ones
  included. Continued 2026-10-06 as the rust round: delta saves, the full
  Rust/yrs server, notes projected on idle, DOCX/PPTX override seeds, drafts
  per update (`capy-harness/2026-10-06-rust-round/PLAN.md`).
- **Office size limit** (decided 2026-10-05): refuse oversized Office files at
  upload, per format on the unzipped size of the XML parts only (Epo
  2026-10-06; media stays under the upload cap); numbers come from the
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
- **Header follow-ups:** check the Chinese header (page `lang`) on Windows
  (Microsoft YaHei), Safari and Firefox; the DOCX rulers follow the section at
  the cursor (fork; today the horizontal ruler draws the last section, the
  vertical one the first).
- **DOCX view-mode copy** (landed 2026-10-06; Epo's visual checkpoint on UAT
  pending): the positioned a11y mirror is the view-mode text layer
  (`textLayer.ts`). Unchecked: Safari and Firefox
  (word/paragraph clicks use `caretPositionFromPoint`/`caretRangeFromPoint`,
  Firefox drags links instead of selecting from them).
- **PPTX presenter view** (landed 2026-10-06, capy-ci 5409533d;
  Epo's visual checkpoint pending, including the presenter window's layout 2):
  check on UAT that Present goes full screen from the runtime's own origin
  (Capability Delegation) and that Presenter view's pop-up attaches; Firefox
  and Safari (windowed Present plus Full screen) and iPad are unchecked.
- **PPTX comments UI (parked):** comments are kept on save
  (`crates/pptx-edit/src/comments.rs`) but Capy shows none; start from a mock
  (the parity track landed 2026-10-06). Next parity gaps from its GAP.md: find
  and replace, links, duplicate and object copy-paste, rotate/flip, group and
  border dash.
- **DOCX table leftovers** (docx-table-menu, 2026-10-06): a new table draws
  its text in another font in edit mode than in view mode, and after Auto-fit
  is about 478px wide in edit against 560px in view; Auto-fit offers only
  Word's AutoFit Contents (Window and Fixed column width if asked); no-wrap
  widens a column only into empty room (Word also squeezes other columns to
  their longest word, which needs a minimum-width measure in `ooxml-text`);
  two peers changing the same table's rows at once keep one of the two
  changes. The table ops apply as plain edits in suggesting mode (unused in
  Capy). Notes in
  `capy-docx-review-harnesses/2026-10-05-office-batch/docx-table-menu/`.
- **Unplaceable sync step 2 (lowest priority).** A client whose own sync step 2
  the room cannot place (it holds content out of order) is closed after 2 tries
  (`resyncUnheld`, `collaboration/src/officeRoots.ts`) and then reconnects
  forever with its edits unsent. The fix is a new stateless signal that makes
  the client call `replace()` and enter recovery with a download. Build it only
  if `source_step2_unplaced` ever shows up in the collaboration logs.

## Unverified or small

- **PPTX embedded fonts saved by PowerPoint** (pptx-fonts review 2,
  2026-10-08): the decoder is checked on Google Slides exports (EOT 2.2,
  MicroType Express, run-length stage off) and on constructed run-length
  streams; no PowerPoint-saved (t2embed) deck embedding an OFL face has been
  opened. Add one as a fixture when someone has one
  (`vendor/betteroffice/crates/ooxml-text/src/embedded_font/`).
- **AI-edit Undo storage is not released on source publications** (upload
  audit 2026-10-06, unverified; context in `todo-storage.md`):
  `agent_edit_inverses` are charged at up to 256 KiB each
  (`collaboration/src/persistence.ts` ~66) and released only by Undo, an
  immediate Office publication or rebuild (`source_refresh.go` ~435, ~691),
  trash, compaction (small notes rarely qualify, `persistence.ts` ~1262) or
  deleting the chat or workspace. Text-source publications
  (`source_refresh.go` ~424-428) and deferred Office publications (~417-423)
  leave them charged with no expiry; maintenance-window resets release them
  for the reset formats only. Decide with Epo whether a publication
  invalidates Undo (it rewrites the base the inverse applies to).
- **DOCX section break from the toolbar may not reach the saved file**
  (found by docx-toc review 2, probes J/J2 in
  `capy-docx-review-harnesses/2026-10-05-office-batch/docx-toc/review-2/`):
  in that harness `exportOffice` wrote no paragraph `sectPr` for an
  `insertSectionBreak` embed, with or without a table of contents. Check
  whether it's a harness artefact (breaks owner).
- **DOCX table of contents in content controls and cells** (docx-toc review N2,
  2026-10-06; a follow-up track): Word's References › Table of Contents gallery
  wraps the field in a `docPartObj` block content control (`body:sdt0`), which
  `toc_fields`/`toc_count` don't read, so Update isn't offered for most
  Word-made tables and Insert adds a second one; headings inside table cells
  and content controls (and headers and notes) are not listed (Word lists
  table-cell headings). Read TOC fields and headings in block-control and cell
  stories.
- **DOCX table of contents leftovers** (docx-toc, 2026-10-06): entries leave
  out a numbered heading's list number (Word copies it with a tab); a code
  with `\t`, `\f`, `\l`, `\b` or a Table of Figures (`\c`, `\a`) is left
  alone by Update, and so is one with `\* MERGEFORMAT` or a bare `\f`
  (LibreOffice may write `TOC \f \o "1-9" \h` for its default table, which
  would then get no Update and a second table on Insert: check a LibreOffice
  file); Update does not read `\p` (a `\p "-"` table gets a dot-leader tab
  instead of its separator), `\w` or `\x`; `\n "2-3"` drops every page
  number, not only those levels;
  add "Word opens and updates a Capy-inserted TOC" to the UAT checks (Word was
  not available on the dev machine).
- **DOCX save leftovers after the fidelity track** (2026-10-06; pre-existing):
  the engine's suggesting-mode paragraph property change (unused in Capy) no
  longer makes the save throw but writes the editor's resolved values as the
  previous pPr (no `w:pStyle`, style values as direct), so Reject in Word
  would restyle the paragraph; convert the record through the paragraph save
  as the current pPr is. A vMerge continuation cell saves its restart cell's
  `w:tcPr`, losing its own borders and shading. The editor lays out a row's
  skipped grid columns (`w:gridBefore`) from the first column (view mode and
  Word shift the row). Cells whose
  row or column position changes (a row inserted above the header, a column
  after the last) keep their old table-style look in the editor until the
  file reopens; the save and the editor's style values already use that look,
  so the file follows Word (office-small, 2026-10-06). Paragraphs a merge
  brings into a cell whose look the merge changes (it reaches the last column
  with a lastCol look) save their old cell's look as direct formatting (probe:
  lastCol `ind left 300`, merge H0+H1, H1's paragraph saves `w:ind`). A style
  list paragraph with
  an ilvl-only `numPr` shows no bullet in the editor. A font pick diffs the
  whole story (about 0.75 ms more a keystroke with a stored caret font on a
  4000-paragraph story). Probes in
  `capy-docx-review-harnesses/2026-10-05-office-batch/docx-fidelity/`.
- **DOCX Enter then Backspace drops a section** (docx-enter-copy, 2026-10-06;
  pre-existing): Enter at the end of a paragraph that ends a section, then
  Backspace, loses the section break (the join adopts the text mark's
  properties, which never carry `sectPr`; keep the survivor's section keys
  when the donor has none; probe
  `docx-enter-copy/probes/section-enter-backspace.test.ts`). Same cause: Enter
  mid-paragraph then Backspace drops the source mark's tracked insertion
  (`w:rPr/w:ins` on the mark; the new mark leaves out `pPrIns`/`pPrDel`,
  `ops/paragraph.rs` `split_paragraph`, and `adopt_pilcrow` in `ops/mod.rs`
  replaces the survivor's keys), and the copied `pPrChange` comes back under
  new ids; keep the survivor's mark-revision and section keys when the donor
  has none (docx-enter-copy REVIEW2 finding 4).
- **DOCX Undo of one peer's concurrent split leaves an empty paragraph id**
  (pre-existing on capy-ci, found by the fork-small review 2026-10-08): two
  peers split one paragraph mid-text and sync, then one undoes its split: its
  undo removes its re-mint of the source mark, the other peer's concurrent
  re-mint was already overwritten, so the merged paragraph has no `paraId`
  (`"":pha beta`) and two such paragraphs would share the empty Loc id. The
  duplicate rename skips marks without an id; giving one `{client}.{clock}`
  there would fix it. Probe `fork-small-review/undoBase.test.ts`.
- **DOCX run formatting written as direct on every save** (pre-existing, found
  by the docx-fidelity review 2026-10-06): every save writes the style's run
  formatting as direct formatting on every run of a saved story (long-handbook
  0 → 1103 `w:rFonts`; book-30p's Title gains `sz`, `kern`, `spacing`, its
  Heading 1 runs colour, `kern` and `sz`, every run `lang`), so later style
  changes in Word no longer reach those runs. The run-level counterpart of the
  paragraph save: write each run property the editor holds differently from
  what the seed gave it, source kept for the rest.
- **PPTX typed text size** (pre-existing, found by pptx-parity): text typed
  where the run inherits its size from the placeholder gets an explicit 24 pt
  (`pptx-parity/shots/slide-bulleted.png`, "Nested item").
- **DOCX fields under suggestions (pre-existing, docx-fields final review 2026-10-06):**
  if A joins while B suggests deleting the moved text, B's deletion lands on the
  whole field and Accept All removes the REF field code (needs a decision);
  Enter inside a field suggested for deletion as a whole turns its result into
  live text that Accept All leaves behind. Probes `r3-join-vs-suggest.ts`,
  `r3-struck-field.ts` in the docx-fields harness folder.
- **DOCX layout leftovers from the mid-paragraph break fix** (docx-breaks,
  2026-10-06; the break itself is fixed on `capy/docx-breaks`): a page or
  column break inside a complex field's result is drawn after the field, so
  the field's text stays on one line and the next paragraph moves to the next
  page; a page or column break in a table cell shows as a line break (Word's
  behaviour not checked); a paragraph an in-flow chart (or a non-anchored
  shape) splits numbers its list item once per part and keeps its
  space-before and first-line indent on each part (shared `list_state` in
  `flush_paragraph_parts`). Also: a footnote longer than a page is never
  continued; viewer list numbers may ignore start values (8, 9), legal
  numbering and Chinese numbering (seen with minimal numbering XML — confirm on
  a real Word file first).
- **DOCX Home/End go to the paragraph, not the line** (docx-breaks review,
  2026-10-06; Left/Right and word steps over breaks fixed by fork-small
  2026-10-08): Home/End go to the paragraph's start and end, not the line's
  (Shift+End from text before a break selects across it; Word stops at the
  line end). Needs the display line plus a caret affinity at a wrap point.
- **DOCX `splitPgBreakAndParaMark` is not honoured** (fork-small review,
  2026-10-08): the parser reads only `compatibilityMode` from `w:compat`
  (`docx-parse/src/settings.rs`), so a file setting the flag keeps a
  paragraph's mark on its page break's page here while Word moves it to the
  next page. Read `w:compat/w:splitPgBreakAndParaMark` into the render env and
  skip `mark_stays` in `flush_paragraph_parts` when it is set.
- **Recovery logging** (decided 2026-10-05): log each draft from another epoch
  entering copy-only recovery (no late merge), in the `edit_incidents` table.
- **Editing incident log** (decided 2026-10-05, with the optimization round):
  `edit_incidents` table written by collaboration and by the browser through a
  small endpoint; slow-save, slow-engine-call and room load/unload lines in the
  machine's logs (`human/observability-metering.md`).
- **Office budgets in the gate:** `bench:office` heap figures stay report-only
  until the ceilings exist (after the optimization round; per format, view vs
  edit; measure open/close growth from about the 10th open, not the first);
  then Office joins the production promotion gate with a scroll benchmark once
  its budgets hold for a few runs. The small DOCX key p90 (188 against 195 ms)
  is the closest.

## After the optimization round (decided 2026-10-05)

- **Performance baselines and user-side measurement** (Epo 2026-10-08; last,
  after the optimization and security reviews of the Rust round): decide how
  every measured performance number gets a baseline and a regression gate so
  new changes cannot fall below standard (editor budgets, stress, engine and
  server timings). Decide how to measure from the user's side: bundle size, network
  requests, scroll FPS, time to first paint, font and CSS loading, repaints and
  render blocking, and whether these run inside the user journeys or on
  their own. It covers every page, not only the editors (`openwiki/editor-perf.md`,
  `bench/`).

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

## Live editing for quizzes, flashcard sets and Mermaid (2026-10-07, revised 2026-10-09)

- Problem: note-embedded quizzes and flashcard sets render and edit inside the
  note (decisions in `human/frontend/plate-editor.md`, 2026-10-07). Their
  editors stage a draft and write the whole item through the content endpoints
  with `expectedRevision`; the collaboration service then replaces the item's
  one `quiz`/`flashcards` block in its own Yjs document (headless Slate-Yjs
  command). The note holds only the item's id, and its content comes from the
  API with React Query's 5-minute cache, so another open editor of the note (a
  collaborator, another tab, an agent edit) keeps a stale copy for up to 5
  minutes, and two people editing one set conflict on the revision. Mermaid
  blocks keep their source as one string attribute, so two people typing in
  one diagram overwrite each other's whole source (last write wins).
- Epo decided (2026-10-09): **this is not a "content changed, go fetch the new
  content" signal.** The 2026-10-07 suggestion (Go broadcasts a stateless
  "embed {id} changed" and open editors refetch the whole item) is dropped.
  Each edit travels as a Yjs update that carries the edit itself: these
  characters inserted at this place in this option, this card added after that
  one, this question moved, this mark changed. It works the way blocks and
  text in a note work, so two people can type in the same quiz, set or diagram
  at once and each sees the other's keystrokes merge in place. It is a large
  change, and it makes these items natively editable inside the note. Build it
  on the Rust/yrs server only: the Node server is deleted at the cutover, so
  nothing here goes into `collaboration/`.

### Proposal

- **Where the content lives.** Keep one Yjs document per quiz and flashcard
  set (they already have one), not inside the note's document. Permissions,
  sharing, study state, clone and trash stay per row, and answer keys never
  enter the note document, its projection or the public note read.
- **Shape, finest useful grain** (answers the 2026-10-07 question of how
  fine-grained edits should be):
  - Every typed text is a `Y.Text` that merges per character: text blocks
    (with their inline math text), options, accepted answers, hints, mark
    scheme items, matching and ordering items, table cells, card front and
    back, captions, and the Mermaid source.
  - Lists are collections of items with stable ids: questions, parts, blocks,
    options, cards, graph elements. Adding and removing are list operations.
    Reordering sets an order key on the moved item (a fractional index) rather
    than deleting and reinserting it, so an edit someone makes inside a
    question while another person drags it is kept.
  - Small values are one field each, last write wins: question type, marks,
    unit, boolean answer, correct options, image `assetId`, time limit, chart
    and graph properties, Mermaid theme and width. Changing a question's type
    replaces only that question's answer.
  - Correct answers point at option ids, not positions. Today `correct:
    number[]` indexes `options`, which goes wrong when someone inserts an
    option above.
- **Rust server.**
  - Check every incoming update for these documents against the schema and
    caps before applying and relaying it (types, the 2,000-rune card back,
    option and part counts, assets the material owns), and refuse it
    otherwise, in the same place as the note update check. Check the item the
    update touched, not the whole document, so typing stays cheap.
  - Only people who may edit an item join its room; under the answer-key rule
    they may see keys. Viewers, learners, comment-mode note collaborators and
    public pages keep the answer-free reads.
  - One WebSocket carries the note's document plus the document of each
    embedded item that is on screen, so the note editor opens an embed's
    document only while it is visible or being edited.
  - Agent and API writes become server-side transactions that change only the
    fields that differ (a diff of the old and new item), so they don't
    overwrite someone typing in another question. The content endpoints stay
    as thin wrappers over that; `expectedRevision` goes away for the editors.
  - `materials.content` is projected on idle, as notes are. Study state is
    already keyed by card and question id, so kept ids keep their progress.
  - Viewers and learners see edits live too (Epo, 2026-10-09). See "Live
    reads without answer keys" below for how.
- **Frontend.**
  - The quiz edit page and `FlashcardsEditor` bind each field to the shared
    document: an input applies its change to its `Y.Text` as a minimal edit
    (common prefix and suffix), the question `TextEditor` converts its math
    text the same way, and remote edits move the caret correctly.
  - The staged draft, Save, Reset and their confirmations go away. Each user
    gets their own Undo (`Y.UndoManager` on the item's document); note Undo
    still covers only inserting and removing the reference.
  - Card and question images upload when picked; an unused upload is cleaned
    by the existing asset sweep.
  - Optional: per-field presence (who is in which question) from awareness.
- **Mermaid.** The source becomes a `Y.Text`, in the note's document for
  inline blocks and in the material's own room for standalone mindmaps and
  diagrams. slate-yjs keeps element properties as plain attributes, so the
  source needs either a nested shared text or a hidden text child of the
  block; prototype both. It touches the node shape every note uses: the Plate
  binding, the server validator, Go `materialdoc`, markdown import and export,
  agent edits and projections. The code column is CodeMirror 6 (Epo,
  2026-10-09; it landed for the standalone editor the same day, see the next
  section), so the binding is `y-codemirror.next` or an equivalent written
  against our trimmed CodeMirror, which also gives remote cursors.

### Live reads without answer keys

- Epo decided (2026-10-09) viewers and learners see quiz, set and diagram
  edits live, and asked why that needs a separate answer-free copy instead of
  filtering the keys out per requester.
- Observation: filtering per requester is what reads already do
  (`questions.LearnerView`), and it works for any one-shot read. It does not
  work on the live stream. A Yjs update is a binary batch of items that point
  at earlier items by id; a client that is sent an update with the answer-key
  items cut out holds the later items as pending forever (they reference
  items it never got) and its document stops advancing. So the server cannot
  forward a filtered Yjs update.
- Observation: note viewers are not live today either. View mode renders the
  `materials.content` projection and never joins a room
  (`openwiki/frontend/plate-editor.md`, "Viewers never join a room"), so live
  View would be new for notes as well. Decide whether notes get the same.
- Two ways that do filter per requester, with no third copy:
  - **Keys in their own document** (suggested): each quiz has a content
    document everyone who can read it joins, and a keys document (correct
    options, accepted answers, mark schemes, hints, worked solutions) keyed by
    question, part and option id that only editors join. Readers get real Yjs
    updates; the server's per-document access check is the filter. Flashcard
    sets and diagrams have no keys and need only the content document.
  - **Filtered changes for readers**: readers don't run Yjs for these items.
    The server turns each applied update into a plain change list ("question
    q3 stem: insert 'abc' at 12"), drops paths under answer keys, and fans the
    same list out to every reader of that item, computed once per update.
- Either way, public pages and signed-out shares stay on fresh-on-open reads.

### Running costs

Measured bundle sizes (esbuild, minified, gzip -9, 2026-10-09): `yjs` 28.8
KB; `yjs` with `@hocuspocus/provider` 36.9 KB; CodeMirror state and view
70.3 KB, plus history and its keys 78.3 KB, plus the default keymap 91.5 KB;
for scale, `mermaid.core` is 150.7 KB before any diagram chunk.

- **Storage (server).**
  - An item's stored state is its Yjs document instead of one JSON row per
    Save. Yjs keeps an id and length for every deleted character (garbage
    collection drops the text, not the bookkeeping), and every field, list
    item and order key carries its own ids, so a heavily edited quiz stores
    more than its JSON. Measure a 50-question quiz and a 200-card set before
    and after a scripted edit session with the stress harness; the room size
    caps still bound it, and compaction is the open "Text source history"
    item above.
  - The `materials.content` projection stays, as for notes. A keys document
    (if chosen) adds one more small row per quiz.
  - Mermaid: the source as shared text costs the same per-character
    bookkeeping in the note's document; diagrams are a few KB.
- **Server performance.**
  - Memory: one loaded document per open item, two for a quiz with a keys
    document. A note with 10 embeds on screen for an editor loads up to 10
    (or 20) more small documents; readers add load only if they go live.
  - CPU per update: apply, the schema check on the item the update touched,
    relay, and with filtered changes for readers one conversion per update.
    The check and conversion must scale with the change, not the item.
  - Projection on idle per item, as notes; fewer whole-item replaces than
    today's Save, which rewrites the block.
  - No extra sockets: items share the note's connection; each opened item
    costs one sync exchange (state vectors) on open.
- **Client performance.**
  - Bundle: quiz and flashcard edit and study pages that go live load Yjs and
    the provider (36.9 KB gz); the note editor already has them. The Mermaid
    code column loads CodeMirror (78.3 KB gz) lazily, only in Edit.
  - Memory: one Y.Doc per item on screen plus its field bindings.
  - Rendering: each field subscribes to its own shared value, so a keystroke
    re-renders that field only, never the whole quiz or set.
- **Latency.**
  - Typing: local edits show at once with no Save round trip; others see them
    after one relay hop, as in notes.
  - Opening an embed or item: the projection paints first, then one sync
    exchange before it is editable (the same handover notes use).
  - Agent and API edits: one server transaction per write, relayed like a
    peer's edit, instead of a refetch.
- **Gone:** revision conflicts, staged drafts, Save, Reset and Cancel with
  their confirmations, refetching on open for editors, and the 5-minute stale
  copy.

### For the session that picks this up

- Epo decided (2026-10-09) the editing mechanics above (shared document
  shapes, bindings, server checks, live reads) are not built in the Mermaid
  UI session; they are this item's own work. Before starting, read the Rust
  round plan and the current `collaboration-rs` state, and reconsider any
  point here that conflicts with what the Rust port or other ongoing editor
  work is doing (document layout, update checks, multiplexing, projection on
  idle, agent edits). Bring conflicts back to Epo rather than picking a side.
- Developer questions:
  - Answered (Epo 2026-10-10): keys in their own document; signed-in note
    View goes live too (read-only channel). Built in the rust round session
    (`capy-harness/2026-10-06-rust-round/live-items/`).
  - The quiz could also render inside the same center panel on the same page,
    like flashcards (still open from 2026-10-07).

## Mermaid materials without Plate (2026-10-09)

- Landed 2026-10-09 (decisions in `human/frontend/plate-editor.md`): View
  draws the diagram without Plate; Edit is mock option A with Cancel and Save,
  the blamed line marked in a CodeMirror source, a phone Preview toggle, and
  the full-screen viewer on click; a diagram that cannot be drawn shows
  "Syntax error on line N" and its marked source everywhere it is read.
- Observation for the live-editing session: Edit still runs on the note
  editor. `NoteEditorCore` keeps its room, saving, offline and recovery, and
  mounts `PlateSlate` without `PlateContent`, so the full note plugin set
  loads for one block. Save writes the whole source string by index; two
  editors saving at once still overwrite each other. Replace this with the
  shared-text source from the previous section, and drop the Plate editor here
  once the block can be edited through a lighter binding.
- An unclosed bracket mid-source makes mermaid read to the end, so the
  marked line is the last one, not the bracket's. That is the parser's
  position; improving it means scanning brackets ourselves.

## Typing lost after inserting an embed on UAT (2026-10-07, check later)

- On UAT (`6d358c6c`), scripted as the synthetic owner in a standalone note:
  after the slash command inserted an embedded quiz (its editor opened in
  place), clicking the end of another paragraph and pressing Enter added a line,
  but the typed `/` and text never reached the editor and the slash menu did not
  open. The same steps against the local MSW editor type normally. Reloading
  the note before the next insert worked around it. Epo suspects the ongoing
  Plate editor work; recheck once that lands.

## Note block text caps (2026-10-09)

- The input length pass (titled fields show `72/80` from 90%, untitled fields
  get a silent `maxLength`) skipped the note blocks because the Plate editor
  is being reworked. When it lands, give these the silent treatment, no
  counter, frontend only since they live in the note document:
  - HTML embed caption (`notes/blocks/HtmlEmbedSourceDialog.tsx`) and the
    inline Mermaid caption (`notes/blocks/elements.tsx`): 300 characters.
  - Mermaid source (`notes/blocks/MermaidSourceDialog.tsx`): the same 64 KiB
    byte bound as the HTML embed source (`HTML_EMBED_MAX_BYTES`), with its
    existing error message.
- Today only the 2 MiB document cap bounds them.

## Agent writes to notes and Office files (2026-10-09)

- Test the chat agent's writes end to end against notes and Office sources,
  beyond the paragraph-text cases the 2026-10-09 edit lab covered
  (`bench/rag/reports/local/2026-10-intake-eval/edit-tools-comparison.md` on the
  developer PC): `create_material` and `edit_document` on notes holding
  embedded quizzes and flashcard sets, mermaid diagrams, interactive HTML
  embeds, tables, images, block and inline equations, links and mentions; and
  `edit_document` on DOCX, PPTX and XLSX sources (`replace_text` by paragraph or
  shape id, `set_cell`). For each, check that the write lands where the agent
  meant, that blocks it did not touch keep their content and ids, that Undo
  restores the whole change, and that open editors (another tab, a
  collaborator) see it.
- Developer observation: an `html-embed` fence in an agent-written note does
  not seem to become an interactive block in the app right now. Check the
  import (fence to element), the child pass and the renderer; in the
  2026-10-08 UAT backfill two notes were refused with "An html-embed fence
  needs html", so look at what GLM writes there too.
- Developer consideration: a "changed by someone else since you last saw it"
  marker in `inspect_document` output, so the agent keeps collaborators'
  changes (in the 2026-10-09 edit lab GLM once deleted a collaborator's
  sentence and section to restore "exactly three sections"). Only the editing
  skill line ("keep other people's changes unless the learner asks
  otherwise", 271a8d5a) shipped. No existing source is correct: the Yjs
  contributor markers are per document and cleared on store, Yjs client ids
  are random for browsers and agent edits alike, and stored inspect results
  would flag the agent's own later edits and are dropped by compaction. A
  within-turn marker could come from the per-turn record of what the turn
  inspected or wrote (f11f830f), but it cannot flag new blocks because the
  pipeline never learns inserted block ids. Decide whether that partial
  marker is worth it, or wait for per-block attribution (the Rust server work
  may be the place for it).

## Image size cap in Office files (2026-10-09)

- Every other image upload is moving to a byte cap by plan (2 MiB Free,
  5 MiB Pro, from `plan_limits`): under the cap the file goes in as is, over
  it the browser shrinks it first (`src/features/quizzes/quizImage.ts`, to be
  generalised). Office was left alone because of the ongoing work there.
- Today an inserted image goes into the file at its original size with no
  limit. DOCX reads the picked file into a data URL and only caps the display
  width at 612 px (`insertImageFile` in
  `vendor/betteroffice/packages/docx-react/src/components/DocxEditor/hooks/useFileIO.ts`);
  PPTX gets the raw bytes from Capy's Insert › Image (`api.insertImage` in
  `src/office-runtime/PptxEditorHost.tsx`). Check paste and drop too, in case
  they take another path.
- To do: apply the same cap before the bytes reach the document, using the
  plan of whoever pays for the file. Shrink to JPEG (opaque) or PNG
  (transparent), never WebP: older Word, PowerPoint, LibreOffice and Google
  Docs imports cannot open WebP inside DOCX/PPTX.
