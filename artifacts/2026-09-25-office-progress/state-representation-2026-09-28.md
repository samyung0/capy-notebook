# DOCX/PPTX editing state: full snapshot or changes over the seed?

Investigation only. No repo file was changed. Scripts and raw outputs are in this
folder (listed at the end). Sizes are decimal KB unless given in bytes.

## 1. Short answer

No, DOCX and PPTX do not need to store the full editing snapshot, with one exception.

- **Every state that grew from seed(base)** can be stored as
  `Y.encodeStateAsUpdate(roomDoc, Y.encodeStateVectorFromUpdate(seed))`: the changes
  over the seed. Over all 18 fixtures, seed(base) plus that diff rebuilt a state whose
  bytes were identical to the full state. The rebuild matched in the same process, in
  another process and in another runtime (Bun with the TS source, Node with the
  production `.mjs` bundle). Exports and baselines matched too, and so did 11 sessions
  of 300 mixed edits and the browser view worker's composition.
- A one-edit row drops from **1.5–186 KB** (pglz) to **137–984 bytes**. Across all
  12 DOCX/PPTX fixtures together, it drops from 543.9 KB to 3.2 KB. After 300 mixed
  edits over 12 sessions, the row is **6.7–15.3 KB** instead of 8.4–127.6 KB.
- **The exception is a state made by a publication rebase.** When a save lands during
  a publication, the rebased DOCX state keeps the lineage of the *old* base's seed.
  The rebased PPTX state is re-seeded from the latest save and carries changed package
  parts as raw bytes. Neither is seed(export) plus a diff, and that is why they need
  the stored `indexed_baseline`. XLSX's rebase already lands on seed(export), and its
  rebased state diffs cleanly.
- Snapshots do not bloat during a long epoch. They start bloated: 94–99% of a one-edit
  DOCX/PPTX state is the seed. Later growth is roughly linear, about 30–160 bytes per
  edit raw.

**Recommendation:** store the changes over seed(base) for every Office state whose
lineage is seed(base). Keep a seed hash with each stored diff and check it on every
rebuild. Rebased DOCX/PPTX states stay full for now. As a follow-up, give DOCX and
PPTX an XLSX-style rebase onto seed(export), so that rebased states are also small
diffs and stored baselines go away. Four points need a decision from you (section 8).

## 2. What the DOCX and PPTX Y.Docs hold (task 1)

Method: `seed_anatomy.ts` applies each seed to a JS Y.Doc and walks the struct store.
It sizes every item exactly with `item.write(UpdateEncoderV1)`. The sum of item sizes
is within 0.3% of the seed size.

| File | Source | Uncompressed XML | Seed | Seed zlib | Items | Text chars | Map entries | Format attrs | Text |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| exchange-plan.docx | 65.7 | 270.9 | 313.0 | 36.9 | 4,184 | 6,295 | 75% | 18% | 6% |
| book-30p.docx | 48.0 | 191.2 | 259.2 | 57.7 | 3,375 | 94,867 | 32% | 31% | 37% |
| feature-rich.docx | 39.2 | 827.8 | 42.3 | 6.7 | 795 | 1,014 | 64% | 33% | 3% |
| images-10.docx | 4,190.9 | 106.8 | 67.3 | 15.6 | 1,028 | 20,854 | 39% | 29% | 31% |
| lecture.pptx | 311.2 | 436.2 | 109.1 | 18.6 | 2,825 | 7,694 | 77% | 8% | 10% |
| deck-50.pptx | 94.2 | 219.2 | 161.2 | 35.8 | 4,330 | 29,999 | 72% | 0% | 22% |
| jp_llm2.pptx | 24,390.7 | 1,549.6 | 714.7 | 134.2 | 21,225 | 24,808 | 68% | 19% | 8% |
| course-guide.xlsx | 145.4 | 1,226.0 | 24.3 | 3.9 | 142 | 0 | 100% | 0% | 0% |
| cells-100k.xlsx | 836.4 | 4,322.0 | 4.2 | 1.1 | 38 | 0 | 99% | 0% | 0% |

Why a DOCX/PPTX state is larger than its source:

1. **The source is DEFLATE-compressed XML; the seed is an uncompressed model.**
   exchange-plan's seed (313 KB) is about the size of its uncompressed XML (271 KB),
   and the seed compresses to 37 KB with zlib.
2. **DOCX stores resolved (denormalized) formatting, per paragraph and per run.** The
   one root is `stories` (`OFFICE_DOCUMENT_ROOTS`,
   `vendor/betteroffice/shared/office-checkpoint.ts:30`). Each story is a Y.Text. Each
   paragraph ends in a pilcrow embed, which is a Y.Map with one entry per property
   (`crates/docx-edit/src/raw.rs:586-596`, `seed.rs:3258-3280`). The largest entries
   in exchange-plan:
   - table `rows` JSON: 6 tables, 84.5 KB (`seed.rs:3331-3338`)
   - `_originalFormatting`: 239 entries, 52.5 KB (`seed.rs:1922`, plus 2647/2831/3055
     for tables)
   - `defaultTextFormatting`, the paragraph style's run formatting merged with direct
     formatting: 241 entries, 44.1 KB (`seed.rs:2011-2014`)
   - `paraId`, `lineSpacing`, `hangingIndent`, `_kind` and similar: about 5 KB each

   Runs carry their resolved marks as Y.Text format attributes (`marks_to_attrs`,
   `seed.rs:914`). fontFamily, language and fontSize repeat at every run boundary:
   57 KB in exchange-plan, 80 KB in book-30p. The run-boundary cache
   (`_originalRunBoundaries`, `seed.rs:2155-2158`) is already small: 0.7 KB in
   exchange-plan. Raw-XML embeds such as `chartJson` and `fieldData` are single JSON
   strings (`seed.rs:1187`, `seed.rs:1244`). There is no comments content unless the
   file has comments.
