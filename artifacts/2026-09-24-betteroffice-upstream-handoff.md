# BetterOffice upstream port handoff

Date: 2026-09-24. For Epo, continuing locally after the chat review of the same day.

This compares our fork `samyung0/betteroffice` at `capy-ci` (`dfa3f05e`, the commit
Capy pins) with upstream `openooxml/betteroffice` `main` at `0ba58e5a` (2026-09-22).
It answers three questions. Which upstream changes are worth porting? Where both
sides built the same thing, whose implementation should we keep? What is wrong in
what Capy runs today? Nothing was committed or pushed to the fork. The one code
artifact is `2026-09-24-betteroffice-xlsx-single-materialize.patch` next to this
file (Appendix A).

The review ran as four area reviews (DOCX, PPTX, XLSX, shared crates and build),
three head-to-head comparisons, a security audit and a performance audit. Each
problem below carries a status. Verified means I checked it in the code myself.
Measured means a native run. Reported means a reviewer's reading that I did not
re-check. Timings come from native Rust release builds and Node on a 4-core
container, so WASM in a browser will be slower.

## Summary

- Keep our side wherever the two differ on collaboration and saved state. Take
  upstream's engine work underneath it: parsing, layout, rendering, save fidelity
  and speed. Port features, not commits.
- The most urgent problems are not in upstream's changes. The DOCX viewer never
  wraps text. LibreOffice converts untrusted uploads with open network access. One
  worker with no timeout runs every Office save.
- Any port that changes XLSX parsing orphans saved XLSX rooms. Settle the
  engine-upgrade policy (Decision 1) before the first port reaches UAT.
- Two corrections to the chat summary. Upstream's regex removal (`5e75d3ae`,
  `acaebe56`) saves us nothing: upstream added regex with its search APIs on
  2026-09-18 and removed it four days later, and our fork never had it. Only
  `7ee5c12b` (about 22 KB gzip per module) and `8b9f3635` shrink our WASM. And the
  trial merge has six conflicted generated `.d.ts` files, not nine.

## Continue locally

```bash
cd vendor/betteroffice            # or any clone of samyung0/betteroffice
git remote add upstream https://github.com/openooxml/betteroffice.git
git fetch origin capy-ci
git fetch upstream main
git log --oneline origin/capy-ci..upstream/main   # 422 commits at 0ba58e5a
git merge-base origin/capy-ci upstream/main       # cf9a2f50, 2026-08-26
```

References use `ci:` for `origin/capy-ci` and `up:` for `upstream/main`; read them
with `git show origin/capy-ci:<path>`. Line numbers are on those refs. Paths without
a prefix are in this repository.

Follow the BetterOffice workflow in `AGENTS.md`: branch from `origin/capy-ci`,
rebase onto it before merging, then pin the reviewed `capy-ci` commit in
`vendor/betteroffice`.

The fork's `main` still sits at the merge base although it is meant to track
upstream. `git push origin upstream/main:main` fast-forwards it.

## The two sides

### What capy-ci adds

26 commits and about 14k lines over the merge base. The editors and the Yjs
collaboration themselves are upstream's (`feb818f4`, `bb621c89`, `a34e721b`,
2026-07-18 and 19). Our commits add the layer on top:

| Feature | Commits | Main code |
| --- | --- | --- |
| Read-only viewer WASM per format, size-optimized `viewer-release` profile, viewer analysis hooks, browser round-trip proof | `c1b37258` `5bbd2ae3` `3ac57dc9` `71524815` `fc25f893` `3355642d` `04faabdf` `469cee17` | `crates/{docx,xlsx,pptx}-view-wasm`, `packages/*/src/viewer.ts`, `Cargo.toml`, `poc/` |
| Durable checkpoints: seed, export, compare, baseline, assets | `be23b455` `90f9b029` `f910f731` `06a40f8a` | `shared/office-checkpoint.ts` |
| XLSX schema 7: stable row and column identities, structural edits while collaborating | `be23b455` | `crates/betteroffice-xlsx/src/authority/{stable,topology}.rs` |
| PPTX deck schema 3.0 (binary media) and 4.0 (source overlay) | `98a6059f` `ee8dbf7a` | `crates/pptx-edit/src/{deck,rebase}.rs` |
| DOCX raw story operations and comments in Yjs | `be23b455` `73454f02` | `crates/docx-edit/src/raw.rs`, `packages/docx/src/yrs/comments.ts`, `crates/docx-parse/src/serializer/s13.rs` |
| Rebase saved checkpoints onto a reparsed source | `73454f02` `ee8dbf7a` `4148d1c6` `70259d6f` | `rebaseOffice` in `shared/office-checkpoint.ts` |
| XLSX sync fixes | `db304ea1` `fd94cb97` `34a97cc4` | `authority.rs`, `workbook.rs` |
| Agent edit bridge | `ae7f156c` `48abe3df` `11d3602a` | `applyOfficeCommands`, `locateOfficeTargets` |
| Toolchain | `ef3a5fdf` | aarch64 Binaryen, arch-keyed CI caches |
| Small fixes | `27e18535` `dfa3f05e` | loader fixtures, PPTX typing style |

The workspace also sets `default-features = false` on `ooxml-opc` and `docx-parse`,
and Capy builds only the three WASM targets and the checkpoint bundle
(`scripts/prepare-betteroffice.mjs`). Our commits reformatted several upstream TS
files to double quotes and 80 columns, which causes about half the TS merge
conflicts. Keep upstream's formatting on upstream files from now on.

### What upstream added

422 commits, 1,466 files, +245k lines. By subject scope: about 100 DOCX, 90 PPTX,
40 XLSX, 74 Visio (`vsdx`) and 116 other (CI, docs, text, opc, redaction, releases,
CLA signatures).

Carry Visio and redaction as source and never build them. Visio is an editor-only
preview written between 2026-09-13 and 22, unpublished (0.0.3), hidden from
upstream's own site (`bc52f5e4`, `c11ad114`), and 3.09 MB of WASM, 4.91 MB with
raster. Redaction masks a whole document for bug reports and cannot redact selected
personal details. Deleting either would add modify/delete conflicts to every future
sync, and `ooxml-redact` depends on `vsdx-parse`. The prepare script builds crate
by crate, so neither gets compiled; `Cargo.lock` grows by 33 packages.

### Trial merge

A trial `git merge upstream/main` into `capy-ci`, aborted afterwards, conflicts in
30 files. Six are generated `.d.ts` bindings that get rebuilt anyway. `Cargo.lock`
merges textually but should be regenerated.

| File | Hunks | Conflict lines |
| --- | ---: | ---: |
| `crates/pptx-edit/tests/write_fidelity.rs` | 2 | 1065 |
| `crates/betteroffice-xlsx/tests/workbook.rs` | 2 | 339 |
| `crates/betteroffice-xlsx/tests/schema_migration.rs` | 1 | 330 |
| `crates/betteroffice-xlsx/src/authority.rs` | 14 | 318 |
| `crates/docx-parse/src/serializer/s13.rs` | 2 | 215 |
| `crates/pptx-edit/tests/schema_migration.rs` | 7 | 191 |
| `crates/pptx-edit/src/deck.rs` | 6 | 173 |
| `packages/docx/src/yrs/yrsToDocument.ts` | 7 | 125 |
| `crates/betteroffice-xlsx/src/workbook.rs` | 11 | 101 |
| `crates/pptx-edit/src/story.rs` | 1 | 85 |
| `crates/pptx-edit/README.md` | 1 | 67 |
| `crates/pptx-edit/src/wasm.rs` | 1 | 61 |
| `crates/pptx-edit/src/lib.rs` | 5 | 54 |
| `Cargo.toml` | 1 | 51 |
| `packages/docx/src/wasm/generated/edit/docx_edit.d.ts` | 3 | 50 |
| `packages/docx-react/src/components/DocxEditor/PagedEditor.tsx` | 2 | 44 |
| `packages/xlsx-react/src/XlsxEditor.tsx` | 4 | 34 |
| `.gitignore` | 2 | 29 |
| `scripts/build-docx-wasm.ts` | 1 | 29 |
| `packages/xlsx/src/wasm/generated/xlsx_wasm.d.ts` | 4 | 26 |
| `packages/docx/src/wasm/generated/edit/docx_edit_bg.wasm.d.ts` | 2 | 22 |
| `packages/pptx/src/wasm/generated/pptx_wasm.d.ts` | 3 | 20 |
| `packages/pptx/src/wasm/generated/pptx_wasm_bg.wasm.d.ts` | 2 | 14 |
| `crates/pptx-edit/src/model.rs` | 1 | 14 |
| `crates/xlsx-parse/src/package.rs` | 1 | 12 |
| `packages/xlsx/src/wasm/generated/xlsx_wasm_bg.wasm.d.ts` | 2 | 10 |
| `package.json` | 1 | 7 |
| `crates/docx-edit/src/lib.rs` | 1 | 7 |
| `crates/xlsx-parse/src/lib.rs` | 1 | 6 |
| `crates/pptx-edit/Cargo.toml` | 1 | 5 |

