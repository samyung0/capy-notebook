# Review of the BetterOffice fork branch `capy/upstream-merge` (b8ee465c)

Date: 2026-09-26. Adversarial review of the fork-owned work on `capy/upstream-merge` before it is merged into `capy-ci`: the conflict resolutions in merge `5dadfabf` (against `origin/capy-ci` `dfa3f05e` and upstream `c0fa7262`) and every first-parent commit after it (F1 follow-ups, F2, the two F3 branches and their merges, the demo seeds). I checked it against records 10, 13-18 and 21 of `human/frontend/office-files.md`, the replace_text record in `human/agentic-retrieval.md`, plan sections F1-F3, the progress notes `f1.md`, `f2.md`, `f3-xlsx.md`, `f3-docx.md`, `f3-merge.md`, and the handoff review with its keep tables.

I changed nothing in `C:\WEB\betteroffice-merge` (still clean at `b8ee465c`) or in Capy apart from this file. All experiments ran in a `git clone --shared` of the clone in the session scratchpad, with a second scratch worktree at `dfa3f05e` to tell regressions from old behaviour. No containers were started.

## What was run

| Check | Result |
| --- | --- |
| WASM builds (`build:xlsx-wasm`, `build:pptx-wasm`, `build:docx-wasm`, checkpoint bundle) | Pass. Generated `.d.ts` unchanged. |
| `bun test --isolate shared` | 29 pass, 0 fail (goldens included). |
| `cargo test --release -p betteroffice-xlsx --test storage --test stable_collaboration` | 22 pass. |
| X1: XLSX rebase over 11 workbooks, with and without a post-capture row insert | All succeed, one override each; see below. |
| X2: XLSX model round trip through a collaborative export, 12 workbooks, with and without a row insert and a column delete | Everything round-trips except defined names (H1). |
| X3: XLSX concurrency matrix (clear, revert, undo, insert, delete against a concurrent set) | Converges every time. |
| X4: XLSX timings, native release and WASM under Node 22, at HEAD and at `dfa3f05e` | See L1. |
| D1: DOCX export census and publication round, 14 files | One rebase failure (M1); every export of a comment-free file carries a 0-byte `comments.xml` (H2). |
| D2: DOCX rebase after comment, hyperlink, Heading3, bold, table and section-break edits, 3 files | All succeed. |
| D3: seed determinism, 14 DOCX and 6 PPTX files, twice per process and across two processes seeding in opposite orders | Byte-identical everywhere. |
| D4: DOCX state above 64 MiB | Unloadable (M2). |
| P1: PPTX publication round, 12 decks | All rebases succeed; rebased export equals the latest export on disk. |
| Namespace-aware parse (Python ElementTree) of every XML part of 27 DOCX, 7 XLSX and 6 PPTX exports | Only the empty `word/comments.xml` fails. |

## Findings, ranked

### H1. High: a collaborative XLSX export drops defined names whenever the source does not list them in the engine's sort order

`crates/betteroffice-xlsx/src/authority/stable.rs:1316-1319`, `crates/xlsx-parse/src/write.rs:2086-2131`, `crates/betteroffice-xlsx/src/workbook/rebase.rs:17-60,104`.

**Defect.** Schema 8 `materialize` sorts `model.defined_names` by `(local sheet, name)` with byte ordering, so every sheet-local name goes after every global one and uppercase sorts before lowercase. The workbook.xml patcher `render_defined_names` walks the source `<definedName>` elements in source order and advances through the model's names with a `peek`. When the next model name is not the current source entry, it skips the source entry, and a skipped entry is not written. Names the source template never had are never written either.

**Evidence.** `packages/xlsx/test-fixtures/defined-names.xlsx`, one cell edited in a collaborative session, then `save()`: 2 of 5 names survive (`Header`, `Picked`; `Rows`, `Spilled`, `Spaced` are gone). A standalone save of the same edit keeps all 5, and a collaborative save with no edit copies workbook.xml verbatim. A workbook built from `sample.xlsx` with Excel's usual order (`_xlnm._FilterDatabase` and `_xlnm.Print_Area` local to sheet 0, then the globals `Rate` and `taxRate`) loses both `_xlnm` names. `dfa3f05e` gives the same two outputs, so UAT publishes this damage today. In X2 everything else round-trips on 12 workbooks: cells with formula text, values and resolved formats, merges, links, freeze panes, dimensions, chart anchors, column styles, array ranges and tables.