3. **PPTX stores one Y.Map per shape and per paragraph.** Slide, shape, story and
   comment roots are written by `seed_doc` (`crates/pptx-edit/src/deck.rs:39-96`) and
   `seed_shape` (`deck.rs:237-336`). Shapes carry about 15 keys, including JSON strings
   such as `placeholderJson`, `fillJson`, `outlineJson` and `graphicJson`
   (`deck.rs:358-370`). Stories carry pilcrow maps with long positional `paraId`
   strings (`story.rs:107-144`). For deck-50, paraId entries alone take 23 KB.
4. **PPTX seeds under client 2^53−1** (`BOOTSTRAP_CLIENT_ID`,
   `crates/pptx-edit/src/lib.rs:60`), which is an 8-byte varint in every origin or
   parent reference. DOCX uses client 0, 1 byte (`seed.rs:3613-3615`). On measurement,
   18–23% of every PPTX seed is spent naming that client (`pptx_client_cost.ts`:
   deck-50 28.5 KB, jp_llm2 152 KB). This is a side finding: changing it would change
   seeds, so it needs a maintenance window.
5. **Yjs adds per-item overhead:** an info byte, origin and right-origin IDs, the
   parent key string, and the content length.

**XLSX schema 8, for contrast.** Cells are not in Yjs at all. The seed holds topology
only: `xlsx:cell-formats`, `xlsx:sheets`, `xlsx:axis-catalog`, sheet order and defined
names. That is 1.8–24 KB whatever the cell count; the 100,000-cell workbook seeds to
4.2 KB. Its full state is therefore small already, and a diff shrinks it further
(2–25 KB down to about 250 bytes).

## 3. Is seed(base) deterministic? (task 2)

- **DOCX** seeds in a separate doc under `SEED_CLIENT_ID = 0` and then applies that
  update into the session (`seed.rs:3613-3633`). The session's own client is random
  (`office-checkpoint.ts:846`), but it never appears in the seed. The Rust test
  `seeds_are_byte_identical_under_the_fixed_seed_client` (`seed.rs:4400-4424`) seeds
  under two different clients and asserts identical bytes.
- **PPTX** seeds a bootstrap doc under `BOOTSTRAP_CLIENT_ID` and hydrates the session
  doc from it (`lib.rs:127-151`). Its ids are positional (`deck.rs:338-348`).
- **XLSX** takes its bootstrap client from the head of the base fingerprint
  (`crates/betteroffice-xlsx/src/authority.rs:703`).
- **Contributor markers** are written under a random marker client, one per room,
  which changes when a peer writes under it (`collaboration/src/contributors.ts:157-212`).
  Markers are removed before the state is stored, but their tombstones stay. They are
  never part of a seed.
- **Time and randomness:** there is no clock or RNG in the seed code. The HashMaps in
  the seed paths are used only for lookups (`deck.rs:59`, `comments.rs:134`,
  `seed.rs:3643`). Seeds are only ever produced by the WASM build. A future native
  seeder would need its own check, because Rust's HashMap order is random per process
  on native targets.
- **Evidence:**
  - The golden hashes in `shared/docx-pptx-storage.test.ts:272-297` (6 DOCX/PPTX files)
    matched on this ARM64 Mac with the current pin, and CI checks them on Linux. That
    covers the same pin rebuilt on a different machine.
  - My runs: seeding twice in one process gave identical bytes for all 18 files.
    Seeding in Node with `office-checkpoint.mjs` gave the same hash as seeding in Bun
    with the TS source for all 18 (`verify_node.mjs`).
  - The browser path (`openDocx(base, true)`, `PptxDocument.openCollaborative`) gave
    byte-identical exports after applying the diff (`view_compose.ts`, section 4.4).
- **What changes with diffs:** today a stored state carries its own seed items, so
  seed determinism only matters for NULL-state rooms at the moment a deploy switches
  engines. With diffs, determinism holds up *stored data*. The golden test covers 6
  DOCX/PPTX files. A pin that changes the seed only for a feature those files lack
  would silently corrupt every affected stored diff: same `(client, clock)` ids with
  different content, so the delete set would remove the wrong items. See the risks
  and mitigations in section 6.

## 4. Measurements (task 3)

### 4.1 Method

- The engine is the pinned BetterOffice `64bbde82`. Its runtime manifest hashes are
  identical to the 2026-09-28 report, so no rebuild was needed. Yjs is 13.6.31.
