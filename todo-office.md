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
- **XLSX agent inspect/edit memory:** an AI agent inspecting or editing the
  large gradebook grows the XLSX engine to ~1.9 GiB, which stays resident on
  Linux afterwards. Find what holds it (a second opened copy per call, WASM
  memory never returned) and bound or release it.
- **Second collaboration instance** with document-sticky routing (the gateway's
  collaboration-token response already returns the WebSocket URL) only when
  one main thread runs out; first fix the contributor-marker check below.
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

- **Stress job `continue-on-error`.** `bench:office` and `bench:stress`
  budgets now come from CI runs (the stress p95 budget, 45 ms, from three runs
  after the 30 ms broadcast batching, at 33 to 35 ms within 3% of each other).
  The `stress` job still has `continue-on-error`; drop it once that spread
  holds.
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
  discarding keep today's disabled menus; Select all stays enabled in every
  pause state. `connecting` (before the first sync) is open: Epo asked whether
  it can edit offline as a reconnecting editor does.
- **Order after the 2026-10-05 batch:** one optimization round (Yjs save
  latency, typing latency, memory; Office and Plate), then heap/latency
  ceilings from the largest allowed files, then a prod-box stress run for the
  live document per room, a new storage-bytes run, then UAT hardening.
- **Shortcut map:** map and consolidate keyboard shortcuts across the app
  (Office print shortcut waits for it).
- **Header:** DOCX ruler as a View toggle (Google Docs); Chinese text mixes
  weights in the header (CJK falls back from Fustat to the system font);
  outline item placement pending Epo's screenshot check.
- **DOCX view-mode copy.** View mode draws pages on a canvas
  (`DocxDisplayListViewer`) with no selection. Add a selectable text layer over
  the pages, as PDF viewers have, so text can be selected and copied. Approved
  2026-10-03.
- **PPTX presenter view.** Show speaker notes while presenting. Notes are
  already hidden by default and toggled in edit and view mode.
- **PPTX lists and indent.** The PPTX engine has no list or indent operations,
  so the text toolbar can't offer them.
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

- **Safari copy/cut.** DOCX ⌘C/⌘X use `beforecopy`/`beforecut` listeners for
  WebKit; untested because Playwright's WebKit isn't installed here.
- **Firefox.** The menu bar's edge fades were checked in Chromium only.
- **XLSX Print notice.** "Printed the first 50 pages" hasn't been seen live; the
  test sheet prints 2 pages.
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
- **Office memory ceiling:** heap figures in `bench:office` are report-only;
  decide what a ceiling means (per format, view vs edit; the long DOCX holds
  ~450 MB of WASM in edit mode, the large XLSX ~242 MB) before gating them.
- **Office in the production promotion gate** and a scroll benchmark: later,
  once the Office budgets have held for a few runs. The small DOCX key p90
  (188 against 195 ms) is the closest budget.
- **Editor read-only open** budget was rebaselined to 4,050 ms; the trim of the
  workspace page's startup imports is in `openwiki/editor-perf.md` "Open items".
- **PPTX differences kept on purpose:** Enter on an empty bullet keeps the
  list (as PowerPoint; Google Slides ends it); Backspace at the start of a
  bulleted line joins at once (PowerPoint first removes the bullet).
- **Prune local Docker** if space runs low: four stopped `capy-e2e-local-*`
  containers from 2026-09 and their images (~3 GB).

## Benchmarks and UAT hardening (deferred 2026-09-26)

Storage-round reports, prototype patches and probe scripts are in
`artifacts/2026-09-25-office-storage/` (reference only, not runnable as is).

- **`bench/office` family** with the standard layout, registered in
  `bench/README.md` and the benchmark table in `AGENTS.md`:
  - storage: seed, baseline and pending-change bytes per fixture and format,
    and the charge after first Edit open and at the refresh peak under the quota
    rule (start from `probes/storage/` and `probes/cross-shrink/`);
  - large spreadsheets in WASM: seed, open, one-cell commit, checkpoint save
    and export at 10k, 50k and 100k cells (start from `probes/xlsx-lazy/`);
  - collaboration service cost per incoming update, and browser draft write
    cost per keystroke;
  - WASM sizes of viewer and editor builds against the previous pin (the
    2026-09-26 upstream merge grew DOCX/XLSX 10–13% and PPTX 34–50%; find which
    upstream additions the viewer needs);
  - XLSX save serialization on the 100k-cell sheet (no `onSaveRequest`, so the
    bytes are discarded); add one in the fork if it matters.
- **UAT hardening:** many editors in one Office room and one Plate room,
  sustained typing and reconnect storms; large Office files near the plan
  limits (open, edit, save, publish); publication under concurrent editing with
  a slow or disconnecting editor; a rehearsal of the seed-changing upgrade
  window on UAT; recheck the 3,000-token refresh trigger on CJK documents.
- **Before a second collaboration instance:** the contributor-marker check
  (`collaboration/src/contributors.ts`) only knows this instance's marker
  client, so a crafted delete aimed at another instance's markers isn't
  rejected. Design the trade-off (rejecting honest resends after a room reload)
  first. Deferred while production runs one instance.
- **Late merge of old-epoch edits:** a client disconnected during a publication
  gets its unsaved edits in copy-only recovery (offline editing, 2026-10-05,
  never merges another lineage). Merging them needs the previous source and
  final old-epoch state kept for a grace period.

## Deferred from the 2026-09-25 Office round (status not rechecked)

Listed as "not in this round" in `artifacts/2026-09-25-office-implementation-plan.md`:
parser-tolerant XLSX binding, compact XLSX keys and values, compression at rest,
style-table DOCX formatting, the XLSX agent-edit projection cost, the descriptor
truncation side fix, a PPTX comments UI, DOCX export dropping paragraph and
language properties, and chat captioning of edited Office images.

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
