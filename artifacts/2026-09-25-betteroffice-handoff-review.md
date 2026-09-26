# Review of the 2026-09-24 BetterOffice upstream handoff

Date: 2026-09-25. Reviews `artifacts/2026-09-24-betteroffice-upstream-handoff.md` against
`origin/capy-ci` (`dfa3f05e`), upstream at `0ba58e5a`, and Capy at HEAD. Doc line numbers
refer to the handoff file. `ci:` and `up:` mean the same refs as in the handoff.

How it was checked: four read-only reviewers (DOCX, PPTX, XLSX, Capy side) and one pass over
the header, trial merge, shared crates, build and work plan. The claims that change decisions
were re-read in code before landing here. Nothing was committed or pushed, and the submodule is
still at `dfa3f05e`. Measured timings in the handoff were not re-run, because its probe code was
never committed.

## Verdict

The bookkeeping holds. All 220 cited hashes exist on the side the doc says. The trial merge
reproduces exactly: `git merge-tree` gives the same 30 files and the same hunk counts, and the
doc's line counts include the three marker lines per hunk. The build notes, licence notes and
fork commit table are right. The XLSX patch applies cleanly and passes the 211 tests with the
stated breakdown.

The weak parts are the conclusions that drive decisions. The DOCX editor is broken the same way
as the viewer. PPTX and DOCX saved state are not safe across seed changes. The Decision 1 options
don't work as written. Several Phase 1 fixes change behaviour, although the doc says they don't.
One live XLSX bug is missing entirely.

## 1. Findings that change the plan

### 1.1 The DOCX editor doesn't wrap either, and the fix needs no upstream port

Doc 158, 166-169, 173-191, 435-437, work plan 774.

- Neither Capy's editor nor upstream's falls back to browser measurement. The editor sends
  `measurement` straight to the Rust layout (`ci:packages/docx/src/editor/computeLayout.ts:121-129`).
  With no `configureDefaultFonts` call, `resolveDefaultFontProvider` loads nothing
  (`ci:.../measure/defaultFontProvider.ts:79`). The registry then returns an empty chain for
  every family without an embedded face (`ci:.../measure/fontRegistry.ts:326-385`), and
  `measurementConfigForRequirements` drops empty chains (`ci:.../rustMeasureSource.ts:108-130`).
  Rust turns "no font chain" into `synthetic_paragraph_extent`
  (`ci:crates/docx-layout/src/measure_blocks.rs:488-493`), which splits rows only at authored
  breaks. The "falls back to measureText" wording in `fontRegistry.ts:396-398` is stale.
- So the editor lays out the same unwrapped paragraphs as the viewer. Checked in code, not run
  in a browser. Opening any DOCX with a paragraph longer than about 90 characters in Capy's
  editor confirms it.
- The fork already has everything the fix needs: `createFontProvider` (`ci:packages/fonts/src/index.ts:598`),
  `configureDefaultFonts`, `createRustMeasureSource`, and the viewer WASM's `register_measure_font`.
  - Editor: call `configureDefaultFonts({ load: () => import('@betteroffice/fonts') })` at
    `DocxEditorHost` module scope, and add a Vite alias for `@betteroffice/fonts` (it has none today).
  - Viewer: split `open` as step 1 says, and reuse `createRustMeasureSource` in the worker with
    `register_measure_font` as the sink.
  - Missing step: the viewer paints glyph runs through `drawGlyphRunFallback` with `fillText` in
    the authored family (`ci:packages/docx-react/src/components/DocxViewer.tsx:30-38`,
    `glyphOutlineProvider={false}`). Register the fetched bytes as `FontFace`s in the iframe under
    the Word names they stand in for (Carlito as Calibri, Caladea as Cambria, Liberation as
    Arial, Times and Courier), as `src/office-runtime/pptxFonts.ts` does for Arial. Otherwise line
    breaks are right but painted widths aren't.