- Compression was measured with PostgreSQL 18.4 `pglz`, the default, in a throwaway
  cluster on 127.0.0.1:55471 that has since been stopped and deleted. The value is
  `pg_column_size` after inserting into a temp table. exchange-plan's one-edit full
  state compresses to 47,860 bytes, exactly the report's figure.
- zlib means `deflateSync` at level 6.
- The probe edit is exactly `bench/parsers/scripts/office_storage.ts`: an engine
  `replace_text` or `set_cell` appending ` Capy storage probe.`, the room's
  contributor tracker, and the durable merge.
- Long sessions (`exp_b.ts`, `replicas.ts`):
  - Each session is a real engine replica on its own client. DOCX uses `YrsSession`
    (`insertText` per character, `deleteRange`, `splitParagraph`, `mergeParagraphs`,
    `toggleMark`, `formatRange`, `setParagraphAttrs`). PPTX uses `PptxDocument`
    (per-character `insertTextJson`, `deleteTextJson`, paragraph breaks,
    `formatTextJson`, alignment, `insertSlideJson` plus `addTextBoxJson`,
    `moveShapeJson`).
  - Every operation is synced to a JS room doc with a writer origin, so markers are
    written as in production.
  - A save runs every 5 edits, using `storeSnapshot`'s merge
    (`collaboration/src/sourceDocuments.ts:708-767`).
  - A new browser session starts every 25 edits. The PRNG is seeded, so runs repeat.
- Timings come from an M-series Mac. The first Bun runs overlapped another agent's
  benchmark in the same folder, so the Node seed timings below come from a quieter
  rerun and are indicative only.

### 4.2 One saved edit: full state vs diff (task 3a)

| File | Source | Seed | Full state | Full pglz | Diff (bytes) | Diff pglz (bytes) | Seed, Node warm (ms) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| lesson.docx | 37.4 | 8.9 | 9.0 | 2.2 | 143 | 147 | 63 |
| exchange-plan.docx | 65.7 | 313.0 | 313.1 | 47.9 | 482 | 486 | 58 |
| feature-rich.docx | 39.2 | 42.3 | 42.4 | 8.8 | 172 | 176 | 58 |
| book-30p.docx | 48.0 | 259.2 | 259.4 | 72.5 | 134 | 138 | 25 |
| images-10.docx | 4,190.9 | 67.3 | 67.4 | 18.5 | 134 | 138 | 168 |
| opaque-objects.docx | 59.2 | 47.9 | 48.0 | 17.3 | 133 | 137 | 13 |
| lesson.pptx | 29.3 | 4.3 | 4.4 | 1.5 | 142 | 146 | 4 |
| lecture.pptx | 311.2 | 109.1 | 109.2 | 25.3 | 328 | 332 | 22 |
| feature-rich.pptx | 16.6 | 17.8 | 17.9 | 4.7 | 142 | 146 | 3 |
| deck-50.pptx | 94.2 | 161.2 | 161.4 | 47.1 | 142 | 146 | 15 |
| jp_llm2.pptx | 24,390.7 | 714.7 | 714.8 | 186.4 | 980 | 984 | 239 |
| zh_TW_llm.pptx | 8,756.5 | 479.4 | 479.5 | 111.8 | 218 | 222 | 105 |
| grades.xlsx | 5.5 | 1.8 | 2.0 | 1.1 | 247 | 251 | 3 |
| course-guide.xlsx | 145.4 | 24.3 | 24.6 | 5.8 | 248 | 252 | 338 |
| feature-rich.xlsx | 7.3 | 12.7 | 13.0 | 3.2 | 280 | 284 | 4 |
| cells-1k.xlsx | 14.6 | 4.2 | 4.4 | 1.7 | 243 | 247 | 15 |
| cells-10k.xlsx | 89.4 | 4.2 | 4.4 | 1.7 | 243 | 247 | 112 |
| cells-100k.xlsx | 836.4 | 4.2 | 4.4 | 1.6 | 241 | 245 | 1,070 |

- **Totals:** full states are 2,279 KB raw and 559 KB pglz; diffs are 4.7 KB raw and
  4.7 KB pglz. Values under about 2 KB are not compressed by TOAST.
- **The diff always carries the seed's own delete set**, because Yjs keeps the whole
  delete set in every update. That is 354 bytes for exchange-plan, 840 for jp_llm2,
  188 for lecture and 78 for zh_TW; it explains most of those four diffs.
- **Two ways to compute the diff, with equivalent results:**
  - `Y.encodeStateAsUpdate(mergedDoc, seedSV)` takes 0.01–0.2 ms. `storeSnapshot`
    already holds `merged`, so this path is effectively free.
  - `Y.diffUpdate(bytes, seedSV)` takes 0.04–56 ms because it parses the full update.
- **Rebuild cost:** applying seed plus diff to a JS doc costs the same as applying the
  full state today, 0.1–18 ms in Node.

### 4.3 Long sessions (task 3b)

Sizes are in KB. "Growth charged today" is `max(0, full − seed_bytes)`, the current
quota term.

