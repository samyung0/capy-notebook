# DOCX follow-up handoff (2026-10-01)

For the agent picking up the remaining BetterOffice DOCX items. It replaces the
2026-09-30 handoff.

## State

- Landed: follow-up rounds 1 and 2 (`dcf7d9b5`), the toolbar track (`86744da3`,
  Capy `ea24fffa`) and round 3 of items 1–6 (2026-10-03, `capy-ci` =
  `50caf83a`, Capy commit "Land DOCX follow-up round 3", deployed to UAT).
  Production has none of it and holds no Office data, so a pin bump there
  needs no maintenance window.
- Landed 2026-10-03: the Performance track (`capy-ci` = `8a891c89`, Capy
  commit "Land the DOCX performance track").
- Landed 2026-10-03: the Office header batch (`capy-ci` = `dd87c75e`, Capy
  commit "Land the Office header batch"): the two-row Google-style header and
  menu bar (protocol v7, Radix Menubar), Plate-style popovers for DOCX, XLSX
  and PPTX, PPTX speaker notes hidden by default, DOCX keyboard copy/cut with
  copy-only cuts for content plain text can't carry, and clipboard permission
  for the Office iframes. Decisions are the 2026-10-03 lines in
  `human/frontend/office-files.md`; screenshots in
  `artifacts/2026-10-03-office-header/` and `artifacts/2026-10-02-pptx-toolbar/`.
- Capy ships the engine's CJK faces (`c254fcee`), loaded on demand. Before
  that, CJK text overlapped in view mode and vanished in edit mode. Check CJK
  files (`e2e/fixtures/files/rich-content/exchange-plan.docx`) in both modes
  after layout or font changes.
- Publications are deferred (since `a7b95b7b`): an owner or automatic
  publication completes at once, and the rebase runs later in a background
  rebuild, once nobody has the file open. A rebuild whose rebase refuses marks
  the file due again (`source_documents.rebuild_refusal`), and the automatic
  republication carries the edit. The UAT refusal journey
  (`e2e/uat/journeys/officeRefusal.ts`) checks that path with a TOC edit the
  engine refuses. If an engine fix makes that edit land, the journey fails:
  pick a new refusing edit and pin it with a fork test.

## Read first

1. `human/frontend/office-files.md`: the 2026-09-29 to 2026-10-01 lines are
   binding. The last 2026-10-01 line lists what is left.
2. `openwiki/frontend/office-files.md`: current DOCX behaviour (breaks, fields,
   Enter splitting fields, rebase refusals).
3. `vendor/betteroffice/shared/matrix/README.md`: the matrix and its accepted
   classes.
4. Evidence: `/Users/sam/web/capy-docx-review-harnesses/`:
   - `2026-09-30`: the original reviewers;
   - `2026-10-01-followup`: round 1;
   - `2026-10-01-round2`: round 2 review probes, with `rv5-*` repros for the
     items below.

## Remaining items

Landed from BetterOffice `capy/docx-followup-3` at `50caf83a` (2026-10-03).
Status per item; the decisions are the 2026-10-02 and 2026-10-03 lines in
`human/frontend/office-files.md`.