- Step 4 (one shared Rust request builder) is more machinery than needed. Add the fields the
  viewer lacks, which the fork's own JS builder already sends (`regions.watermark`,
  `options.contractVersion`, the final `sectionId`), plus one parity test against
  `buildResidentRegionLayoutRequest`. `tocStyleIds` and `defaultParagraphStyleId` belong with the
  upstream layout commits that read them.
- Step 5 (binary FrameDelta, merged rectangles) is an optimization. Defer it until a browser
  measurement shows the structured clone hurts. Citation rectangles are per glyph run, not per
  glyph (`src/office-runtime/citations.ts:76-77`).
- Port list: DOCX step 1 should become "Capy fonts on the current pin". Move `1dc0e41f`,
  `cb2c6fe0` and `1d0f41d9` to step 6 with the layout work. Keep `1d830df7` in step 3 for the
  alternate main-part fix.
- Same bug, PPTX: `pptxFonts.ts` registers only Liberation Sans as "Arial". Unmatched families
  are measured with the first registered face (`ci:crates/pptx-render/src/layout.rs:111,243`)
  but painted with the requested family (`ci:packages/pptx/src/render/canvas.ts:235-237`). Calibri,
  Cambria, Times and Courier decks break lines at Arial widths, and CJK decks get no CJK face.
  The faces already ship in `vendor/betteroffice/packages/fonts/assets`.

Replacement for 166-169: "Capy never calls `configureDefaultFonts`, so the editor also sends empty
`fontChains` and gets the same one-em-per-character layout as the viewer. Neither ref has a
browser-measurement fallback; only files that embed their fonts measure correctly."

### 1.2 Missing live bug: some XLSX files can't be opened for editing

Not in the doc. Doc 607 treats `e8c4f5b3` as "the local decoder", and 641 treats
`float_roundtrip` as a build note.

- `ci:crates/betteroffice-xlsx/Cargo.toml:28` has `serde_json = "1"` without `float_roundtrip`.
  Schema 7 stores cell formats as JSON and re-checks that each payload is canonical
  (`ci:crates/betteroffice-xlsx/src/authority.rs:2721-2728`). A float that doesn't round-trip
  fails that check, so `from_source` fails and the file can't be seeded, edited, checkpointed or
  view-exported. Probe: theme tint `-0.14996795556505021` fails with "cell format ... is not
  canonical". About 11% of arbitrary doubles (223 of 2,001) also come back one ULP off through the
  shared state.
- Fix: `serde_json = { version = "1", features = ["float_roundtrip"] }`, the one Cargo line from
  `e8c4f5b3`, plus upstream's `canonical_cell_formats_preserve_high_precision_theme_tints` test.
  With it the probe opens and the drift is 0 of 2,001. Serialization is unchanged, so fingerprints
  and stored payloads don't change. Decoded values move by an ULP, so the browser and the service
  still need the same pin.
- The rest of `e8c4f5b3` (the looser local decoder) isn't needed. Schema 7 stores one JSON value
  per cell, so the 64 MiB state cap (`ci:crates/betteroffice-xlsx/src/workbook.rs:52`) binds at
  about 490k cells, long before the 1M-value decoder cap. The strict decoder read 600k-cell states
  fine. Drop "the local decoder" from the XLSX table row at 607 and from port step 3.

### 1.3 Seed changes break all three formats, and clearing rooms needs an epoch bump

Doc 193-224 (problem 2), 438-443, 468-475, 647-658, 740-747 (Decision 1).

- PPTX is not safe (doc 213-215). The state survives, since nothing re-seeds on open, but every
  save diffs it against a fresh seed from the current parser
  (`ci:crates/pptx-edit/src/save.rs:71-86`), with shapes addressed by source ordinal. Any paragraph
  that differs is rebuilt with `hyperlink_relationship_id: None`, `language: None` and hex colours
  (`save.rs:357-397`). After a seed-changing bump (a theme fix such as `27bf1fc1`, or connectors in
  `bc34dfc6`, which shift ordinals), exporting an unedited deck drops links, hard-codes theme
  colours or patches the wrong shape. Auto-refresh then publishes the damage.
