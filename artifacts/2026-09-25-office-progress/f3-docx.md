# F3 DOCX and PPTX storage: done, results and choices to confirm

Date: 2026-09-26. Plan section F3 items 2, 3 and the DOCX/PPTX part of item 4, on branch
`capy/f3-docx` in the worktree `C:\WEB\bo-f3-docx` (from `capy/upstream-merge` = `d1a2972b`).
HEAD `ce3ff6d2`, pushed to `origin/capy/f3-docx`. Nothing merged into `capy/upstream-merge`,
`capy-ci` or `main`; `vendor/betteroffice` in Capy untouched. The XLSX part of F3 runs on
`capy/f3-xlsx` in `C:\WEB\bo-f3-xlsx`.

## Commits

| SHA | Step | Subject |
| --- | --- | --- |
| `f8bfde71` | 1 | feat(docx): reference source images by package part |
| `9d2433f7` | 2 | perf(docx): keep the run-boundary cache only where merging loses data |
| `b77acbf4` | 3 | feat(docx): seed under a fixed client id |
| `00554f93` | 4 | fix(pptx): require the source to open a deck state |
| `fea48b49` | 5 | test(office): pin DOCX and PPTX golden seeds and state sizes |
| `45f13a8a` | 1, fix | fix(docx): type the rebase image bindings by part (tsc caught it) |
| `e284ebb1` | 1, test | test(docx): a replica without the source resolves image references |
| `ce3ff6d2` | 3, fix | perf(docx): seed the viewer in place (viewer WASM size) |

## What each step does

- **Media references** (record 18). The Rust seed writes `media:<part>` for every image embed
  whose data URL is a package media part (drawings, VML `v:imagedata`, the OLE preview picture).
  `EngineSession` holds the source media (part to display data URL) that `open_docx` and the
  viewer attach, and resolves references after lowering, so the display list is unchanged. The
  resident worker has no source: a full worker snapshot carries `media` (JSON from
  `EditSession.media_json`), which the worker attaches with `set_media_json` before loading the
  state. `docxEntries` (baseline, `resolveAsset`) resolves references from the attached package
  and throws for a missing part. The rebase leaves references alone and turns an inserted
  data-URL image whose bytes match a part in the owner's exported relationships into
  `media:<part>` with that `rId`; its authored-content check compares image bytes. The serializer
  (`s13.rs` `bind_media_reference`, on `RelationshipsIndex`) keeps an image's `rId` while it
  targets the part or a part with the same bytes, otherwise reuses or adds the owner part's
  relationship to the existing part (no bytes written), and fails on a missing part. The TS
  document seeder (`documentToYrs`, no source package) keeps data URLs; parity tests resolve
  references before comparing (`packages/docx/src/yrs/imageRefs.testing.ts`).
- **Run-boundary cache.** Both seeders keep `_originalRunBoundaries` only when a run has
  `propertyChanges`, note marks, flow breaks or no text, and cache `formatting` only for empty
  runs.
- **Fixed seed client.** `seed_parsed_docx` seeds a bootstrap replica under
  `SEED_CLIENT_ID = 0` and applies its state to the session as a local update. Seeded paragraph
  ids are `story:pN`, never client-prefixed, so a session that draws id 0 is harmless; no id is
  rejected. Baseline object ids are now `<0#n>`. The viewer seeds in place under its own client
  (`seed_parsed_docx_in_place`) because it never stores state; otherwise update decoding added
  141 KB to the viewer WASM.
- **PPTX check.** F1 already matched plan item F3.2: schema 5.0 only, no `packageJson` or
  `media` in `pptx:meta` (asserted in `deck.rs` tests), validation through
  `validated_snapshot(doc, &session.package)` on open and on each staged remote update, rebase
  overlays storing changed parts (media included) as `Any::Buffer`, inserted pictures as a
  `pendingMedia` buffer on the shape, migrations and `schema_migration.rs` deleted. The one gap:
  `openCollaborativeFromUpdate` took `source?: Uint8Array | null` and failed at run time; it is
  now a required argument (all callers already pass it).