Porting features instead of merging touches the same code, so this table shows
where the effort goes either way. A real merge keeps later syncs cheaper, because
the next diff starts from a shared base. Re-implemented features don't give you
that.

## Problems in what runs today

The numbering matches the chat summary.

### 1. The DOCX viewer never wraps text

Status: verified in code, measured natively.

- `ci:crates/docx-view-wasm/src/lib.rs:102` sends `"fontChains": {}`. Measurement
  fails with "no font chain" (`ci:crates/ooxml-text/src/measure/input.rs:91`) and
  falls back to `synthetic_paragraph_extent`
  (`ci:crates/docx-layout/src/measure_blocks.rs:622`). That fallback breaks lines
  only at authored line breaks and counts one em per character.
- The demo document lays out as 1 page and 39 lines. With fonts registered it is 2
  pages and 55 lines. Text items reach 5,581 px on an 816 px page. Upstream's crates
  give the same result, but upstream has no Rust-only viewer, and its editor falls
  back to browser measurement.
- The painter draws glyph runs and falls back to `fillText` at the computed
  positions (`ci:packages/docx/src/layout/render/canvasBackend.ts:396`), so readers
  see each paragraph as one line cut off at the page edge.
- `insidePage` (`src/office-runtime/citations.ts:39`) drops rectangles wider than
  the page, so citation highlights fail silently on paragraphs longer than about 40
  characters.
- Capy never calls `configureDefaultFonts`, so the editor measures with browser
  fonts and paginates differently from Word. The 2026-09-14 decision in
  `human/frontend/office-files.md` mentions existing DOCX layout bugs; this may be
  one of them.

Fix, effort L:

1. Split the viewer's `open` into steps. Parse and seed, return the engine's font
   requirements (`layout_font_requirements_json` exists), register fonts
   (`register_measure_font` is exported), lay out with the chains, and build the
   display list with the same chains.
2. Fetch fonts in the viewer worker with upstream's `fontProvider(loadBytes)`
   (`up:packages/fonts/src/provider.ts:28`, from `1d830df7`) over same-origin asset
   URLs, as `src/office-runtime/pptxFonts.ts` already does for PPTX. Fonts stay out
   of the WASM and share the HTTP cache with the editor iframe. The 5 to 9 MB CJK
   faces load only when a document needs them. The runtime CSP already allows
   `connect-src 'self'` and `font-src 'self' data: blob:`
   (`workers/office/index.ts:34`).
3. Call `configureDefaultFonts` with the same provider in the editor.
4. Build the layout request in one Rust function in `docx-edit`, shared with the
   editor, with a parity test against the JS builder. Ours has drifted: it lacks
   `tocStyleIds` (`1dc0e41f`), `defaultParagraphStyleId` (`cb2c6fe0`), and the
   resolved final section and watermark (`1d0f41d9`).
5. With fonts, the display list grows to 0.26 to 0.66 MB of JSON per page, one
   glyph run per glyph. Send the binary FrameDelta as a transferable `ArrayBuffer`,
   about 35% smaller, and merge per-glyph citation rectangles into one per line.

### 2. Saved XLSX state breaks whenever the parser changes

Status: verified.

- `ci:crates/betteroffice-xlsx/src/authority.rs:379-424` binds each room to a
  SHA-256 of the source SHA plus a fingerprint of the parsed workbook
  (`authority.rs:3475`): styles, shared strings, defined names, every cell's value,
  formula and style, merges, widths, heights, panes, hyperlinks and charts. The
  bootstrap client id is derived from that hash.
- Every open re-seeds from the source file and applies the saved state on top
  (`ci:shared/office-checkpoint.ts:871`). `ci:.../authority/stable.rs:795` rejects a
  stored fingerprint it does not accept, and `stable.rs:843-846` requires source
  sheet containers written by that exact bootstrap client.
- So any pin bump that changes parse output for a file orphans its live room,
  durable checkpoint, IndexedDB drafts and `rebase_checkpoint`
  (`ci:crates/betteroffice-xlsx/src/workbook/rebase.rs:227`). Upstream `57980319`
  (shared formulas) alone changes most real files.
- Upstream's lists of accepted older fingerprints (`up:authority.rs:145-200`) cover
  only changes to the hashing itself, and cannot help schema 7, which checks the
  container's writer.
- PPTX and DOCX are safe. Their state is self-contained and tied to a SHA-256 of the
  source bytes (`ci:crates/pptx-edit/src/lib.rs:88`; DOCX opens without seeding and
  loads the state).

Fix, effort M:

1. Golden seed tests in the fork. For fixtures in each format, pin a hash of the
   seed output (XLSX fingerprint, PPTX seed update, DOCX seed), so CI fails when a
   change alters it. Upstream has a similar fixture,
   `workbook-npm-0.2.1.update.bin`.
2. An upgrade policy for seed-changing pin bumps, Decision 1.
3. Keep derived fields out of the hash, such as column styles (XLSX section).

### 3. Agent edits flatten formatting

Status: verified.

`replace_text` in `ci:shared/office-checkpoint.ts` deletes the whole paragraph and
inserts the replacement. For DOCX (`:805`) the `plain` check excludes only tracked
deletions and embedded objects, so paragraphs with mixed bold, italic and link runs
pass it and get flattened. For PPTX (`:977`) the new text takes `runs[0].style`
(`:661`). Fixing one typo strips the paragraph's bold words and links.

Fix, effort S: compare old and new text by common prefix and suffix, then delete and
insert only the changed middle so the surrounding runs keep their attributes. PPTX
also re-parses the whole deck snapshot for every command (`pptxParagraph` at
`:691`); parse it once per call.

### 4. LibreOffice converts untrusted files with open network access

Status: configuration verified. Whether this LibreOffice build fetches external
resources during conversion is untested.

- `parser/odl/document.py:43` runs `soffice --headless --convert-to pdf` with the
  shared default profile, `--nolockcheck`, and no macro or link-update settings.
- The ingest host's `output` chain is `policy accept`
  (`deploy/ansible/ingest-host/templates/nftables.conf.j2:26`), the parser runs
  with `network_mode: host` (`deploy/docker-compose.ingest-host.yml:58`), and the
  host reaches the app host's private listener at `10.77.0.1:8080` over WireGuard
  (`openwiki/deployment-runbook.md:779`). This host serves production, UAT and dev.
- Linked images, `INCLUDEPICTURE` and `INCLUDETEXT` fields, OLE links and remote
  templates are the known ways to make a LibreOffice-based converter fetch URLs.
  Direct uploads and collaboratively exported sources both reach this path.

Fix, effort M:

1. Run each conversion with `-env:UserInstallation=file:///<per-job tmp>` and a
   profile that never updates links and disables macros.
2. Limit the ingest host's outbound rules to what the workers need, or convert in a
   network namespace with no route.