- DOCX is safe only for rooms seeded after the bump. Seed-time fixes skip persisted states, so
  `9114209a` and `0f1ab4a7` don't help old rooms. After `4bf205b5`, old rooms holding a chart
  store `chartJson` without `drawingXml` and fail export with "chart run carries no drawing to
  replay" (`up:crates/docx-parse/src/serializer/run.rs:347-350`). That blocks refresh, the
  Leave-Edit preview and view mode with unpublished edits. `w:pict`, `w:object` and
  `mc:AlternateContent` stay dropped on every Capy export even after the port, because upstream
  still doesn't seed them (`up:crates/docx-edit/src/seed.rs:1410`). Also, `chart` is not a new Yjs
  embed (ci already seeds it); only `horizontalRule` is new (doc 471).
- XLSX breaks wider than the doc says. `seedOffice` stores the full bootstrap state when a file is
  first opened in Edit (`ci:shared/office-checkpoint.ts:1019-1031`), so every file ever opened
  in Edit breaks, not only files with unpublished edits. Users see an engine error in view and
  edit, saves never acknowledge, and refresh fails. Nothing is deleted; the edits become
  unreachable.
- The XLSX port order hides the seed changes. `dfb5c824` (port step 2) changes the fingerprint of
  nearly every workbook, because xf 0 carries no `applyX` flags in any fixture checked and absent
  flags now apply. `b56efb33` and `0c5c4fcf` also change hashed parse output. Step 1 is mostly
  calculation work that doesn't touch the fingerprint; only `57980319` does, and it also adds hard
  parse errors ("shared formula group has no master"). Group `57980319`, `dfb5c824`, `b56efb33` and
  `0c5c4fcf` as the seed-changing set gated on Decision 1.
- Decision 1 option (a), "clear source rooms and drafts", can't clear drafts, because they live in
  browsers' IndexedDB. Same-epoch drafts merge back into the new seed (`src/features/files/sourceDraft.ts:114-126`).
  For PPTX the fixed bootstrap client id (`ci:crates/pptx-edit/src/lib.rs:42`) makes that
  collision silent. The fork's two-phase seed exists because this already happened once. The clear
  has to bump the epoch and drop the state in one statement, as `server/internal/store/trash.go:405`
  does. Stale tabs then get 403 (`collaboration/src/sourceDocuments.ts:302-307`) and old drafts go to
  recovery instead of merging.
- Option (b) is incomplete. After publication each room still holds a state seeded by the old
  engine from the new base. It also needs an epoch bump and reseed after deploy for every room.
  Unchecked: who pays parse credits for a forced publication, and what happens to owners who are
  out of credits, over quota or suspended.
- Mixed engine versions. The doc says to ship the pin to the browser and the service together
  (473-474, 506-507, 633). That doesn't cover tabs opened before the deploy. There is no engine
  handshake: the room is `source:<fileId>:epoch:<n>` (`collaboration/src/sourceDocuments.ts:580`),
  and the SPA has no reload on deploy (only chunk-load handling in `src/lib/errors.ts:47`). Old
  tabs keep sending old-engine updates, including values the new engine writes and old engines
  can't read (`6bd37830` `#CALC!`). The epoch bump fixes this for the rooms it touches.

Suggested Decision 1 text: "Any pin bump that changes seed output breaks saved state: XLSX rooms
stop opening, PPTX exports rewrite unedited paragraphs, and DOCX rooms with charts stop
exporting. (a) Now, with no production data: the deploy that moves the pin bumps the epoch of
every Office source and drops its state in one statement. Stale tabs get 403 and old drafts go
to recovery. (b) Before launch: publish pending edits on the old engine, deploy, then bump the
epoch and reseed every Office room. Golden seed tests either way."

Doc 208-209: "Upstream `dfb5c824` (absent applyX flags now apply) changes the fingerprint of
nearly every workbook; `57980319` changes every workbook with filled formulas."

### 1.4 Merge upstream instead of porting commit lists

