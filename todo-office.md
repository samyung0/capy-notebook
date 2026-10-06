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
- **Text typed between the halves of a split field, then the join**
  (pre-existing for every split shape, 2026-10-05 probe `E,typeQ,BS`): the join
  keeps the split as decided, but the editor shows the field ending before the
  second half while the save keeps it all in the result (`REF=` vs reopened
  `REF=Qyy`). Not in the matrix.
- **Enter before a nested field holding a link** after the split point keeps
  the old Enter (the half-link before the split leaves the field).
- **Tracked-deleted note references and `w:fldSimple` results** (R2-8, separate
  DOCX fidelity task): after any edit in their paragraph, a deleted footnote or
  endnote reference saves live and a deleted simple field saves its result
  empty; reproduces on capy-ci in a plain paragraph.
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
- **Header follow-ups:** check the Chinese header (page `lang`) on Windows
  (Microsoft YaHei), Safari and Firefox; the DOCX rulers follow the section at
  the cursor (fork; today the horizontal ruler draws the last section, the
  vertical one the first).
- **DOCX view-mode copy** (landed 2026-10-06; Epo's visual checkpoint on UAT
  pending): the positioned a11y mirror is the view-mode text layer
  (`textLayer.ts`). Unchecked: Safari and Firefox
  (word/paragraph clicks use `caretPositionFromPoint`/`caretRangeFromPoint`,
  Firefox drags links instead of selecting from them).
- **PPTX presenter view.** Show speaker notes while presenting. Notes are
  already hidden by default and toggled in edit and view mode.
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

- **A field that shows nothing is laid out one digit wide** (pre-existing,
  found by docx-toc 2026-10-06): ooxml-text measures an empty field result as
  `"1"` (`prepare_field_run`, `crates/ooxml-text/src/measure/prepare.rs`), so a
  table of contents' own marker (and a REF over links, a split field's first
  half) takes ~9 px at 12 pt. In every TOC's first entry, Word's or Insert's,
  the page number then sits one digit left of the others. Fix: measure an
  empty result as nothing unless the field is PAGE/NUMPAGES (whose text each
  page resolves), in the JSON and typed measure paths alike.
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
  Word shift the row). Enter at the end of a paragraph keeps only style,
  spacing, font carry and the list, where Word copies all direct pPr
  (alignment, indents, the unmodeled children): needs a decision. Cells whose
  row or column position changes (a row inserted above the header, a column
  after the last) keep their old table-style values and save them as direct
  formatting, where Word shows the new position's. A style list paragraph with
  an ilvl-only `numPr` shows no bullet in the editor. A font pick diffs the
  whole story (about 0.75 ms more a keystroke with a stored caret font on a
  4000-paragraph story). Probes in
  `capy-docx-review-harnesses/2026-10-05-office-batch/docx-fidelity/`.
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
- **Copy at a mid-paragraph break (needs Epo's decision):** view mode copies a
  newline at a page or column break inside a paragraph; the editor
  (`yrsCommands.ts` `yrsSelectionText`) copies nothing there and marks the copy
  not plain. LibreOffice's text export writes a newline; Word's clipboard is
  unchecked (its object model uses U+000C/U+000E). Recommended: a newline in
  both modes when text precedes the break in its paragraph, keeping
  `plain = false` so Cut still only copies.
- **DOCX arrows over breaks** (docx-breaks review, 2026-10-06): Left/Right step
  through `session.paragraphs(story)[i].text`, which leaves break units out
  (`YrsInput.tsx:829`, `:850-856`), so ArrowRight stops before the last
  character of a paragraph holding a page, column or soft line break, and
  Alt/Ctrl+Arrow word steps are off by one per break. Step through the story's
  unit segments instead. Home/End go to the paragraph's start and end, not the
  line's (Shift+End from text before a break selects across it; Word stops at
  the line end).
- **Enter right after a mid-paragraph break** (docx-breaks review,
  2026-10-06): it leaves `Aa<pageBreak>¶Bb¶`, so an empty line paints at the
  top of the next page and "Bb" sits one line down; reopening the saved file
  shows "Bb" at the top, because the seed moves the break onto the next
  paragraph. Split before the break instead (the shape the seed makes, and no
  text ahead of a break in its slot, as decided 2026-09-28); queue with the
  matrix's `break-paragraph` rows.
- **Chat can't describe an image added to an Office file** (decided
  2026-10-05): attach the image to the next model request as `capture_page`
  does and remove the source-change caption path (`captioning_spec()` needs
  ingest job pins the retrieval service never sets; the test mocks it).
- **File descriptors cut mid-phrase** (retrieval): the prompt asks for one
  ~50-word sentence and `_truncate_words` cuts at word 50, the only bound on
  that call (no `max_tokens`). Decided 2026-10-05: bounded like compaction,
  `max_tokens` 400 is the only cut, an empty reply fails explicitly.
- **CJK refresh trigger:** `effectTokens` counts a CJK character as a token and
  each effect carries 40 characters of context on each side in `before` and
  `after`, so a small CJK edit counts ~160 tokens against ~41 in English (the
  3,000 trigger after ~19 edited paragraphs instead of ~73). Decided
  2026-10-05: context counts at the Latin rate in every script (TS and Go).
- **Chat slot requires vision** (decided 2026-10-05): add `vision` to the chat
  slot's required capabilities in `server/internal/models/slot.go` so the ops
  dashboard refuses a text-only chat model; check every assigned chat row
  carries `vision` first (migration if not).
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