3. Test before and after with a document whose linked image points at a local
   listener.

### 5. One bad file can stall every Office save

Status: verified.

- `collaboration/src/officeRuntime.ts:124` creates one worker for all rooms, with a
  serialized queue, no per-call timeout and no `resourceLimits`. A hang blocks every
  room's saves, exports and rebases.
- `ci:shared/office-checkpoint.ts:122` initializes each format's WASM once and never
  again. The Rust crates set no panic hook and no `catch_unwind`, so a panic traps
  the instance and the next room reuses it in whatever state the trap left. The
  trap arrives as an ordinary rejected promise, so the worker's `error` and `exit`
  handlers never fire.
- WASM memory never shrinks, so the worker keeps the peak of the largest file it
  has opened.
- A 50k-cell publication is roughly 20 to 30 s of engine time (reported estimate),
  and every other room waits behind it.

Fix, effort S to M: a per-call timeout; terminate and recreate the worker after any
engine error or timeout; recycle it after about 60 s idle or past an RSS limit; set
`resourceLimits`; cap commands per agent call. A small pool would remove
head-of-line blocking, but recycling comes first.

### 6. Source rooms accept any Yjs content

Status: the missing checks are verified; the consequences are reported.

- For source rooms, `beforeHandleMessage` (`collaboration/src/server.ts:540`) checks
  only the merged state size. Material rooms go through `store.validateUpdate`.
- A collaborator with edit access can add unknown top-level roots. They persist in
  every checkpoint, because the server re-encodes the whole document
  (`server.ts:819`), and reach every peer. The same collaborator can overwrite
  `pptx:meta.schemaVersion`, after which baseline, checkpoint, inspect and export
  fail for that file until the room is evicted.
- XLSX validates strictly inside its engine (update size, state-vector entries,
  strict roots). PPTX `validate_doc` (`ci:crates/pptx-edit/src/deck.rs:731`) does
  not reject unknown roots, and DOCX `apply_update_v1`
  (`ci:crates/docx-edit/src/lib.rs:602`) has no size cap.

Fix, effort S: on the source path, reject unknown top-level roots and oversized
updates per format. Give DOCX the `MAX_UPDATE_BYTES` guard PPTX has. Optionally
length-check `packageJson` before `serde_json::from_slice` (`ci:deck.rs:817`).

### 7. Full-state work on every keystroke

Status: measured.

- Server. The size check in problem 6 (`server.ts:545-553`) encodes the room,
  decodes it into a new `Y.Doc`, applies the update and encodes again for every
  inbound update. That costs 50 ms at 10k cells, 213 ms at 50k and 98 ms on
  `jp_llm2.pptx`, on the event loop every room shares.
- Browser. The update handler at `src/features/files/useSourceSession.ts:395` runs
  a full `Y.encodeStateAsUpdate` and queues an IndexedDB write of base plus state
  for every update, never coalesced. That is about 47 MB per keystroke on
  `jp_llm2.pptx`.

Fix, effort S: keep a per-room size counter and add `update.byteLength`; write
drafts latest-only and store the base once per session. Neither changes behaviour.

### 8. Saves pile up, and each one reopens the file

Status: measured.

- The browser requests a checkpoint one second after each typing pause
  (`useSourceSession.ts:412`), and `persistSource`
  (`collaboration/src/server.ts:811`) queues one full save per request.
- Each save calls `open` (`ci:shared/office-checkpoint.ts:745`), which parses the
  base and replays the state, then builds the baseline, then makes a second worker
  trip for `compareBaselines` (`collaboration/src/sourceDocuments.ts:399`). An agent
  edit or undo opens the file 2 to 3 times plus a full XLSX projection per command
  and target (`ci:office-checkpoint.ts:896,945`). An XLSX publication opens it about
  12 times.
- One save costs 0.64, 3.6 and 7.5 s at 10k, 50k and 100k cells, peaking at 132 MB,
  632 MB and 1.26 GB. Node adds about 1.5 s at 50k. Agent edits can hit the API's
  20 s collaboration timeout (`server/internal/store/store.go:113`).

Fix, effort S to M: allow one queued save per room, since its `claimed` ids already
cover later requests; return the effects from the same worker call and cache the
decoded indexed baseline per indexed checkpoint.

### 9. XLSX rebuilds the workbook about four times per commit

Status: measured, patch attached.

- `ci:crates/betteroffice-xlsx/src/authority/stable.rs:1129` materializes inside the
  op loop and clones the result (`:1142`). `authority.rs:868` materializes again
  through `structure()`, the facade does it again (`workbook.rs:1902`), and
  `install_model` (`workbook.rs:2374`) computes the structure once more.
- One-cell commit: 135, 787 and 1,729 ms at 10k, 50k and 100k cells. 20-cell paste:
  0.8, 4.2 and 8.8 s. Remote one-cell update: 0.16, 0.86 and 1.84 s.
- The attached patch materializes once per batch and reuses the staged model and
  structure, the pattern of upstream `775f184f`. Commits drop to 72, 459 and 978 ms
  and pastes to 86, 553 and 1,143 ms.

Next steps are in the XLSX section: upstream's `Arc<WorkbookBase>` instead of deep
clones per stage, target-cell reads for `SetCell`, and `xlsx_ops::apply_in_place`.

### 10. Editing a spreadsheet uses a lot of quota

Status: measured. Plan size checked in `openwiki/backend-storage-quota.md`.

- The XLSX projection emits every cell's resolved format, and images as JSON number
  arrays (`ci:crates/xlsx-wasm/src/core.rs:361,363`). The stored baseline is about
  400 bytes per cell.
- A 219 KB workbook with 50k cells stores about 20 MB of baseline plus 8.4 MB of
  state, charged at initialize (`server/internal/store/source_documents.go:301`).
  That is 29% of the Free plan's 100 MB.
- PPTX state carries the deck's media (22.7 MB for `jp_llm2.pptx`). DOCX state
  carries images as base64 data URLs (`ci:crates/docx-parse/src/media.rs:46`).
- The baseline rides every bootstrap and checkpoint response, and the browser
  editor downloads it without using it.

Fix, effort M: a style table instead of per-cell formats, images out of the
baseline JSON, and the baseline sent only to the collaboration service. Dropping the
format entry for default-styled cells and referencing PPTX media by part are bigger
calls (Decision 3).

### 11. Smaller findings

Status: reported unless noted.

- Viewing a file with unpublished edits runs the editor engines in a worker
  (`src/office-runtime/main.tsx:198`): about 2.5 s at 50k cells, against 0.12 s for a
  plain viewer parse. This is the common case, because auto-refresh waits for 5,000
  tokens. Problem 9 and the zip copy shrink it, and caching exports per file, epoch
  and checkpoint would remove repeats.
- PPTX remote updates clone the whole state (`ci:crates/pptx-edit/src/lib.rs:195`),
  and `validate_doc` re-parses the 1.08 MB `packageJson` and copies all media
  (`ci:deck.rs:845`): 73 ms per remote keystroke on `jp_llm2.pptx`.
- Citation matching repeats parsing. XLSX unzips and DOM-parses up to 20 MB on the
  iframe main thread and gives up past 20k cells
  (`src/office-runtime/xlsxCitation.ts:26-71`). PPTX lays out every slide
  (`src/office-runtime/PptxViewer.tsx:100`).
- DOCX viewer on a 14-page file: parse 55 ms, seed 70, layout 50, display list 40.
  Skipping the Yjs seed would save 30 to 35%.
- Quadratic spots in fork code: the merge overlap scan (`ci:stable.rs:1004`); axis
  span scans that grow with every row or column insert until publish
  (`ci:.../authority/topology.rs`); `pendingEffects.find` per effect
  (`collaboration/src/sourceDocuments.ts:419`); rebased XLSX states rezipped and
  reparsed on every open (`ci:crates/betteroffice-xlsx/src/workbook/rebase.rs:214,330`).
