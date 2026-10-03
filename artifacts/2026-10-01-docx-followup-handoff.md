# DOCX follow-up handoff (2026-10-01)

For the agent picking up the remaining BetterOffice DOCX items. It replaces the
2026-09-30 handoff.

## State

- Landed: follow-up rounds 1 and 2 (`dcf7d9b5`), the toolbar track (`86744da3`,
  Capy `ea24fffa`) and round 3 of items 1–6 (2026-10-03, `capy-ci` =
  `50caf83a`, Capy commit "Land DOCX follow-up round 3", deployed to UAT).
  Production has none of it and holds no Office data, so a pin bump there
  needs no maintenance window.
- In flight on local fork branches (not pushed): `capy/docx-perf`
  (Performance track, accessibility mirror option B), and the 2026-10-03
  header redesign (`capy/office-header`, `capy/xlsx-toolbar`,
  `capy/pptx-toolbar`; decisions are the 2026-10-03 lines in
  `human/frontend/office-files.md`, mock at
  `artifacts/2026-10-03-office-header-mocks.html`). Each rebases onto the
  current `capy-ci` before landing.
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
- The six DOCX table-menu items (vertical alignment, table alignment, header
  row, distribute columns, auto-fit, no-wrap), as a later engine task.

Behaviour choices beyond these need a new decision from the developer, recorded
in `human/` before you implement (see the `human` skill).

## Performance track (added 2026-10-02)

This is separate from items 1–6, and neither blocks the other. In dev, editing
lags and hangs, and the tab reaches about 2 GB.

**Already done in Capy (2026-10-02):** the workspace no longer remounts the viewer
when it crosses lg, and the editor's Google Fonts lookup is off.

**Measured** on Windows, in headless Chromium against MSW, with
`exchange-plan.docx` (15 pages, Chinese) in edit mode at 1280×800. The probes
and how to run them are in `artifacts/2026-10-02-docx-perf-probes/`.

- **Typing:** keystroke to painted frame is p50 78 ms and p90 266 ms with
  production React. Dev is p50 230 ms and p90 840 ms, about 18% of which is
  React's dev-only render profiling.
- **CPU per keystroke** (production React, 40 keys):
  - Display-list decode takes 19%, about 23 ms per key. That is
    `ValueCursor.value` in `packages/docx/src/layout/render/frameDelta.ts`,
    which builds every object through `Object.defineProperty`.
  - WASM layout takes 11% and the edit WASM 6%.
  - 23% is browser work the profiler doesn't attribute.
- **Memory:**
  - The renderer uses 834 MB with the editor open, against 167 MB for the
    workspace without a file.
  - JS heap is 42 MB. The WASM heaps are 41 and 27 MB, and the 27 MB one grows
    to 191 MB on the first edits and stays there.
  - The total levels off around 1.2 GB after 200 keys, so it isn't an unbounded
    leak.
  - About 400–500 MB is unaccounted for. Suspected: copies of the font files
    (the CJK faces are 4.5–11.6 MB each). Unverified.

**Next:**

1. Count how many pages each keystroke re-sends and decodes. If it's more than
   the pages the edit changed, fix that first.
2. Make the decoder cheap: plain object literals instead of `defineProperty`,
   or decode lazily.
3. Find where the unaccounted renderer memory goes with a native heap profile.
   Start by counting how many copies of each font the editor and layout hold.
4. Measure a larger real document (50+ pages) before and after each change.
5. **Then in Capy:** add an Office spec to `bench/editor` that runs against a
   production build:
   - measures open to first paint, View to Edit ready, and keystroke to frame;
   - the runtime reports its own timings in the `ready` message, because the
     parent can't read the cross-origin frame's timeline.

Fork changes follow How to work below. The matrix and goldens should not move,
because these changes only touch rendering and decode.

## Toolbar styling track (landed 2026-10-02)

Done: fork `capy-ci` = `86744da3`, Capy commit "Match the DOCX editor toolbar to Capy's toolbars". The decisions are the
2026-10-02 toolbar, icon and toolbar-review lines in
`human/frontend/office-files.md`; current behaviour is in
`openwiki/frontend/office-files.md` (single-row toolbar, runtime theming via
`set-appearance`, the icon hook, the protocol mismatch error). Screenshots of
each approved checkpoint are in `artifacts/2026-10-02-docx-toolbar/checkpoint-5/`
and `/Users/sam/web/capy-docx-review-harnesses/2026-10-02-toolbar/screenshots/`.

Left over:

- XLSX and PPTX get the same treatment as a separate task (decided, last
  XLSX/PPTX line in `human/frontend/office-files.md`). Their editors still
  paint light chrome in dark mode, and the row under the file header is an
  empty 40 px strip once their editor is ready.
- After a runtime reload the host re-sends `load` and `set-appearance` but not
  `set-citation` or `set-capabilities` (older than this track).
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
