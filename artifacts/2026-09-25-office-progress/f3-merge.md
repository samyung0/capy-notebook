# F3 merge: both F3 branches merged into `capy/upstream-merge`, checked, pushed

Date: 2026-09-26. Clone `C:\WEB\betteroffice-merge`, branch `capy/upstream-merge`, from
`d1a2972b`. HEAD `b8ee465c8d989ec615df2c5abcaa52aa59de9bc0`, pushed to
`origin/capy/upstream-merge` (fast-forward from `d1a2972b`). Nothing pushed to `capy-ci` or
`main`, no rebase, and `vendor/betteroffice` in Capy was not touched. The worktrees
`C:\WEB\bo-f3-xlsx` and `C:\WEB\bo-f3-docx` are removed. The local branches `capy/f3-xlsx`
and `capy/f3-docx` are still in the clone, identical to their origin copies and fully merged.

## Commits

| SHA | Subject |
| --- | --- |
| `f28c6c50` | Merge capy/f3-xlsx into capy/upstream-merge (`--no-ff`, second parent `66483284`) |
| `b70c16ea` | Merge capy/f3-docx into capy/upstream-merge (`--no-ff`, second parent `ce3ff6d2`) |
| `b8ee465c` | chore(demo): regenerate the DOCX, PPTX and XLSX collaboration seeds |

No fix commits were needed: nothing failed because of the merge.

## Conflicts

There were no textual conflicts. Git merged both branches cleanly. I checked the two expected
overlaps by hand:

- `shared/office-checkpoint.ts` is the only file both branches changed. The merged diff against
  `d1a2972b` is exactly the union of the two sides (47 changed lines from XLSX, 20 from DOCX,
  67 in the merge). XLSX side: the roots comment without `xlsx:rebase`, `OFFICE_DOCUMENT_ROOTS.xlsx`
  without `xlsx:rebase`, `Session.effects`, the XLSX `effects` in `open`, the early XLSX return in
  `rebaseOffice`, the PPTX-only `rebaseCheckpoint` call and `xlsxPendingEffects`. DOCX side:
  `docxImageAsset`, the `media` parameter of `docxEntries` and its call with `base.package.media`.
  The hunks are far apart and none depends on the other.
- `poc/fixtures/README.md` was only changed by the DOCX branch (the XLSX fixtures live under
  `crates/betteroffice-xlsx/tests/fixtures/storage/`), so there was nothing to reconcile.

Generated files: the three per-format WASM builds and the checkpoint bundle at the merged HEAD
produce `.d.ts` files identical to the committed ones, so nothing needed regenerating.

## Demo seeds

`apps/demo/scripts/build-collaboration-seeds.ts` (`bun run build:seeds` in `apps/demo`),
run after building all four WASM bundles (the script also seeds VSDX):

| Seed | Before | After |
| --- | ---: | ---: |
| `docx.bin` | 58,616 | 40,355 |
| `pptx.bin` | 165,546 | 80,515 |
| `xlsx.bin` | 232,654 | 9,719 |

Two runs gave byte-identical output. The script also rewrote `vsdx.bin` with different bytes
even though neither F3 branch touched VSDX. The committed VSDX seed still passes the check
("different bytes, equivalent state"), so I left it unchanged and committed only the three
affected seeds. `bun run check:seeds` at HEAD:

```
DOCX seed: byte-identical, 18 stories
XLSX seed: byte-identical, 3 sheets
PPTX seed: byte-identical, 3 slides
VSDX seed: different bytes, equivalent state, 2 pages
```

## Results at `b70c16ea` / `b8ee465c`

Windows, Bun 1.3.3, stable toolchain 1.98.1, wasm-pack 0.15.0. For Bun, a copy of
`python.exe` named `python3.exe` was on PATH (the Windows Store stub cannot run
`fidelitySave.test.ts`).

- **cargo test, whole workspace** (`cargo test --workspace --no-fail-fast -j 4`, all 41 crates,
  Visio and redaction included): 4,057 passed, 0 failed, 2 ignored (221 test targets). Totals
  for the crates Capy uses: `betteroffice-xlsx` 237, `xlsx-parse` 176, `xlsx-wasm` 22,
  `xlsx-calc` 272 (1 ignored), `xlsx-ops` 114, `xlsx-model` 73, `xlsx-render` 70,
  `xlsx-raster` 11, `docx-edit` 342 (1 ignored), `docx-parse` 233, `docx-layout` 413,
  `docx-raster` 65, `betteroffice-docx` 28, `pptx-edit` 176, `pptx-parse` 133,
  `pptx-render` 255, `pptx-raster` 48, `betteroffice-pptx` 5, `drawingml` 210, `ooxml-text` 197,
  `opc` 38, `ooxml-fidelity` 79.
