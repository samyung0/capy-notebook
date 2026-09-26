# Fork review fixes on `capy/upstream-merge`: pushed, two questions open

Date: 2026-09-26. Findings H1, H2, M1, M2 and M3 of `review-fork.md`, fixed in the worktree
`C:\WEB\bot` (fork `samyung0/betteroffice`) on top of `e912e8e0`, the tip of
`origin/capy/upstream-merge`. Nothing merged into `capy-ci`. `vendor/betteroffice` in Capy was
not touched. L1 and the XLSX golden limitation (a room binds to a fingerprint of the whole parse)
are left as they are.

HEAD `1ca0968b31dc8b153e6716c42195403cf896a73c`, pushed to `origin/capy/upstream-merge` as a
fast-forward from `e912e8e0` (five commits, one per finding).

## Branch incident, repaired

`C:\WEB\bot` is a worktree of `C:\WEB\betteroffice-merge`, and that clone has
`capy/upstream-merge` checked out at `b8ee465c`. Git 2.41 let the instructed
`git checkout -B capy/upstream-merge origin/capy/upstream-merge` reset that shared branch, so after
my first commit the clone showed phantom staged changes (its files had not changed, its branch
had). I put the ref back with `git update-ref refs/heads/capy/upstream-merge b8ee465c` (the clone
is clean at `b8ee465c` again, `git worktree list` confirms) and did the rest of the work on a
local branch `capy/fork-fixes` that tracks `origin/capy/upstream-merge`. The push targets
`origin/capy/upstream-merge`. No file in the clone was modified. Its local branch is still at
`b8ee465c`, behind origin by `e912e8e0` and these commits.

## Commits

| SHA | Finding | Subject |
| --- | --- | --- |
| `d0f045c9` | H1 | fix(xlsx): keep source order of defined names in collaborative exports |
| `ff3bb1b8` | H2 | fix(docx): drop comment parts instead of writing empty ones |
| `18121f66` | M1 | fix(docx): ignore generated comment thread ids in the rebase check |
| `094d1ebe` | M2 | fix(office): cap incoming updates only, not the stored state a session loads |
| `1ca0968b` | M3 | test(office): add test:golden for the seed goldens and checkpoint tests |

## What each fix does