- **Tests.** `shared/docx-pptx-storage.test.ts` (headless API): exchange-plan and opaque-objects
  seeds hold no data URL, baseline image hashes equal the part hashes, `resolveAsset` matches,
  the export keeps every media part byte-identical and equals the export of the same state with
  inline data URLs; a publication with a later edit rebases, keeps the edit, and turns an
  inserted image into a reference to its exported part; a missing-part reference fails
  `officeBaseline` and `exportOffice`; a Word-like package (rsid-split runs, one `w:rPrChange`)
  exports merged runs with per-character bold and the tracked change intact; golden SHA-256,
  two identical seeds per run and a size budget (measured + 2%) for exchange-plan.docx,
  opaque-objects.docx, book-30p.docx, images-10.docx, lecture.pptx and deck-50.pptx, plus no
  random client in DOCX object ids. Rust: `s13.rs` media rebinding and missing part,
  `seed.rs` references resolve at lowering, boundary rule cases, byte-identical seeds under two
  session ids. Bun: `mediaRefs.test.ts` (replica without source). Fixtures added to
  `poc/fixtures/`: `lecture.pptx`, and `book-30p.docx`, `images-10.docx` (4.2 MB), `deck-50.pptx`
  from a full run of `gen_files.py`.

## Results (Windows, Bun 1.3.3, stable toolchain)

- Builds: `build:docx-wasm`, `build:pptx-wasm`, `bun scripts/build-office-checkpoint.ts` pass.
  WASM: DOCX editor 9,977,776 (F2) to 9,993,380, viewer 7,455,561 to 7,467,125 (74.7%), PPTX
  3,827,196 to 3,826,929.
- cargo test (`-j 4`) `docx-view-wasm`, `betteroffice-docx-parse`, `betteroffice-docx-edit`,
  `betteroffice-docx`, `betteroffice-docx-layout`, `betteroffice-pptx-edit`, `pptx-wasm`,
  `pptx-view-wasm`, `betteroffice-pptx`, `betteroffice-pptx-render`: 1,452 passed, 0 failed,
  1 ignored; after `ce3ff6d2`, `docx-view-wasm` and `docx-edit` again: 342 passed.
  `docx-edit --features wasm`: 346 passed, 1 ignored.
- `cargo fmt --all -- --check` clean; clippy `--all-targets` on `docx-view-wasm`,
  `docx-parse`, `docx-edit`, `pptx-edit` (and `--features wasm` for the two edit crates):
  0 warnings.
- `tsc --noEmit` in `packages/docx`, `packages/pptx`, `packages/docx-react`,
  `packages/pptx-react`: clean.
- Bun `bun test --isolate packages/docx packages/docx-i18n packages/docx-react packages/pptx
  packages/pptx-i18n packages/pptx-react shared` (no Visio; `fidelitySave.test.ts` needs a
  spawnable `python3`, here a copy of `python.exe` named `python3.exe` on PATH): 782 pass,
  1 fail, the Windows-only failure that predates F3:

  ```
  packages\docx\src\yrs\residentEngineWorker.test.ts:
  52 |   startWorker = new Function(
       ^
  SyntaxError: import.meta is only valid inside modules.
  (fail) (unnamed)
  ```
- Seeds are byte-identical across two processes for all twelve measured files (and within one
  process in the golden test).
- Not run: `test:poc` (needs `build:packages`, XLSX included), workspace `rust:check`, XLSX
  suites, `apps/demo` seed check, `apps/native-viewer` tests.

## Sizes against the storage reports

State bytes from `seedOffice`, before = `d1a2972b` (merged engine), after = this branch.
Report columns: `docx-state.md` "After" (random 45-bit seed client) and section 3.5 (1-byte
client); `pptx-and-shared-overhead.md` 4.4.

| File | Source | Before | After | Report after | Report, 1-byte id | After vs report |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| book-30p.docx | 47,972 | 443,118 | 243,706 | 269,482 | 244,426 | -9.6% / -0.3% |
| book-300p.docx | 359,568 | 4,493,210 | 2,455,975 | 2,732,617 | 2,467,975 | -10.1% / -0.5% |
| book-30p-word.docx | 53,242 | 657,688 | 293,353 | 321,799 | not run | -8.8% |
| images-10.docx | 4,190,856 | 5,669,857 | 63,575 | 70,949 | | -10.4% |
| opaque-objects.docx (full run) | 66,509 | 104,848 | 45,968 | 37,074 | | +24%, see choice 7 |
| opaque-objects.docx (fork fixture) | 59,241 | 96,112 | 46,367 | | | |
| feature-rich.docx | 39,174 | 57,498 | 39,276 | 45,064 | | -12.8% |
| lesson.docx | 37,406 | 11,824 | 8,058 | 9,076 | | -11.2% |
| exchange-plan.docx | 65,718 | 456,290 | 295,141 | | | |
| deck-50.pptx | 94,191 | 161,245 | 161,245 | 157,934 | | +2.1% |
| lesson.pptx | 29,338 | | 4,293 | 4,258 | | +0.8% |
| feature-rich.pptx | 16,550 | | 17,753 | 17,718 | | +0.2% |
| lecture.pptx | 311,193 | 109,072 | 109,072 | | | |