Doc 22-24 ("Port features, not commits"), 138-141, and every "Port list, in order".

- The doc argues both ways. Line 24 says port features, and 138-141 says a real merge keeps later
  syncs cheaper. The port lists read as cherry-pick orders.
- Cherry-picking doesn't work here. Of the 191 upstream commits the doc cites, 164 conflict when
  cherry-picked alone onto `capy-ci` (`git merge-tree --merge-base=<c>^ origin/capy-ci <c>`). Only
  27 apply cleanly, and 82 of the conflicts are in files the fork never touched, so they fail on
  unlisted upstream commits. Porting features by hand repeats the same conflict work at every sync,
  and upstream moves fast: 422 commits in a month, 9 more since the doc.
- Recommendation: fast-forward the fork's `main` to a fixed upstream commit, merge it into a
  branch from `capy-ci` once, and resolve the 30 files (31 at `c0fa7262`) with the Keep tables as
  the guide. Do the semantic fixes (encode_package, PPTX schema, fingerprints, the schema-7
  rebuilds) as commits on that branch, gated on golden seed tests and Decision 1. The port lists
  then become test checklists. If one merge is too big, merge in two or three dated steps.
- This needs a sign-off on AGENTS.md. Its BetterOffice rule says to rebase branches onto
  `origin/capy-ci` before merging. Rebasing an upstream merge would replay 422 upstream commits
  as new commits and lose the shared ancestry that keeps the next sync cheap. Upstream syncs
  should merge, not rebase.

### 1.5 Phase 1 and 2 fixes that change behaviour or can't work as written

Problem 7 (doc 308-322, work plan 765-766):
- Each source-room update copies the whole document twice, not once. `assertUpdatePreservesContributors`
  (`collaboration/src/contributors.ts:91-106`) does the same encode, decode and apply before the
  size check. It also awaits an HTTP access check (`collaboration/src/server.ts:541`) right under
  the comment "must stay free of I/O". The per-edit check is a recorded design
  (`openwiki/frontend/office-files.md:218-220`), so list it as a cost. The measured 50/213/98 ms
  is the size check alone.
- Summing `update.byteLength` changes behaviour. It over-counts deleted content that GC removed
  (the server doc runs `gc: true`), so the 100 MB cap trips early. The error is a plain `Error`,
  so no stateless rejection is sent and the client reconnects forever (`server.ts:564-566`). It
  under-counts updates that arrive through Redis or are applied by the server. Keep an estimate from
  the document's `update` event and recheck the exact size when it crosses the cap. Check contributor
  markers and roots on the decoded update (`Y.decodeUpdate`) rather than on a full copy.
- Drafts: storage already keeps one row per session (`put` keys on the session `draftId`). What
  isn't coalesced is the encode and the write queue. A coalesced write that lands after a receipt
  resurrects a saved draft as a false recovery prompt, so skip writes a receipt already covered.
  Storing the base once means an IndexedDB version bump from 2 to 3. "Neither changes behaviour"
  (322) holds only with these rules.

Problem 8 (doc 324-343):
- Saves with no new edits already take a cheap path (`collaboration/src/sourceDocuments.ts:519-529`).
- Missed cost: each real save moves state plus baseline over HTTP three times: the bootstrap GET,
  the checkpoint POST, and the checkpoint response, which returns the full `SourceSession`
  although only `.checkpoint` is read. Stop returning `state` and `indexedBaseline` there.
- One running plus one queued save per room is safe, because `claimed` is read when a save starts
  (`server.ts:821`). Callers must await the queued promise so failures still reach them.

Problem 4 (doc 241-264, Decision 5):
- A per-job `UserInstallation` alone disables nothing, because a fresh profile has default
  settings. Write a `registrymodifications.xcu` into it with `BlockUntrustedRefererLinks`,
  `MacroSecurityLevel=3`, `DisableMacrosExecution`, and Writer and Calc `Update/Link` set to
  never. Check the enum values against the 7.4 schema, since they differ between Writer and Calc.
