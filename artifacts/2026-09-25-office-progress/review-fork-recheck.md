# Recheck of the fork fixes on `capy/upstream-merge` (`e912e8e0..1ca0968b`)

Date: 2026-09-26. Recheck of the fixes for `review-fork.md` H1, H2, M1, M2 and M3 (commits `d0f045c9`, `ff3bb1b8`, `18121f66`, `094d1ebe`, `1ca0968b`) and of the build fix `e912e8e0`, against the implementer's report `fork-fixes.md`. `git ls-remote` shows `capy/upstream-merge` at `1ca0968b`, `capy-ci` at `dfa3f05e` and `main` at `c0fa7262`.

Everything ran in a fresh `git clone --shared` checked out at `1ca0968b` in the session scratchpad. The old engine's outputs came from the first review's clone at `b8ee465c`. Word 16 and Excel 16 were driven through COM on scratch copies: read-only opens, alerts off, only instances I started, all closed afterwards. `C:\WEB\betteroffice-merge` (clean at `b8ee465c`) and `C:\WEB\bot` (clean at `1ca0968b`) were not touched.

## Summary

| Severity | Count | Items |
| --- | ---: | --- |
| Fixed | 4 | H1, M1 and M2 in the fork, and H2 for comment-free files. M3 works as a script (see L2). |
| High (new, pre-existing) | 1 | N1: deleting any comment that came with the file leaves its `w:commentReference`, and Word refuses the export. |
| Medium (new, from `ff3bb1b8`) | 1 | N2: deleting every comment in a package whose `.rels`/content types use explicit end tags leaves orphan `</Relationship>`/`</Override>` tags. Neither the engine nor Word can open the export. |
| Low | 2 | L1: PPTX stored-state cap removed (answer 3). L2: the golden gate still depends on an uncommitted Capy CI step and on a hoisted `happy-dom`. |

`1ca0968b` is fit to fast-forward `capy-ci` onto. The window's pin should wait for small fixes to N1 and N2 (answer 5).

## What was run at `1ca0968b`

| Check | Result |
| --- | --- |
| Docker office stage reproduced: fresh checkout, `bun install --frozen-lockfile`, `bun scripts/build-office-wasm.ts` | Passes. `docx_parse.js` exports `decodeTiffPng`, the checkpoint bundle builds, and the regenerated `.d.ts` equal the committed ones. |
| `bun run build:docx-wasm` after it | The DOCX `edit` and `parse` modules are byte-identical to the office build's (`shared/office-runtime/docx.wasm`, `parse.wasm`). |
| `bun run test:golden` | Shared 31 pass, 0 fail. XLSX `storage` 2 pass. |
| `cargo test --release --no-fail-fast` on `betteroffice-xlsx`, `docx-parse`, `docx-edit`, `pptx-edit` | 990 pass, 0 fail, 1 ignored (54 targets). |
| `bun test` on `rebaseCheckpoint.test.ts` and `packages/docx/src/wasm` | 22 pass. |
| First review's XLSX probes (11 workbooks plus the Excel-ordered one) | Model round trip: 0 missing, 0 extra lines on every file, `defined-names.xlsx` included. Rebase: one override each. Concurrency matrix unchanged. |
| First review's DOCX census and publication round, 14 files | Unchanged, and `wordprocessingml-comprehensive.docx` now rebases. |
| First review's PPTX publication round, 12 decks | Unchanged. |
| Word, headless | 16 exports tested: the 13 comment-free ones and the comprehensive exports that keep their comments open. Every export after a comment deletion fails (N1, N2). |
| Excel | Opens the fixed exports with every name. The source `defined-names.xlsx` itself does not open in Excel, so that file is checked natively only. |

## Answers

### 1. The four fixes on the evidence cases

**H1, fixed.** On `defined-names.xlsx`, the Excel-ordered workbook and a new seven-name file with three scopes (two `_xlnm.Print_Area`, a hidden `_FilterDatabase`, a name local to sheet 3, globals out of alphabetical order), all of the following hold:
- A collaborative export after one edit re-opens with exactly the source names in source order.
- A later edit rebased over that export yields only the cell effect.
- A row insert exports every name, with shifted references.
- A sheet rename exports every name, rewritten to the new sheet name.
- Removing a sheet drops only the name local to it.
- Two peers agree on the name order.

Excel lists the same names and ranges, for example `Budget!Print_Area =Budget!$A$1:$D$22` after the row insert. Seeds and goldens are unchanged. The sort key in `stable.rs:1299-1330` matches by source sheet index and exact name, which the patcher's pairing needs.

