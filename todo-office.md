# Office (DOCX, XLSX, PPTX) backlog

The single list of open Office work, as of 2026-10-03. It replaces
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

## Open from the 2026-10-04 rounds

- **Stress job `continue-on-error`.** `bench:office` and `bench:stress`
  budgets now come from CI runs (the stress p95 budget, 45 ms, from three runs
  after the 30 ms broadcast batching, at 33 to 35 ms within 3% of each other).
  The `stress` job still has `continue-on-error`; drop it once that spread
  holds.
- **Server errors under collaboration stress.** At high local load (20 peers per
  room) the stress test saw a projection deadlock (Postgres 40P01), a store
  statement timeout and a source-access 500, with p95 41–64 s. Reviewer's read:
  the collaboration pool's 15 s `statement_timeout` (`collaboration/src/server.ts`)
  counts lock waits; every Office access check and checkpoint, the read-only
  `CheckSourceAccess` included, takes `workspaces … FOR UPDATE` then
  `users … FOR NO KEY UPDATE` (`store/storage.go`, `sourceLockTx` in
  `source_documents.go`, `account_state.go`), while the Plate store takes
  `FOR SHARE` on the same rows (`persistence.ts`), so many reconnecting Office
  peers serialize writes in one workspace. The 40P01 cycle isn't pinned; the
  candidate is the `materials` `FOR SHARE` → `FOR UPDATE` upgrade in
  `persistence.ts`, and `ProjectMaterialContent` doesn't retry 40P01.
- **View-mode memory** still creeps about 2 MB per open and close (232 → 271 MB
  over 20 rounds); cause unknown, not the font loading. `bench:office` now
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

- **Pause standard.** While editing is paused (handoff, newer version
  replaced, recovery, connecting, discarding) the header menus grey out every
  editing item and File › Save, and the runtime ignores editing commands. Decide
  case by case what each state should allow, menus and toolbar alike (e.g.
  Select all is greyed although it only selects; XLSX View › Freeze counts as
  editing).
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
- **Header open questions:** is "Show document outline" the right label; the
  print shortcut isn't bound; Show ruler is left out; Chinese text in the header
  mixes font weights.
- **Create workspace dialog, zh title.** Now 创建一个 to follow the English
  "Create one", which reads oddly; 新建工作区 would be more natural.
- **Fork typecheck noise:** `usePagesPointer.note.test.ts:539` (docx-react) and
  `.at()` errors in `pptx-react/src/PptxEditor.test.tsx`.
- **UAT text journey** "browser edit automatically publishes durable UTF-8
  source" fails now and then (editor never ready); read its `*-not-ready`
  evidence when it does.

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
  can only download its unsaved edits. Merging them needs the previous source
  and final old-epoch state kept for a grace period; needed once offline
  editing is built.

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