- A network namespace isn't available: Docker's default seccomp blocks `unshare` without
  `CAP_SYS_ADMIN`. A per-destination allowlist for the workers is brittle. Smallest rule: in the
  host's output chain, reject new connections from the parser's uid 10001 except loopback to the
  parser ports. Use `reject`, not `drop`, or every linked URL stalls until the 180 s timeout.
- `file://` includes (`INCLUDETEXT`, linked images) bypass any egress rule and land in parsed text
  the uploader can read. `/proc/self/environ` holds `PARSER_TOKEN`. Add a `file://` case to the
  test.
- Missed callers: `/capture_page` (`parser/app.py:186-192`) and Drive and OneDrive imports use the
  same conversion.
- Likely bug, not run: `subprocess.run(timeout=...)` kills only `/usr/bin/soffice`, and
  `soffice.bin` can survive while holding the shared profile, breaking later conversions until the
  parse child restarts. Start it with `start_new_session=True` and kill the process group.
- Target: the live WireGuard peer is UAT at `10.77.0.3`; production `10.77.0.1` isn't deployed.
  The tunnel also carries Postgres and Redis. LibreOffice is 7.4.7 (Debian bookworm), which is out
  of upstream support, so record the version. Decision 5 also belongs in `human/deployment-runbook.md`.

Problem 5 (doc 266-286):
- "No panic hook and no catch_unwind" is wrong as written. `ci:crates/docx-layout/src/lib.rs:95-108`
  installs a logging hook, and `catch_unwind` exists but catches nothing in WASM. The conclusion
  holds: a trap leaves the instance reused.
- The queue lives inside the worker, so a per-call timer would count queue wait. Move the queue to
  the main thread with one call in flight, and time from send.
- Restart only on `WebAssembly.RuntimeError`. Engine refusals (`stale_target`, invalid updates) are
  normal results, and restarting on them reloads about 21 MB of WASM and fails every room's calls.
- `resourceLimits` bounds the V8 heap, not WASM memory. Recycle on RSS.
- The agent tool already caps a call at 20 commands (`server/internal/agenttools/agenttools.go:647`).
- Missed: engine failures during a save count as recoverable (`server.ts:838-840`), so
  `FailedStoreRetryRunner` retries a trapped or poisoned state forever.

Problem 6 (doc 288-306): the `schemaVersion` damage outlasts eviction. Failed saves are retried,
refresh is blocked, and clients' IndexedDB drafts replay the bad update on reopen. Export the
allowed-root list from the fork's checkpoint bundle, so a bump that adds roots (`pptx:comments`)
carries its own list, and include `__capy_pending_contributors`.

Problem 3 (doc 226-240):
- Prefix and suffix plus `insertText` still loses bold at run starts: "I like **cats**" to
  "I like **dogs**" inserts "dog" with the left neighbour's plain attributes. Use the engine's
  `replaceRange` on the changed middle (`ci:packages/docx/src/yrs/index.ts:824`). It adopts the
  first replaced unit's formatting, links included, in one transaction.
- Tracked insertions pass the `plain` check, and the full rewrite silently accepts them.
- PPTX: pass the style of the run holding the first replaced character, not `runs[0].style`. Cache
  only `paragraphId -> storyId` once per call; offsets change after each edit.

Phase 2 hardening (doc 405-407, work plan 780): `863b70ed` patches `crates/pptx-render/src/metafile.rs`,
which the fork doesn't have until `25c7ea32` lands. It can't apply on the current pin. `0eadb859`,
`8419f119` and `519dc697` only add tests and fuzzing. Delete the Phase 2 bullet and make
`863b70ed` ride with `25c7ea32`.

### 1.6 PPTX Decisions 2 to 4

- Decision 2 is Decision 1 applied to PPTX and can't stand apart from it. Rejecting 3.0 and 4.0
  makes every PPTX file with a saved state fail to open, view, save and refresh unless the same
  deploy bumps epochs (1.3). It amends the 2026-09-13 record for both reopening and export, so say
  so. Upstream burned 3.0 to 21.0 on dev builds and may reuse numbers, so a fork-only version
  avoids the next collision.