- **`cargo test -p betteroffice-docx-edit --features wasm`**: 346 passed, 0 failed, 1 ignored.
- **Golden seed and size-budget tests**: XLSX `tests/storage.rs` 2/2 pass
  (`seeds_are_golden_deterministic_and_within_budget`, `a_hundred_edited_cells_stay_within_budget`).
  DOCX/PPTX `shared/docx-pptx-storage.test.ts` 10/10 pass.
- **`rust:check` parts**: `cargo fmt --all -- --check` is clean. `cargo clippy --all-targets`
  gives 11 warnings at HEAD and 13 at `origin/capy-ci` (`dfa3f05e`, temporary worktree, same
  toolchain). All 11 at HEAD are the same fork code as on `capy-ci`, at shifted lines:
  collapsible `if` in `betteroffice-xlsx` `authority.rs` (2), `authority/stable.rs` (2),
  `workbook.rs` (1), `xlsx-ops/remap.rs` (3), `xlsx-parse/chart.rs` (1); `and_then(Ok)` in
  `stable.rs`; `unwrap` in `xlsx-wasm/src/core.rs`. The two `capy-ci` warnings that are gone are
  a collapsible `if` in `stable.rs` (code removed by F3) and the 9-argument function (now an
  explicit allow). The merge adds none. `rust:check` itself still stops at
  `clippy -D warnings` on these 11 old warnings.
- **Builds**: `build:docx-wasm`, `build:xlsx-wasm`, `build:pptx-wasm`, `build:vsdx-wasm` and
  `bun scripts/build-office-checkpoint.ts` pass. `build:xlsx`, `build:docx` and `build:pptx`
  (packages) pass.
- **`bun run test:poc`**: passes.

  ```
  DOCX: open 2388.21 ms; no-op 233.8 ms; edit 159.88 ms; 6/19 parts changed on no-op
  XLSX: open 59.53 ms; no-op 22.59 ms; edit 17.53 ms; 4/13 parts changed on no-op; removed allowed inert part xl/sharedStrings.xml
  PPTX: open 72.59 ms; no-op 17.12 ms; edit 20.29 ms; 0/26 parts changed on no-op
  ```
- **Bun, DOCX/PPTX/shared** (`bun test --isolate packages/docx packages/docx-i18n
  packages/docx-react packages/pptx packages/pptx-i18n packages/pptx-react shared`): 783 pass,
  1 fail. The one failure is the Windows-only upstream failure listed in `f1.md`, `f2.md` and
  `f3-docx.md`:

  ```
  packages\docx\src\yrs\residentEngineWorker.test.ts:
  52 |   startWorker = new Function(
       ^
  SyntaxError: import.meta is only valid inside modules.
  (fail) (unnamed) [78.00ms]
  ```
- **Bun, XLSX** (`packages/xlsx packages/xlsx-i18n packages/xlsx-react`): 249 pass, 1 skip,
  0 fail.
- **Bun, the rest without Visio** (`packages/fonts packages/fonts-cjk apps/web/app apps/web/lib
  apps/demo/lib apps/fidelity/src scripts e2e`): 314 pass, 117 skip, 19 fail. All 19 are the
  Windows-only failures `f1.md` lists, in files neither F3 branch touched:
  `scripts/python-bindings.test.ts` (7), `scripts/office-quality/renderer.test.ts` (6),
  `scripts/office-quality/merge.test.ts` (3), `scripts/office-quality/workflow.test.ts` (1),
  `packages/fonts/src/cdn.test.ts` (2). Examples:

  ```
  error: BadPathName: failed to open root directory: /C:/WEB/betteroffice-merge/packages/fonts/src
        at <anonymous> (C:\WEB\betteroffice-merge\packages\fonts\src\cdn.test.ts:99:29)

  Expected to contain: "C:\\Users\\yungc\\AppData\\Local\\Temp\\office-quality-renderer-EC8KrG\\commit\\index.js"
  Received: "export * from \"/@fs/C:/Users/yungc/AppData/Local/Temp/office-quality-renderer-EC8KrG/commit/index.js\";"
        at <anonymous> (C:\WEB\betteroffice-merge\scripts\office-quality\renderer.test.ts:55:32)

  TypeError: undefined is not an object (evaluating 'Object.keys(publish.on)')
        at <anonymous> (C:\WEB\betteroffice-merge\scripts\python-bindings.test.ts:241:19)

  TypeError: undefined is not an object (evaluating 'workflow.on.workflow_dispatch')
        at <anonymous> (C:\WEB\betteroffice-merge\scripts\office-quality\workflow.test.ts:14:19)
  ```