- Upstream hardening the fork lacks: `863b70ed` (WMF MOVETO/LINETO overread) and the
  metafile and package-parse fuzzing in `0eadb859`, `8419f119`, `519dc697`. These
  affect the browser viewers, not the server path.
- Fine as is: DOCX `sanitizeHref` and XLSX `safeExternalHyperlink` allowlist schemes
  and open links with `noopener,noreferrer`; the iframe origin and message checks
  in `officeProtocol.ts` and `useOfficeRuntime.ts:317` hold; the fork's 26 commits
  add no `unsafe`.

## Decisions by format

The tables come from reviewers reading both refs; treat their line numbers as
starting points. Effort: S is hours, M a day or two, L several days.

### DOCX

| Area | Ours | Upstream | Keep | Action | Effort |
| --- | --- | --- | --- | --- | --- |
| Viewer measurement | Hand-built Rust layout request with no fonts (`ci:crates/docx-view-wasm/src/lib.rs:102`) | JS request builder `buildResidentRegionLayoutRequest` (`up:.../computeLayout.ts:82`) and a font provider (`1d830df7`) | Ours, plus fonts | Problem 1. | L |
| Save serializer | Rebinds images whose part changed (`ci:s13.rs:674-690`) | `RelationshipsIndex` and lossless replay of raw XML and charts (`up:s13.rs:688`). It skips any image with a non-empty rId (`up:s13.rs:964`), so an image inserted with a temporary `rId_img_*` (`useFileIO.ts:244`) keeps a dangling rId | Upstream, plus our rebind | Take upstream's s13. Re-add our rebind as a `RelationshipsIndex` `by_id` lookup and keep our clearing of empty comment parts. | M |
| Projection | Hooks, `sourceBinding` and `projectedComments` (`ci:yrsToDocument.ts:1317,1728,1808,1868,1880`) | Cached `storyToBlocks` (`up:yrsToDocument.ts:2002-2019`, `28867ce8`) | Both | Bypass the cache when a hook is passed; rebase runs once, so its speed doesn't matter. Build comment ranges from `projectedComments`. Make upstream's base-paragraph lookups (`up:packages/docx/src/yrs/yrsToDocument.ts:2098`, `restoreRawInlines` at 1454) use `sourceBinding.paraId` when set, or raw XML is lost after a rebind. | M |
| Comments | Bodies, replies and done state in the Yjs `comments` map (`ci:raw.rs:49,459`, `ci:comments.ts:16`) | Anchors in Yjs, bodies in React state (`up:DocxEditor.tsx:1372,1424`), written at save (`up:useFileIO.ts:142`) | Ours | Ours are shared and exportable without a browser. Take only the comment-parsing parts of `1d0f41d9`. | S |
| Undo | No fork code uses the undo API | `295f42f2`: one history per session, grouped keystrokes, no Cmd+Z capture of other inputs (`up:index.ts:756-786`) | Upstream | Take as is. Its API changes (`applyLocalUpdate` and `beginUndoCapture` lose arguments, `historyStory` becomes `historyStories`, `markUndoGroup`, `undoDepth` and `redoDepth` go away) don't touch `office-checkpoint`. | S |
| TIFF | Compares data-URL bytes to raw part bytes (`ci:s13.rs:679`, `ci:rebaseCheckpoint.ts:113-125`) | Converts to PNG for display, and the package keeps the TIFF (`up:media.rs:111-135`, `36dab048`) | Upstream | In s13 compare the converted form of the part with the source. In rebase, build `imageBindings` from the parsed media map, not the raw zip. The viewer needs `docx-parse/tiff` (tiff and weezl crates, about +105 KB); measure first. | M |
| Agent edits | Server-side bridge that refuses non-plain paragraphs (`ci:office-checkpoint.ts:815`) | Session-local proposals (`up:agentProposalRange.ts:3`, `5069ad24`) | Ours | Problem 3. | S |
| Search | Normalized unique match on the display list (`src/office-runtime/citations.ts:11-36`) | Literal Yjs search that needs an edit session (`up:index.ts:935`) | Ours | After fonts land, merge per-glyph rectangles into one per line. For find-in-editor later, take `b46ad04e`, `5e75d3ae` and `acaebe56` together, since the first alone adds regex. | S |
| Measure caches | None | `e0cfa137`: thread-local cache up to 2×(8 MB keys + 32 MB values) (`up:measure_blocks.rs:585-588,675`), cleared only by `clear_measure_fonts` | Upstream, tuned | Fine in the disposable viewer worker. In the editor, cap values near 8 MB and clear on dispose. | S |
| Engine worker crashes | None | `0019657c` and `846b5d60` recover instead of leaving a permanent error panel | Upstream | Take. | S |

Port list, in order:

1. Viewer and editor fonts plus the shared request builder (problem 1): `1d830df7`
   (fonts manifest and provider), `1dc0e41f`, `cb2c6fe0`, `1d0f41d9` (request
   fields).
2. Save data loss: `4bf205b5` (the first save dropped charts and opaque drawings:
   `w:object`, `w:pict`, `mc:AlternateContent`), `0f1ab4a7` (authored page breaks
   lost), `9114209a` (a paragraph starting with a page break gained a second one),
   `1d0f41d9` (lossless foreign markup, unknown attributes, custom root bindings),
   `7aa1ba32` with our rebind. Once auto-refresh publishes an export, these losses
   become permanent in the source.
3. Parse and open: `2ee434c4` (text inside customXml, smartTag and sdt-wrapped rows
   and cells), `1d830df7` (a main part under another file name), `36dab048` (TIFF
   files that failed to open or painted nothing) with the corrected comparisons.
4. Undo and crash recovery: `295f42f2`, `0019657c`, `846b5d60`.
5. Projection cache: `28867ce8` with the hook bypass and `sourceBinding` lookups.
6. Layout fidelity, which reaches the viewer through docx-parse, docx-layout and
   seeding. Tables `d4f4b85b` `8adcd043` `975027c7` `20e913c0` `0664bd37` `b351bbe6`
   `c087612c` `3ab732f3`; spacing `63931371` `2c56acdb` `284f0c46` `5b2c6957`
   `e151d793`; hidden content `356f67a2` `e5ad702d`; page numbers `4d27f1e8`
   `a117530f`; floats and wrapping `9b2fe7b7` `b57f8634` `2d0344eb` `42083b33`
   `0e9ca887` `67797384` `c1f96842`; other `25902e55` `933c672f` `4511b9ac`
   `41f508b8` `8eddb2e6` `8b74d58d`. The font-metric commits `e4cb2286` `91cd1d01`
   `a409d437` `1f82d046` `04d50bb2` `12472707` `b1d92842` `59d71c4e` `1e46a6f0` pay
   off only after step 1. CJK course files depend on `1f82d046`, `8eddb2e6` and
   `59d71c4e`. Shape and colour fixes (`60c79dd0` `bd69e9ed` `56c3ca47` `b2ca63b0`
   `29589354` `4eb1d90b` `20618492` `1a5ef230` `d926fb0b`) can ride along.
7. Import and editor speed: `9e4656ff` (import 13 to 25% faster), `6ce2439a`,
   `b46469d6`, `cd8ebd6b`, `564b7dc3`, `963f0dbf`, `c574c803`, `43fad65d`,
   `73cea546`, `bd596269` (remote updates that don't apply yet no longer set up
   observers), `6220cb1e`, and `e0cfa137` tuned.
8. Saves and size: `28bb033f`, `5f0f5c59`, `6632da06`, `d08ebf6a`, `7ee5c12b`,
   `8b9f3635`, then re-measure with `poc/scripts/check-viewer-split.ts`.
9. Canvas page reuse and freed temporary buffers: `0b0a90ad`.

