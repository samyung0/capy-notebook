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