- **Native-viewer test** (`apps/native-viewer/tests/native_typescript_collaboration.test.ts`):
  not run, because the native viewer does not compile (`cargo build --manifest-path
  apps/native-viewer/Cargo.toml`):

  ```
  error[E0282]: type annotations needed
     --> src\xlsx_editing.rs:103:80
  103 |         let viewport = viewport_for_used_range_within(workbook.sheet(sheet)?, |viewport| {
  error[E0308]: mismatched types
     --> src\xlsx_scene.rs:108:77
  108 |             let line = PreparedLine::new(*x1, *y1, *x2, *y2, *width, color, style)?;
      |   expected `&Option<String>`, found `&Option<Arc<str>>`
  ```

  The merge did not cause this: `apps/native-viewer`, `crates/xlsx-render` and
  `crates/xlsx-raster` at HEAD are byte-identical to upstream `c0fa7262`. Upstream's viewer
  still calls the two-argument `viewport_for_used_range_within`, but the function now takes a
  stylesheet as well. The viewer has its own Cargo workspace, and only the macOS workflow builds
  it, so upstream CI does not catch this. I did not fix it. The seed loads the test performs
  (DOCX `loadState`, XLSX `applyUpdate`, PPTX `initialUpdate` against the demo files) are the
  same ones `check:seeds` performs, and those pass. The build rewrote
  `apps/native-viewer/Cargo.lock`; I reverted that.

## Developer decision carried

Record 14, confirmed for this merge: the shared DOCX serializer keeps replaying the authored XML
of unedited OLE objects and AlternateContent text boxes for upstream's own `Document::save`
path as well, not only for Capy's Yjs export. There is no Capy-only flag. Upstream's
`saving_keeps_shape_text_box_bodies_and_character_unit_indents` keeps its adjusted assertion
(three `w:txbxContent`, the VML fallback kept) and passes at HEAD.

## WASM sizes (bytes), `origin/capy-ci` (`dfa3f05e`) against the merged HEAD

Both sides were built on this machine with the same scripts.

| Module | `capy-ci` | HEAD | Change |
| --- | ---: | ---: | ---: |
| DOCX editor (`docx_edit`) | 8,923,417 | 9,993,380 | +1,069,963 (+12.0%) |
| DOCX viewer (`docx_view_wasm`) | 6,775,986 | 7,467,125 | +691,139 (+10.2%) |
| XLSX editor (`xlsx_wasm`) | 4,573,822 | 5,157,911 | +584,089 (+12.8%) |
| XLSX viewer (`xlsx_view_wasm`) | 730,815 | 820,915 | +90,100 (+12.3%) |
| PPTX editor (`pptx_wasm`) | 2,863,031 | 3,826,929 | +963,898 (+33.7%) |
| PPTX viewer (`pptx_view_wasm`) | 1,409,841 | 2,114,762 | +704,921 (+50.0%) |

Viewer share of the editor: DOCX 75.9% to 74.7%, XLSX 16.0% to 15.9%, PPTX 49.2% to 55.3%.
Other DOCX cores: layout 3,678,011 to 3,997,170, parse 4,142,854 to 4,542,683, opc 401,056
to 351,985. Brotli (from `test:poc`): editor/viewer DOCX 2,324,639 / 1,880,563, XLSX 1,466,373 /
293,754, PPTX 1,122,487 / 703,306.

Almost all of the growth came with the F1 upstream merge (see `f1.md`). Against `d1a2972b`
(`f2.md`), F3 adds: DOCX editor +15,604 and viewer +11,564, XLSX editor +90,174 with the viewer
unchanged, PPTX editor -267 with the viewer unchanged.

## For the developer

- `capy/upstream-merge` now holds F1, F2 and both F3 branches. Next comes the review, then the
  merge into `capy-ci` without rebasing, then the pin bump in C5. The fork's `main`
  fast-forward to `c0fa7262` (`f1.md`) still waits for your go-ahead.
- The native viewer does not build on upstream `c0fa7262`, as described above. Either leave it
  to upstream or fix it in a separate fork commit; Capy does not use it.
- `rust:check` fails at `clippy -D warnings` on 11 fork warnings that predate this work (13 on
  `capy-ci`).
- The demo VSDX seed rebuilds with different bytes but still passes the equivalence check. I
  left it as is.
- The seeds of all three formats differ from the old pin, so C5 and the window reset cover
  DOCX, XLSX and PPTX. The golden hashes in `crates/betteroffice-xlsx/tests/storage.rs` and
  `shared/docx-pptx-storage.test.ts` decide future windows.
- The open items from `f3-xlsx.md` and `f3-docx.md` are unchanged: their "choices to confirm",
  the C5 items (`xlsxPendingEffects`, NULL baselines and states, `OFFICE_DOCUMENT_ROOTS`
  without `xlsx:rebase`) and the test-catalog entries.