Yjs changes to expect: additive attributes (`snapToGrid`, `spaceBefore/AfterLines`,
`autoSpaceDE/DN`, list marker formatting, table `compatibilityMode`,
`inheritedHyperlink`, `fieldResult` and `resultProjection`), new `horizontalRule`
and `chart` embeds, and one rename, seeded `pageBreakBefore` to
`pageBreakBeforeRun`. Seed-time fixes skip states already persisted. Clients on
mixed versions during a deploy could save the new embeds wrongly, so ship the pin to
the browser runtime and the collaboration service together. Vanished text is now
hidden by default, so citations into hidden text won't highlight.

Conflict notes:

- `crates/docx-edit/src/lib.rs`: one `pub use` line.
- `crates/docx-edit/src/seed.rs`: upstream changed `seed_parsed_docx` (`mut
  envelope`, media clearing, compatibility mode). Re-apply our comment operations
  and visibility changes by hand.
- `crates/docx-edit/src/wasm.rs`: ours is additive (`patchComment`,
  `story_object_ids`, `list_comments`). Move the `story_segments` doc comment back
  to its function.
- `crates/docx-parse/src/serializer/s13.rs`: the comment-parts hunk is easy; rewrite
  our target rebind against `RelationshipsIndex`.
- `packages/docx/src/yrs/yrsToDocument.ts`: hardest; see the projection row.
- `packages/docx/src/yrs/index.ts`: upstream marks stories dirty everywhere; ours is
  additive plus line-wrap noise.
- `documentToYrs.ts`, `DocxEditor.tsx`, `PagedEditor.tsx` (`renderEnv` memo deps),
  `useFileIO.ts` (upstream adds `downloadOnSave`), `useDocxEditorRefApi.ts`: small,
  mostly our 80-column rewraps.
- `scripts/build-docx-wasm.ts`: upstream only adds `tiff` to the cargo features;
  our quote reformat makes the whole file conflict.

### PPTX

| Area | Ours | Upstream | Keep | Action | Effort |
| --- | --- | --- | --- | --- | --- |
| Media storage | Binary Yjs buffers in `pptx:meta.media`; `packageJson` holds no media (`ci:deck.rs:852`, read at `:813`) | Base64 inside `packageJson` (`up:pptx-parse/src/model.rs:228`, `15bb9751`); inserted pictures as base64 strings on the shape (`up:deck.rs:578`, `911a2949`), carried into every snapshot (`up:model.rs:147`); a package sync rewrites the whole blob (`up:deck.rs:988`) | Ours | 1.0x the image size against 1.33x, and syncs don't rewrite media. Our `encode_package` serializes a hand-picked field list, which after the port would drop `tableStyles`, `commentAuthors`, `comments`, `commentFlavor` and `shapeElements`; decks would reparse without connectors and saves would corrupt. Serialize the whole package with media emptied. Store inserted pictures as binary on the shape, keep them out of the snapshot, and serve them via `mediaBytes("pending-media:<id>")` (`up:deck.rs:511`). | M |
| Schema versions | 3.0 binary media, 4.0 source overlay, migrations from 1 and 2 (`ci:deck.rs:23,781`) | 2.1 (its collapsed dev chain) and 2.2 (base64), with backfills (`up:deck.rs:30,1339`) | Neither | Accept one version, 5.0, and reject the rest. Delete `migrate_doc`, the backfills and the `*PendingSource` flags. `sourceOverlay` becomes an optional validated key, not a version. Golden seed tests force a bump when seed output changes. Needs Decision 2. | S |
| Opening with the source | Strict fingerprint check and overlay rebuild (`ci:lib.rs:139`, `ci:rebase.rs:110`) | Seven `SourceImport` passes that write to the doc on open (`up:lib.rs:176`); WASM silently falls back to a session that can't save (`up:wasm.rs:342`) | Ours | Every Capy path already holds the fingerprinted source. Don't port `SourceImport`. | none |
| Viewer snapshot | A duplicated `snapshot_package` (`ci:model.rs:156`) with its own theme lookup that ignores the slide colour map (`:390`), no run merging, and no hidden, effects, spacing, baseline or caps fields | `baseline_snapshot` (`up:deck.rs:1829`), tested equal to the seeded snapshot (`:2593`) | Upstream | Make it `pub`, call it from `pptx-view-wasm`, delete ours. Ours stops compiling after the port anyway (`Table { rows }` became `Table(table)`). | S |
| Remote updates | `migrate_doc` on the staged and the live doc for every remote update (`ci:lib.rs:200,208`) | Applies to a staged copy, then transfers the diff and decodes once (`up:lib.rs:265`, `0f474019`) | Upstream | Take the transfer, drop the migration. Neither side should decode the whole package per update (`ci:deck.rs:813`, `up:lib.rs:278`). Reject remote writes to `pptx:meta` and validate with `validated_snapshot` (`up:deck.rs:910`). | S |
| Seeding | Two phases: write 2.0 and a null `packageJson`, then override (`ci:deck.rs:34`) | One phase (`up:deck.rs:42`) | Upstream | Both use a fixed bootstrap client id (`ci:lib.rs:42`, `up:lib.rs:51`), so the browser runtime, collaboration service and export worker must share one pin. Drop our convergence test with the two-phase seed. | S |
| Agent edits | Durable `applyOfficeCommands` with inverses and guards (`ci:office-checkpoint.ts:1236`), `replace_text` only | Session-local proposals (`up:proposals.rs:134`) previewed on a cloned doc (`:278`), eight edit kinds (`:19`) | Ours | Problem 3 first. Later add upstream's kinds as commands: text formatting, alignment, shape rect and fill, slide notes. Upstream's before/after diff view (`60e18093`) could show applied agent edits. | M |
| Citations | Normalized unique match on the display list (`src/office-runtime/citations.ts:12`), highlighting every line of the matching text box (`:106`) | Literal case-folded search over Yjs stories, editor only (`up:search.rs:126`) | Ours | Recurse into the new nested `table` elements, and narrow highlights to the matched lines using the per-run offsets in `PositionedTextRun` (`ci:packages/pptx/src/types.ts:264`). | S |
| Typing-style guard | Compares six fields (`ci:PptxEditor.tsx:587`, `dfa3f05e`) | Sets the style unconditionally (`up:PptxEditor.tsx:856`) | Ours | Compare every key, including the new `spacingPt` and `baselinePct`. | S |
| Comments | None | A `pptx:comments` root (`up:lib.rs:44`, `up:comments.rs:15`), written into the file on save | Your call | This matches our DOCX comments, which also export. Decision 4. | M |

Upstream's schema history. Upstream moved from 2.0 through 3.0 to 22.0 on dev builds
between 2026-09-05 and 08 (its 3.0 meant connectors, 4.0 the slide-number field).
`e5c45210` then collapsed that chain to 2.1, and `15bb9751` made 2.2. Upstream
accepts 1, 2, 2.1 and 2.2; we accept 1, 2, 3 and 4. What 2.1 adds to the Yjs doc:

- `packageJson` rewritten through the new package model, which adds `tableStyles`,
  `commentAuthors`, `comments`, `commentFlavor` and `shapeElements`
- `meta.commentFlavor`, a `pptx:comments` root and `slide.notes`
- `hidden` and `blipEffectsJson` on shapes; backfilled `graphicJson` for tables and
  OLE previews
- `spacing`, `baseline` and `caps` on text runs
- five `*PendingSource` flags, cleared by import passes in
  `open_from_update_with_source`

2.2 changes only how media bytes inside `packageJson` serialize (base64). Our 3.0
and 4.0 documents are 2.0-shaped, so merged code that treats anything at or above
3.0 as current would skip every 2.1 backfill.

Merge traps:

- `encode_package`, above. With the one-version scheme only `seed_doc` still writes
  `packageJson`; route it through our encoder, or our reader fails with "media must
  be binary".
- `seed_snapshot` and `seed_snapshot_story` must write `hidden`, blip effects, notes,
  comments and the new run attributes.
- Upstream rewrote `apply_update_v1` and dropped the live-update migration, which
  suits the one-version scheme.
