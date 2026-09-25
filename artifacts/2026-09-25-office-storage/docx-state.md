# Shrinking the DOCX editing state

Date: 2026-09-25. Engine: `vendor/betteroffice` at `origin/capy-ci` = `dfa3f05e`, upstream
checked at `0ba58e5a`. Builds on `scratchpad/storage-report.md` (same test files and
accounting). Nothing in the Capy tree, the submodule or any live service was changed. The two
scratch worktrees used for native prototypes are removed. Scripts, generated files, prototype
patches and raw outputs are in `scratchpad/docx-shrink/` (called `docx-shrink/` below).

"Charged after first Edit open" is source + state + baseline + 2 bytes, as in the storage
report. All state sizes below come from the real engine: a native build of the fork with the
prototype applied, seeding with a 45-bit client id like the headless runtime. With the
prototype switched off it reproduces today's bundle seed sizes to the byte (443,838 for
book-30p, 5,669,857 for images-10). Numbers marked "estimate" come from a Yjs simulation that
rebuilds the stored stories with one component removed.

## 1. Recommendation

Make two fork changes, after the upstream merge, in the seed-changing batch that already
carries PPTX media, the XLSX baseline and the raw-XML embeds:

1. **Store `_originalRunBoundaries` only for paragraphs that need it.** Keep the cache only
   when a run carries something that merging equal-formatted runs would lose: a tracked
   formatting change (`propertyChanges`), note marks, flow breaks (upstream's `breaks`) or an
   empty run. Drop `formatting` from non-empty runs, because the export never reads it for
   them. That's about 17 lines in `crates/docx-edit/src/seed.rs` (patch checked against
   upstream's `seed.rs`) and the same rule in `packages/docx/src/yrs/documentToYrs.ts`.
   - Effect: the state drops 39% on the generated books and 51-54% on the Word-like books.
   - The export is byte-identical for every test file except the Word-like book. There, runs
     that Word split only for rsids are merged (803 → 299 runs). Per-character formatting
     matches over all 94,844 characters, and all 9 tracked formatting changes survive.
   - Effort: S.
2. **Keep source images out of the state.** The image embed's `src` becomes `media:<part path>`
   (for example `media:word/media/image3.jpeg`). The bytes come from the fingerprint-checked
   source package that every open already parses, the same approach as the decided PPTX media
   change. Files touched:
   - `crates/docx-edit/src/engine.rs`: after lowering, the engine swaps the reference for the
     package's display data URL. The display list and the renderer see exactly what they see
     today.
   - `crates/docx-edit/src/seed.rs`: writes the reference.
   - The browser editor session and the viewer: attach the package media when they open.
   - `shared/office-checkpoint.ts`: the baseline resolves references from the attached package.
   - `packages/docx/src/yrs/rebaseCheckpoint.ts`: leaves references alone.
   - `crates/docx-parse/src/serializer/s13.rs`: binds a reference to the owner part's
     relationships when an image moved between body, header and notes.
   - Effect: images-10 goes from 5.67 MB to 71 KB of state, and its first-open charge from
     2.36x to 1.03x.
   - Checks: the unedited export is byte-identical, the baseline image hashes are identical,
     and a rebase with a later edit works.
   - Effort: M.

Binary images, which the developer asked about, do cost 1.0x: images-10 would charge 2.03x
instead of 2.36x (estimate). But binary needs the same reader changes as references, and it
still stores every source image once more on top of the source package. For source images,
references are strictly better. Binary only makes sense for images a user inserts in the
editor. For those I recommend keeping today's data URL (1.33x) and turning them into
references at the next publication, when they become package parts (a few lines in the
rebase). Section 3.3 has the details.

Expected multipliers after the recommended set (charged after first Edit open):

| File | Source | Today: state / charged / x | After: state / charged / x | + fixed 1-byte seed client id (optional, 3.5) |
| --- | ---: | --- | --- | ---: |
| book-30p.docx | 47,963 | 443,838 / 636,113 / **13.3x** | 269,482 / 461,757 / **9.6x** | 9.1x |
| book-300p.docx | 358,686 | 4,505,210 / 6,270,338 / **17.5x** | 2,732,617 / 4,497,745 / **12.5x** | 11.8x |
| images-10.docx | 4,191,049 | 5,669,857 / 9,902,092 / **2.36x** | 70,949 / 4,303,184 / **1.03x** | 1.03x |
| book-30p-word.docx (new, Word-like runs) | 53,242 | 658,936 / 858,764 / **16.1x** | 321,799 / 521,627 / **9.8x** | not run |
| book-300p-word.docx (new) | 420,050 | 6,644,313 / 8,485,842 / **20.2x** | 3,071,651 / 4,913,180 / **11.7x** | not run |
| opaque-objects.docx | 66,650 | 93,444 / 175,107 / 2.63x | 37,074 / 118,737 / 1.78x | not run |
| feature-rich.docx | 39,174 | 57,580 / 109,769 / 2.80x | 45,064 / 97,253 / 2.48x | not run |
| lesson.docx | 37,406 | 11,804 / 52,775 / 1.41x | 9,076 / 50,047 / 1.34x | not run |

Baselines are unchanged by both changes (book-30p 144,310 B, book-300p 1,406,440 B,
images-10 41,184 B). The first publication's re-seed growth drops from +14% to +6% (books)
and from +26% to +5% (Word-like book), section 3.7.

Text documents stay around 10-13x, because the text is stored twice: once in the state and
once in the baseline, uncompressed, plus resolved formatting on every paragraph and run. With
the fork alone, the remaining levers reach about 7-8x (estimate, section 3.9). Getting under
about 4x needs one of two things. Either store compressed state and baseline (storage report
option A: book-30p would charge 3.2x and book-300p 3.7x on top of this set, measured gzip), or
store only the edits against a deterministic seed. The DOCX seed is byte-deterministic for a
fixed client id (checked, section 3.5).

## 2. Open questions for the developer

1. **Merge order.** Both changes touch `seed.rs`, and the image change touches `s13.rs`; both
   files conflict in the upstream merge. I recommend implementing them on the merged branch.
   The boundary rule is backward compatible and could land on `capy-ci` first, but then it
   would conflict again during the merge.
2. **Images the user inserts.** Options:
   - Keep data URLs until the next publication (recommended).
   - Store them as binary now (1.0x, matches PPTX's "inserted pictures stay binary").
   - Upload them as editor assets. Not recommended: it needs a new host protocol, network
     access at insert time, asset reference tracking for source states, and B2 reads in the
     headless export.
3. **Picture fills inside shapes and VML images.** These carry data URLs inside `shapeJson`
   and were not covered or measured, because no fixture has them. Include them in the
   reference change or do them later?
4. **Fixed 1-byte seed client id.** It saves 9-10% of the new state (measured). The cost is a
   contract: the seed must be deterministic per engine pin, and every reseed with a different
   seed must bump the epoch. The planned upgrade already does that, and PPTX already uses a
   fixed bootstrap id. Accept?
5. **Lazy baseline.** Capy-side, no seed change: charge the baseline only from the first
   content edit, instead of at the first Edit open or AI `inspect`. That saves 144 KB / 1.41 MB
   / 41 KB for files that are opened but never edited.
6. **Next lever for text documents.** Compression (option A), delta-from-seed storage, or the
   fork model changes (`defaultTextFormatting` from a style table, then style-relative run
   marks)? The model changes buy about 25-40% of the state for L effort and carry export
   fidelity risk.
7. **Corpus.** The Word-like fixture is synthetic: rsid-split runs, proofErr, rFonts hints,
   w:lang, and a few `w:rPrChange`. Should real Word and Google Docs course files, including
   CJK ones, be measured before shipping? I didn't use any personal files outside the
   repository.
8. **Adjacent bugs, not storage, found while measuring.** File them separately?
   - Edits to indent, spacing, borders, tabs or keep settings are dropped at export for every
     paragraph whose source had direct paragraph properties. A `pStyle` alone counts.
   - The export drops `w:lang` and `w:rFonts w:hint` on every run.
   - Every text edit before an image records a "move" effect for each later image.

   Section 3.10 has the evidence.

## 3. Evidence

### 3.1 What the state is made of

JSON bytes per component, measured by walking the stored Yjs doc (`docx-shrink/compose.mjs`).
The rest of each state is Yjs structure: item headers, origin ids, map keys and value tags.
Stored bytes differ from JSON bytes by about ±10%, so the exact effect of each change is in the
later sections.

| State | Total | Text | `_originalRunBoundaries` | `defaultTextFormatting` | Run marks (fontFamily) | Image `src` |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| book-30p today | 443,838 | 94,867 | 179,594 | 51,957 | 52,331 (34,098) | 0 |
| book-30p after | 269,482 | 94,867 | 0 | 51,957 | 52,331 (34,098) | 0 |
| book-30p-word today | 658,936 | 94,477 | 412,284 | 54,567 | 54,758 (35,708) | 0 |
| book-30p-word after | 321,799 | 94,477 | 42,880 | 54,567 | 54,758 (35,708) | 0 |
| images-10 today | 5,669,857 | 20,854 | 41,045 | 15,939 | 13,073 | 5,559,370 |
| images-10 after | 70,949 | 20,854 | 0 | 15,939 | 13,073 | 297 |

The book-30p boundary cache is 95,303 B of repeated run text, 77,864 B of `marksKey` and
1,113 B of original run formatting. On the Word-like book (4.5 runs per paragraph, as Word
writes them) it is 96 KB of text, 281 KB of `marksKey`, 11 KB of formatting and 1.5 KB of
`propertyChanges`. So real Word files make the cache worse than the generated books did.

### 3.2 `_originalRunBoundaries`

**What it is for.** The seed (`seed.rs:1588 run_boundary`, `:1908 paragraph_units`, `:1875`)
records, on each paragraph mark, every source run's text, its resolved marks key, its direct
formatting and its `rPrChange`. The only reader is the export: `yrsToDocument.ts:1056
restoreOriginalRuns`, called from `paragraphFromStory` (`:1272`).
- If the paragraph still has the same text and the same per-run marks, the export rebuilds the
  source run segmentation. Otherwise it merges adjacent text with equal marks into one run.
- Restored non-empty runs take their formatting from the live marks, not from the cached
  formatting (comment at `:1102`). The cached `formatting` is read only for empty runs.
- What the cache really preserves is what has no story unit: tracked formatting changes, note
  number marks, empty runs, and upstream's `breaks` (page breaks inside runs, `0f1ab4a7`).
  Beyond that it only reproduces run splits.
- It is never read for paragraphs containing embeds or links (`restoreOriginalRuns` bails),
  which includes every paragraph with a footnote reference.

Other readers and writers:
- The TS seeder `documentToYrs.ts:910` writes the same cache.
- The baseline's per-paragraph formatting hash covers all paragraph properties
  (`office-checkpoint.ts` `docxEntries`), so the cache is hashed too.
- A paragraph split copies the cache to both halves (`ops/paragraph.rs` split keeps "full
  properties"). There, the text check always fails and the cache is dead weight.
- No Rust code and no Capy code reads it.

**Options measured** (`docx-shrink/export_check.mjs`, `verify_states.mjs`, native prototype):

| Option | book-30p state | Word-like 30p state | Export effect |
| --- | ---: | ---: | --- |
| Today | 443,838 | 658,936 | reference |
| Drop entirely | 269,482 (no paragraph here needs it) | about 284 KB (estimate) | Word-like: runs merged, but 9 of 9 `w:rPrChange` lost. Rejected. |
| **Store only when needed (native prototype)** | **269,482** | **321,799** | book-30p, images-10, opaque-objects, feature-rich and lesson: all parts byte-identical. Word-like: `document.xml` 803 → 299 runs, per-character run properties identical (0 mismatches in 94,844 characters, `char_format_check.mjs`), `rPrChange` 9 → 9. |
| Derive from the source at export (not built) | 269,482 | about 284 KB (estimate) | Keeps today's segmentation exactly. Needs a second pass over the source at every export, a new wasm export, and a paraId / generated-id / `sourceBinding` mapping. More code for the last 0-38 KB. |

What merging loses that restoring kept: only run splits. The current export already drops
rsids, `w:proofErr`, `w:lang` (100 → 0), `w:rFonts w:hint` (196 → 0) and most
`lastRenderedPageBreak`s, with or without the cache (`docx-shrink/out-*.document.xml`). The
Word-like export also gets smaller: 57,179 → 52,084 bytes zipped, because fewer runs repeat
their full resolved run properties.

Paragraphs that keep the cache on the Word-like book weigh 42.9 KB (13 of 177 paragraphs). If
documents full of tracked formatting changes matter, the kept caches can be made compact
later: lengths instead of text, and marks keys without their nulls.

Remaining checks:
- **Rebase and effects.** With the new seed, a rebase with a later agent edit works on the
  Word-like book and yields only the edited paragraph's two effects (`verify_refs.mjs`).
  Comparing an old-seed baseline with a new-seed state gives a formatting effect on every
  paragraph (168 of 168), so baselines must never cross seeds. That can only happen through an
  in-place reseed without a baseline reset, which the planned upgrade doesn't do.
- **Upstream.** The rule applied to upstream's `seed.rs` (`docx-shrink/prototype-upstream-boundaries.patch`)
  passes 21 of 23 seed unit tests. The two failures assert the cache where the export never
  uses it:
  - `raw_inline_nodes_leave_run_boundaries_intact`: equal runs around a raw node. Upstream's
    `restoreRawInlines` splits the merged run at the node's offset anyway.
  - `reused_run_units_keep_comments_out_of_saved_boundaries`: a paragraph with a footnote
    reference.

  Upstream's `fidelitySave.test.ts:92` asserts the same; `pageBreakSave.test.ts:136` (breaks)
  keeps its cache under the rule. The bun tests were not run.
- **Seed output** changes, so the golden seed tests must be updated. Old states still export as
  today, and new states export the same under an old engine. Correctness doesn't depend on the
  reseed, but existing rooms only shrink when they are reseeded or published.
- **CPU.** The smaller state also cuts headless work (single runs, shared machine):
  - `officeBaseline`, which every save runs: book-300p 761 → 594 ms, Word-like 300p
    1,188 → 808 ms.
  - Export: 758 → 576 ms and 1,233 → 861 ms.

### 3.3 Images

**Today.** `media.rs:33` builds `data:<mime>;base64,…` for every `word/media/*` part. The parser
puts it in the image's `src`, and `seed.rs:1054` copies it into the image embed. Readers of `src`:
- Layout (`bridge/mod.rs:916 lower_image_values`) → display list → canvas resolver, which
  decodes only `data:`/`blob:` and ignores everything else, so there is no network fetch
  (`canvasImageResolver.ts`).
- Export: `yrsToDocument.ts:585` → `s13.rs:645 process_image_part`, which keeps the rId when
  the part's bytes equal the data URL (`:681`), otherwise writes a new part.
- The baseline and `resolveAsset` for captions (`office-checkpoint.ts:293 assetFromDataUrl`).
- The rebase (`rebaseCheckpoint.ts:232`, which throws on anything but a data URL, and binds
  rIds by base64).
- The editor's image insert (`useFileIO.ts`: a data URL with a temporary `rId_img_*`).
- No Capy code reads it.

**Options for source images** (images-10: 4,169,330 image bytes, 10 images):

| Option | State | Charged (x) | Reader changes |
| --- | ---: | ---: | --- |
| Today (data URL) | 5,669,857 | 9,902,092 (2.36x) | none |
| Binary `Uint8Array` (estimate) | about 4,280,000 | about 8,512,000 (2.03x) | Layout needs a string for the display list, so it must base64-encode on every lowering or cache the result. Export has to rebuild a data URL. Baseline and rebase read bytes. The JSON story segments carry a Buffer as a number array unless a new byte accessor is added. |
| **Package reference `media:<part>` (native prototype)** | **70,949** | **4,303,184 (1.03x)** | Layout resolves through a table the session already has when it opens. The export needs no change for images that stay in their story. Baseline and rebase need 2 small changes. |

Prototype, all measured:
- **Seed** (`prototype-ci.patch`): builds a data-URL → part-path table from the package media
  before the envelope is dropped, then rewrites image embeds. Upstream already clears
  `media_entries` at the start of `seed_parsed_docx`, so the table goes just before that.
- **Rendering.** `EngineSession::set_media` plus a pass after lowering in `lower_story_into_cache`
  (`engine.rs:619`, the only production lowering path). Every image resolves to the package's
  display data URL: 10/10 on images-10 and 1/1 on opaque-objects (the OLE preview), none left
  unresolved. The wasm `open_docx` and the viewer (`docx-view-wasm/src/lib.rs:15`) need to
  attach the table they already parse. Memory stays about the same: the data URLs move from
  Yrs into the session table.
- **Export** with references through today's runtime: byte-identical packages for images-10
  and opaque-objects. The serializer skips non-data sources and keeps the rId.
- **Baseline, asset and rebase** through a copy of today's runtime with two small edits
  (`prototype-bundle.patch`):
  - `docxEntries` resolves `media:` from `base.package.media`.
  - The rebase skips `media:` images. `validateExportBacking` already guarantees that the
    export keeps every source part and relationship.

  Results: image SHA-256 values identical (10/10), and `resolveAsset` returns the package part.
  A publication with a later agent edit rebases to a 76,563 B state (5,675,631 B today) with
  no data URLs. The edit survives, all 10 media parts are kept, and the effects are identical
  to today's. Unpatched, the baseline throws: "Image object does not contain supported
  embedded image bytes".
- **Moves between parts.** An image moved from body to header or notes keeps an rId from the
  other part's relationships. Today the byte comparison catches this. The fix: in
  `process_image_part`, a `media:` source keeps its rId only if it targets that part in the
  owner's relationships, otherwise it gets a relationship to the existing part (no new bytes).
  About 20 lines, written against upstream's `RelationshipsIndex` (`7aa1ba32`). Not prototyped.

Side benefits:
- Every client downloads 71 KB instead of 5.67 MB on Edit open, and IndexedDB drafts shrink
  the same way.
- The per-update document copies in the collaboration service shrink.
- Baseline and export CPU drop: images-10 baseline 393 → 335 ms, export 676 → 562 ms.
  Single runs on a shared machine.

**Images the user inserts** arrive as data URLs from the toolbar (no paste path exists). They
become package parts at the next publication. After a plain publication the reseed makes them
references. After a rebase they can too: the rebase already finds the part by bytes to set the
rId, and it can set `src` at the same time. Until then they cost 1.33x. Binary would cost 1.0x,
but needs the byte reader paths listed above. So it only pays off if users insert many large
images between publications.

**Upstream:**
- Upstream stores the same data URLs: its images-10 seed is byte-for-byte the same size.
- Its TIFF change (`36dab048`) puts a PNG display copy into the media table. With references,
  that copy is what layout shows, the export keeps the TIFF part, and the TIFF fixes the review
  lists for the byte comparison and the rebase are no longer needed for source images.

**Upgrade.** This change must ride the planned upgrade with the epoch bump:
- An old engine paints `media:` images as blank boxes, and old baseline code throws.
- A new engine reads old data-URL states unchanged.

### 3.4 Resolved paragraph and run formatting

**What they are.** The seed resolves styles once. Every paragraph mark gets
`defaultTextFormatting`: docDefaults + paragraph style + default character style + the
paragraph mark's own run properties (`seed.rs` `paragraph_attrs`). Every run gets marks
resolved from docDefaults, paragraph style, run style and direct formatting (`run_marks`).
The engine has no style table after seeding: layout, toolbar and ops all read these resolved
values.
- **Readers of `defaultTextFormatting`:**
  - layout (`bridge/mod.rs:2888` paragraph defaults, `:2899`/`:2939` fill missing run font
    family, size, cs flags and language)
  - split (`ops/paragraph.rs` carries font, size and colour)
  - `set_paragraph_attrs` (wasm)
  - toolbar (`yrsToolbar.ts:73`)
  - the baseline hash

  The export doesn't read it.
- **Readers of run marks:** layout, the export (`createTextRun` writes them as `w:rPr` on
  every run), the toolbar, typing inheritance, `restoreOriginalRuns`, and the baseline hash.

Options, simulated on the new state (estimates; the engine stores numbers as 8-byte floats,
so its savings are likely a bit larger):

| Option | book-30p | book-300p | Word-like 30p | Cost and risk |
| --- | ---: | ---: | ---: | --- |
| `defaultTextFormatting` omitted when it equals the style's resolved value, derived at read time from a style table the session builds at open | -49 KB (-18%) | -0.50 MB | -52 KB | M-L. Layout, toolbar and split read through the table. Seed change. Conflicts in `seed.rs` and the bridge. |
| Run marks equal to the paragraph defaults omitted (fontFamily, fontSize, kerning) | -57 KB (-21%) | -0.58 MB | -60 KB | L. The layout filler already fills font and size, but the export would then write runs without `rFonts`/`sz`. That is correct only if the omitted value came from styles and not from the paragraph mark's own run properties ("everything Arial" documents), and toggle properties (bold, italic) follow XOR rules in Word. Needs separate style-only and mark defaults. |
| Both | -106 KB (about 163 KB state) | -1.08 MB | -111 KB | as above |

Not in the recommended set. Together they are the next 35-45% of a text document's state, but
they change the editing model upstream designed. `_originalFormatting` (the paragraph's source
properties) is small on first open (2.3 KB on book-30p).

### 3.5 Yjs overhead

This is the rest of the state: item headers, origin ids, parent keys for every paragraph-mark
property, and value tags. It scales with the item count, which the two changes barely touch
(168 fewer items on book-30p).
- **Client id.** The seed's 45-bit random client id is repeated in every item's origin. With a
  1-byte id the new state drops 269,482 → 244,426 (-9.3%) on book-30p and 2,732,617 → 2,467,975
  (-9.7%) on book-300p (measured). Today's state would drop 443,838 → 417,774.
- **Determinism.** The DOCX seed is byte-deterministic for a fixed client id: two runs give the
  same SHA-256 for the Word-like book and for images-10. A fixed seed id therefore also makes
  a duplicate seed idempotent, as PPTX's fixed bootstrap id does. The risk the review raised
  for PPTX (stale drafts silently merging into a different seed) is covered only if every
  reseed that changes content bumps the epoch.
- **Update v2 encoding** saves 6-9% (simulated), but every reader of stored states would have
  to switch. Not recommended.

### 3.6 The baseline's full text

**What it is for.** One text entry per paragraph (id, label, full text, position) plus one
formatting-hash entry.
- `compareBaselines` detects changes, and pending effects carry `before` and `after` texts.
- The chat agent reads those texts as pending edits (`pipeline/retrieval/pending.py`).
- Auto refresh counts their tokens (`effectTokens`, Go `sourceEffectTokens`).
- Captions key on `imageSHA256`.

So it can't be dropped or replaced by hashes unless `before` comes from somewhere else.

| Option | book-30p | book-300p | Notes |
| --- | ---: | ---: | --- |
| Today | 144,310 | 1,406,440 | text values are 95 KB and 904 KB of it |
| 16-hex formatting hashes, labels derived from position | 124,534 (-14%) | 1,202,591 (-14%) | S-M, fork and Capy readers |
| Lazy: compute at the first content edit from the stored (still seed) state | 0 until the first edit | 0 until the first edit | S-M, Capy only (`sourceDocuments.ts` initialize and save, Go validation). No seed change. |
| gzip (storage report option A) | 48,047 | 455,018 | quota policy question |

It can be derived from the source only while no content edit has happened. After a
publication with later edits, the indexed state is the rebased lineage and is not stored.

### 3.7 First-publication growth

**Cause.** The exporter writes each run's resolved marks as `w:rPr` and, for paragraphs without
direct properties, the style-resolved spacing and indents as `w:pPr` (`saveFormatting.ts:45`).
Re-seeding the export stores these as bigger boundary `formatting` (runs) and a new
`_originalFormatting` (+12 KB on book-30p).

Measured with the native engine:

| File | seed(A) → seed(B) today | Growth | seed(A) → seed(B) after | Growth |
| --- | --- | ---: | --- | ---: |
| book-30p | 443,838 → 505,143 | +13.8% | 269,482 → 285,692 | +6.0% |
| book-300p | 4,505,210 → 5,152,827 | +14.4% | 2,732,617 → 2,886,126 | +5.6% |
| book-30p-word | 658,936 → 828,978 | +25.8% | 321,799 → 339,186 | +5.4% |
| images-10 | 5,669,857 → 5,685,954 | +0.3% | 70,949 → 76,234 | +7.4% (5 KB) |
| feature-rich | 57,580 → 70,847 | +23.0% | 45,064 → 52,932 | +17.5% (tables) |
| lesson | 11,804 → 15,417 | +30.6% | 9,076 → 10,970 | +20.9% (tables) |

What's left comes from paragraph and table properties. Removing it means making the exporter
write back the source properties when nothing changed. That is fidelity work, tied to the
dropped-edit bug in 3.10, and small for storage.

### 3.8 Upstream

- **Seed size and composition.** Upstream `0ba58e5a` seeds the same things, built natively
  (`docx-shrink/upstream-sizes.jsonl`): book-30p 443,118, book-300p 4,493,210, Word-like
  657,688, images-10 5,669,857, opaque-objects 95,920 (+2.6%, chart `drawingXml`). The
  boundary cache, defaults, marks and data URLs are all identical.
- **The merge won't shrink anything.** The new resolved paragraph attributes
  (`autoSpaceDE/DN`, `snapToGrid`, line-based spacing) didn't appear in these files. They may
  add bytes on CJK documents that set them. Not measured.
- **Lossless raw-XML replay (`1d0f41d9`).** Restores foreign inline markup from the base
  paragraph at export. That markup is never stored in Yjs, and it works without the boundary
  cache: the raw node splits the merged run at its offset.
- **`7aa1ba32`.** This is where the reference binding for images goes (`RelationshipsIndex`).
- **TIFF display copies (`36dab048`).** Covered in 3.3.
- **Projection cache (`28867ce8`).** In-memory only, so no storage effect. With references it
  caches short strings instead of data URLs.
- **Selective save (`28bb033f`).** Could keep untouched paragraphs byte-exact at export. But it
  refuses on paragraph-count changes and documents without `w14:paraId`, so it is not a general
  answer to the growth.

### 3.9 Ranking by bytes saved per effort

| Rank | Change | Effort | Saved (measured unless marked) | Seed change / upgrade | Main risk |
| ---: | --- | --- | --- | --- | --- |
| 1 | Boundary cache only when needed | S | book-30p -174 KB (-27% of charge), book-300p -1.77 MB (-28%), Word-like 30p -337 KB (-39%), 300p -3.57 MB (-42%); re-seed growth 14-26% → 5-6% | yes; backward compatible; batch with the upgrade | export run splits only |
| 2 | Source images as package references | M | images-10 -5.60 MB (2.36x → 1.03x); OLE preview -41 KB; images the user inserts leave the state at publication | yes; must ride the epoch bump | unresolved reference paints blank (test); image moved between parts (s13 binding) |
| 3 | Fixed 1-byte seed client id | S | -9.3% / -9.7% of the new state | yes; epoch contract | stale-draft merge if a reseed skips the epoch bump |
| 4 | Lazy baseline until first content edit (Capy) | S-M | the whole baseline for never-edited opens (144 KB, 1.41 MB, 41 KB) | no | first-edit latency (one baseline computation) |
| 5 | `defaultTextFormatting` via style table | M-L | about -49 KB / -0.50 MB (estimate) | yes | layout and toolbar parity; merge conflicts |
| 6 | Baseline compaction | S-M | -14% of the baseline | no (format bump) | none notable |
| 7 | Style-relative run marks | L | about -57 KB / -0.58 MB (estimate) | yes | export fidelity (toggles, paragraph-mark properties) |
| 8 | Binary images the user inserts | M | -25% of inserted image bytes until publication | yes | Buffer reader paths |

Beyond the recommended set (1+2) for book-30p / book-300p:
- Adding 3: 9.1x / 11.8x.
- Adding 3, 5, 6 and 7 (estimate): about 6.6x / about 8.3x.
- 1+2 with lazy baseline at first open: 6.6x / 8.6x.
- 1+2 with gzip on state and baseline: 3.2x / 3.7x.

### 3.10 Adjacent findings (not storage, pre-existing, shared with upstream)

- **Paragraph edits lost at export.** `paragraphAttrsToFormatting` (`saveFormatting.ts:45`;
  upstream identical plus `autoSpaceDE/DN`) returns the source properties with overrides only
  for alignment, numbering, style, pageBreakBefore, widowControl and bidi. Any paragraph with
  `_originalFormatting`, which a `pStyle` alone creates, loses indent, spacing, border, shading,
  tab and keep edits at export. Measured (`para_edit_check.mjs`):
  - Setting `indentLeft=1234` and `spaceAfter=777` on book-30p's Title paragraph exports
    `<w:pPr><w:pStyle w:val="Title"/></w:pPr>`.
  - The same edit on a Normal paragraph without direct properties exports both values, plus the
    style's line spacing as direct formatting.
- **Language and font hints.** The export drops `w:lang` and `w:rFonts w:hint` on every run,
  because marks don't carry them. This matters for Japanese documents.
- **Image move effects.** Baseline image positions are story offsets, so one text edit before
  10 images records 10 `image:move` effects (identical today and with references).

## 4. Method and files

- **Fixtures.**
  - The storage report's files, plus `docx-shrink/files/book-{30,300}p-word.docx` from
    `gen_wordlike.py`. These use the same text model with Word's run structure: 2-6 rsid runs
    per paragraph, `w:proofErr`, `rFonts w:hint`, `w:lang`, `_GoBack`,
    `lastRenderedPageBreak`, and about 2% of runs with `w:rPrChange`.
  - Repository fixtures `lesson.docx`, `feature-rich.docx` and `opaque-objects.docx`.
- **Native prototype.**
  - A scratch worktree at `origin/capy-ci` with environment switches in `seed.rs` and
    `engine.rs` (`prototype-ci.patch`).
  - The example `shrink_probe.rs.txt` seeds, writes the state (`docx-shrink/states/*.bin`),
    attaches media, and lowers every story.
  - A second worktree at upstream `0ba58e5a` (`seed_size.rs.txt`, `prototype-upstream-boundaries.patch`,
    `test-up.log`).
  - Debug builds, `-j 4`/`-j 6`, one at a time.
- **Headless checks.** Today's bundle (`vendor/betteroffice/shared/office-checkpoint.mjs`,
  read-only) exports and baselines the native states (`verify_states.mjs`, `export_check.mjs`,
  `char_format_check.mjs`, `roundtrip_weigh.mjs`). A patched copy in `docx-shrink/bundle/`
  covers baseline, asset and rebase with references (`verify_refs.mjs`).
- **Simulations.** `options.mjs` rebuilds the stories in Yjs 13.6.31 with one component removed.
  The rebuild without changes comes out 7% smaller than the engine (it stores integers
  compactly), so the report states each simulated saving as a difference, not a ratio.
- **Raw outputs.** `native-sizes.jsonl`, `verify.jsonl`, `upstream-sizes.jsonl`,
  `options-*.json`, `rt-*.json`, `out-*.document.xml`.
- **Caveats.**
  - Fixtures are synthetic and there's no CJK or Google Docs corpus.
  - Timings are single runs on a machine shared with other probes.
  - Browser painting of resolved references wasn't run. The native lowering check covers the
    display list input.
  - The s13 binding for images moved between parts is designed, not built.
  - Upstream bun tests weren't run.