Everything is at or under the reports' "after" numbers within 10% except opaque-objects (choice
7). Baselines as in the reports: book-30p 144,310, book-300p 1,406,440, deck-50 204,388;
images-10 40,794 (41,184; shorter ids). Word-like book export, before vs after: runs 803 to 299,
`w:rPrChange` 9 to 9, 0 per-character run-property mismatches over 94,844 characters, zipped
57,136 to 52,061 bytes (the report's figures exactly). Reseed growth seed(A) to seed(B): book-30p
+6.0%, Word-like +5.4%, images-10 +7.6%, exchange-plan +3.3%, lesson +23.1%, feature-rich
+19.8% (report: 6.0, 5.4, 7.4, -, 20.9, 17.5). Single-run times, seed / baseline: exchange-plan
969 / 493 ms to 494 / 193 ms, images-10 1,009 / 539 to 569 / 428, book-300p 472 / 750 to
561 / 520 (the seed pays one state transfer).

## Choices to confirm

1. **Seed client id 0.** A one-byte id outside `randomInt(1, …)`; the browser and resident
   worker may still draw 0, which is harmless (seeded paragraph ids carry no client prefix), so
   no id is rejected.
2. **The TS document seeder** (`documentToYrs`, used only when a host passes a parsed `Document`
   without bytes; Capy never does) keeps data URLs and seeds under the session's client, since
   it has no source package to reference or render from. Its parity tests seed under client 0 and
   resolve references before comparing.
3. **Not referenced:** picture fills and VML images inside a shape's `shapeJson`, and images
   inside inline-SDT or block-SDT payload JSON, keep data URLs (report open question 3; no
   fixture has them).
4. **Parts with equal bytes:** the seed references the first such part in package order; the
   serializer keeps an image's relationship whenever it targets a part with the same bytes, so
   unedited exports do not change.
5. **Unresolved reference:** paints nothing in the editor and viewer (no error there); the
   baseline, `resolveAsset` and the export fail explicitly.
6. **Rebase conversion** covers inserted images whose display bytes match an exported part of
   their owner; an inserted TIFF (display form differs) keeps its data URL.
7. **opaque-objects** stays 24% above the report's 37,074 because F2 now stores the raw XML of
   opaque drawings and `sourceXml` of the OLE object and text boxes (record 14), which the
   report predates; F3 saves 58.9 KB on it, the report's change 56.4 KB.
8. **Demo seeds:** `apps/demo/public/seeds/docx.bin` no longer matches the seed (`pptx.bin`
   already did not since F1). `documentToYrs.parity.test.ts` no longer asserts against it (the
   golden tests replace that check); `apps/demo/scripts/check-collaboration-seeds.ts` and
   `apps/native-viewer/tests/native_typescript_collaboration.test.ts` will fail until
   `apps/demo/scripts/build-collaboration-seeds.ts` regenerates them (outside this package's
   paths).

## Next steps

1. Review `capy/f3-docx`, then merge it and `capy/f3-xlsx` into `capy/upstream-merge` without
   rebasing. Expected overlaps: `shared/office-checkpoint.ts` (this branch touches only
   `docxImageAsset`/`docxEntries` and their call), `poc/fixtures/README.md`.
2. Regenerate the demo collaboration seeds (choice 8) or drop their checks, then `test:poc`
   and the workspace `rust:check` on the merged branch.
3. C5: DOCX baselines can now be derived from the base (NULL `indexed_baseline`) and a NULL
   state can mean seed(base); record WASM sizes against the old pin; list
   `shared/docx-pptx-storage.test.ts`, `packages/docx/src/yrs/mediaRefs.test.ts` and the new
   Rust tests in `openwiki/test-catalog.md`; the reset migration covers DOCX and PPTX (both seeds
   differ from the old pin: DOCX through F3, PPTX through F1, whose seed F3 leaves unchanged;
   the golden hashes decide future windows).
