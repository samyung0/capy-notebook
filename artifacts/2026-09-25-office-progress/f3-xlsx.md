# F3 XLSX storage (schema 8): done, pushed

Date: 2026-09-26. Plan items F3.1 and the XLSX part of F3.4 of
`artifacts/2026-09-25-office-implementation-plan.md`, on branch `capy/f3-xlsx` in the worktree
`C:\WEB\bo-f3-xlsx` (clone `C:\WEB\betteroffice-merge`), from `capy/upstream-merge` at
`d1a2972b`. HEAD `66483284`, pushed to `origin/capy/f3-xlsx`. Nothing merged into
`capy/upstream-merge`, `capy-ci` or `main`; `vendor/betteroffice` in Capy was not touched. The
DOCX and PPTX part of F3 is another agent's branch.

## Commits

| SHA | Step | Subject |
| --- | --- | --- |
| `af716e64` | 1 | feat(xlsx): store schema 8 cell overrides over the source |
| `b55c4499` | 2 | feat(xlsx): read pending effects off the overrides |
| `cb9d5122` | 3 | feat(xlsx): rebase publications as overrides over the export |
| `dc19d381` | 4 | fix(xlsx): keep preserved row, column and cell markup through live axes |
| `66483284` | 5 | test(xlsx): pin schema 8 seeds and state-size budgets |

## What each step does

- **Schema 8** (`authority.rs`, `authority/stable.rs`, `topology.rs`). The only accepted schema;
  the fingerprint domain moved to v8, so a schema 7 state is refused like any other. The seed
  writes the skeleton only. `contents` and `styles` hold overrides keyed by the stable identity:
  clearing a source cell writes `{"value":{"kind":"empty"},"formula":null}` (style `""`), writing
  the source's plain value or style removes the override, formula cells keep theirs (the
  prototype rule). The projection lays the parsed source (`WorkbookBase.sheets`) through the live
  axes (`Axis::index_in`) and then the overrides; source formulas bind once per session
  (`OnceLock`, shared by staged copies). A hidden source sheet still resolves its unedited
  formulas, so an opaque formula still refuses structural edits. Source binding unchanged. The
  array-formula stopgap now keys on "the anchor has no content override"; `ArrayAnchor` and
  `seeded_array_anchors` are gone. Tests: clear marker, revert, undo over a source cell,
  concurrent clear and set in both client orders, hidden-sheet validation (checked to fail
  without the validation).