**H2, fixed for comment-free files.** All 13 comment-free files export with no added or lost parts, and `[Content_Types].xml` and `word/_rels/document.xml.rels` are byte-identical to the source. Word opens all 13. When every comment is deleted, the four parts, their overrides and their relationships go away as designed, whether the source had only `comments.xml` or all four parts. The export still does not open in Word, because the comment references stay behind (N1). With explicit end tags the fix itself breaks the package (N2). For the record, headless Word also opened the old 0-byte `comments.xml` exports, so H2's original impact was on strict consumers rather than Word.

**M1, fixed.** With an edit after the capture, `wordprocessingml-comprehensive.docx` rebases whether or not the capture had edits, and both comments survive. Word opens the rebased exports. The fix drops `paraId` and `durableId` only inside `comments` (`rebaseCheckpoint.ts:171`); body paragraph ids are still compared.

**M2, fixed in the fork.** The six-image DOCX state (67,117,648 bytes) loads through `loadState` and exports with all six 8 MiB media parts. Remote `applyUpdate` still refuses it, now as an `Error` ("invalid yrs update: update exceeds 67108864 bytes"). The new PPTX test opens a stored state over the cap and refuses it as one update. The implementer's point about the editor's `collaboration-ready` path is right. Capy's working tree already has the uncommitted fix (`replicaCatchUp` in `src/features/files/useOfficeRuntime.ts`, which sends only what the replica lacks), so M2 is fixed end to end only once C5 lands it.

### 2. Does anything rely on the old string errors?

No. Every catch site in the fork's DOCX, PPTX, XLSX and `shared` TS, and in Capy's `collaboration/src`, `src/office-runtime` and `src/features/files`, reads errors as `error instanceof Error ? error.message : String(error)` or `typeof error === 'string' ? error : String(error)`. Both give the same text for a string and for an `Error` with that message.

The places where the type could have changed behaviour are safe:
- The resident worker (`residentEngineWorker.ts:79,220`) posts `error.message` and matches "resident input state is not ready" on that message.
- Capy's office worker (`collaboration/src/officeRuntime.ts:179`) posts `String(error?.message || error)`. It detects traps with `instanceof WebAssembly.RuntimeError` plus the `BROKEN_OBJECT` pattern on the message. `js_sys::Error` is not a `RuntimeError` and the text is unchanged, so engine refusals still do not restart the worker.
- `collaboration/src/editCommands.ts:900` parses `OfficeEditError` codes, which the TS layer throws.

One correction to the implementer's note: `server.ts:932` and `:1033` never received raw engine throws. They get `OfficeEngineError` objects from `officeRuntime.ts`, so their output does not change. No Capy test asserts engine error strings.

### 3. Did the PPTX load cap guard anything besides size?

No. It was a bare `update.len()` check before `hydrate_doc`, added in upstream `9fe37ee8` when the demo relay fed `open_from_update` with room state from the network. Every structural check still runs after hydration and is unchanged: the client id, the root allow-list, the schema version, the fingerprint against the source, the overlay parse and `validated_snapshot`. `apply_update_v1` keeps the per-update cap (`lib.rs:240`).