- Decision 3 is smaller than "optional and bigger". Every Capy path reads media from the parsed
  source (`mediaBytes` reads `session.package()`, `ci:crates/pptx-edit/src/wasm.rs:245-251`). The
  roughly 21 MB of media in `pptx:meta.media` is read only by validation, which copies it on every
  remote update. Dropping it removes the per-keystroke clone, the room-join download and the 47 MB
  draft writes together. It changes the seed, so do it in the same reset as Decision 2 or pay for
  a second clear.
- Decision 4 is framed wrong. Upstream has no PPTX comments UI, and its comment model is woven into
  seed, snapshot and save. Take the model with the port and decide the UI later. The remote-write
  rule at 505 must then allow `commentFlavor` (`up:crates/pptx-edit/src/comments.rs:433-446`) and
  be enforced in the collaboration service, not only the engine.

## 2. Wrong or imprecise facts

| Doc line | Says | Should say |
| --- | --- | --- |
| 32-33 | `7ee5c12b` and `8b9f3635` shrink our WASM | Only `7ee5c12b`. The fork already sets `default-features = false` on opc (`ci:Cargo.toml:15`); `cargo tree -e features` shows opc's `wasm` feature off in all five WASM crates. |
| 43 | 422 commits | `upstream/main` is now `c0fa7262` (431). Pin commands to `0ba58e5a` or re-baseline. |
| 158, 166 | Editors fall back to browser measurement | Neither does (1.1). |
| 160 | Painter falls back at `canvasBackend.ts:396` | Today's path is `drawTextRun` (`:319`) clipped to the synthetic slot; `:396` is the after-fix path. |
| 182 | CJK faces 5 to 9 MB | 4.4 to 11.4 MB (NotoSansJP 4.4, NotoSerifSC 11.4). |
| 213-215 | PPTX and DOCX are safe | See 1.3. |
| 273-275 | No panic hook, no `catch_unwind` | See 1.5. |
| 250-252 | Host reaches `10.77.0.1:8080` | UAT `10.77.0.3` today, plus Postgres and Redis. |
| 355 | Materializes once per batch | Twice: before the op loop and for the returned model (N+3 down to 2). |
| 366-368 | ~400 B/cell from per-cell formats and image arrays | The stored baseline hashes formats and images. The 400 B is two entries per cell (text and `:format`) with long ids and 64-hex hashes. A style table cuts worker CPU, not quota; skipping `:format` for default cells and shorter ids cut quota. |
| 389-390 | Problem 9 and the zip copy shrink view export | The patch doesn't touch that path (about 9 materializations in `from_source`, `restore_snapshot` and `save`). Passing known structures there is the follow-up. |
| 398-399 | Skipping the Yjs seed saves 30-35% | Layout lowers from Yjs, so the seed can't be skipped. Upstream's seeding speedups (step 7) are the lever. |
| 471 | New `chart` embed | Only `horizontalRule` is new. |
| 503 | Seven `SourceImport` passes | Eight, plus `sync_package_json`. |
| 512 | Dev chain to 22.0 | Topped out at 21.0. |
| 549-553, 572-573 | TIFF/WMF/EMF fixes need `decodeTiffPng` | Only `b1f5c910`. `7ce54d68` and `8e8f97a4` are plain JS (pass the TIFF decoder into `presentationImageBlob`); `1f846180` arrives through `paintSlide`. |
| 569-570 | `0f474019` opens 2.4x faster | That speedup is in the `SourceImport` passes we skip. We gain only the diff transfer. |
| 607 | Large workbooks need the local decoder | See 1.2. |
| 610 | Compare against `fingerprints[6]` or schema 6 docs get rewritten | No effect for Capy: `upgrade_schema` returns early for schema 7, and schema 6 runs only in standalone sessions. |
| 210-212, 629-631 | Accepted-fingerprint lists cover hashing changes | They reconstruct older parser output for three parse changes. Only column styles changed the hash function. |
| 653 | Step 1 commits change fingerprints | Only `57980319` does (1.3). |
| 657 | `bfc3231e` in XLSX step 2 | It's a pptx-scoped commit that touches `xlsx-render/src/chart.rs`. Fine to keep; label it. |
| 659-660 | Port `f855d02e` | It commits stray `g*.log` files. Port only the `xlsx-ops` and workbook code. |
| 696 | `bc0314bc` dropped about 12% of tab stops | 12% of twip positions round-trip short; only right and centre stops at those positions were lost (2 of 63 upstream corpus docs). |
| 700 | `6632da06` copies unchanged members | It collapses duplicate content-type and validation passes; `5f0f5c59` is the verbatim copy. |
| 716 | The WASM cache key changes once | It changes with every Rust source change in a bump. |
| 717-718 | Five new workspaces | Six: `apps/desktop`, `apps/fidelity`, `bindings/python-vsdx`, `packages/vsdx`, `vsdx-i18n`, `vsdx-react`. |
| 827-828 | Run `rust:check` before landing | It already fails on stable clippy 1.98.1 for untouched code. Expect red that isn't the patch's. |
| 3, 30, 145 | "the chat summary" | The reader doesn't have it. Drop those references. |