- Upstream's `loader.test.ts` still tests the silent fallback on open (around line
  530); ours rejects that case.
- A rebase compares against a package the old engine exported, so in-flight
  checkpoints may fail across a pin change. Clear rooms (Decision 1).

Viewer follow-ups:

- The renderer reads `hidden`, blip effects, spacing, baseline and caps from the
  snapshot (`up:pptx-render/src/layout.rs:598,730,2406-2441`); `baseline_snapshot`
  fills them.
- Capy's viewer calls `createImageBitmap` directly, so upstream's TIFF and WMF/EMF
  bitmap fixes (`b1f5c910`, `7ce54d68`, `8e8f97a4`, `1f846180`) never reach it.
  Upstream's `presentationImageBlob` imports the full editor WASM loader, which
  would break the viewer split. Export `decodeTiffPng` from `pptx-view-wasm`
  instead. TIFF adds about 142 KB.

Port list, in order:

1. Parser and renderer fidelity, which reaches the viewer once step 2 lands. Tables
   `60113a3d` `051830e7` `ef5cdeea` `030505a5`; bullets `2c90c17f` `2877abaa`
   `3fb2bf7f` `c5f14677`; text `6963a672` `04d50bb2` `3d95068f` `875d556d`
   `088d177e` `1af946fc`; theme `2710a419` `a3b2acdb` `27bf1fc1` `d926fb0b`; shapes,
   pictures and backgrounds `0c9b52ed` `58f9bfb8` `1f30ea03` `70e73942` `25c7ea32`
   (EMF/WMF drawn in Rust) `c02a1459` `af6292e7` `e0d12f34`; charts `c9b72bf8`
   `d2aaf9cb` `cca2618c`; bounds `863b70ed` `0eadb859`.
2. `baseline_snapshot` for the viewer, with the new snapshot fields: `a250378a`
   `54fdaa00` `069e4d66` `f5d9fd95` `7f158c7a`.
3. Save fidelity: `d280c872` (hyperlinks and fields survive edits across runs),
   `5c015e9e` (a hostile `cNvPr id` wrapped to 0 in release builds, and adjust edits
   on custom geometry vanished on save), `6632da06`, `5f0f5c59`, `7ee5c12b`.
4. Collaboration and render speed: `0f474019` (opening with a source 2.4x faster),
   the cached `encode_state_as_update` from `78b64aac` (`up:lib.rs:235`), the text
   layout cache `3ec60e4a`, single-slide render `d4f29f78` and `dfa0b1ff`.
5. Image formats in the viewer: `b1f5c910`, `7ce54d68`, `8e8f97a4`, `1f846180`,
   through `decodeTiffPng`.
6. Speaker notes, `a6fee5a7`. Notes reach the snapshot, so the retrieval baseline and
   agent inspection can use them.
7. Picture insert and z-order, `911a2949`, stored as binary.
8. Agent edit kinds from `d6ba9da3`; optionally the diff view `60e18093`.

Also useful: `3d77b4fe` (`readOnly` and `initialSlide` props) and `915dbaad`
(translations). Skip `15bb9751`, `e5c45210` with the `SourceImport` passes, the
native `pptx-raster` (`387f2392`, `77b1a275`), the proposal store, and the search API
(`ab3d7221`, `5e75d3ae`, `acaebe56`).

Conflict notes:

| File | Upstream change | Difficulty |
| --- | --- | --- |
| `deck.rs` | +1824 lines: migrations, seed, import passes | Hard |
| `lib.rs` | Import pipeline, cache, rewritten `apply_update_v1` | Medium |
| `model.rs` | New fields, `SlideScope`, comments | Easy once `snapshot_package` goes |
| `story.rs` | +262 lines: new run attributes, baseline story | Medium |
| `wasm.rs` | +522 lines, additive | Low; keep the strict source check |
| `Cargo.toml` | Adds `base64` | Trivial |
| `README.md` | Additions | Trivial; rewrite the schema section |
| `tests/schema_migration.rs` | Rewritten | Hard; rewrite for the one-version scheme |
| `tests/write_fidelity.rs` | +1674 lines, additive | Medium |
| `PptxEditor.tsx` | Style-update block moved | Trivial, plus the two new fields |
| `loader.ts`, `loader.test.ts` | Additive | Low |
| `package.json` | Version bump only | Trivial |

### XLSX

| Area | Ours | Upstream | Keep | Action | Effort |
| --- | --- | --- | --- | --- | --- |
| Collaboration model | Schema 7, stable row and column identities; structural edits allowed while collaborating (`ci:stable.rs:638,1122`) | Schema 6, index-addressed; structural edits refused in collaboration | Ours | Recorded decision in `human/frontend/office-files.md`. | none |
| Commit path | Deep-clones the base per stage (`ci:authority.rs:623,767,858`); about four materializations per commit (problem 9) | `Arc<WorkbookBase>` (`up:authority.rs:401,468`); reads the workbook once per batch and applies ops in place (`up:authority.rs:506,521`); reuses the staged model (`:785`) | Both | The attached patch first. Then the `Arc` base, with `Arc::make_mut` where we write `base.rebase`; one read per batch with `xlsx_ops::apply_in_place` (from `f855d02e`) inside `stable::apply`; target-cell reads for `SetCell`. | M |
| Local decoding | Our own encoded bytes go through the strict decoder (`ci:authority.rs:854`), capped at 1M values | A looser decoder for bytes the engine produced itself (`up:authority.rs:1563,1647`, `e8c4f5b3`) | Upstream, for local bytes | Use it for bootstrap, staging and restore. Keep the strict decoder for anything incoming (`ci:authority.rs:689`, `ci:.../workbook/rebase.rs:58`). Large workbooks can't be edited locally without it. | S |
| Update intake | Gap detection on incoming updates (`ci:authority.rs:726`) | Reuses the encoded baseline across queued updates (`up:authority.rs:640`) | Both | Keep ours and add the baseline parameter. | S |
| Source bytes | Uncompressed parts plus a hash (`ci:workbook.rs:161-162`). Rebase data holds only changed parts, as `Arc`-backed Yjs buffers (`ci:.../workbook/rebase.rs:45,92-121`) | Keeps the compressed zip (`up:ooxml-opc/src/lib.rs:186`, `up:workbook.rs:356`) and copies unchanged members on save (`up:workbook.rs:805`, `5f0f5c59`) | Both | Let the compressed zip own the source bytes and compute our hash from it; `restore_rebase` passes the rebuilt package. Use the owned parse (`1acc67b0`) in the editor and viewer to avoid a second uncompressed copy. | S |
| Fingerprints | Strict and source-bound (problem 2) | Accepted-fingerprint lists; `upgrade_schema` rewrites the stored fingerprint in place (`up:authority.rs:145-200,943`) | Ours | Golden test plus Decision 1. Don't adopt upstream's column-style hashing (`up:authority.rs:3425`) in schema 7. In the `upgrade_schema` hunk compare against `fingerprints[6]`, not `base.fingerprint`, or every schema 6 doc gets rewritten. | M |
| Pristine check | Exact snapshot equality (`ci:authority.rs:652`, `34a97cc4`), which also gates `restore_rebase` | One client in the state vector and no deletions (`up:authority.rs:607`) | Ours | Drop the npm-0.2.1 test from `9a6cdd5a`: it expects a schema 6 snapshot to restore into a collaborative session, which we refuse. | S |
| Editor save API | `flush` reads the live input value, which is safe during IME composition (`ci:XlsxEditor.tsx:1395`); `onPendingChange` (`:1414`) | Settles pending edits through a ref and cancels chart drags (`up:XlsxEditor.tsx:920`); `save` (`:659`), `selectCells` (`:485`), `readOnly` (`:123`), all from `5206ccf3` | Both | Take `save`, `selectCells`, `readOnly` and the settle logic. Keep `onPendingChange` and the DOM read. `flush` becomes settle or throw, and the host calls `api.save()`. | S to M |
| Citations | `xlsxCitation.ts` unzips again, DOM-parses each sheet and gives up past 20k cells, one WASM call per cell | `search_text` in Rust over the parsed model (`up:workbook.rs:944`, `bcc90ba0`) | Upstream, in our viewer | Add `searchTextJson` to `xlsx-view-wasm` using `xlsx_render::display_text`, with `normalized()` matching and at most two hits. Delete the fflate path. | S |
| Active sheet on save | Mapped through the structure (`ci:workbook.rs:682-697`) | By index | Ours | Plus upstream's rezip from the original zip. | S |