**Failure scenario.** An owner uploads a grade sheet with a print area, an autofilter and a named rate, and types into one cell. The next publication replaces the file's bytes with an export that has no print area or filter database. Any formula that uses a dropped name shows `#NAME?` in Excel, and the index is rebuilt from that export. The F3 rebase verification passes, because it compares model projections, which still hold the names, and never the export. The rebased state then carries the names as pending "add" effects (3 on `defined-names.xlsx`), and every later export drops them again, so those effects never clear.

**Lazy fix.** In `materialize`, order names by their index in `base.defined_names` (the source order), with names the source lacks after them in the current sort. That is as deterministic as the sort and lets the patcher pair entries. Alternatively pair by `(name, local_sheet)` in `render_defined_names`. Test: a collaborative export after one edit re-opens with every source name, on `defined-names.xlsx` and on an Excel-ordered fixture.

### H2. High: every DOCX export of a document without comments writes a 0-byte `word/comments.xml`

`packages/docx/src/yrs/yrsToDocument.ts:2436`, `crates/docx-parse/src/serializer/s13.rs:485-523` (write at 494), `crates/docx-parse/src/serializer/parts.rs:300-302`, test `s13.rs:2547`.

**Defect.** The projection always passes `comments: context.projectedComments`, which is `[]` for a document without comments. The fork's clearing block in `serialize_comment_parts` then calls `serialize_comments_with_info([])`, which returns an empty string, and writes it as `word/comments.xml`. It also writes the three companion parts and `ensure_comment_parts` adds four relationships and four content-type overrides. Upstream's version of the function returned early for an empty list. The handoff asked to keep the fork's clearing, so the merge resolution did, and nobody noticed that the part it writes is empty. A document whose comments were all deleted gets the same empty part.

**Evidence.** In D1, all 13 comment-free fixtures export `word/comments.xml` with 0 bytes (ElementTree: "no element found"), plus `commentsExtended.xml`, `commentsIds.xml`, `commentsExtensible.xml` and relationships `rId12`-`rId15` on `feature-rich.docx`. The same export at `dfa3f05e` also has a 0-byte part, so this is live. The fork's test `empty_comment_projection_clears_original_thread_parts` only asserts that the old comment text is absent, which an empty part satisfies.

**Failure scenario.** A student edits a DOCX in Capy and downloads it after publication. Word will very likely report unreadable content and offer to repair the file, because a referenced part is not well-formed XML. I could not verify this in Word here; LibreOffice and the fork's own parser accept the file.

**Lazy fix.** When the list is empty: if the source package has no `word/comments.xml`, return as upstream did; if it has one, write `{XML_DECLARATION}<w:comments {FULL_NAMESPACES}/>` instead of an empty string. Add one assertion to the export tests that every XML part of the output parses.

### M1. Medium: a DOCX publication with later edits fails when the source's comments lack `commentsIds`/`commentsExtended`

`packages/docx/src/yrs/rebaseCheckpoint.ts:141-177` (replacer at 169), throw at 288.

**Defect.** `authored()` ignores `rId`, `verbatimXml` and `customRootBindings`, but not the comment `paraId` and `durableId` that the export generates. When the source has only `comments.xml`, the first export adds the companion parts, the projection over the export picks up the new ids, and the authored comparison fails.

**Evidence.** `crates/betteroffice-docx/tests/corpus/fixtures/wordprocessingml-comprehensive.docx`: `rebaseOffice` throws "DOCX rebase changed authored content or package-owned story metadata". The first difference is at the first comment, where the "after" side has `"durableId":"6570F69D"` and `"paraId":"1C0FE129"`. `dfa3f05e` fails the same way on `paraId`. The other 13 D1 files rebase, and so do the six edit kinds in D2.

**Failure scenario.** Comments written by LibreOffice, older Word versions or generators come without these parts. The first publication of such a file fails whenever someone types during the capture, and it only goes through on a capture with no later edits. After that first publication the export carries the parts and later rebases pass.

**Lazy fix.** In the replacer, also drop `paraId` and `durableId` inside `comments`, the same treatment `rId` gets.

### M2. Medium: F2.6 caps the whole stored DOCX state at 64 MiB, but Capy accepts source rooms up to 100 MiB

`crates/docx-edit/src/lib.rs:119,782-789`, `crates/docx-edit/src/wasm.rs:1640` (`load`), Capy `collaboration/src/sourceDocuments.ts:43`.

**Defect.** `decode_update_v1` now guards `EditingDoc::apply_update_v1`, and that is also how a stored state is loaded (`EditSession::load`, `loadState`). Any DOCX state over 64 MiB can no longer be opened by the engine, while the service keeps accepting updates until 100 MiB. The error reaches JS as a bare string, so `error.message` is `undefined`.