## 3. Gaps in the port lists and work plan

- DOCX step 2: keep our removal of the React comments sync in `handleSave` (`be23b455`). If
  upstream's line comes back, empty React comment state overwrites the Yjs comments on every export.
- DOCX projection row: use `sourceBinding.paraId` only when `ownerParaId === segment.paraId`,
  the guard the fork already applies (`ci:yrsToDocument.ts:1800-1802`).
- DOCX measure caches: take `e0cfa137` as is. The editor iframe is discarded on Leave Edit, and
  WASM memory never shrinks.
- PPTX step 1: add `bc34dfc6` (connectors) and `6ae0b92e` (`mc:AlternateContent` in shape trees).
- XLSX: add work-plan items for steps 7 and 8, which Phase 3 skips: `bcc90ba0` citations in the
  viewer with the fflate path deleted, and `5206ccf3`.
- XLSX patch: add the one test the XLSX reviewer found. A batch of three `PatchRangeStyle` ops then
  a `SetCell` using a newly interned style index wrote the wrong format before the patch and the
  right one after. Free follow-ups with the same trick: remote update, undo, `restore_snapshot` and
  `save()`.
- After each pin bump, the checklist should also run `pnpm test:collaboration` (it loads all three
  packaged runtimes in the Node worker), `pnpm test:office`, `pnpm typecheck`, and the fork's Bun
  tests. `test:poc` already runs `check-viewer-split.ts`.
- Appendix A switches branches inside `vendor/betteroffice`, which moves Capy's submodule off its
  pin. A worktree or separate clone avoids that.
- Measurement: the probes weren't committed, so no number can be re-run. Either add
  `bench/office/` (registered in `bench/README.md`) or label the numbers as one-off.

## 4. Upstream since `0ba58e5a`

Nine commits to `c0fa7262`. None changes seeds.

- `48849242` (DOCX host-controlled save and input flushing) adds a 31st merge conflict
  (`packages/docx-react/.../hooks/useFileIO.ts`) and is worth taking. Capy's DOCX Cmd+S serializes
  the whole package in the browser and discards the bytes (`src/office-runtime/main.tsx:332`), and
  DOCX has no input flush before save, which the save decision promises for spreadsheets.
- `2eb2c553` gives PPTX the same `onSaveRequest`. Add it to "Also useful".
- `c3c17939` and `ff36896c` measure 26 families that have no bundled face with their own metrics.
  They add a 331 KB source table to `pptx-render`, which the viewer uses, so measure the viewer WASM.
- `c0fa7262`, `404d28d3`, `2196b5c5` and `d5b7d9a8` are PPTX render fixes for step 1.
- `ebacc4e9` (DOCX undo capture modes) doesn't change "take `295f42f2` as is".