Upstream features that address cells by sheet index and row number. Rebuild each from
the source file plus our row and column identities at load, so nothing new is stored
in Yjs and schema 7 stays as it is.

| Feature | What goes wrong if merged as text | Schema 7 version | Effort |
| --- | --- | --- | --- |
| Preserved row, column and cell markup on save (`8a27bb76`; upstream replays ops by index and forgets the mapping on remote updates, `up:workbook.rs:601,756`) | Our `apply_preserved_state_ops` returns early for schema 7 and `install_model` never resets `axes`, so after a collaborative row insert, save pastes source row markup onto the wrong rows | Build a source-to-current row and column map from each axis's `"base"` run (`ci:topology.rs:42`) and set it in `install_model` (`ci:workbook.rs:2372`); needs `AxisMap::from_segments` in `xlsx-parse/src/axis.rs`. Stopgap: set it to `None`. | M, S for the stopgap |
| Column styles and sheet format (`21d83b36`, `dfb5c824`, `91554bf6`; from base by sheet index, `up:authority.rs:2808`) | `stable::materialize` uses `Sheet::new`, so schema 7 drops column fills and default heights | At `Sheet::new` (`ci:stable.rs:930`), take them from base through the `sheet:{i}` key and map them through the column axis. Yjs undo then restores them, so `RestoreColStyles` isn't needed. | S to M |
| Tables (`d1c6a553`; keyed by sheet index, `up:authority.rs:228`) | Sheet index and range go stale after sheet or row edits. Structural edits already fail safely, because our formula binding treats table references as opaque. | Map the sheet through its key and the range through the axes; drop a table whose range was deleted. | M |
| Array-formula ranges (`retain_array_formulas`, `retain_formula_caches`; by sheet index and cell, `up:workbook.rs:2710`) | Our export path (open, apply checkpoint, save) runs through `restore_snapshot`, so array formulas in shifted regions lose `t="array"` | Map source ranges through the axes; keep one only while its cell still holds the bootstrap item. | M |

More to watch:

- Upstream changed what the schema 6 fingerprint covers (column styles, indexed
  palettes, `legacy_styles`) without a version bump. A plain merge would apply the
  column-style hashing to schema 7 too.
- `6bd37830` persists a new `#CALC!` value without a version bump, so the browser
  runtime and the headless service must run the same pin.
- Keep our `__capy_pending_contributors` filter.
- Compile breaks after porting: `GridGeometry::new(sheet, styles)` at three call
  sites and `chart_regions(sheet, styles, viewport)` in `xlsx-view-wasm`; the
  `apply_staged_update_v1` rename and `stage_updates_v1(.., baseline)`; both sides
  added a fourth `from_source` parameter; `WorkbookModel` literals need a `tables`
  field.
- New direct `hashbrown` dependency in `xlsx-render`, which reaches the viewer.
  serde_json `float_roundtrip` applies to every crate in the build. About +14.6k
  lines land in crates the viewer uses (7.3k of it drawingml) and +11.8k in
  editor-only crates, so measure both WASM builds.

Port list, in order:

1. Formula correctness and parsing: `57980319` (shared formulas, used by most real
   files), `ae8c931a` (authored values survive recalculation, and text spills into
   blank cells), `13016f29` (A:A references), `0f23444f` (ROW, COLUMN), `65f0ce9d`
   (OFFSET), `ddbfd29f` (MMULT), `35f9ceca` (TRANSPOSE), `6d28c9d9` (TANH,
   RANDBETWEEN), `6bd37830` (computed arrays), `d1c6a553` (table references),
   `0ba58e5a` (TEXT with 1904 dates), `e7f4868f` (Text-format entry). These change
   fingerprints, so land them after the golden test and Decision 1.
2. Files that failed to open, and rendering; the viewer gets these through
   xlsx-parse, xlsx-model and xlsx-render: `b56efb33` (negative column width or zero
   default row height), `0c5c4fcf`, `7f062e09`, `b4db492a`, `dfb5c824`, `3153c959`,
   `21d83b36`, `fb062332` (cell text at its true point size), `bfc3231e`. Fix the
   viewer build in the same change.
3. Commit path: `775f184f`, `apply_in_place` from `f855d02e`, the local decoder from
   `e8c4f5b3`.
4. Save path: `5f0f5c59` and `1acc67b0`, then `8a27bb76` only together with the
   derived row and column map.
5. Speed. Viewer `8317de05` (a 5k-merge sheet went from 97.6 to 8.9 ms per frame),
   `26ca667c`, `f17da1f9`, `187cebc9`; recalculation `f8ef0cc1`, `3f9da44f`,
   `79640495`, `7edce24a`; editor `9bfadb1e`, `703bdb37`.
6. The schema 7 rebuilds in the table above.
7. Citations: `bcc90ba0` in the viewer.
8. Editor API: `5206ccf3`, merged with our flush.

Skip the test from `9a6cdd5a`, `RestoreColStyles` in schema 7, and the
older-fingerprint lists in `0c5c4fcf`, `21d83b36` and `dfb5c824`.

Conflict notes:

- `authority.rs`, 14 hunks, medium. `Arc` base next to our `bootstrap_snapshot`;
  keep both fourth parameters; combine upstream's baseline and `hydrate_local_doc`
  with our gap detection and snapshot-based `effective`; fix the schema 6
  fingerprint comparison.
- `workbook.rs`, 11 hunks, medium. Keep `source_container` and `source_sha`; the
  baseline parameter plus our `supports_structure` guards; keep `is_pristine`; merge
  `save()` as our active-sheet mapping plus `rezip`. The preserved-axes problem is
  not a textual conflict and must be fixed by hand.
- `tests/schema_migration.rs`: drop the upstream test. `tests/workbook.rs`: easy.
- `xlsx-parse` `lib.rs` and `package.rs`: keep both sides' exports and accessors.
- `XlsxEditor.tsx` and its test: see the editor save API row.
- `betteroffice-xlsx` `lib.rs`, `xlsx-ops`, `xlsx-wasm` and
  `packages/xlsx/package.json` merge cleanly; regenerate the `.d.ts` files.

### Shared crates, build and licence

Take these as they come:

- Word-accurate line heights, including East Asian and substituted Latin and Korean
  fonts: `04d50bb2`, `1f82d046`, `91cd1d01`, `a409d437`, `12472707`. Trailing
  ideographic spaces: `1e46a6f0`. A rounding bug that silently dropped about 12% of
  tab stops: `bc0314bc`. `1f82d046` also edits `docx-edit/src/wasm.rs` and
  `docx-layout`.
- DrawingML: theme tint applied backwards (`d926fb0b`), 11 more preset shapes
  (`60c79dd0`), hexagon and star fixes (`3e0c3112`, `18e1f324`).
- Saves copy unchanged zip members verbatim: `5f0f5c59`, `6632da06`. `jp_llm2.pptx`
  saves in 713 ms today, 583 of them recompressing media. PPTX and XLSX then keep
  the original file bytes in memory per open session; the Node service already
  caches base bytes by SHA (128 MiB), and the export worker is short-lived.
- `7ee5c12b` drops zopfli (about 58 KB raw, 22 KB gzip per module), and `8b9f3635`
  makes opc's WASM bindings opt-in.
- TIFF decoding: on by default in `pptx-wasm` (+142 KB), through cargo features for
  DOCX (+105 KB). Our view crates need the feature enabled explicitly.