**Evidence.** `lesson.docx` plus six inserted 8 MB images, which stay as data URLs until the next publication by record 18: state 67,117,648 bytes, and `exportOffice` fails with "invalid yrs update: update exceeds 67108864 bytes". Before F2.6 this state loaded.

**Failure scenario.** A student pastes a handful of phone photos into a DOCX. The room still accepts edits, but every save's effects computation, the publication export, view with unpublished edits, agent edits and reopening the editor fail from then on. PPTX and XLSX have the same 64 MiB against 100 MiB gap today.

**Lazy fix.** Export each engine's state cap from the checkpoint bundle next to `OFFICE_DOCUMENT_ROOTS` and have C5 refuse a source-room update that would push the state past it. The smaller alternative is to cap only incremental remote updates in DOCX and leave `load` unbounded.

### M3. Medium: the golden seed and size tests gate nothing, and for XLSX they cannot decide

`package.json:43`, `.github/workflows/ci.yml:3-6,127-154`, `shared/docx-pptx-storage.test.ts:226-251`, `crates/betteroffice-xlsx/tests/storage.rs`.

**Defect.** The fork's `test` script runs `bun test` over `packages`, `apps/...`, `scripts` and `e2e`, never `shared/`, so the DOCX and PPTX goldens and `shared/office-checkpoint.test.ts` run only by hand. CI runs on pull requests and on pushes to `main`, not on `capy-ci`. Its Rust gate runs `cargo clippy -- -D warnings` before `cargo test`, and clippy fails on the 11 older warnings, so `tests/storage.rs` never runs there either. Capy's scripts do not run fork tests. The only seed check that CI runs is `check:seeds` on three demo files. Separately, an XLSX room is bound to a fingerprint of the whole parse of the user's file, so goldens on four workbooks cannot show that a parser change leaves other files' seeds alone. DOCX has four golden files and PPTX two.

**Failure scenario.** A later pin bump changes parse output for a feature the golden files lack. Nobody runs the goldens, or they pass, so record 23's window is skipped. XLSX rooms of affected files stop opening on a fingerprint mismatch, and PPTX saves rebuild unedited paragraphs against the new baseline (review 1.3).

**Lazy fix.** Add `shared` to the `test` script or a `test:golden` script, and put it together with `cargo test -p betteroffice-xlsx --test storage` in the C5 pin-bump checklist. Fix or allow the 11 clippy warnings so CI reaches `cargo test`. Until parser-tolerant binding lands, treat any change under `xlsx-parse`, `xlsx-model` or `betteroffice-xlsx` as seed-changing for XLSX.

### L1. Low, known and deferred: XLSX agent inspect and `set_cell` build the full checkpoint projection up to three times per call

`shared/office-checkpoint.ts:961,975,1003,1024`, `crates/xlsx-wasm/src/core.rs:417-445`.

The plan lists this cost under "Not in this round". I measured it because it is worse than the handoff's numbers suggest. Under Node 22, `checkpointProjectionJson` takes 1.4 s on cells-10k, 27.6 s on the rich-content `course-guide.xlsx` (25 MB of JSON) and 104 s on cells-100k (49 MB). At `dfa3f05e` the same calls take 0.9 s, 25.2 s and 78.6 s. Natively it is 3.6 s at 100k, so the WASM path is about 30 times slower. One agent `set_cell` on course-guide therefore takes over a minute, beyond the 20 s API collaboration timeout, and at 100k cells it passes the two-minute worker timeout. Everything else got faster: at 100k, open is 2.5 s against 7.9 s, a cell edit 0.3 s against 4.4 s, and `pendingEffectsJson` takes 4 ms. Lazy fix: get the sheet from `sheetInfoJson` and the target from `cellJson` plus a one-cell identity export instead of a projection. C5.3 must not derive XLSX baselines through `officeBaseline`, or every save pays this cost.

For scale, the XLSX publication rebase takes 6.7 s natively at 100k cells (10.1 s with a row insert), with a 517 MB process peak, and 14 s under WASM. That is inside the timeout and cheaper than the old overlay path.

### L2. Low: tests that claim more than they check

- `stable_collaboration.rs` `a_concurrent_clear_and_set_of_a_source_cell_resolve_by_client_order` asserts only the clearing replica's value. X3 shows that both replicas converge, so this is a gap in the test, not a bug.
- The F3 XLSX verification (`workbook/rebase.rs:104`) and its failure test never exercise the export. H1 slips past it.
- The DOCX size-cap test sends a zero-filled buffer to remote and local apply. It does not cover `load`, which is where the cap hurts (M2).
- `empty_comment_projection_clears_original_thread_parts`, see H2.