| File | Edits | Full | Full pglz | Diff | Diff pglz | Growth charged today |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| exchange-plan.docx | 50 | 314.6 | 49.7 | 5.6 | 2.2 | 1.6 |
| exchange-plan.docx | 300 | 322.6 | 56.9 | 32.4 | 10.0 | 9.6 |
| book-30p.docx | 50 | 262.3 | 74.7 | 5.4 | 1.9 | 3.1 |
| book-30p.docx | 300 | 272.1 | 83.8 | 35.5 | 9.9 | 12.9 |
| feature-rich.docx | 300 | 55.4 | 15.6 | 20.9 | 7.9 | 13.1 |
| opaque-objects.docx | 300 | 64.2 | 25.1 | 24.1 | 8.4 | 16.3 |
| images-10.docx | 300 | 80.8 | 27.7 | 26.7 | 8.8 | 13.5 |
| lesson.docx | 300 | 25.2 | 8.4 | 18.2 | 6.7 | 16.3 |
| lecture.pptx | 50 | 113.4 | 27.0 | 4.3 | 2.0 | 4.3 |
| lecture.pptx | 300 | 135.1 | 35.1 | 24.5 | 8.8 | 26.0 |
| deck-50.pptx | 50 | 165.1 | 48.5 | 3.5 | 1.5 | 3.9 |
| deck-50.pptx | 300 | 185.7 | 55.7 | 21.8 | 7.5 | 24.5 |
| zh_TW_llm.pptx | 50 | 488.4 | 114.5 | 9.1 | 3.2 | 9.0 |
| zh_TW_llm.pptx | 300 | 527.0 | 127.6 | 48.4 | 15.3 | 47.6 |
| feature-rich.pptx | 300 | 44.8 | 14.6 | 26.7 | 10.1 | 27.0 |
| lesson.pptx | 300 | 32.0 | 10.9 | 27.3 | 9.6 | 27.7 |

The full series at 0, 1, 5, 10, 25, 50, 100, 150, 200, 250 and 300 edits is in
`out/exp_b_300.json`. The 300-edit mixes averaged about 113 typed words, 50
backspace runs, 20–30 range deletions, 35 new paragraphs, 16 merges, 45 formatting
changes and about 10 slides.

- **No bloat within an epoch.** Growth is steady and roughly linear. After 300 edits
  and 14 clients, the delete set is 350–1,100 bytes. Marker tombstones are too small
  to appear in the top 16 categories of the diff (`diff_anatomy.ts`).
- **What a diff is made of:** mostly new model content.
  - DOCX: each new paragraph copies its pilcrow map, and `defaultTextFormatting`
    (150–250 bytes each) is the largest item, followed by formatting attributes and
    text.
  - PPTX: text, format attributes, and new paragraph and slide maps. Format items in
    zh_TW take 27 KB, because their origins name the 8-byte bootstrap client.
- **DOCX diffs grow faster than today's charged growth.** Deleting or merging seed
  content makes the full state *shrink*: GC drops the old pilcrow maps. In a diff, a
  deletion costs only a delete-set range, while replacements add their new values.
  PPTX diff size and today's charged growth track closely.
- **The stored row is rewritten on every save.** Each save re-TOASTs the whole value
  and writes it to WAL. Summed over the 60 saves of a 300-edit session:

  | File | Full states | Diffs | Ratio |
  | --- | ---: | ---: | ---: |
  | exchange-plan.docx | 3.2 MB | 0.33 MB | 9.6× |
  | book-30p.docx | 4.7 MB | 0.30 MB | 15.6× |
  | deck-50.pptx | 3.1 MB | 0.23 MB | 13.3× |
  | zh_TW_llm.pptx | 7.2 MB | 0.49 MB | 14.7× |

  The browser asks for a checkpoint 1 s after typing pauses
  (`src/features/files/useSourceSession.ts:519-520`), and the service stores at least
  every 10 s while typing continues (`collaboration/src/config.ts:104-110`).

### 4.4 Rebuilding from seed plus diff (task 3c)

- **Byte equality.** For all 18 one-edit rows and all 11 300-edit states, fresh
  seed(base) plus the stored diff gave `encodeStateAsUpdate` bytes identical to the
  original. State vectors, per-root content, engine export bytes, `officeBaseline`
  and XLSX `xlsxPendingEffects` were all identical too.
- **Deleted seed content and Yjs GC.** The sessions delete seed text, remove pilcrow
  maps through merges, and replace embed attributes. The diff carries only delete-set
  ranges for these. Applying it to a fresh seed deletes and GCs the same items, and
  the byte equality above includes these cases. No `pendingStructs` or `pendingDs`
  remained after any rebuild.
- **Another process and runtime.** `verify_node.mjs` ran in a fresh Node process with
  `office-checkpoint.mjs`. It re-seeded each base, applied the diff written by the Bun
  process, and matched the seed hash, full-state hash and export hash on 18/18 files.
- **The browser view path.** `view_compose.ts` composed each state the way the
  runtime worker would with a diff: DOCX `openDocx(base, true)` then `loadState(diff)`;
  PPTX `openCollaborative(base)` then `applyUpdateJson(diff)`. Exports were
  byte-identical to today's full-state composition, `openDocx(base, false)` plus
  `loadState(full)`, for 12 one-edit and 4 300-edit states. The time differed by
  −17 to +10 ms, because parsing the base dominates both.