- Security bumps in dev dependencies (next, sharp, js-yaml, fast-uri, browserslist)
  and `6a1551aa` (rustls, only in the redact CLI). None reach code Capy ships.

Build notes:

- Upstream didn't touch `scripts/wasm.ts`, `scripts/wasm-cache-key.ts`,
  `build-{pptx,xlsx}-wasm.ts` or `.github/actions/wasm-toolchain`, so nothing clashes
  with `ef3a5fdf`. Versions are unchanged: wasm-pack 0.15.0, Binaryen `version_132`,
  Bun 1.3.14. The WASM cache key changes once.
- `bun install --frozen-lockfile` gains five workspaces (`apps/desktop`,
  `apps/fidelity`, `packages/vsdx*`) and the root devDeps vite 8.1.4 and playwright
  1.61.1. No install scripts run. Take upstream's `bun.lock`; our fork never changed
  it.
- Keep `prepare-betteroffice.mjs` on the three per-format builds. Upstream's new
  `build:wasm` also builds Visio.
- DOCX and PPTX now import `../../../../shared/media.ts`. The Vite aliases resolve
  it, but the watch list covers only `vendor/betteroffice/packages`, so edits under
  `shared/` won't hot-reload.
- `Cargo.toml`: upstream bumps every version from 0.1.0 to 0.2.0 and adds
  `pptx-raster` and nine Visio crates. Keep our `default-features = false` lines (a
  no-op on `ooxml-opc` after `8b9f3635`) and the `viewer-release` profile. For
  `Cargo.lock`, take upstream's and let cargo add our three view crates.
- `.gitignore` and `package.json`: keep both sides.
- Mislabelled upstream commits: `5069ad24` ("agents") changes DOCX and XLSX agent
  proposal review; `80341ac5` ("test(ci)") changes the `pptx-edit`, `pptx-wasm` and
  `xlsx-wasm` APIs; `6f5bcfd0` (native app) makes small edits to the React editors.
- Licence: `LICENSE`, `NOTICE`, `CLA.md` and `CCLA.md` are unchanged.
  `THIRD-PARTY-NOTICES` adds Carlito for vsdx-raster and a vendored yrs for the
  macOS app. Nothing affects a private fork used in a commercial app.

## Decisions needed

1. Engine-upgrade policy. Any seed-changing pin bump orphans saved XLSX rooms
   (problem 2). Option (a): clear source rooms and drafts on deploy while there is
   no production data. Option (b): before a bump, publish pending edits through the
   existing refresh handoff on the old engine, then deploy; this costs one reparse
   per file with unpublished edits and reuses the epoch remount and draft recovery
   that already exist. My recommendation is (a) now and (b) before launch, with
   golden seed tests either way. This is new policy for
   `human/frontend/office-files.md`.
2. PPTX schema: accept one version and drop the migrations. The 2026-09-13 decision
   kept old checkpoints reopening when binary media landed. This gives that up while
   there is no data to keep.
3. Optional and bigger: stop storing PPTX media in Yjs and reference parts of the
   fingerprint-checked source instead. It saves quota (problem 10) and room-join
   bandwidth, and replaces the 2026-09-13 binary-media design. The same question
   applies to dropping format entries for default-styled XLSX cells from the
   baseline.
4. PPTX comments: take upstream's Yjs comments, which export on save like our DOCX
   comments, or leave PPTX without comments.
5. Ingest-host egress rules (problem 4): an operator change in
   `deploy/ansible/ingest-host`, to record in `openwiki/deployment-runbook.md`.

## Work plan

Phase 1, Capy only, no pin change:

- [ ] Cached room size in `beforeHandleMessage`, latest-only draft writes, one queued
      save per room (problems 7 and 8).
- [ ] Office worker: per-call timeout, restart on engine error, idle and memory
      recycling, agent batch cap (problem 5).
- [ ] Source-room checks for unknown top-level roots and update size (problem 6).
- [ ] LibreOffice per-job profile and ingest egress rules (problem 4, Decision 5).

Phase 2, fork fixes on the current pin, each on a branch from `capy-ci`:

- [ ] DOCX viewer and editor fonts, shared request builder (problem 1).
- [ ] Diff-based `replace_text` for DOCX and PPTX (problem 3).
- [ ] The attached XLSX patch, then the `Arc` base (problem 9).
- [ ] Golden seed tests for all three formats (problem 2).
- [ ] Engine-side guards: DOCX update size cap, PPTX unknown-root rejection
      (problem 6).
- [ ] Missing hardening: `863b70ed`, `0eadb859`.

Phase 3, upstream ports one format at a time:

- [ ] DOCX port list, steps 2 to 9.
- [ ] PPTX port list, steps 1 to 5, schema per Decision 2.
- [ ] XLSX port list, steps 1 to 5 once Decision 1 is settled, then the schema 7
      rebuilds.
- [ ] Shared crates and build changes.

After each pin bump:

- [ ] `pnpm office:prepare`, `pnpm test`, the fork's `test:poc`, and
      `poc/scripts/check-viewer-split.ts`; compare WASM sizes with the previous pin.
- [ ] Capy follow-ups: PPTX citations inside tables, XLSX viewer build fixes, TIFF
      decoding in the viewers.
- [ ] Clear UAT source rooms if the bump changed seeds (Decision 1).
- [ ] Update `openwiki/frontend/office-files.md` (schema text),
      `openwiki/test-catalog.md`, and `human/frontend/office-files.md` for the
      decisions taken.

## Appendix A: XLSX single-materialization patch

File: `artifacts/2026-09-24-betteroffice-xlsx-single-materialize.patch`, made
against `capy-ci` at `dfa3f05e`.

```bash
cd vendor/betteroffice
git fetch origin capy-ci
git switch -c capy/xlsx-single-materialize origin/capy-ci
git apply ../../artifacts/2026-09-24-betteroffice-xlsx-single-materialize.patch
cargo test -p betteroffice-xlsx -p xlsx-wasm
```

What it changes:

- `stable::apply` materializes once before the op loop and carries each op's `after`
  model into the next op, instead of materializing again for every op.
- Staging a local update returns the materialized model with the structure
  (`StagedLocalUpdate.model`). It calls `materialize_internal(false)`, the same call
  `structure()` already made; for schema 7 the flag has no effect.
- The facade installs the staged model directly and passes the known structure to
  `install_model_with`, which removes two more materializations.

Tested in a clean worktree of `origin/capy-ci`: 211 tests pass. That is
`betteroffice-xlsx` with 32 unit tests, `chart_render` 21, `schema_migration` 1,
`stable_collaboration` 15 and `workbook` 121, plus 21 in `xlsx-wasm`. Problem 9 has
the measured effect. Before landing, run the fork's `rust:check` (fmt, clippy, full
tests) and a WASM build.

## Appendix B: how the numbers were measured

- Native release builds of the `capy-ci` crates (opt-level s, no LTO) in a scratch
  worktree on a 4-core container.
- XLSX: synthetic 10-column sheets of 10k, 50k and 100k cells. One-cell commit,
  20-cell paste, one-cell remote update, and a full save through the checkpoint
  path.
- PPTX: `bench/parsers/fixtures/docs/jp_llm2.pptx`, 24.4 MB with 21 MB of media.
- DOCX: the fork's `apps/demo/public/betteroffice-demo.docx` through the viewer's
  code path, with and without registered fonts, plus the timing split on a 14-page
  file.
- Node: the encode, decode and encode cost of the source-room size check, and draft
  size from base plus state bytes.

The probe code was not committed, because measurement code belongs under `bench/`.
A `bench/office` family is the place for it if you want to track these numbers.

## Appendix C: not verified

- Whether this LibreOffice version fetches external resources during
  `--convert-to`, and what the app host's private listener at `10.77.0.1:8080`
  exposes to the ingest host.
- The editor's runtime font fallback; read from code, not run.
- WASM sizes after any port.
- Items marked reported, and the line numbers in the per-format tables.