- **H1** (`crates/betteroffice-xlsx/src/authority/stable.rs`, `materialize`). Each materialized
  name is matched to its entry in `base.defined_names` by source sheet index (from the stable
  `sheet:N` key, so renames and moves don't break it) and exact name. Names are sorted by that
  index, and names the source lacks come after them in the old `(local sheet, name)` order. The
  upstream `render_defined_names` peek pairing now meets the names in source order. I kept the
  pairing in the patcher unchanged; ordering in `materialize` is fork code and has no
  scope-rescoping edge cases.
- **H2** (`crates/docx-parse/src/serializer/s13.rs`). For an empty projection,
  `serialize_comment_parts` now calls `remove_comment_parts`. It drops the four comment parts and
  their own `_rels` parts, the four `Override` entries, and the document relationships of the four
  comment types. A package without comment parts is left untouched: no parts, no relationships, no
  overrides. The package overlay got a `remove` (a removed index is skipped by `refs` and `paths`).
  The part table that `ensure_comment_parts` used moved into a shared `COMMENT_PARTS` const.
- **M1** (`packages/docx/src/yrs/rebaseCheckpoint.ts`). When the `authored()` replacer reaches
  `comments`, it drops every `paraId` and `durableId` inside them, including those on comment
  paragraphs.
- **M2.**
  - DOCX: `EditingDoc::load_state_v1` decodes and applies without the 64 MiB check, and
    `EditSession.load` (TS `loadState`) uses it. Remote (`apply_update`,
    `apply_update_with_inference`) and local-worker intake keep F2.6's `decode_update_v1` guard.
  - `js_err` in `crates/docx-edit/src/wasm.rs` now builds a `js_sys::Error`, so every DOCX
    `EditSession` error reaches JS as an `Error` with a message. Before, they were all bare
    strings. Capy's callers handle both. `collaboration/src/server.ts:932` and `:1033` used to fall
    back to a generic message for non-`Error` throws; they now get the engine message.
  - The `load` doc comment changed, so `docx_edit.d.ts` and `docx_edit_bg.wasm.d.ts` were
    regenerated and committed. The second file only reorders one export.
  - PPTX: the stored-state cap in `DeckSession::open_from_update_with_source` is removed.
    `apply_update_v1` keeps its per-update cap.
- **M3** (fork `package.json`). The new script is
  `"test:golden": "bun scripts/build-office-checkpoint.ts && bun test --isolate ./shared && cargo test -p betteroffice-xlsx --test storage"`.
  The checkpoint bundle is rebuilt first: the shared tests load the WASM copies in
  `shared/office-runtime/`, which otherwise go stale (or are missing) after a WASM rebuild. The
  script builds no WASM itself; it expects the office build to have run. The `test` script, the
  fork CI workflow and the old clippy warnings are unchanged.

## Tests added or tightened

- H1, Rust: `a_collaborative_export_and_its_rebase_keep_every_source_defined_name`
  (`crates/betteroffice-xlsx/tests/stable_collaboration.rs`). It runs on
  `packages/xlsx/test-fixtures/defined-names.xlsx` and on an Excel-ordered workbook: `sample.xlsx`
  with `_xlnm._FilterDatabase` (hidden) and `_xlnm.Print_Area` local to sheet 0, then the globals
  `Rate` and `taxRate`, built in the test through `ooxml_opc`.
  - The workbook is exported after a captured edit (Z1). The reopened export must list exactly the
    source's names, in order.
  - A later edit (Z2) is then rebased over that export. The rebased state's only pending effect
    must be `Data!Z2` / `Budget!Z2`, with no name effects.
  - Without the fix it fails: the export keeps `Header` and `Picked` only.
- H2, Rust: `empty_comment_projection_clears_original_thread_parts` (`s13.rs`) now asserts three
  things:
  - With comments `None`, the parts, `[Content_Types].xml` and the document rels are byte-equal to
    the source.
  - With `[]` over a commented source, the four parts are absent and neither the content types nor
    the rels contain `comments`.
  - With `[]` over a comment-free package, no part is added and both packaging parts are
    byte-identical.
- H2, TS (`shared/office-checkpoint.test.ts`):
  - A new test, `an edited DOCX without comments exports no comment parts and only well-formed
    XML`, exports `poc/fixtures/feature-rich.docx` with one edit. A helper,
    `expectWellFormedWithoutComments`, parses every `.xml`/`.rels` part with happy-dom's
    `DOMParser` and requires no `parsererror`. It also requires no `word/comments*` part and no
    `comments` in the content types or document rels.
  - The existing `deleting every DOCX comment clears source and reply parts ...` now uses the same
    helper. Before, it read the absent parts as empty strings and passed trivially.
  - Two notes on the helper. happy-dom rejects a valid single-quoted XML declaration
    (`<?xml version='1.0' ...?>`, used by `feature-rich.docx`), so the helper strips the declaration
    first. With that, every part of five source DOCX files parses. happy-dom comes in transitively
    through the react packages' `@happy-dom/global-registrator` (hoisted, `configVersion: 0`), not
    as a direct dependency.
- M1, TS: `rebases a later edit over comments whose source has no commentsIds or commentsExtended`
  (`packages/docx/src/yrs/rebaseCheckpoint.test.ts`). It uses
  `crates/betteroffice-docx/tests/corpus/fixtures/wordprocessingml-comprehensive.docx` and asserts
  the source has only `word/comments.xml`. After an edit following the capture, the rebase
  succeeds, the rebased state starts with the edit and keeps every comment. Without the fix it
  throws "DOCX rebase changed authored content or package-owned story metadata".
- M2, TS: `a DOCX state above the 64 MiB update cap loads and exports but is refused as one update`
  (`shared/docx-pptx-storage.test.ts`).
  - It inserts six 9 MiB data-URL images into `feature-rich.docx`, so the state is over 64 MiB.
  - `exportOffice`, which loads through `loadState`, succeeds and writes a 9 MiB media part.
  - A peer's `applyUpdate` of the same state throws an `Error` whose message contains
    `update exceeds 67108864 bytes`.
- M2, Rust: `a_stored_state_above_the_update_cap_opens_but_is_refused_as_one_update`
  (`crates/pptx-edit/tests/write_fidelity.rs`). Nine 8 MiB pictures push the state over the cap.
  `open_from_update_with_source` opens it, and a peer's `apply_update_v1` refuses it. With the
  load cap restored, it fails with `InvalidUpdate("update exceeds 67108864 bytes")`.

**Against the old engine.** The tests were copied into a `git clone --shared` at `e912e8e0` in
the session scratchpad, with its own WASM built. There, all four TS tests fail:

- the over-cap test fails with `invalid yrs update: update exceeds 67108864 bytes`, thrown as a
  bare string;
- both comment tests fail because `word/comments.xml` does not parse (it is 0 bytes);
- the M1 test fails with the rebase error.

The two Rust tests were checked the same way, by reverting only the fix.

## Checks at `1ca0968b`

Windows, Bun 1.3.3, stable toolchain 1.98.1, wasm-pack 0.15.0. For Bun, a copy of `python.exe`
named `python3.exe` was on PATH, as in `f3-merge.md`.

- **cargo test** (`-j 4 --no-fail-fast`): 1,889 passed, 0 failed, 1 ignored. It covered
  `betteroffice-xlsx`, `xlsx-wasm`, `betteroffice-xlsx-parse`, `xlsx-view-wasm`,
  `betteroffice-docx-parse`, `betteroffice-docx-edit`, `betteroffice-docx`, `docx-view-wasm`,
  `betteroffice-docx-layout`, `betteroffice-pptx-edit`, `betteroffice-pptx`, `pptx-wasm`,
  `pptx-view-wasm` and `betteroffice-pptx-render`.

  | Crate | Passed | Change from `f3-merge.md` |
  | --- | ---: | --- |
  | `betteroffice-xlsx` | 238 | +1, H1 |
  | `xlsx-parse` | 176 | |
  | `xlsx-wasm` | 22 | |
  | `docx-parse` | 233 | |
  | `docx-edit` | 342 (1 ignored) | |
  | `betteroffice-docx` | 28 | |
  | `docx-layout` | 413 | The two Windows snapshot failures from the fork's CLAUDE.md did not occur in this worktree (`core.autocrlf=false`). |
  | `pptx-edit` | 177 | +1, M2 |
  | `pptx-render` | 255 | |
  | `betteroffice-pptx` | 5 | |
- **`cargo test -p betteroffice-docx-edit --features wasm`**: 346 passed, 1 ignored.
- **`cargo fmt --all -- --check`**: clean.
- **clippy `--all-targets`**: my changes add no warnings.
  - `betteroffice-xlsx`, `docx-parse`, `docx-edit` and `pptx-edit` were linted, and `docx-parse`
    and `docx-edit` also with `--features wasm`.
  - The 10 warnings that show up are the old ones, in `authority.rs` (2), `stable.rs` (2 + the
    `and_then(Ok)`), `workbook.rs` (1), `xlsx-ops/remap.rs` (3) and `xlsx-parse/chart.rs` (1).
    The `stable.rs` ones sit 11 lines lower than before because of H1.
- **WASM**: `bun run build:docx-wasm` (its script builds `docx-edit` and `docx-parse` with
  `--features wasm,tiff`), `build:xlsx-wasm`, `build:pptx-wasm` and
  `bun scripts/build-office-checkpoint.ts` all pass. After the final build the generated `.d.ts`
  files equal the committed ones.

  | Module | Before (`f3-merge.md`) | Now |
  | --- | ---: | ---: |
  | DOCX editor | 9,993,380 | 9,993,239 |
  | DOCX viewer | 7,467,125 | 7,467,125 |
  | XLSX editor | 5,157,911 | 5,159,387 |
  | PPTX editor | 3,826,929 | 3,826,928 |
- **`tsc --noEmit` in `packages/docx`**: clean.
- **`bun run test:golden`**: shared 31 pass, 0 fail. XLSX `storage` 2 passed.
- **Bun, DOCX/PPTX/shared** (`bun test --isolate packages/docx packages/docx-i18n
  packages/docx-react packages/pptx packages/pptx-i18n packages/pptx-react shared`): 786 pass,
  1 fail. That is 3 new tests against `f3-merge.md`'s 783. The one failure also occurs at
  `e912e8e0`, where the same command in the baseline clone gives 783 pass and 1 fail with the
  identical error:

  ```
  packages\docx\src\yrs\residentEngineWorker.test.ts:
  52 |   startWorker = new Function(
       ^
  SyntaxError: import.meta is only valid inside modules.
  (fail) (unnamed) [31.00ms]
  ```
- **Bun, XLSX** (`packages/xlsx packages/xlsx-i18n packages/xlsx-react`): 249 pass, 1 skip, 0 fail.
- **`bun run test:poc`** (after `build:xlsx`, `build:docx`, `build:pptx`): passes.

  ```
  DOCX: open 1346.1 ms; no-op 226.72 ms; edit 146.03 ms; 4/19 parts changed on no-op
  XLSX: open 56.48 ms; no-op 19.63 ms; edit 21.73 ms; 4/13 parts changed on no-op; removed allowed inert part xl/sharedStrings.xml
  PPTX: open 63.39 ms; no-op 15.43 ms; edit 17.57 ms; 0/26 parts changed on no-op
  ```
  The DOCX no-op now changes 4 of 19 parts instead of 6: the comment-free round trip no longer
  adds comment overrides and relationships.
- **Not run**: the whole-workspace `cargo test`, `rust:check` (it still stops at the old clippy
  warnings), the Visio and other app suites, and the demo `check:seeds`. No seed changed (next
  section), so the demo seeds are unaffected.

## Golden hashes

No change. The XLSX `tests/storage.rs` and DOCX/PPTX `shared/docx-pptx-storage.test.ts` goldens
pass with their recorded hashes and budgets. None of the fixes touches seeding:

- H1 changes the order in which the state is read, not what the seed writes.
- H2 is export-only.
- M1 is the TS rebase check.
- M2 is the load path.

## PPTX and XLSX state caps

- **PPTX.** `crates/pptx-edit/src/lib.rs` has `MAX_UPDATE_BYTES = 64 MiB`, and both checks came
  from upstream (Elia, 2026-07-19, both in upstream `c0fa7262`).
  - Stored-state load cap: `open_from_update_with_source` (`9fe37ee8`). **Removed** (M2).
  - Per-update cap: `apply_update_v1` (`bb621c89`). Kept.
  - Hydrating the staged copy and the rebase run through `hydrate_doc`, which was never capped.
    `betteroffice-pptx`'s `MAX_COLLABORATION_BYTES` only re-exports the constant.
- **XLSX. Not changed; see question 1.**
  - `crates/betteroffice-xlsx/src/workbook.rs` sets `MAX_COLLABORATION_BYTES = 64 MiB` and caps
    the whole state on every path. All but the last of these checks are upstream (`a34e721b`,
    `148ba023`, Elia, July/August):

    | Line | What it caps |
    | ---: | --- |
    | 437 | The seed at `open_collaborative` |
    | 523, 528 | `encode_diff_v1`: the remote state vector and the diff it returns |
    | 541 | `apply_update_v1`: the incoming update |
    | 642 | `stage_remote_updates`: the resulting state (`validate_collaboration_state`) |
    | 2414, 2415 | `stage_local_update`: the local update and the resulting state |
    | 606 | The resulting state of a snapshot replacement |
    | 776 | The total of buffered out-of-order remote updates |
    | `workbook/rebase.rs:100` | The rebased state (fork, `4148d1c6`, 2026-09-14) |
  - XLSX has no separate load entry. A stored state is loaded by `openCollaborative` plus
    `applyUpdate`/`applyUpdateJson`, so the per-update check at 541 is also the load cap.

## Open questions for the developer

1. **XLSX cap alignment.**
   - Aligning XLSX "the same way" is not a small change. It needs a new load entry that skips the
     per-update check, added through the Rust facade, `xlsx-wasm`, its `.d.ts`,
     `shared/office-checkpoint.ts` and Capy's `exportCheckpoint.worker.ts`. It also means deleting
     upstream's whole-state checks at 437, 606, 642 and 2415 and the fork's at `rebase.rs:100`,
     and deciding what `encode_diff_v1` (528) may return.
   - Schema 8 keeps only overrides, and XLSX has no image insertion: 100 edits take about 17 KB
     and 10,000 edited cells about 1.3 MB, so 64 MiB is roughly half a million edited cells.
   - My recommendation is to leave XLSX on upstream's caps. The alternative is the new load path
     above. I did not choose either.
2. **The editor still meets the per-update cap on open (Capy side, C5).**
   - The DOCX editor loads `initialUpdate` through `loadState`, which is now uncapped.
   - On `collaboration-ready`, however, `src/features/files/useOfficeRuntime.ts:368-378` posts
     `Y.encodeStateAsUpdate(active.doc)`, the whole room, back as one `update`, and
     `src/office-runtime/main.tsx:233` applies it with `replica.applyUpdate`. That is remote
     intake, so for a DOCX or PPTX room above 64 MiB it throws and the editor cannot open.
   - Export, view with unpublished edits, effects, agent edits and the resident worker all go
     through `loadState` and are fixed.
   - Lazy fix: send only what the replica lacks,
     `Y.encodeStateAsUpdate(active.doc, Y.encodeStateVectorFromUpdate(new Uint8Array(message.bytes)))`,
     since `message.bytes` is the replica's own full state. I did not change it; it is outside this
     task's Capy scope.

## Other notes

- **What the CI step catches.** A deliberate seed change updates the golden hashes in the same
  fork commit, so the CI step passes. It only catches seeds that drift from their recorded
  goldens. The checklist covers the deliberate case: a golden hash that differs between the old
  and the new pin means a maintenance window.
- **Names added during a session still don't export.** `render_defined_names` writes only names
  the source has, as the review noted. H1 fixes the order but not this upstream limitation. A
  rebase re-adds such names as overrides, as before.
- L1 (XLSX agent inspect building the full projection) and the XLSX golden limitation are
  unchanged.

## Capy files changed (uncommitted)

- `.github/workflows/ci.yml`: in `frontend_check`, after `pnpm test:office` (the office build ran
  in `pnpm run build`'s `office:prepare`), a step `bun run test:golden` with
  `working-directory: vendor/betteroffice`.
- `openwiki/frontend/office-files.md`: one new paragraph, **Pin bump checklist**, at the end of
  "Repository boundary":
  - goldens must pass;
  - a golden hash changed between pins means a maintenance window;
  - until parser-tolerant binding lands, any change under `xlsx-parse`, `xlsx-model` or
    `betteroffice-xlsx` counts as seed-changing for XLSX.

  C5's uncommitted edits in that file were left alone; I re-read the file right before editing.
- `artifacts/2026-09-25-office-progress/fork-fixes.md`: this file.
- Not touched: `openwiki/test-catalog.md`, which should list the new fork tests with C5.