### 4.5 Publication with later saves (task 3d)

In `exp_a.ts`, a probe edit is captured, exported, followed by a later edit, and
passed to `rebaseOffice`. In `exp_d.ts`, 20 mixed edits are captured and exported,
then 20 structural edits follow and the result is rebased, for two cycles. The
results:

| Format | Rebased state = seed(export) + diff? | = seed(old base) + diff? |
| --- | --- | --- |
| XLSX | yes, all 6 files | no |
| DOCX | no | yes; the diff is 1–25 KB, mostly `sourceBinding` |
| PPTX | no | no |

**Why**

- **DOCX** rebinds the *old* lineage to the export: "without importing a new CRDT
  lineage" (`packages/docx/src/yrs/rebaseCheckpoint.ts:16-33`). It opens the old
  source, loads the latest state, and writes a `sourceBinding` attribute on every
  paragraph (`rebaseCheckpoint.ts:186-226`). The client-0 items are seed(A)'s, and A
  is released at publication.
- **PPTX** saves the latest state to bytes, seeds a *new* lineage from those bytes, and
  stores every package part that differs from the export as raw bytes in
  `pptx:meta.sourceOverlay` (`crates/pptx-edit/src/rebase.rs:18-56`, `rebase.rs:70-93`).
  - After 20 edits the overlay was 66–82 KB for lecture and deck-50, and 459 KB for
    zh_TW: whole slide XML parts of up to 67 KB each.
  - That is why zh_TW's rebased state is 948 KB raw (183 KB pglz), about twice its
    seed.
- **XLSX** re-applies override differences to seed(export) and verifies that the
  result reproduces the latest workbook
  (`crates/betteroffice-xlsx/src/workbook/rebase.rs:67-110`).

**Why a rebased DOCX/PPTX state needs a stored baseline.** Its identities are not
seed(export)'s:

- **DOCX:** paragraph and object ids come from seed(A)'s lineage and the editors' own
  ids.
- **PPTX:** positional ids come from the latest save.

A baseline derived from seed(export) produces wrong effects. In `exp_a`, exchange-plan
gave 278 effects instead of 17. In `exp_d`:

| File | Cycle | Rebased state raw / pglz | Stored baseline raw / pglz | Later edits alone (estimate for a seed(export)-relative state) raw / pglz | Effects: stored / derived baseline | Baseline entries differing from derived |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| exchange-plan.docx | 1 | 314.5 / 52.2 | 96.2 / 39.0 | 3.5 / 1.6 | 131 / 348 | 258/500 |
| exchange-plan.docx | 2 | 317.7 / 54.7 | 88.4 / 36.4 | 2.8 / 1.7 | 124 / 481 | 282/455 |
| book-30p.docx | 1 | 277.9 / 77.5 | 144.2 / 69.0 | 3.1 / 1.2 | 89 / 239 | 168/336 |
| images-10.docx | 1 | 74.1 / 21.1 | 40.7 / 19.8 | 2.9 / 1.1 | 53 / 116 | 69/122 |
| lecture.pptx | 1 | 198.5 / 42.7 | 78.4 / 25.2 | 2.9 / 1.4 | 51 / 656 | 323/362 |
| lecture.pptx | 2 | 187.9 / 42.1 | 81.6 / 26.8 | 1.5 / 1.5 | 33 / 30 | 10/380 |
| deck-50.pptx | 1 | 232.4 / 61.5 | 205.8 / 74.1 | 2.3 / 1.0 | 74 / 1,697 | 843/969 |
| deck-50.pptx | 2 | 202.8 / 57.5 | 209.0 / 75.7 | 1.1 / 1.1 | 29 / 25 | 10/987 |
| zh_TW_llm.pptx | 1 | 947.7 / 183.2 | 273.1 / 98.1 | 3.9 / 1.6 | 62 / 2,414 | 1,203/1,397 |
| zh_TW_llm.pptx | 2 | 950.2 / 188.9 | 275.0 / 98.9 | 1.9 / 1.9 | 34 / 29 | 8/1,407 |

`out/exp_d.json` has all 11 files. The "later edits" column is `Y.diffUpdate(latest,
SV(captured))`. It estimates how big a seed(export)-relative rebased state would be.

**Could the baseline be derived or shrunk?**

- **Derived as it stands:** no. The derived baseline gives the wrong effects.
- **Stored as a delta over the derived baseline:** this works only sometimes. PPTX
  cycle 2 needed 8–10 differing entries. A slide insert shifts every positional id
  after it, so PPTX cycle 1 needed 90% of the entries. DOCX needed 40–60%.
- **Removed:** yes, if the rebase lands on seed(export), as XLSX's does. Effects would
  then be `compare(baseline(seed(export)), baseline(state))`, and nothing would need
  storing. Measured over the whole rebased rows (state plus baseline, pglz):

  | File | Stored today | Later edits alone |
  | --- | ---: | ---: |
  | exchange-plan.docx | 91 KB | about 2 KB |
  | deck-50.pptx | 136 KB | about 1 KB |
  | zh_TW_llm.pptx | 281 KB | about 2 KB |

### 4.6 CPU and time