- **Pending effects** (`stable::pending_effects`, `Workbook::pending_effects_json`,
  `XlsxDocument.pendingEffectsJson`, `xlsxPendingEffects` in `shared/office-checkpoint.ts` and
  `.d.ts`). One text effect per changed cell (id `{sheetKey}:{identity}` as today), one visual
  effect per formatting rectangle, one per row or column insert or delete (a delete lists the
  deleted cells' text as `before`), plus sheet add/remove/rename, one layout effect per sheet
  (merges, dimensions, chart anchors, freeze pane), one per changed hyperlink and defined name,
  all compared against the seed (its update bytes are kept in `WorkbookBase.bootstrap`). Sorted
  by id. Test with exact labels, then undo to an empty list.
- **Overrides rebase** (`workbook/rebase.rs`, `stable::rebase`). `rebase_checkpoint` now returns
  the state only. Captured and latest contexts give the post-capture sheet adds, removes and
  renames and, per sheet, the row and column deletions (captured positions no longer present,
  bottom up) and insertions (latest gaps, top down); positions only pushed off or added at the
  grid's end are left to the cell overrides. Merges, links, freeze panes, dimensions, defined
  names and chart anchors diff through the existing ops; every cell whose content or format
  still differs gets an override in one transaction. A fresh replica on the new source then
  applies the state and must reproduce the latest workbook (cells with formula caches aside,
  merges, links, freeze, dimensions, chart anchors, names); otherwise the call fails with
  `rebased checkpoint does not reproduce the latest workbook`. No edits after the capture
  returns the plain seed of the export. Deleted: `RebaseData`, the `xlsx:rebase` root and its
  validation, `restore_rebase`, `rebase_aliases`, the indexed alias projection
  (`checkpoint_sheet_ids`/`checkpoint_cell_identities`), `XlsxRebaseResult`, `Workbook.source_sha`.
  `rebaseOffice` returns `{state, baseline: [], effects: xlsxPendingEffects(...)}` for XLSX;
  `OFFICE_DOCUMENT_ROOTS.xlsx` no longer lists `xlsx:rebase`. Tests: post-capture row delete,
  interior row insert, column insert, rename, added sheet and edits (exact effect labels after
  the rebase, later structural edits, peer convergence), a second rebase over a rebased state,
  the WASM layer's one-effect check, a TS `rebaseOffice` test, and the verification failure.
- **Preserved markup** (`Workbook::save`, `stable::source_axes`, `xlsx_parse::AxisMap::from_runs`).
  Collaborative saves build each source sheet's `SheetAxes` from the live axes and move the
  package's shared-string provenance along them, so upstream's patcher keeps unmodeled row,
  column and cell markup and authored shared strings. The schema 7 markup stopgap is removed;
  the array-formula stopgap stays (its comment now says schema 8). Test: a peer's row insert
  keeps `spans`/`cm`/`vm`/row `extLst` markup shifted, and a row delete on `sample.xlsx` keeps
  `t="s"` cells. On `course-guide.xlsx` an edited export now keeps 1,300 shared-string cells and
  no inline strings (the README records inline strings for the old engine).
- **Golden seeds** (`tests/storage.rs`, fixtures under `tests/fixtures/storage/`): seed SHA-256
  and byte budget for `course-guide.xlsx` and `cells-1k/10k/100k.xlsx` (generated by a full run of
  `probes/storage/gen_files.py`, RNG 20260925), checked identical across two replicas, plus a
  budget for 100 edited cells.

## Results at `66483284`

Windows, Bun 1.3.3, stable toolchain 1.98.1.

- `cargo test -p betteroffice-xlsx -p xlsx-wasm -p betteroffice-xlsx-parse -p xlsx-view-wasm`:
  435 passed, 0 failed (lib 38, chart_render 21, date_system 1, print_render 10,
  proposal_review 4, schema_migration 1, stable_collaboration 20, storage 2, text_input 2,
  workbook 138, xlsx-parse 176, xlsx-wasm 22). `xlsx-ops`, `xlsx-model`, `xlsx-calc`,
  `xlsx-render`, `xlsx-raster`: all pass.
- `cargo fmt --all -- --check`: clean.
- clippy `--all-targets` on the touched crates: no new warnings. Remaining, all pre-existing:
  collapsible `if` in `authority.rs` (2), `stable.rs` (2), `workbook.rs` (1), `xlsx-parse/chart.rs`
  (1); `and_then(Ok)` in `stable.rs`; `unwrap` in an `xlsx-wasm` test. The 9-argument
  `write_cell` warning is now an explicit allow (10 arguments).
- `bun run build:xlsx-wasm`, `build:docx-wasm`, `build:pptx-wasm` and
  `bun scripts/build-office-checkpoint.ts`: pass. XLSX editor WASM 5,067,737 -> 5,157,911 bytes
  (+1.8%); viewer unchanged (820,915). Regenerated `xlsx_wasm.d.ts` committed.
- Bun `bun test --isolate shared packages/xlsx packages/xlsx-react packages/xlsx-i18n`: 268 pass,
  1 skip, 0 fail.
- Not run: `bun run test:poc`, DOCX/PPTX suites (other branch).
- Failures met on the way, all fixed before the commits: the legacy `unknown_schema_version`
  message test (now "9; supported versions are 3 through 8"), and the WASM test asserting that a
  rebased state cannot merge into an edited replica, which no longer holds (a rebased state is an
  ordinary update over the published source); that assertion was removed.

## Sizes against `xlsx-lazy-cells.md` (Q5)

Edited states for 8,991 and 10,000 cells were emulated (engine-format overrides on distinct
cells, as the report did); 100-edit states are real engine edits.

| Measure | Report | F3 | Difference |
| --- | ---: | ---: | ---: |
| cells-10k seed | 3,594 | 4,187 | +16.5% |
| cells-100k seed | 3,619 | 4,162 | +15.0% |
| cells-10k, 100 edits | 16,220 | 16,982 | +4.7% |
| cells-100k, 100 edits | 16,345 | 16,857 | +3.1% |
| cells-10k, 8,991 edited cells | 1,162,440 | 1,163,060 | +0.05% |
| cells-100k, 10,000 edited cells | 1,293,664 | 1,293,058 | -0.05% |
| First Edit open charged, cells-1k (source + seed) | 18.0 KiB | 18,828 B (18.4 KiB) | +2% |
| cells-10k | 91.2 KiB | 93,573 B (91.4 KiB) | +0.2% |
| cells-100k | 823.1 KiB | 840,584 B (820.9 KiB) | -0.3% |
| Effects for 100 edits | 25,652 (jsonb) | 24,187 (JSON text) | -5.7% |
| course-guide.xlsx seed (not in the report) | | 24,314 (source 145,425) | |

Only the two seed rows miss the 10% bar: about 590 bytes more per seed, mostly the formats
catalog (cells-10k: 7 entries, 2,811 bytes against the report's 2,418), whose `CellFormat` JSON
carries the merged upstream fields. Everything built on the seed is within 10%. Native release
timings on this shared machine: cells-100k open 1.07 s, one-cell commit about 130 ms, the
course-guide rebase with post-capture edits 1.67 s (23.6 s in a debug build).

## Choices to confirm

1. **Formula revert** (report design): retyping a source formula keeps its override; its effect
   is dropped because the text matches the source formula resolved on the live axes.
2. **Delete effects carry the deleted text** (report Q2 design): `before` holds the deleted
   cells' text, tab-separated per row or column and one line each; insert effects have none.
3. **Formatting ranges** are row-run rectangles over the style overrides regardless of the target
   format, so bold A1:A10 and italic B1:B10 read as one effect `A1:B10 formatting`.
4. **Effect values keep today's shape** (`{"kind":"number","value":20.0}`, formulas `=text`);
   `before` for a formula cell is the source text as authored.
5. **Sheet-level effects**: one layout visual per sheet (merges, dimensions, chart anchors, freeze
   pane), one text effect per changed hyperlink and defined name, compared with the seed records.
6. **Rebase failure cases**: a publication fails explicitly when the latest state shows what
   overrides cannot carry. The concrete one: a sheet with a chart removed before the capture and
   restored by Undo after it (the old `rebase_restores_deleted_chart_and_image_parts_from_saved_undo`
   now asserts that failure). With the parts overlay this used to succeed.
7. **Rebase alignment** leaves positions pushed off or appended at the grid's end to cell
   overrides, and a post-capture rename that swaps two names would fail the publication.
8. **Memory**: the parsed source sheets are cloned once per session into `WorkbookBase` instead of
   sharing one `Arc` with `PreservedPackage` (the report's production note). Upgrade path: make
   `PreservedPackage.original_workbook` an `Arc` and hand its sheets to the base.
9. **Legacy schemas 3-6** (upstream's standalone path, never reachable from a collaborative
   session) were left in place; only schema 7 handling was removed.
10. `officeBaseline`/`compare` still accept XLSX (projection entries) until C5 moves Capy to
    `xlsxPendingEffects`.

## Next steps

- Reviewer run on `capy/f3-xlsx` (the `human` skill loop).
- Merge with the DOCX/PPTX F3 branch into `capy/upstream-merge` without rebasing. Likely overlap
  in `shared/office-checkpoint.ts`: the roots comment and `rebaseOffice`, where the XLSX branch
  now returns early and the PPTX call reads `PptxDocument.rebaseCheckpoint(...)` instead of the
  shared `engine` ternary.
- C5: `SourceDocumentStore.effects` calls `xlsxPendingEffects` for XLSX (C5.7); XLSX stores no
  baseline (`rebaseOffice` returns `[]`); enforce the new `OFFICE_DOCUMENT_ROOTS.xlsx`; the XLSX
  seed changed (golden hashes in `tests/storage.rs`), so the window resets XLSX states.
- Developer: record 21 in `human/frontend/office-files.md` still describes the markup stopgap,
  which is gone; the array-formula stopgap remains. `openwiki/frontend/office-files.md` lines
  365-366 still describe the `xlsx:rebase` root (C5/C6 docs).
- Optional later: formats catalog from the source (about 456 bytes per source format) would bring
  the seeds back under the report's numbers.
