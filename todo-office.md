# Office (DOCX, XLSX, PPTX) backlog

The single list of open Office work, as of 2026-10-03. It replaces
`todo-office-bench-and-uat-hardening.md` and the open lists in the older
handoffs under `artifacts/`, which are now history. Decisions live in
`human/frontend/office-files.md`; current behaviour in
`openwiki/frontend/office-files.md`. Anything that needs a behaviour choice gets
a developer decision recorded in `human/` before it is built (`human` skill).

Where things stand: everything from the 2026-10-01 DOCX follow-up (items 1–6),
the toolbar, perf and header tracks, DOCX copy/cut and the runtime-reload fix
is on main and UAT (fork `capy-ci` dd87c75e, Capy 600a3ab9, UAT green).

## In progress

- **DOCX editor and save disagree (3 cases).** An agent is fixing these on fork
  branch `capy/docx-mismatch`, notes in
  `/Users/sam/web/capy-docx-review-harnesses/2026-10-03-docx-mismatch/`.
  - After an Enter split, a nested complex field before a projected link
    (`[REF|[PAGE|7]L(AA)yy]`) shows "7" instead of the seed's text.
  - A `w:ptab` in a moved run doesn't rejoin, and the save writes one link as
    two.
  - When a continued field's first-paragraph tail holds a break or a comment
    reference, text typed at that paragraph's end shows after the field in the
    editor but the save puts it inside the result. Item 4 fixed this for plain
    tails (text after the field marker); these tails still use the old rule.
- **DOCX perf leftovers.** An agent is on fork branch `capy/docx-perf-2`, notes
  in `/Users/sam/web/capy-docx-review-harnesses/2026-10-03-perf2/` (earlier
  numbers and probes in `…/2026-10-02-perf/NOTES.md`).
  - Office spec for `bench/editor`: open to first paint, View to Edit ready and
    keystroke to frame on a production build. The runtime has to report its own
    timings (e.g. in `ready`), because the host can't read the cross-origin
    frame's timeline, so it is a protocol change.
  - Each close and reopen of a DOCX leaves about 35 MB of native memory (the
    frame and its workers are gone). Unknown whether it plateaus (WASM code
    cache) or leaks.
  - On a 62-page document the worker engine's WASM grows 571 → 802 MB over 40
    keys. Only measuring whether it plateaus: per-key engine cost on long
    documents is not pursued (decision).
  - Pages crossing the screen-reader mirror window rebuild while scrolling; this
    is the remaining scroll CPU after mirror option B.

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