- **Seeding** in Node with the production bundle, warm median of 5 (quiet rerun):
  - DOCX: 13–168 ms
  - PPTX: 3–239 ms
  - XLSX: 3 ms–1.07 s (cells-100k)
  - A cold first call adds WASM initialization.
- **Today**, only NULL-state files pay for seeding on load, cached by base SHA in a
  64 MiB LRU (`sourceDocuments.ts:368-410`). With diffs, every Office load and every
  save pays for it on a cache miss: the room, agent inspect and edit, captured
  candidates, and rebase inputs.
- **Engine calls** need no extra work. Each call already opens the base, and seed plus
  diff costs about the same as loading the full state (section 4.4).

## 5. Consumers that would change (task 4)

### Collaboration service (`collaboration/src/`)

- `sourceDocuments.ts:413-417` `stateOf`: build seed ⊕ diff when the row holds a diff,
  check the seed hash, and assert that nothing is left pending.
- `sourceDocuments.ts:534-549` `load`: apply the seed, then the diff. This covers
  room loads (`server.ts:708-728`), `inspect` (`:774-811`) and `applyEdit`
  (`:819-844`).
- `sourceDocuments.ts:708-767` `storeSnapshot`: store
  `Y.encodeStateAsUpdate(merged, seedSV)` instead of `Y.encodeStateAsUpdate(merged)`.
  Effects are still computed from the full state (`:738`). Keep
  `MAX_SOURCE_STATE_BYTES` (`:44`, `:736`) on the full in-memory size.
- `sourceDocuments.ts:898-921` `applyEdit` → `durableCommit`
  (`persistence.ts:52-60`): same change. Guards (`editCommands.ts:961-1009`) read the
  rebuilt full state, so they do not change. Seed ids and diff ids are identical to
  today's.
- `sourceDocuments.ts:441-445` `seedReport` and the `seedBytes` handshake: their
  meaning changes (section 8, quota).
- `sourceDocuments.ts:625-702` `rebasePublication`: build the captured and latest
  states before calling the engine. For output:
  - XLSX: store the rebased state as a diff over seed(export) (verified).
  - DOCX/PPTX: keep full plus baseline, until the rebase changes (section 7).
- `sourceDocuments.ts:94-95` `CAPTURED_STATE_SQL`, and the candidate copy-on-write:
  the captured value must carry its kind (diff or full) too.
