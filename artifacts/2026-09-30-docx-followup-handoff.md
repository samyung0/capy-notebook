# DOCX follow-up handoff (2026-09-30)

For the agent picking up the BetterOffice DOCX follow-up task. Read this, then
the sources it names; the decision file is binding.

## State

- Landed and green on UAT: DOCX breaks as units in every story, field
  containers, Accept/Reject all, refuse-when-unsure rebases, a patched yrs,
  and the pre-production fixes. BetterOffice `capy-ci` = `30e6ef9c`; Capy pins
  it (`aa9f9166`). UAT runs `24130ab6` (same engine; `30e6ef9c` only added tests).
- Production has none of it. Its pin bump needs the Office maintenance window
  (seeds change for breaks outside the body, leading page breaks, some fields).

## Read first

1. `human/frontend/office-files.md`: every 2026-09-29/30 line. Items marked
   "join(s) the follow-up fork task" are this task. Decisions are binding; any
   behaviour choice they don't cover needs a new decision from the developer
   (see the `human` skill), recorded before implementing.
2. `openwiki/frontend/office-files.md`: current DOCX engine behaviour.
3. `AGENTS.md`: BetterOffice workflow (branch from `origin/capy-ci`, rebase,
   land on `capy-ci`, then pin the exact SHA in Capy).
4. Evidence: `/Users/sam/web/capy-docx-review-harnesses/2026-09-30/` has the
   11 review reports (`review-*.md`, `fields-review-*.md`), the reviewers'
   `zz*` probes and fixtures. Most items below have a repro there.

## Why it matters

Only files edited in Capy are affected. A publication exports the editing
state to a new `.docx`, which replaces the stored source before ingest, so an
export loss becomes permanent at the first publication after an edit.

## Follow-up list (priority order)

BetterOffice's own parser, exporter and edit ops (they show up in any export):

1. Block content controls in table cells are dropped on every export.
2. Tables of contents: PAGEREF fields inside entry links are flattened; a field
   spanning paragraphs closes after its first paragraph; `fldChar w:dirty` is
   dropped (Word stops refreshing page numbers).
3. Tracked-change and field nesting losses:
   - a whole field inside one `w:ins`/`w:del`;
   - links inside tracked changes, and tracked changes inside links;
   - content inside `w:ins`+`w:del` pairs;
   - tracked changes inside inline content controls;
   - a content control inside a link;
   - text inside `fldChar` begin/separate runs.

   Also: `w:rPrChange` and move ranges are left unresolved by Accept/Reject
   all, and deleting a page break inside a field result doesn't stick.
4. Links and fields: typing at a link's end drops `w:history`, `w:tgtFrame`
   and `w:docLocation`; field runs stay bold after their first child is
   unbolded.
5. Bookmarks:
   - copied to both halves on Enter;
   - dropped on joins, on accepted paragraph-mark deletions, and inside links
     or inline content controls;
   - their offsets don't shift when text is typed before them.
6. Breaks:
   - a mid-paragraph break inside a link, content control or tracked change
     moves to the paragraph end;
   - a break beside a field moves on Enter at the paragraph start, and on
     Accept all;
   - Enter at the start of a heading after a column-break paragraph puts the
     empty line on the other side of the break.
7. Tooling: move the native viewer's own yrs copy, the Python bindings and the
   fuzz workspaces to the patched yrs (`third_party/yrs`).

Caused by Capy's capture → export → rebase publication (rare comment and
break edge cases):

8. Needs a seed change, so the maintenance window:
   - Word files whose comment reference sits before a leading break seed that
     break mid-paragraph;
   - the direct save grows a comment over a column break that moved onto the
     previous paragraph.
9. Comment drift next to leading breaks:
   - the editor's own save (download draft, view bytes) writes a reply's
     reference ahead of a break;
   - a text-less `[PB][CB]` paragraph with a comment only gets its
     space-before after a reopen;
   - Word's own comment shape, and a comment starting at the text start,
     drift next to a leading break;
   - a comment added after a capture grows over a trailing page break (R11-N2).
10. Direct and rebased saves differ for a source comment whose reference sits in
    the next paragraph (R8-N1, timing).
11. One refusal where the export would be exact (N15); field numbering after a
    bookmark hand-off; a generated comment id could equal a body `w14:paraId`.
12. Confirm first, probably not real: "an empty comment range lands differently
    in a table cell, header cell or endnote". The matrix builder traced it to
    story position in the reviewers' processes.

## How to work

- **Branch:** from `origin/capy-ci` in a separate worktree under your
  scratchpad, and symlink `node_modules` from `vendor/betteroffice`. Never
  modify `vendor/betteroffice` or the Capy tree directly, and never `git stash`.
- **Tests first:** add a failing test per item in `shared/docx-*.test.ts` (plus
  Rust `op_corpus`/unit tests where the change is in the crates).
- **Rebuild before every run:** WASM (`bun run build:wasm`), plus
  `shared/office-runtime` and `office-checkpoint.mjs` via
  `scripts/build-office-checkpoint.ts`. Tests otherwise load a stale engine.
- **Before landing, run `bun run test:matrix` in the fork** (`shared/matrix/`,
  see its README):
  - A worse class fails the run.
  - An improvement prints `better …`; accept it with `--update-baseline` in
    the same commit.
  - Every new `silent` row is a stage 2 violation: a rebase must land exactly
    or refuse.
- **Also run** `bun run test:golden`, packages/docx and docx-react, cargo
  docx-parse/docx-edit/docx-layout (including `--features wasm`), clippy and
  fmt.
- **Review:** use the `human` skill's review loop. Reviews found a regression
  in almost every round of the last task, most of them caused by the previous
  round's fix, so re-run the matrix after every fix.
- **Landing:**
  1. Fast-forward `capy-ci`.
  2. Pin the exact SHA in Capy and update `openwiki/test-catalog.md` and the
     Office wiki.
  3. If seeds change, run the UAT maintenance window. Nobody else uses UAT, so
     deploy there without asking.
  4. Deploy UAT (`deploy-uat.yml`, then `deploy-ingest.yml`), then run
     `uat-quality.yml` with critical paths. It includes the Office refusal
     journey.
  5. Never touch production.
- **Shell traps:**
  - There is no `timeout` command; bound long commands with
    `perl -e 'alarm N; exec @ARGV' …`.
  - In zsh write `${C}:refs/…`, not `$C:refs/…` (`:r` is a modifier).
  - If another session's uncommitted work breaks the pre-commit hook, commit
    your files alone through a separate `GIT_INDEX_FILE` and `commit-tree` on
    `origin/main`. Never push another session's commits.