L1, one side effect worth knowing: `apply_update_v1` re-hydrates a staged copy of the whole state on every remote update (`lib.rs:247`, upstream's diff transfer). Now that states over 64 MiB open, that per-keystroke cost grows with them. Capy's own cap (100 MiB, `sourceDocuments.ts:43`) is the bound. Accept it, or measure it with C5.

### 4. `e912e8e0`

Correct. The Docker office stage (`collaboration/Dockerfile:34` runs `bun scripts/build-office-wasm.ts`) now builds `docx-edit` and `docx-parse` with `wasm,tiff`, the same flags as `build-docx-wasm.ts`. From a clean checkout the stage passes, where C5 recorded it failing on `decodeTiffPng`. Both scripts now share one `target/wasm-pack` stamp key per module, because the key includes `cargoArgs` and every `scripts/*wasm*` file. They produce byte-identical DOCX modules, so the service and the browser run the same engine, and a cache restored from before the fix rebuilds instead of re-vendoring. Seeds are unaffected: the goldens pass through this build.

### 5. Is `1ca0968b` fit to fast-forward `capy-ci`?

Yes. `dfa3f05e` is an ancestor (26 first-parent commits), so `git merge --ff-only` works. It keeps the upstream merge commit as record 13 asks, needs no rebase, and I found no regression against `capy-ci` on the evidence cases or the first review's probes.

The one change that is worse than `capy-ci` for some input is N2. It needs explicit-end-tag packaging plus every comment deleted, so it is rare. I would still fix N1 and N2 before the pin that ships in the window: both are a few lines, both hit comment deletion, which is ordinary editing, and every publication after the window would carry them.

## New findings

### N1. High (pre-existing): deleting a comment that came with the file leaves its `w:commentReference`, and Word refuses the export

`crates/docx-edit/src/raw.rs:482-489` (`RemoveComment` removes only the `comments` map entry), `packages/docx/src/yrs/yrsToDocument.ts:922-929` (`commentReferenceFromPayload` emits the reference run whether or not the comment still exists).

**Defect.** A source comment's reference is seeded as a `field` embed in the story. Removing the comment leaves the embed, so the export writes `<w:r><w:commentReference w:id="N"/></w:r>` for a comment that is no longer in `comments.xml`. After H2 there may be no comments part at all.

**Evidence.**

| File and action | Result in Word |
| --- | --- |
| `wordprocessingml-comprehensive.docx` (opens in Word with its 2 comments), delete the first comment | Fails: "The file appears to be corrupted." |
| Same file, delete the reply | Fails the same way |
| Same file, delete both | Fails the same way |
| The deleted-all export with the reference runs stripped | Opens |
| The deleted-all export with a valid empty `comments.xml` added back | Still fails |
| The old engine's (`b8ee465c`) deleted-all exports | Fail the same way |

The fork's test `deleting every DOCX comment clears source and reply parts across export and fresh seeding` passes because it checks only the comment parts, and its fixture (the seed-parity `comments` overlay) does not open in Word even unedited. `RemoveComment` and the reference projection are unchanged since `capy-ci`, so UAT very likely has this. I did not rebuild `capy-ci` to confirm.

**Failure scenario.** A student deletes a teacher's comment in Capy. The next publication makes an export Word will not open the file's bytes. Downloads fail in Word, while Capy's own viewer still renders them.

**Lazy fix.** In the projection, drop a `commentReference` run whose id is not in `projectedComments`. Alternatively, have `RemoveComment` delete the reference embed. Extend the deletion test to require that every `commentRangeStart`, `commentRangeEnd` and `commentReference` id in `document.xml` exists in `comments.xml`. Use `wordprocessingml-comprehensive.docx` as its fixture.

Side note, also pre-existing: even without a deletion, that file's export drops the first comment's `commentRangeStart`/`commentRangeEnd`. Word then shows that comment at a point instead of over its phrase.

### N2. Medium (from `ff3bb1b8`): with explicit end tags, `remove_comment_parts` leaves orphan end tags and makes the export unparseable

`crates/docx-parse/src/serializer/s13.rs:567-600`, the `XmlTagIter::new(&xml, tag)` loop at 592.

**Defect.** `XmlTagIter` returns only the start tag. For `<Relationship …></Relationship>` or `<Override …></Override>` the fix cuts the start tag and keeps the end tag.

**Evidence.** I rewrote the comprehensive fixture's packaging parts with explicit end tags, which is valid OPC. Word opens that source with its 2 comments. After deleting every comment, both packaging parts of the export are malformed. Capy's engine refuses the export ("malformed XML in word/_rels/document.xml.rels at byte 915: … expected `</Relationships>`, but `</Relationship>` was found"), and so does Word. Before the fix the engine could still open this export.

**Failure scenario.** A publication makes this export the file's new base. The room then cannot reseed from it and the file stops opening in Capy until an operator restores the previous version. The trigger is rare: the producer must write explicit end tags and every comment must be deleted.

**Lazy fix.** When a matched tag does not end in `/>`, cut through its matching end tag. Add one test with explicit end tags. A Strict-namespace comments relationship (`purl.oclc.org`) is not removed either; that is rarer still.

### L2. Low: the golden gate is only half wired

The new `test:golden` works at `1ca0968b` (31 + 2 pass), but three gaps remain:
- It only gates anything through Capy's uncommitted CI step (`bun run test:golden` in `vendor/betteroffice`). That job also needs a native Rust toolchain for `cargo test`; it has one because `office:prepare` builds the WASM.
- The fork's own CI still skips `shared/` and still stops at the old clippy warnings.
- `shared/office-checkpoint.test.ts:20` now imports `happy-dom`, which no fork `package.json` declares. It resolves only because `@happy-dom/global-registrator` in the React packages is hoisted to the root. Declare it as a root dev dependency, or parse XML with the engine's own parser.

## Not rechecked

- L1 from the first review (XLSX agent projection cost) is unchanged, as `fork-fixes.md` says.
- The XLSX cap question (implementer's question 1) is a decision, not a defect. Schema 8 states are small, and I agree with leaving XLSX on upstream's caps for now.