1. **Concurrent join of a just-split field:** accepted known limitation. The
   join keeps rewriting the moved text into the field (2026-10-02, "the DOCX
   join after an Enter split keeps rewriting").
2. **The join drops formatting:** accepted known limitation (same line).
3. **Redo after Enter moves the field end:** done. The vendored yrs keeps the
   offset into a redone item, and after Undo/Redo a continued field's end is
   re-anchored when its own text was restored (2026-10-02, "the vendored yrs
   also carries a follow_redone fix").
4. **V, typing at the end of a paragraph whose field result continues:** done.
   The plain tail of the first paragraph's result is text after the field
   marker (2026-10-02, "to land DOCX item 4"; 2026-10-03, "after the item 4
   recheck").
5. **Comment coverage refusal widened by ±1:** done. A reversed range covers
   what lies between its ends, and no matrix row turned silent.
6. **Small:** done. The tracked-move split refusal has its matrix rows, and a
   join's shown text drops tabs as the seed does.

Also done: Backspace and Delete step over an invisible field marker (2026-10-02,
"Backspace and Delete beside an invisible DOCX field marker").

## Follow-ups

- Shown text after an Enter split differs from the seed in two cases: a
  nested complex field before a projected link (`[REF|[PAGE|7]L(AA)yy]` shows
  "7"), and a `w:ptab` in a moved run, which doesn't rejoin and saves one link
  as two.
- A continued result whose first-paragraph tail holds a break or a comment
  reference keeps the behaviour from before item 4: text typed at that
  paragraph's end shows after the field in the editor while the save puts it
  inside the result.
- DOCX Insert/Update table of contents, as its own engine track.
- Header menus and toolbars per pause state (handoff, replaced, recovery,
  connecting, discarding): editing items are disabled for now; a case-by-case
  standard is a later task (e.g. Select all is greyed although it only selects).
- DOCX view mode: a selectable text layer over the drawn pages, for copy.
- PPTX presenter view showing speaker notes while presenting.
- PPTX lists and indent (engine), XLSX view-mode zoom.
- The six DOCX table-menu items (vertical alignment, table alignment, header
  row, distribute columns, auto-fit, no-wrap), as a later engine task.

Behaviour choices beyond these need a new decision from the developer, recorded
in `human/` before you implement (see the `human` skill).

## Performance track (landed 2026-10-03)

Done: fork `capy-ci` = `8a891c89`. The decisions are the 2026-10-03 perf lines
in `human/frontend/office-files.md`; current behaviour is in
`openwiki/frontend/office-files.md` (Browser loading model). Measurements,
probes and logs are in `/Users/sam/web/capy-docx-review-harnesses/2026-10-02-perf/`
(NOTES.md); the earlier probes are in `artifacts/2026-10-02-docx-perf-probes/`.

What changed, measured in production builds under load:

- **Typing:** the render env and resolved comment ids stay stable while
  typing, so a key re-sends 1.7–2.1 pages instead of 11.8 (15 pages) with no
  full frames, and range queries read only the pages they touch. FrameDelta
  decode is 2.6–3.2× faster on full frames (open, View to Edit, sync after a
  fallback).
- **Fallback:** a withheld worker answer used to leave the editor in its error
  state; now editing continues on the main thread's frames. Worker timeouts
  start when the worker begins a request, with 60 s for one it never begins.
- **Memory:** cached whole-list JSON is dropped once its handle moves on (layout
  WASM stays at 340 MB instead of growing to 634 MB on 62 pages), and font
  bytes are kept by reference (−17 to −23 MB). 62 pages after 40 keys:
  2251 → 1885 MB.
- **Scrolling:** the screen-reader mirror is a plain-text copy outside two pages
  of the viewport (option B), so scroll frames stay at p50 17 ms with the whole
  document readable by screen readers.

Left over:

- `bench/editor` has no Office spec yet. It needs the runtime to report its own
  timings in the `ready` message (proposal in the perf NOTES.md).
- Each close and reopen leaves about 35 MB of native memory (WASM code or
  allocator retention); the frame and its workers are gone.
- On 62 pages the worker engine's WASM grows 571 → 802 MB over 40 keys, before
  and after these changes. The long-document engine cost per key is not pursued
  (decision line).
- Pages crossing the mirror window rebuild while scrolling (the remaining scroll
  CPU).
- A dev-only patch clearing React's dev measures
  (`capy-dev-clear-measures.patch` in the perf folder) is not applied.

## Toolbar styling track (landed 2026-10-02)

Done: fork `capy-ci` = `86744da3`, Capy commit "Match the DOCX editor toolbar to Capy's toolbars". The decisions are the
2026-10-02 toolbar, icon and toolbar-review lines in
`human/frontend/office-files.md`; current behaviour is in
`openwiki/frontend/office-files.md` (single-row toolbar, runtime theming via
`set-appearance`, the icon hook, the protocol mismatch error). Screenshots of
each approved checkpoint are in `artifacts/2026-10-02-docx-toolbar/checkpoint-5/`
and `/Users/sam/web/capy-docx-review-harnesses/2026-10-02-toolbar/screenshots/`.

Left over:

- Inline SVGs in the print preview, find/replace and shortcut dialogs, toasts
  and placeholders still draw the fork's icons (outside the icon decision).
- The edge fades were checked in Chromium only, not a real Firefox.
- Dialog buttons and tooltips have no fallback for browsers without relative
  colour syntax (Chrome/Edge 111–118); menus and dropdowns do.

## How to work

- **Branch:** create one from `origin/capy-ci` in a worktree under your
  scratchpad. Symlink `node_modules` from `vendor/betteroffice`. Don't modify
  `vendor/betteroffice` or the Capy tree directly, and never `git stash`.
- **Bun:** use Bun 1.3.14, as CI does. The default Bun is older and fails
  before tests run.
  `PATH=/Users/sam/.npm/_npx/60c3515df86f25b1/node_modules/.bin:$PATH bun …`
- **Rebuild before every test run:** `bun run build:wasm`, then
  `bun scripts/build-office-checkpoint.ts`.
- **Tests first:** add a failing test per item in `shared/docx-*.test.ts`, plus
  `crates/docx-edit/tests/op_corpus.rs` when the change is in Rust.
  - Assert content against an oracle: the original text plus what was typed.
    Don't only check that the editor and the save agree. Round 2's worst bugs
    were losses that the editor and the save agreed on, so the matrix showed
    them as exact.
  - For anything collaborative, add a two-peer case.
- **Before landing:**
  - `bun run test:matrix`: no worse class and no new `silent` row. Accept
    improvements with `--update-baseline` in the same commit.
  - `bun run test:golden`.
  - packages/docx and docx-react.
  - cargo docx-parse/docx-edit/docx-layout, also with `--features wasm`.
  - clippy and fmt.
  - Report any golden seed hash change.
- **Review:** every fix round so far broke a neighbouring case, so loop a
  read-only reviewer subagent after each round, per the `human` skill, until
  it reports clean.
- **Landing:**
  1. Fast-forward `capy-ci`.
  2. Pin the exact SHA in Capy with a separate `GIT_INDEX_FILE` and
     `commit-tree` on `origin/main`, so other sessions' uncommitted work stays
     out. Update the Office wiki, `openwiki/test-catalog.md` and the code
     references in `human/`.
  3. Capy CI's `office_matrix` runs the matrix and `shared/docx-*.test.ts`
     when the pin moves.
  4. Deploy UAT with `deploy-uat.yml` (revision = full SHA), then always
     `deploy-ingest.yml` (`environment_name=uat`): the gate refuses an ingest
     running another revision than the backend. Then run `uat-quality.yml`.
     Nobody else uses UAT, so deploy without asking. On an editor-readiness
     timeout the journeys attach `*-not-ready` evidence (save and source
     status, alerts, the runtime frame's text, console errors).
  5. Never touch production.
- **UAT seed check:** `office-maintenance seed-manifest` needs a shell on the
  UAT host, which this Mac has no access to. A seed the new pin can't read is
  refused, never misapplied.
- **Shell traps:**
  - There's no `timeout`: use `perl -e 'alarm N; exec @ARGV' …`.
  - In zsh write `${C}:refs/…` and `${N}:path`, since `:r` and `:h` are
    modifiers.
  - Watch the disk: each fork worktree `target` grows to several GB. Clone it
    with `cp -c -R` and delete it when you're done.