- `sourceDocuments.ts:941-974` `resolve` and `:982-1083` `exportCandidate` go through
  `stateOf` (the candidate shares the row's base).
- `sourceHandoff.ts:358-375` is the text branch and does not change.
- `contributors.ts` does not change. Marker tombstones end up in the diff.
- `server.ts:923-983` `storeSource` and the failed-store retry keep the in-memory
  room state and do not change.

### Go API

- `server/internal/store/source_documents.go:21-39` `SourceSession`, `:240-247`
  `readSourceSession`, `:200-218` `ViewSourceSession`: expose the kind (or the seed
  hash) of the state. The view read can add it as a column or a derived SQL value.
- `source_documents.go:256-360` `SaveSourceCheckpoint`:
  - The 100 MB cap (`:259`) now applies to the diff.
  - Revisit the `seeded`/`seedBytes` handshake (`:314-326`) and the growth
    arithmetic (`:333-337`).
  - Copy the kind with the candidate's state (`:343`).
  - Store it (`:348`).
- `server/internal/store/source_refresh.go:97-123` `ClaimSourceRefresh`: return the
  kind with the captured state.
- `source_refresh.go:168-240` `FinalizeSourceRefresh`: `seedBytes` (`:216`, `:237`).
- `source_refresh.go:262-437` `PublishSourceRefresh`: state and baseline rules
  (`:324-351`), growth (`:369`), `rebasedSeedBytes` (`:438-441`), row update (`:412`).
- `server/internal/store/office_maintenance.go:233-290` `publishExportTx` and
  `applyExportTx` (`:274`).
- `server/internal/httpapi/huma_source_documents.go:112-134` (the editor session
  strips the baseline and effects) and the generated OpenAPI/orval types.
- `server/migrations/0033_office_storage_rule.sql`, the `storage_bytes` generated
  column: unchanged if a diff row keeps `seed_bytes = 0`; otherwise it needs a
  migration.
- `server/migrations/templates/office_window_reset.sql`: drop any new column together
  with the state.
- **Clones need nothing.** They never copy `source_documents`; clones take only the
  published source, index and captions.

### Browser

- Editing, `src/features/files/useSourceSession.ts:203-226`: the browser applies
  `session.state` before connecting (`:224-225`). A diff applied to an empty doc would
  just sit pending until sync delivers the seed. The simplest change is to stop
  pre-applying Office state; sync already sends the full doc for NULL-state rooms
  today. The editor iframe seeds only when it gets no initial update
  (`vendor/betteroffice/packages/docx-react/src/components/DocxEditor/hooks/useYrsCoreSession.ts:123`),
  and with collaboration it always gets the full shared state. So the browser never
  builds its own seed while editing.
- View mode:
  - `src/features/files/useOfficeRuntime.ts:200-220` passes the state as the
    checkpoint, plus a new kind flag.
  - `src/office-runtime/main.tsx:196-205` and `exportCheckpoint.worker.ts:27-64` must
    seed DOCX and PPTX before applying a diff. XLSX already seeds and then applies
    (`:32-40`). This was verified byte-identical in 4.4.
- `src/mocks/handlers.ts:227` (MSW source-session mock) and
  `src/office-runtime/exportCheckpoint.test.ts`.

### Other

- `bench/parsers/scripts/office_storage.ts` (measure the diff) and
  `openwiki/frontend/office-files.md`, `openwiki/backend-storage-quota.md`,
  `openwiki/test-catalog.md`.
- The pipeline never reads `state`; it reads only `pending_effects`.

## 6. Size of the change and risks

**Stage 1: seed-relative states, with rebased DOCX/PPTX states still full.** About
500–800 lines including tests, across about 20 files and one small migration, which
adds `state_seed_sha256` to `source_documents` and `source_refresh_candidates`. That
is roughly 2–4 dev-days. The fork itself needs no changes.

**Stage 2: an XLSX-style rebase for DOCX and PPTX** (section 7). This is engine work
in the fork, likely 1–2 weeks, and it removes code: the stored `indexed_baseline`,
`seed_bytes`/`rebasedSeedBytes`, the PPTX source overlay and the DOCX `sourceBinding`
pass.

**Risks**

1. **Seed determinism now holds up stored data (the largest risk).**
   - Mitigation: store the seed hash with each diff and refuse to rebuild when the
     re-seed hashes differ. That fails explicitly instead of corrupting silently.
   - Add a pin-bump gate that re-seeds the base of every row holding a diff with the
     new engine. Any mismatch sends the bump through the maintenance window, which
     already publishes everything and drops states. The 6 golden fixtures alone are
     not enough.
   - A yrs upgrade that re-encodes the same items differently would trip the hash too.
     That is a false alarm, but on the safe side.
2. **CPU and latency on cache misses.**
   - Loading an edited room today needs no engine call and no base download. With
     diffs, a miss downloads the base (128 MiB cache) and runs one seed (up to about
     0.24 s for PPTX, 0.17 s for DOCX, 1 s for XLSX-100k).
   - That seed runs on the single engine worker, behind any save's `officeBaseline`
     call (`officeRuntime.ts`, one call in flight).
   - Consider pinning the seed while a room is loaded, or raising the 64 MiB seed
     cache.
3. **Rebased DOCX/PPTX rows stay full in stage 1.** A save during a parse is likely for
   files being actively edited: 60 s idle, then a parse of a minute or more. Those rows
   keep today's cost (full state plus baseline, 5–281 KB pglz) until the next quiet
   publication. Stage 2 fixes this.
4. **Partial-diff edge cases.**
   - The whole seed delete set is always included (16–840 bytes). It could be trimmed,
     but that is not worth it.
   - The rebuild must assert that nothing is left pending (no `pendingStructs` or
     `pendingDs`).
   - A diff built against the wrong seed has to be impossible: check the hash, and
     never diff a rebased-lineage state against seed(base). A write-time rebuild
     check can assert this.
   - An editor that happens to use the seed client (DOCX client 0, a 1-in-2^32 chance)
     is still correct. Anything past the seed's clock is inside the diff.
5. **The browser view worker must seed before applying.** That costs 0–10 ms more,
   with identical output. A stale runtime that receives a diff without the flag would
   fail, so ship the protocol version bump together with the server change.
6. **Legacy rows.** Existing full-state rows (`state_seed_sha256` NULL) keep loading
   as full states. Their next save can switch to a diff once it passes the rebuild
   check. There is no backfill.

## 7. Alternatives (task 5)

- **An operation log.** Worse. Yjs already merges typing runs: about 100 bytes per
  edit raw, about 30 bytes pglz. A log of engine commands would be larger, one entry
  per keystroke transaction, and would need deterministic replay on every load.
- **Engine-level override storage, as XLSX does.** This means taking unedited
  paragraphs and shapes out of Yjs, with lazy per-paragraph CRDTs. It would redesign
  collaborative text editing, including concurrent first edits of the same paragraph.
  The seed diff gets nearly all of its storage benefit, because the seed then lives
  only in memory, and needs no schema change in the engine.
- **A periodic squash**, meaning an export-only publication. It already exists for
  store-only files. For indexed files it drops the index and bumps the epoch, so it is
  not a storage tool.
- **Keeping the old base A so rebased DOCX can diff against seed(A).** This conflicts
  with the recorded decision to release the old full source, and A is often as large
  as the compressed state anyway (exchange-plan 65 KB vs 52 KB). Not recommended.
- **An XLSX-style rebase for DOCX/PPTX (recommended stage 2).** Open seed(export),
  replay the latest−captured changes, then check that export(result) = export(latest)
  and fail explicitly otherwise, as XLSX does.
  - PPTX already maps captured ids to export ids (`export_ids`, `rebase.rs:138-192`).
  - DOCX can replay per-story Y.Text deltas: text, format attributes, embed maps.
  - Clients reload at the new epoch and agent Undo is already invalidated
    (`source_refresh.go:412-418`), so new identities cost nothing.
  - Result: every stored state becomes a diff over seed(base), and baselines are always
    derived.
  - Risks: replay fidelity for tables, tracked changes, comments and inserted images,
    and what happens when the check fails (below).
- **A smaller PPTX seed client**, 0 or small instead of 2^53−1. That makes seeds about
  20% smaller, and helps memory, sync payloads and today's full rows. It changes
  seeds, so it needs a maintenance window.

## 8. Recorded decisions this touches

- **Consistent, no new decision:** `human/frontend/office-files.md` 2026-09-25, "Office
  editing state stores only what users changed … seeding uses a fixed client id …
  a NULL state means the seed of the base". Diffs over the seed apply that decision to
  DOCX/PPTX.
- **Needs a new decision (quota):** `human/backend-storage-quota.md` 2026-09-25 charges
  "editing-state growth beyond the recorded seed size". For a diff row there are two
  options:
  - (a) charge what is stored, `octet_length(diff)`, by setting `seed_bytes = 0`. No
    migration. For heavy DOCX editing this charges 2–3× more: exchange-plan at 300
    edits is 32 KB instead of 9.6 KB. PPTX is about the same.
  - (b) keep today's number, full size minus seed size, from a size the service
    reports. This needs a migration of the generated column.
- **Needs a new decision (maintenance window):** `human/frontend/office-files.md`
  2026-09-25, "an engine upgrade that changes seed output (golden seed tests decide
  per format) runs as a maintenance window". With stored diffs, the golden tests are
  not enough to decide. The proposal is a per-row seed-hash gate over rows that hold a
  diff.
