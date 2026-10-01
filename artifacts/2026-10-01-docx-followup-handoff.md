# DOCX follow-up handoff (2026-10-01)

For the agent picking up the remaining BetterOffice DOCX items. It replaces the
2026-09-30 handoff.

## State

- Landed: follow-up rounds 1 and 2. BetterOffice `capy-ci` = `dcf7d9b5`, and
  Capy pins it (`3b725d4e`, deployed to UAT). Production has none of it and
  holds no Office data, so a pin bump there needs no maintenance window.
- The fork has only `main` and `capy-ci`. All feature branches were merged and
  deleted.
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

1. **Concurrent join of a just-split field.** Enter inside a projected link,
   TOC entry or field result splits the field across paragraphs. Backspace or
   Delete rejoins it. The problem is two peers acting on the same split at
   once: both joining, or one deleting or typing in the moved text while the
   other joins. This can:
   - duplicate text;
   - revive a deletion;
   - misplace typed text.

   The cause is that the join deletes the moved text and rewrites it into the
   field, so peer edits don't merge. The fix is a split that keeps text in
   place (a multi-paragraph field whose end marker moves). Repro:
   `rv5-w2.ts`, 13 of 40 flows fail.
2. **The join drops formatting.** Bold applied to the moved text between Enter
   and the join is lost, because matching compares text only. Repro:
   `rv5-fmt.ts`.
3. **Redo after Enter moves the field end.** With a single multi-character run
   (`L(AA)yy`), Enter, Undo, Redo puts the field end one unit early. Text is
   safe. Repro: `rv5-ur2.ts`.
4. **V: typing at the end of a paragraph whose field result continues** into
   the next paragraph. The save puts the text inside the result, as Word does,
   but the editor shows it after the field. These are 6 accepted `exact+moved`
   rows in `docx-fields.tsv`. An attempt that rewrote field data per keystroke
   was reverted: it lost concurrent typing and grew the state by about 18 KB
   per key. A fix must type into the result as an ordinary text unit.
5. **Comment coverage refusal widened by ±1.** A comment range that typing
   reversed counts its neighbour units as covered, so joins beside it refuse.
   That affects 15 rows that landed with `timing+unstable` before. The safe
   side is acceptable; narrow it only if it can be done without silent rows.
6. **Small:**
   - The matrix README lists a tracked-move split refusal that no baseline row
     holds. Add the row or drop the line.
   - After a join, a field's shown text keeps a tab (`"y\tz"`) where the seed
     shows `"yz"`. The save is the same.

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

## Toolbar styling track (added 2026-10-02)

This is also separate from items 1–6. The developer wants the DOCX editor
toolbar to match Capy's own toolbars: `Toolbar` and `ToolbarGroup` in
`src/components/ui/Toolbar.tsx`, and `ToolbarButton` in
`src/components/ui/ToolbarButton.tsx`, as used by `NoteToolbar` and the PDF
toolbar.

Screenshots are in `artifacts/2026-10-02-docx-toolbar/`: the toolbar today in
both themes, the toolbar with a CSS reset injected, and Capy's PDF toolbar for
reference.

The runtime is a separate document, so none of Capy's CSS reaches it. It loads
only `src/office-runtime/office-runtime.css` and docx-react's `dist/styles.css`.

**Capy side (no fork change):**

1. **Add a CSS reset to the runtime.** This is most of today's "off" look.
   `packages/docx/src/styles/editor.css` leaves out Tailwind's reset
   (preflight) on purpose and expects the host to supply it, and the fork's own
   apps load full Tailwind. Without it, every ghost button keeps the browser's
   bevelled border. Injecting `tailwindcss/preflight.css` into the frame fixes
   that (`docx-with-reset.png`). Importing it in `office-runtime.css` is safe
   for the app, because the iframe is its own document. Check the XLSX and PPTX
   viewers and editors afterwards, since they share that CSS.
2. **Map Capy's colours onto the editor's variables.** In `office-runtime.css`,
   set the `--doc-*` and shadcn variables on `.oox-root` (`--background`,
   `--muted`, `--border` and so on) to Capy's values. Those values come from
   `src/styles/tokens/primitives.css`, `src/styles/tokens/themes/*.css` and the
   semantic names in `src/styles/tailwind.css`. The runtime can't read the
   parent's variables, so it needs its own copy.
3. **Dark mode.** The editor stays light while Capy is dark
   (`docx-now-dark.png`). `DocxEditor` already takes
   `colorMode: 'light' | 'dark' | 'system'`. The host needs to send its theme
   (`src/theme/ThemeProvider.tsx`) with `load` and on every change. That is a
   protocol message, so bump `OFFICE_PROTOCOL_VERSION`.
4. **Wrong status label.** In edit mode the DOCX header keeps saying "Opening
   document…" (`src/features/files/DocxView.tsx` around line 96), because only
   the viewer reports a page count.

**Fork side (`capy-ci`, styling only):** what's left after the reset is layout
that docx-react hardcodes as Tailwind classes under `important: '.oox-root'`.
Prefer CSS variables in the fork, with the values set from Capy, over
rewriting the classes. That keeps the `capy-ci` diff small for upstream syncs.

| Part | Fork today | Capy target |
| --- | --- | --- |
| Formatting bar (`packages/docx-react/src/components/Toolbar.tsx`, the `formatting-bar` container) | `bg-muted rounded-full min-h-[36px] mx-2 mb-1` pill | flat `h-10`, `border-b`, `bg-surface/95`, `px-2` |
| `ToolbarGroup` (same file) | `gap-px px-1.5 border-r border-border/50` | 1px × 28px `after:` divider with `mx-1.5` |
| `ToolbarButton` (same file, plus `.oox-toolbar-toggle` in `editor.css`) | `Button size="icon-sm"`, muted text | `size-8`, `[&_svg]:size-4`, hover `surface-hover-bg`, pressed `tint-accent-1` |
| Pickers (zoom, style, font, size) | bordered selects | match Capy's dropdown `ToolbarButton` |

**Not styling only. Each needs a developer decision recorded in `human/`
before implementation:**

- Whether to keep the title-bar row (document icon plus File, Format and Insert
  menus) or fold it into the toolbar. `DocxEditor` already takes
  `showFileOpen` and `showHelpMenu`.
- Whether to swap the fork's `MaterialSymbol` icons for Capy's icon set. That
  needs an icon injection point in docx-react.

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
  4. Deploy UAT with `deploy-uat.yml` (revision = full SHA), then
     `deploy-ingest.yml` (`environment_name=uat`) if the pipeline changed. Then
     run `uat-quality.yml`. Nobody else uses UAT, so deploy without asking.
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