## Checked and holding

- **XLSX overrides and rebase.** Over 11 workbooks, each X1 rebase wrote exactly one content override and no style override, with 1 pending effect (2 with the row insert). The only exception is `defined-names.xlsx`, which gets the extra name effects from H1. Nothing was spuriously overridden, including formulas re-rendered after a structural edit.
- **XLSX convergence.** Clear against set resolves by client order in both orders. A revert-to-source against a set lets the set win in both orders. Clear then undo against a set, a row insert above against a clear, and a row delete against a set followed by undo all converge.
- **XLSX sheet names.** The engine refuses names that would not survive the export (`/`, `:`, `[ ]`, quotes, over 31 characters), so a rename cannot block a rebase.
- **DOCX raw XML and media references.** No part, relationship id or media byte is lost on 14 files. The counts of `w:object`, `w:pict`, `mc:AlternateContent`, `w:drawing`, `c:chart`, `w:txbxContent`, `o:OLEObject`, `v:imagedata`, fields, bookmarks, SDTs and note and comment references stay the same, and after a publication the rebased export matches the latest export on every count. `sourceXml` is dropped only through `set_embed_entry` on a real payload change, and undo restores it with the payload.
- **Seeds.** DOCX seeds under client 0 and PPTX seeds are byte-identical across process histories, so no hash-map order leaks into them. DOCX baseline object ids are all on client 0.
- **PPTX.** On 12 decks with comments, connectors, tables, alternate content and hidden shapes, every rebase succeeded and the rebased state exports the same parts as the latest state (checked on disk). Remote updates are validated on a staged copy of the whole state (`crates/pptx-edit/src/lib.rs:243-267`), which is the only intake path. A write under a new root, or to `pptx:meta` other than `commentFlavor`, cannot hide behind another client's missing dependency; a pending struct can only get its own author's later updates rejected. `OFFICE_DOCUMENT_ROOTS` matches every root the three engines create.
- **replace_text.** `changedSpan` keeps surrogate pairs whole at both ends. The DOCX path refuses tracked insertions and embeds. The PPTX offsets line up because a PPTX story holds only text and pilcrows.

## Merge resolutions against the keep tables

Every row I checked is present at HEAD. DOCX: the viewer registers fonts; s13 is upstream plus the rebind, which now also processes data-URL images that carry a temporary `rId`; the `display_form` TIFF comparison; the projection-cache bypass and the `ownerParaId === segment.paraId` guard (`c8ea7d62`); the fork's Yjs comments with no React sync in `handleSave`; upstream undo and crash recovery. PPTX: one schema (5.0); no `packageJson` or media in Yjs; the strict open with the source; upstream `baseline_snapshot` in the viewer; diff transfer plus `validated_snapshot` and the `pptx:meta` rule; one-phase seed; the typing-style guard comparing every key; upstream comments, with `commentFlavor` allowed. XLSX: schema 7 then 8; `Arc` base; local decoder; gap detection; owned-parts viewer parse; strict fingerprint without column-style hashing past schema 6; active-sheet mapping plus rezip; the `XlsxEditor` save API with `flush` as settle-or-throw.

The dropped tests are either upstream migration and source-free-open tests (record 10), tests upstream renamed (`5069ad24`), or fork overlay tests that F3 replaced. The two things the merge kept that it should not have are the empty comments part (H2) and, carried over from `capy-ci`, the name sort (H1).

## Open questions

1. What Word does with a 0-byte `comments.xml`. I expect a repair prompt, but that needs a real Word run.
2. How many UAT workbooks list their names in an order other than the engine's. Any workbook with a print area or an autofilter plus one global name qualifies, so I expect many; a count would size H1.
3. The XLSX branch of `rebaseOffice` returns `baseline: []`. If the pin landed before C5.7, the service would compare later saves against an empty baseline and report every cell as added. The plan ships both together; worth a guard.
4. In 2 of about 20 PPTX probe runs, in-process part comparisons disagreed for untouched binary parts while the same exports were byte-identical on disk. I could not reproduce it in isolation and believe it was my harness, but I am noting it.

## Recommendation

Fix H1, H2 and M1 on this branch before it goes into `capy-ci`. Each is a few lines, and all three already hurt UAT publications from `dfa3f05e`. The window's publish-all will run on the old pin, so the window's own publications carry H1 and H2 regardless of this branch. That is probably acceptable for UAT data; production would need the fix on the old pin first. M2 needs a C5 decision on which cap wins. M3 should be settled before the window, because the reset chooses formats by the goldens. L1 can wait as planned, provided C5 keeps XLSX baselines off the save path.