- **Needs a new decision (stage 2 only):**
  - The native rebase that keeps lineage and stores a baseline mapped into its
    identities (2026-09-14 in `human/frontend/office-files.md` and
    `human/agentic-retrieval.md`).
  - "Stored baselines … kept only after a publication that rebased later edits"
    (2026-09-25).
  - The PPTX decision that rebase overlays store changed parts as bytes (2026-09-25).

  Stage 2 would replace all three. It fits "shrinking Office storage is the top
  priority", but it changes how the rebase is designed.
- **Needs a new decision (fallback):** falling back to a full state when a check fails
  counts as a fallback under AGENTS.md. As proposed, a failed rebuild check is an
  explicit save failure, and clients keep their drafts. Rebased DOCX/PPTX rows are a
  known category, not a fallback.

## 9. Recommendation

1. **Adopt diffs over seed(base) for Office states** (stage 1).
   - Write: store `Y.encodeStateAsUpdate(merged, seedSV)` together with
     `state_seed_sha256`, after a rebuild check.
   - Read: seed, check the hash, apply, assert that nothing is pending.
   - Keep full states only for rebased DOCX/PPTX rows. They are the rows with a stored
     baseline.
   - Make XLSX rebased states diffs as well.
   - The view worker seeds DOCX/PPTX before applying.
   - The editing browser stops pre-applying Office state.
   - Add a pin-bump seed check over rows that hold a diff.
   - Expected effect: a one-edit DOCX/PPTX row goes from 1.5–186 KB to under 1 KB, a
     300-edit row from 8–128 KB to 7–15 KB, and TOAST/WAL rewrite volume drops 1.3–15×.
2. **Then do the XLSX-style rebase for DOCX and PPTX** (stage 2). It removes the last
   large rows: a rebased state plus baseline, 5–281 KB pglz, becomes about 1–4 KB. It
   also removes code: the stored `indexed_baseline`, `seed_bytes`/`rebasedSeedBytes`,
   the PPTX overlay and DOCX `sourceBinding`.
3. **Before implementing,** decide on the quota rule (8a or 8b), the maintenance-window
   gate, and whether stage 2 is wanted.

## Artifacts

All paths are under
`/private/tmp/claude-501/-Users-sam-web-capy-notebook/7b637a6f-fb77-40a9-b051-8011ac933570/scratchpad/office-save-investigation/`.

| File | What it does |
| --- | --- |
| `common.ts` | Shared helpers (fixtures, pglz, diff, rebuild, content comparison) |
| `seed_anatomy.ts` → `anatomy.json` | Seed composition (task 1) |
| `exp_a.ts` → `out/exp_a.json`, `out/diffs/` | Probe edit, diff, rebuild, rebase (3a/3c/3d) |
| `verify_node.mjs` | Cross-process and cross-runtime rebuild (3c) |
| `replicas.ts`, `exp_b.ts` → `out/exp_b_300.json`, `out/final_300_*.state` | Long sessions (3b) |
| `diff_anatomy.ts` → `out/diff_anatomy_300.json` | What a 300-edit diff contains |
| `exp_d.ts` → `out/exp_d.json` | Structural rebase over two cycles, baseline analysis (3d) |
| `view_compose.ts` | Browser view-worker composition with diffs |
| `seed_timing.mjs` → `out/seed_timing.json` (`seed_timing_run1.json` is the busier first run) | Node seed and load timings |
| `pptx_client_cost.ts`, `seed_ds.ts` | Side measurements |

Other files in this folder (`savebench*`, `results/`, `*.mts`, `container.txt` and
similar) belong to another agent working in the same folder and were not touched.
