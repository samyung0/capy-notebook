# Office storage: PPTX package data and the overhead shared by DOCX, XLSX and PPTX

Date: 2026-09-25. Fork `vendor/betteroffice` at `origin/capy-ci` = `dfa3f05e`, upstream
`upstream/main` = `c0fa7262`. Capy at `3758a0e2` plus the working tree. Engine: the headless bundle
`shared/office-checkpoint.mjs` built from that pin. Yjs 13.6.31 from `collaboration/node_modules`.

Scripts, raw records and the prototype patch are in
`<session scratchpad>/cross-shrink/`
(`cross-shrink/` below). They reuse `scratchpad/storage/lib.mjs` and the generated files in
`scratchpad/storage/files/`. I measured TOAST and WAL in a scratch Postgres 16.15 container built from
the production image `pgvector/pgvector:pg16`. I prototyped the PPTX change in a scratch worktree of
the fork. Both are removed. Production code, live containers and the submodule checkout are untouched.

Markers used in the tables: **M** measured on that file, **M\*** sum of measured parts, **E** estimate
with the assumption stated next to it.

## 1. Ranked recommendation

1. **Take `pptx:meta.packageJson` out of Yjs in the same schema bump as the decided media change.**
   Every Capy path opens a deck state together with its fingerprinted source, and the engine already
   re-parses that source for the session's package. The stored copy only feeds validation and a
   source-free open that Capy never calls. I built the change on `dfa3f05e`. The seed writes no
   `packageJson` or `media`, validation uses the session's package, rebase overlays store changed
   media as bytes, and opening a state requires the source. All 53 remaining `pptx-edit` tests pass,
   the save and write-fidelity suites included, and a save from a reopened state matches the
   editing session's save part for part on all six decks. The 9 schema-migration tests go away under
   the one-schema decision. Measured seeds: deck-50 519 KB to 158 KB, lesson.pptx 106 KB to 4.3 KB,
   jp_llm2 22.71 MB to 0.67 MB (media alone takes it to 1.75 MB). The crate loses 172 lines net. It
   changes seed output, but the decided schema bump already reseeds every room. Risk is low. Only
   the fork's Rust tests open a deck state without its source; the demo and every Capy path pass it.
2. **Stop storing the semantic baseline wherever the published base determines it.** After every
   initialize and every publication without later edits, `indexed_baseline` equals
   `officeBaseline(base, seed(base))`. For text it is the base blob decoded as UTF-8. For PPTX and
   XLSX I measured identical baselines, and byte-identical seeds, from two seeds with different
   client ids. DOCX is not there yet: object and image entry ids embed the seeding client id
   (`body:object:<13334685250010#202>` in one run, `<17538614167084#202>` in the next), so the DOCX
   seed must first run under a fixed bootstrap client, as PPTX already does. Keep storing the
   baseline only after a publication that rebased later edits. The service caches the derived
   baseline by base SHA, the way it caches base bytes. This removes 100% of stored baselines:
   book-300p 1.41 MB, deck-50 204 KB, jp_llm2 461 KB, cells-100k 43.1 MB (22 MB after the decided
   slimming), plus `baseline(B)` in every refresh candidate and in every session response. A cache
   miss costs one seed plus baseline of the base: 0.1 s for deck-50, 1.2 s for book-300p and jp_llm2,
   2.2 s for cells-10k and 80 s for cells-100k with today's XLSX model. XLSX therefore waits for the
   lazy cell model.
3. **Decide what quota counts. I recommend source bytes plus pending edits plus state growth beyond
   the seed.** The engine's representation of a file is a platform artifact, like the Office parse
   cache already is. After 100 edits and the rest of this set, book-300p would charge 0.49 MB instead
   of 5.00 MB and deck-50 0.12 MB instead of 0.29 MB. Charging growth beyond the seed keeps a user
   from inflating state with edits that cancel out. If the rule stays at logical bytes, compress
   `state` at rest and count the stored bytes: book-300p 5.00 MB to 1.39 MB, deck-50 0.29 MB to
   0.16 MB.
4. **Make the refresh candidate cheap.** Copy the captured state only when a save lands during the
   refresh (copy-on-write), drop the candidate baseline (item 2), and charge the candidate either not
   at all or as `max(current, candidate)`. Publication already gates net growth. With items 1 and 2
   and copy-on-write, the jp_llm2 refresh peak falls from 117.2 MB to 49.5 MB under today's sum and
   to 25.1 MB under `max`. book-300p goes from 17.6 MB to 10.3 MB and 5.3 MB.
5. **Write contributor markers under a dedicated marker client id.** About 20 lines in
   `collaboration/src/contributors.ts`. The marker stays in the edit's transaction, the room's
   client id stops rotating, and stored growth per keystroke drops from 23.9 B to 1.1 B (measured on
   deck-50 and on a plain `Y.Text` room). It also silences the
   `[yjs] Changed the client-id because another client seems to be using it.` line that Yjs prints
   on every client update today. Material rooms share the tracker, so their compaction threshold is
   reached about 20 times later.
6. **Trim pending effects to the changed span plus 40 characters of context. This needs sign-off.**
   book-300p after 100 edits: 131 KB to 41 KB (-69%). PPTX -2% to -11%, XLSX 0%. Every chat request
   carries the pending effects, so this also removes about 23k input tokens per chat turn for that
   book. It moves the 5,000-token automatic refresh trigger, which counts `before` and `after`.
7. **Cut the traffic and CPU that follow from the same data.** The checkpoint response echoes the
   full state and baseline, which the service ignores. The browser's editor session receives the
   baseline and effects, which it ignores. IndexedDB drafts write the full base plus the full state
   on every keystroke. The collaboration service copies the full room state twice for every
   incoming message. Section 5.6 has the numbers.
8. **Later, once DOCX seeds are deterministic: store no state until the first edit.** A NULL state
   would mean `seed(base)`. An opened but unedited file, or a freshly published one, then carries no
   engine bytes at all, and an agent `inspect` of a never-opened file stops charging its seed.

## 2. Open questions for the developer

1. Which quota rule: logical bytes (today), stored compressed bytes, or source plus pending edits
   plus growth beyond the seed? Item 3 and the compression design depend on it.
2. How should a refresh be charged: the sum (today), `max(current, candidate)`, or not at all while
   the candidate is transient? With copy-on-write under the sum rule, a save made during a refresh
   could be refused for quota, which is worse than refusing the refresh up front.
3. Are span-trimmed effects acceptable as chat evidence, and should the automatic refresh trigger
   keep counting whole paragraphs?
4. How often do saves land while a refresh runs? That decides how often the captured-state copy and
   a stored baseline are still needed. There is no production data yet.
5. Will the DOCX sibling's seed run under a fixed bootstrap client id? Derived DOCX baselines and
   lazy state depend on it.
6. Is it acceptable that a PPTX state can no longer be opened without its source? Upstream keeps
   that for peers that lack the file. Capy has no such peer.
7. Do you want item 8, lazy state?

## 3. Combined numbers (part 3)

Scenarios. "Today" is `dfa3f05e` as measured. "Decided" adds the 2026-09-25 decisions that change
these files: the slimmer XLSX baseline (-48.8% of the baseline, measured on cells-10k and scaled to
100k cells, E) and PPTX media out of Yjs (measured by removing `pptx:meta.media` from the seed). The
raw-XML DOCX embeds and the PPTX comments root add nothing to these five files. "Recommended" adds
items 1, 2 and 4 above, with the sibling assumptions from the brief: XLSX state and baseline
proportional to edits (E: 2 KB plus 10.6 B per edited cell, the measured browser commit cost
without the marker tombstone, and a derived baseline), and DOCX images out of state (images-10
state without its base64 is 110,733 B, measured in the storage report). book-300p keeps today's
DOCX text state. The DOCX sibling may shrink it further.

"100 edits" means the storage report's distinct-target model: 100 paragraph edits for DOCX and
PPTX, 100 cell commits for XLSX. The refresh peak is taken at 100 edits with no save during the
refresh. Script: `cross-shrink/combined_table.mjs`.

### Table A. Charged bytes under today's rule (logical `octet_length`)

| File | Source | Today, first open | Today, refresh peak | Decided, first open | Decided, peak | Recommended, first open | Recommended, 100 edits | Recommended, peak (sum) | Recommended, peak (`max`) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| cells-100k.xlsx | 0.82 MB | 70.91 MB, 86.5x **M** | 169.10 MB, 206x **M\*** | 49.88 MB, 60.9x **E** | 127.04 MB, 155x **E** | 0.82 MB, 1.0x **E** | 0.85 MB, 1.0x **E** | 1.90 MB, 2.3x **E** | 1.06 MB, 1.3x **E** |
| book-300p.docx | 0.36 MB | 6.27 MB, 17.5x **M** | 17.62 MB, 49.1x **M\*** | 6.27 MB, 17.5x **M** | 17.62 MB, 49.1x **M\*** | 4.86 MB, 13.6x **M\*** | 5.00 MB, 13.9x **M\*** | 10.30 MB, 28.7x **M\*** | 5.30 MB, 14.8x **M\*** |
| images-10.docx | 4.19 MB | 9.90 MB, 2.4x **M** | 25.51 MB, 6.1x **M\*** | 9.90 MB, 2.4x **M** | 25.51 MB, 6.1x **M\*** | 4.30 MB, 1.03x **M\*** | 4.36 MB, 1.04x **M\*** | 8.63 MB, 2.1x **E** | 4.36 MB, 1.04x **E** |
| deck-50.pptx | 0.09 MB | 0.82 MB, 8.7x **M** | 2.19 MB, 23.2x **M\*** | 0.82 MB, 8.7x **M** | 2.19 MB, 23.2x **M\*** | 0.25 MB, 2.7x **M** | 0.29 MB, 3.0x **M\*** | 0.53 MB, 5.7x **E** | 0.29 MB, 3.0x **E** |
| jp_llm2.pptx | 24.39 MB | 47.56 MB, 1.95x **M** | 117.17 MB, 4.8x **M\*** | 26.61 MB, 1.09x **M** | 54.31 MB, 2.2x **E** | 25.07 MB, 1.03x **M** | 25.11 MB, 1.03x **M\*** | 49.53 MB, 2.0x **E** | 25.11 MB, 1.03x **E** |

The recommended columns include copy-on-write (item 4). "Peak (sum)" adds the export B and its
seed to the current row. The recommended peaks assume the export's seed is the size of the
source's seed (E for PPTX, XLSX and images-10; book-300p uses the measured seed(B)). Without
copy-on-write, add one more state: 4.51 MB for book-300p, 0.16 MB for deck-50, 0.67 MB for
jp_llm2. Under "no charge for the candidate" the peak equals the "100 edits" column. What is left
for book-300p is the DOCX text state, 4.51 MB for a 0.36 MB file.

### Table B. The recommended set after 100 edits, under each quota rule

| File | Logical bytes (today's rule) | Stored bytes, state gzip-6 at rest | Source + pending edits |
| --- | ---: | ---: | ---: |
| cells-100k.xlsx | 0.85 MB **E** | 0.85 MB **E** | 0.84 MB **M\*** |
| book-300p.docx | 5.00 MB, 13.9x **M\*** | 1.39 MB, 3.9x **M\*** | 0.49 MB, 1.37x **M\*** |
| images-10.docx | 4.36 MB **M\*** | 4.27 MB **E** | 4.25 MB **M\*** |
| deck-50.pptx | 0.29 MB, 3.0x **M\*** | 0.16 MB, 1.7x **M\*** | 0.12 MB, 1.3x **M\*** |
| jp_llm2.pptx | 25.11 MB **M\*** | 24.55 MB **M\*** | 24.43 MB **M\*** |

"Source + pending edits" in this table leaves out the growth-beyond-seed term, which is 2.7 KB per
100 distinct edits here and about 1.1 B per typed character once item 5 lands.

### Table C. What the platform stores

| File | B2 | Postgres on disk today, first open (pglz state + baseline) | Postgres on disk, recommended (pglz state) | WAL per save today | WAL per save, recommended |
| --- | ---: | ---: | ---: | ---: | ---: |
| cells-100k.xlsx | 0.82 MB | 8.1 MB **E** (10x cells-10k) | about 2 KB **E** | about 2.6 MB **E** | about 2 KB **E** |
| book-300p.docx | 0.36 MB | 2.02 MB **M** | 1.36 MB **M** | 1.49 MB **M** | 1.49 MB **M** |
| images-10.docx | 4.19 MB | 5.69 MB **M**, state stored raw | about 35 KB **E** | about 6 MB **E** | about 40 KB **E** |
| deck-50.pptx | 0.09 MB | 0.17 MB **M** | 0.05 MB **M** | 0.22 MB **M** | 0.09 MB **M** |
| jp_llm2.pptx | 24.39 MB | 22.87 MB **M**, state stored raw | 0.18 MB **M** | 24.9 MB **M** | 0.20 MB **M** |

WAL figures are steady-state saves inside one Postgres checkpoint cycle (1.1x the on-disk state).
The first save after each checkpoint writes about twice that: 48.3 MB for jp_llm2 today, 2.90 MB
for book-300p. deck-50 is the first-save figure. During a refresh B2 also holds the export B.

## 4. Part 1: PPTX

### 4.1 What `packageJson` holds

`encode_package` (`crates/pptx-edit/src/deck.rs:852-888` at `dfa3f05e`) serializes the parsed
`PptxPackage` without media: presentation, slides, layouts, masters, themes, charts and
relationships. `slides` is the full parsed shape tree of every slide, text included, which the seed
also writes into `pptx:shapes` and `pptx:stories`. So the deck is stored twice, once as JSON the
editor never edits and once as the Yjs graph it does edit. The JSON is written once at seed and
never updated. Measured with `cross-shrink/pptx_meta.mjs`, sizes in bytes:

| Deck | State | `packageJson` | slides | layouts | masters | relationships | themes | presentation | charts | media (binary) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| lesson.pptx, 2 slides | 106,179 | 101,836 | 4,791 | 72,613 (11) | 13,272 | 8,963 | 1,643 | 281 | 0 | 0 |
| feature-rich.pptx, 2 slides | 54,819 | 37,016 | 21,052 | 199 | 6,384 | 5,715 | 952 | 308 | 2,201 | 0 |
| betteroffice-demo.pptx, 3 slides | 158,144 | 80,045 | 69,565 | 206 | 5,703 | 3,273 | 425 | 352 | 0 | 68 |
| deck-50.pptx, 50 slides | 518,674 | 360,655 | 237,376 | 72,613 (11) | 13,272 | 31,506 | 1,643 | 3,782 | 0 | 0 |
| zh_TW_llm.pptx, 33 slides | 9,634,772 | 702,505 | 469,136 | 140,474 (22) | 26,042 | 54,493 | 7,190 | 2,569 | 0 | 8,525,937 |
| jp_llm2.pptx, 84 slides | 22,708,897 | 1,078,763 | 903,523 | 17,879 (5) | 15,463 | 127,745 | 3,277 | 6,173 | 0 | 20,952,443 |

Slides are 66% of `packageJson` in deck-50 and 84% in jp_llm2. The small decks are dominated by
the python-pptx template's 11 layouts. `packageJson` gzips to 4-6% (22 KB for deck-50, 60 KB for
jp_llm2), which shows how repetitive it is.

### 4.2 Who reads it

| Reader | Today | After the change |
| --- | --- | --- |
| Seed, `seed_doc` (`deck.rs:34-90`) | Writes `packageJson` as `Null`, then as a buffer at new ids, plus `media` | Writes neither |
| `validate_doc` (`deck.rs:731-763`), on every open and on a staged full copy for every remote update (`lib.rs:187-209`) | Deserializes `packageJson` and copies every media buffer (`package_from_meta`, `deck.rs:813-850`), then builds a snapshot with it to resolve theme colors | Validates against the session's package |
| `open_from_update` without source (`lib.rs:116-136`) | Builds the session package from `packageJson` | Removed. The WASM binding errors if no source is passed |
| `open_from_update_with_source` (`lib.rs:139-157`) | Validates with `packageJson`, then discards it and re-parses the source plus overlay (`rebase.rs:112-163`) | Parses the source once and validates with it |
| Snapshot, save, render (`deck.rs:345`, `save.rs:61-85`, `crates/pptx-wasm/src/lib.rs:37-46`), `mediaBytes` (`wasm.rs:245-255`) | Session package, which comes from the source whenever one is attached | Unchanged |
| Rebase (`rebase.rs:70-110`) | Overlay entries for changed media are `Null` pointers into `pptx:meta.media`, resolved through the doc package | Overlay stores changed media parts as bytes, as already decided |
| `migrate_doc` v1/v2 to v3 (`deck.rs:781-801`) | Rewrites `packageJson` | Removed under the one-schema decision |
| Browser editor (`packages/pptx/src/wasm/loader.ts:133-141`), view export worker (`src/office-runtime/exportCheckpoint.worker.ts:44`) | Always pass the source bytes | Unchanged |
| Viewer (`src/office-runtime/PptxViewer.tsx:53`) | Parses file bytes, never reads state | Unchanged |
| Agent and headless paths: seed, baseline, inspect, apply, locate, resolve, export, rebase (`shared/office-checkpoint.ts:965-970, 1149`) | Always pass `baseBytes` | Unchanged |
| Collaboration service, Go, pipeline | Never read `pptx:meta` | Unchanged |

So yes, `packageJson` can leave the state and be derived from the fingerprint-checked source at
open, exactly like the decided media change. The source is already parsed at every open that can
save or render. The stored JSON only duplicates it.

### 4.3 The prototype

Patch: `cross-shrink/pptx-no-package-json.patch`, 4 source files, +68 and -240 lines, plus a scratch
example. Changes:

- `SCHEMA_VERSION` becomes one value (5.0 in the prototype). No migration list, and no separate
  schema 4 for rebased states; the overlay is an optional `sourceOverlay` key.
- `seed_doc` writes schema, fingerprint and slide size, then the slide graph. No `packageJson`,
  no `media`.
- `validate_meta` checks schema and fingerprint. `validate_doc(doc, package)` takes the package.
- `open_from_update_with_source` hydrates, checks the fingerprint, derives the package from the
  source plus overlay, validates, and builds the undo manager. `open_from_update` and
  `migrate_doc` are gone. `apply_update_v1` validates the staged copy with `self.package`.
- `set_overlay` stores every changed part as bytes, media included. `source_package` no longer
  reads a doc package.
- Tests: 5 source-free opens in `write_fidelity.rs`, `convergence.rs` and `shape_ops.rs` now pass
  the source; the source-free save test is dropped; the media-overlay test now expects the media
  bytes in the overlay; `tests/schema_migration.rs` (9 tests) is removed.

`cargo test -p betteroffice-pptx-edit`: 53 passed, 0 failed (62 passed before, the 9 migration tests
included). The media-overlay rebase test removes a picture before the capture, by deleting
either its slide or its shape, brings it back with Undo after the capture, and checks that the
rebased state saves the picture's media part.

The example `examples/state_size.rs` (native release build) seeds each deck, reopens the state with
its source, applies one remote edit on a second session, and saves from a fresh open of the edited
state. The save from the reopened state equals the editing session's save, part by part, on all six
decks, before and after the change.

| Deck | State before | State after | Remote update apply, before / after | Open with source, before / after |
| --- | ---: | ---: | ---: | ---: |
| lesson.pptx | 106,179 | 4,258 (-96.0%) | 1.2 / 0.3 ms | 6.8 / 8.4 ms |
| feature-rich.pptx | 54,819 | 17,718 (-67.7%) | 2.7 / 1.5 ms | 5.9 / 5.0 ms |
| betteroffice-demo.pptx | 158,144 | 77,907 (-50.7%) | 9.6 / 7.4 ms | 8.3 / 8.4 ms |
| deck-50.pptx | 518,674 | 157,934 (-69.6%) | 13.6 / 13.7 ms | 28.0 / 25.0 ms |
| zh_TW_llm.pptx | 9,634,772 | 404,788 (-95.8%) | 62.2 / 46.4 ms | 104.8 / 111.7 ms |
| jp_llm2.pptx | 22,708,897 | 674,852 (-97.0%) | 84.8 / 42.5 ms | 196.1 / 171.1 ms |

Timings are single runs of native code. The WASM engine in the browser is slower. The clear effect
is on remote-update validation for media decks, which no longer deserializes the JSON and copies
every image. Opens do not get slower, because the source was already parsed at every open.

### 4.4 Each test deck after the decided change and after both

| Deck | Source | Today | Media out (decided) | Media and `packageJson` out | Per slide after both |
| --- | ---: | ---: | ---: | ---: | ---: |
| lesson.pptx | 29,338 | 106,179 | 106,180 | 4,258 **M** | 2.1 KB |
| feature-rich.pptx | 16,550 | 54,819 | 54,820 | 17,718 **M** | 8.9 KB |
| betteroffice-demo.pptx | 12,395 | 158,144 | 158,029 | 77,907 **M** | 26.0 KB |
| deck-50.pptx | 94,214 | 518,674 | 518,676 | 157,934 **M** | 3.2 KB |
| zh_TW_llm.pptx | 8,756,518 | 9,634,772 | 1,107,371 | 404,788 **M** | 12.3 KB |
| jp_llm2.pptx | 24,390,706 | 22,708,897 | 1,753,694 | 674,852 **M** | 8.0 KB |

The "media out" column removes the `media` key from the seed and re-encodes it, which matches a real
seed within about 100 B: the same method gives 158,017 B for deck-50 with both keys removed, against
157,934 B from the prototype engine.

With media out but `packageJson` kept, `packageJson` is the largest item left: 1.08 MB of
jp_llm2's 1.75 MB and 0.70 MB of zh_TW's 1.11 MB. After both changes, a text deck stores 1.7x its
zipped source (deck-50) and a media deck 3% (jp_llm2). Refresh numbers follow: seed(B) shrinks the same way, and a rebased state keeps only the
parts that differ from B.

### 4.5 What else per slide could shrink

What remains is the slide graph. For deck-50 that is 83 KB of stories, 50 KB of shapes and 11 KB of
slide maps. For jp_llm2 it is 311 KB of stories, 281 KB of shapes and 29 KB of slide maps
(`cross-shrink/meta_large.jsonl`, `pptx_remaining.mjs`). Text itself is 30 KB and 43 KB of those.
The rest:

- Ids repeated three or four times per object (map key, `id` field, parent order array, story and
  paragraph ids such as `para:story:slide:0:256:shape:0:0:0`): 11.5 KB (7%) in deck-50, 56 KB (8%)
  in jp_llm2.
- Shape property key names (`placeholderJson`, `adjustValuesJson`, `textStories` and so on) on
  every shape: 11 KB and 57 KB, about 8%.
- Default values stored on every shape: `flipH`, `flipV`, `rotationDeg`, an empty
  `adjustValuesJson`, empty `children` and `textStories`. Five per shape, 500 entries in deck-50.
- JSON strings for fill, outline, placeholder and graphic: about 8 KB in deck-50, 52 KB in
  jp_llm2.
- Yjs v1 item overhead. Seeded items belong to the bootstrap client `2^53 - 1`, whose varint takes
  8 bytes in every id reference.

A leaner schema could cut perhaps 20-30% of these bytes. Encoding does better with no schema change:
update v2 alone saves 29-36%, and v2 plus gzip leaves 21 KB of deck-50's 158 KB and 57 KB of
jp_llm2's 675 KB (`cross-shrink/encodings.jsonl`). I would not restructure the slide schema for
bytes. If quota ends up counting stored bytes, store the state compressed (section 5.5).

### 4.6 Upstream

Upstream (`c0fa7262`, schema "2.2" in code, "v20" in its README) still stores the full package as
JSON, media included as decimal arrays, and mutates it after open: the SourceImport passes write
imported render data back with `sync_package_json` (`upstream deck.rs:988-998`), and
`open_from_update` builds the session package from it. Upstream reads the JSON for source-free
peers, migrations and SourceImport. The fork's decision rejects all three, and upstream already
validates against the session package where it can (`validated_snapshot`, `deck.rs:909-912`,
used by proposals). The conflicts sit in `seed_doc`, `validate_doc` and the two open functions,
which the decided media change rewrites anyway. Inserted pictures, which upstream stores as
`pendingMediaBase64` strings on their shape, stay binary on the shape under the decision and are
unaffected.

## 5. Part 2: overhead shared by all three formats

| Item | Readers | Bytes saved on the measured files | Effort | Risk | Changes seed output |
| --- | --- | --- | --- | --- | --- |
| Baseline derived from the published base | Collaboration `effects()` on every save and AI edit, `rebasePublication`, text handoff; Go `validSourceBaseline`; every session response (the browser ignores it) | All of it: book-300p 1.41 MB, cells-100k 43.1 MB, jp_llm2 461 KB, deck-50 204 KB, images-10 41 KB, plus `baseline(B)` in candidates | Medium | Medium | No for PPTX and XLSX; DOCX needs a deterministic seed first |
| Baseline as hashes, `before` from elsewhere | Same | Text values only: about 62% for book-300p, 12% for deck-50, near 0 for XLSX | High | High | No |
| Baseline dropped for text sources | Same | 1x the text size per edited text file | Small | Low | No |
| Effects without `before` | Chat evidence (`pending.py`), token counts in the service and Go, which drive the refresh trigger | -42% DOCX, -29% to -31% PPTX, -20% XLSX | Small | Chat loses which text was replaced | No |
| Effects trimmed to the changed span | Same | -69% DOCX, -2% to -11% PPTX, 0% XLSX | Small | Trigger semantics, needs sign-off | No |
| Candidate copy-on-write | `ClaimSourceRefresh` export, `rebasePublication`, text handoff | One state per refresh with no save during it: cells-100k 27.0 MB, jp_llm2 22.7 MB (0.67 MB after item 1), book-300p 4.5 MB | Small | Low | No |
| Candidate charged as `max` or not at all | Quota only | jp_llm2 peak 117 MB to 25 MB with items 1 and 2 | Small | Policy | No |
| Marker client id | Every room's tracker; persistence reads marker values only | 22.8 B per client update | Very small | Low | No |
| State compressed at rest | Go store layer, plus the service's direct SQL reads of candidates | book-300p state 4.46 MB to 0.90 MB (gzip) or 0.66 MB (zstd) | Small | Low | No |

### 5.1 The stored semantic baseline

**What it is.** `indexed_baseline` is UTF-8 JSON of `{entries, format, version}`
(`sourceDocuments.ts:68-70`). Readers: `effects()` compares it with the current baseline on every
save and every AI edit (`sourceDocuments.ts:399-431`); publication returns the candidate's baseline
or the rebased one (`:433-511`); the text handoff computes it from the captured text
(`sourceHandoff.ts:263-290`); Go validates its shape (`source_documents.go:474-488`) and returns it
in every session (`:238`). The browser editor receives it in `GET /api/files/{id}/source-session`
and never uses it (`useSourceSession.ts:158-190`). The pipeline never reads it.

**Composition** (`cross-shrink/dump_main.jsonl`). book-300p: text values 65%, the rest ids,
labels, formatting hashes and positions. deck-50: formatting hashes 20%, text 17%, labels 21%,
ids 20%, positions 13%. cells-10k: ids 40%, hashes 17%, labels 12%, text 11%.

**Derived on demand.** Every stored baseline except the rebased one equals
`officeBaseline(base, seed(base))`. `cross-shrink/baseline_det.mjs` seeds each file twice with
different random client ids:

| File | Baseline identical | Seed bytes identical | Seed + baseline time |
| --- | --- | --- | ---: |
| grades.xlsx, feature-rich.xlsx, cells-1k.xlsx | yes | yes | 7-202 ms |
| lesson.pptx, feature-rich.pptx, deck-50.pptx | yes | yes | 11-72 ms |
| book-30p.docx | yes | no | 125 ms |
| lesson.docx, feature-rich.docx, images-10.docx, opaque-objects.docx | no: object and image ids embed the client id | no | 33-579 ms |

More seed plus baseline times (`dump_main.jsonl`): book-300p 0.44 + 0.72 s, images-10 0.32 +
0.39 s, jp_llm2 0.84 + 0.41 s, cells-10k 0.38 + 1.84 s, cells-100k 4.2 + 76 s (storage report).

Design: a NULL `indexed_baseline` means "derive from the base". The service derives and caches it
by base SHA next to its base-bytes cache, so a cold room pays one derivation and later saves pay
nothing extra. Store it only after a publication that rebased saves made during the refresh; the
rebased baseline lives in the new identity space and the base alone cannot reproduce it. For text,
decode the base blob; that equals the stored text at initialize and after every publication
(`exportCandidate` writes `TextEncoder(textState(state))`, the seed is the state, and the decoder
keeps the BOM). DOCX needs its seed to run under a fixed bootstrap client first. XLSX should wait
for the lazy cell model, because 80 s per cold room is too slow for cells-100k.

Per format, then: drop the text baseline now (exact, a UTF-8 decode). Derive PPTX now (0.1-1.3 s
per cold room on the measured decks). Derive DOCX once its seed is deterministic (0.1-1.2 s). Derive
XLSX once the lazy cell model makes a baseline proportional to edits.

Side effects: the candidate no longer needs `baseline(B)`, and neither the bootstrap nor the
checkpoint response carries a baseline. At cells-100k that is 57 MB of base64 on each of them.

**Hashes instead of text, with `before` from elsewhere.** Workable but not worth it. A hash-only
baseline detects changes. The `before` text of an entry that newly changes must then come from the
previous pending effects if it was already changed, or else from the previous save's current
baseline, held in memory or recomputed from the previous durable state after a restart. It saves
only text values (62% for book-300p, near 0 for XLSX) and adds a second source of truth. Deriving
removes everything.

### 5.2 Pending effects without `before`

Readers of `before`:

- Chat and generate requests. `pending.py:47-64` sends the effects to the model as JSON on every
  request, with the instruction to apply replacements and removals to indexed passages. `before`
  is how the model finds the passage an edit replaced.
- Token counts: `effectTokens` (`sourceDocuments.ts:171-182`) and Go's `sourceEffectTokens`
  (`source_caption.go:23-58`) count `before + after + caption`. They feed the 5,000-token automatic
  refresh trigger (`sourceDocuments.ts:859`, `source_documents.go:423`).
- Not captions (`source_caption.go:80-131` uses `id`, `kind`, `imageSHA256`, `caption`), not
  publication (`source_refresh.go:311-316` uses `imageSHA256` and `operation`), not the UI (no
  reader in `src/` outside the mocks).

Measured after 100 edits, as stored jsonb text (`dump_values.mjs`):

| File | Full | Without `before` | Span-trimmed, 40 chars of context |
| --- | ---: | ---: | ---: |
| book-300p.docx | 131,360 | 76,761 (-41.6%) | 41,010 (-68.8%) |
| book-30p.docx | 137,894 | 80,029 (-42.0%) | 41,026 (-70.2%) |
| images-10.docx, 40 edits | 54,307 | 32,916 (-39.4%) | 19,069 (-64.9%) |
| deck-50.pptx | 30,593 | 21,667 (-29.2%) | 29,943 (-2.1%) |
| jp_llm2.pptx | 41,369 | 28,482 (-31.2%) | 36,945 (-10.7%) |
| cells-10k.xlsx | 24,542 | 19,664 (-19.9%) | 24,542 (0%) |

Dropping `before` breaks the chat evidence for paragraphs, since the label says only "body,
paragraph 87". Span trimming keeps what the model needs, the old words and the new words with
enough context to find them in an indexed passage, and it shrinks `after` as well. For book-300p
it takes the per-request pending message from about 33k tokens to about 10k. It changes the
refresh trigger: 100 edited paragraphs count about 5k tokens instead of about 27k, so book-300p
reaches the 5,000-token trigger after about 105 edited paragraphs instead of about 19. That
saves credits and leaves the index staler. It is a product call.

### 5.3 The refresh candidate

Today `RequestSourceRefresh` copies the whole state into `source_refresh_candidates.state`
(`source_documents.go:451,463`), and finalize adds B, `seed(B)` and `baseline(B)`
(`source_refresh.go:180-196`). Readers of the captured copy: the export (`ClaimSourceRefresh`,
`source_refresh.go:99`, then `exportCandidate`), the Office rebase when saves landed during the
refresh (`sourceDocuments.ts:444-493`), and the text handoff (`sourceHandoff.ts:263-273`).

**Reference instead of copy.** A Yjs snapshot of the room cannot stand in for the copy: source rooms
run `gc: true`, so content deleted after the capture is gone. Copy-on-write can. Insert the
candidate with a NULL state, meaning "the source state at the candidate's checkpoint". In
`SaveSourceCheckpoint`, before replacing the state, materialize the copy with
`UPDATE source_refresh_candidates SET state = d.state ... WHERE c.state IS NULL AND
c.checkpoint = d.checkpoint`, in the same transaction. Readers use `COALESCE(c.state, d.state)`,
which is safe because every write that advances `d.checkpoint` materializes the copy first.
The rebase only runs when the checkpoint advanced, and by then the copy exists. The text handoff
does not need the captured state at all, since its baseline is the decoded export. When nobody
saves during the refresh, the copy never exists: 27.0 MB for cells-100k, 22.7 MB for jp_llm2
today, 4.5 MB for book-300p.

**Sum or max.** Today's sum charges both versions at once, so a refresh needs about twice the
file's footprint free (jp_llm2 117 MB, cells-100k 169 MB against a 100 MB Free quota). Three
options:

- Sum, as today. With copy-on-write, the materialization lands inside a user's save and could be
  refused for quota mid-edit. That is worse than refusing the refresh up front.
- `max(current, candidate)`. Fair, but the generated `storage_bytes` columns cannot reference the
  other table, so it needs delta rows at admission, finalize and cleanup.
- No charge while the candidate is transient. Publication already gates the net growth of the
  published result (`source_refresh.go:289-297`), and there is one candidate per file. This is the
  simplest, and I would take it.

`seed(B)` should stay in the candidate. It becomes the next state, and recomputing it inside the
publication handoff would put up to seconds of engine work in the flush window.

### 5.4 Contributor markers

`attachDocumentContributorTracker` (`contributors.ts:113-128`) writes the marker in
`beforeTransaction` of the remote transaction. That write advances the room's own client id inside
a non-local transaction, so Yjs assumes a collision and picks a new id (`yjs.mjs:3342-3345`). Every
update then leaves a tombstone from a fresh client, and Yjs logs the rotation each time.

Fix: write the marker under a dedicated client id for the room and restore the room's id right
away. The marker stays in the same transaction and therefore in the same update across Redis.

```ts
// freshClientId: a random uint32 that differs from document.clientID.
let markerClient = freshClientId(document);
const written = new WeakMap<Y.Transaction, number>();
document.on('beforeTransaction', (transaction: Y.Transaction) => {
  const context = writableContext(transaction.origin);
  if (!context) return;
  const roomClient = document.clientID;
  document.clientID = markerClient; // the marker item gets this id
  try {
    document.getMap<unknown>(CONTRIBUTORS_ROOT).set(key(context), marker(context));
  } finally {
    document.clientID = roomClient;
  }
  written.set(transaction, Y.getState(document.store, markerClient));
});
document.on('afterTransactionCleanup', (transaction: Y.Transaction) => {
  const clock = written.get(transaction);
  // Someone else wrote under the marker id: move on, as Yjs does for its own id.
  if (clock !== undefined && transaction.afterState.get(markerClient) !== clock)
    markerClient = freshClientId(document);
});
```

Measured with `cross-shrink/marker_fix.mjs`, 1,000 single-character client updates with a save
every 100:

| Room | No markers | Today | Restore id after rotation | Marker client id |
| --- | ---: | ---: | ---: | ---: |
| deck-50 story | 1.02 B/update | 23.9 B/update, 1,001 client ids | 1.10 B, 1 id | 1.10 B, 1 id |
| Plain `Y.Text` | 1.02 B | 23.9 B | 1.10 B | 1.10 B |
| Updates carrying their marker | 0 | 1,000 of 1,000 | 1,000 of 1,000 | 1,000 of 1,000 |
| `[yjs] Changed the client-id` log lines | 0 | 1,000 | 1,000 | 0 |

A colliding update, one that carries structs under the room's own id, still rotates in both
variants. The restore-after-rotation variant also works, but it undoes a Yjs decision after the fact
and keeps the log line. `documentContributors`, `clearDocumentContributors`,
`removeDocumentContributors` and `assertUpdatePreservesContributors` read marker keys and values,
never client ids, so they need no change. Material rooms use the same tracker. Their compaction
threshold, `max(256 KiB, 4 x size)`, is reached after about 11,000 updates on a small note today and
about 230,000 with the fix. One focused vitest covers it: a room keeps its client id across client
updates, every emitted update contains its marker, and a colliding update moves the marker id.

### 5.5 Compression, quota, and what the platform pays

**Compression of what remains** (`cross-shrink/encodings.jsonl`, Node 22 zlib, single runs):

| Value | Logical | gzip-6 | brotli-5 | zstd-3 | Yjs v2 | v2 + gzip | pglz on disk |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| book-300p state | 4,459,400 | 899,367 | 474,290 | 657,234 | 3,965,242 | 778,069 | 1,356,830 |
| cells-10k state | 2,666,476 | 158,844 | 104,008 | 132,563 | 2,500,182 | 134,633 | 238,250 |
| deck-50 state, prototype | 157,934 | 34,637 | 29,010 | 32,805 | 112,986 | 20,982 | 46,253 |
| jp_llm2 state, prototype | 674,852 | 125,248 | 90,940 | 106,120 | 434,819 | 57,446 | 178,685 |
| images-10 state | 5,669,857 | 4,190,362 | 4,173,887 | 4,184,494 | 5,655,476 | 4,185,602 | 5,669,857 |
| book-300p baseline | 1,406,440 | 457,657 | 419,289 | 443,916 | | | 666,928 |
| cells-10k baseline | 4,255,767 | 218,118 | 150,961 | 171,629 | | | 574,757 |
| deck-50 baseline | 204,388 | 44,310 | 40,143 | 44,721 | | | 73,592 |

CPU on the 4.46 MB book-300p state: gzip 88 ms, gunzip 13 ms, zstd 22 ms, v1 to v2 212 ms. Media
does not compress, and gzip spends 763 ms on jp_llm2's 22.7 MB for 10%, one more reason media has
to leave first.

**What the platform pays.** B2 holds sources and candidate exports at $6.95 per TB-month. Postgres
on the application VPS holds state, baseline, effects and candidates. TOAST compresses them with
pglz only when that saves at least 25%. Text-heavy values sit on disk at 9-47% of their logical
size. Media states are stored raw: jp_llm2's 22.7 MB and images-10's 5.67 MB. lz4 would save 8% and
0.2% on those two. Each save rewrites the whole compressed state into WAL, about 1.1x its on-disk
size and 2x for the first save after each checkpoint. That is 24.9 to 48.3 MB per save for jp_llm2
today and 0.20 to 0.38 MB after item 1. Saves come every 1-10 s while someone types (a checkpoint
request 1 s after the last update, Hocuspocus debounce 2 s with a 10 s maximum). The old TOAST value
stays dead until autovacuum. Block storage on the Hetzner side lists at about €0.057 per GB-month,
roughly eight times B2, and the VPS disk is fixed size. A byte in Postgres is the expensive byte.

**What quota should count.** Today it counts logical `octet_length`. For text-heavy values that is
2-11x what Postgres stores, and for media states it is exactly what Postgres stores.

- Logical bytes. Simple, but a user pays for the engine's representation: 13.9x for book-300p
  after the rest of this set.
- Stored bytes. Compress `state` in Go's store layer (gzip in the standard library, or zstd through
  `klauspost/compress`) and keep `octet_length` in the generated columns. pglz then gives up on the
  compressed bytes, so disk use falls about 30% below today's pglz size, and the base64 bodies
  between the service and Go shrink 4-17x. The collaboration service reads candidate rows with SQL
  and would need the same codec. Charges then depend on how well a file compresses.
- Source plus pending edits plus growth beyond the seed. Record the seeded state size at initialize
  and at publication, and charge `size_bytes + octet_length(pending_effects::text) +
  max(0, octet_length(state) - seed_bytes)`. A user pays for the upload and for what they changed,
  and the engine's representation is a platform cost. Tombstones from typing that cancels out still
  count through the growth term.

I recommend the third rule. The platform's exposure is then the seeded state of edited files, which
items 1 and 2 and the siblings' work bring to 1.03x source for media files and to 1.7x for text
decks. Text DOCX stays the exception at 12.6x until the DOCX sibling's work lands.

### 5.6 Other findings

**Browser editor open downloads the baseline for nothing.** The locking `source-session` response
carries base64 state, base64 baseline and effects; the browser uses the state only. Per editor open,
B2 source plus that JSON:

| File | Today | After items 1-2 and the siblings, baseline left out of the response |
| --- | ---: | ---: |
| cells-100k.xlsx | 94.3 MB (0.8 + 36.0 state + 57.4 baseline) | about 0.83 MB |
| jp_llm2.pptx | 55.3 MB (24.4 + 30.3 + 0.6) | 25.3 MB |
| images-10.docx | 11.8 MB | 4.3 MB |
| book-300p.docx | 8.2 MB | 6.4 MB |
| deck-50.pptx | 1.06 MB | 0.30 MB |

**Every save moves the state three times between the service and Go.** `storeSnapshot` fetches the
bootstrap (state, baseline, effects), posts the new state, and receives the whole session back
(`source_documents.go:319-330`), although the service reads only `checkpoint` and `operation`. That
is about three base64 states and two base64 baselines per save: 223 MB for cells-100k, 92 MB for
jp_llm2 and 22 MB for book-300p today. A receipt-only response and derived baselines take jp_llm2
to 1.8 MB.

**IndexedDB drafts write the base and the full state on every keystroke.** `useSourceSession.ts:396-410`
encodes the whole Y.Doc and queues a put of `{base, state}` for every local update. The queue
serializes the writes but does not coalesce them. That is 47.1 MB per keystroke for jp_llm2 today,
25.1 MB after item 1 (the base dominates) and 27.8 MB for cells-100k. The encode alone takes 61 ms
for jp_llm2 today and 10 ms after item 1, 38 ms for book-300p (`per_update_cost.mjs`, Node). Storing
the base once per SHA in its own object store, and encoding and writing the draft at most every
250 ms or so, removes both costs.

**The collaboration service copies the whole room state for every incoming message.**
`beforeHandleMessage` runs `assertUpdatePreservesContributors` (encode the room, apply it into a
candidate doc, apply the update) and, for source rooms, the byte-limit check (the same again plus
one more encode) (`server.ts:539-555`). Median per message: 250 ms for jp_llm2 today and 96 ms
without media, 284 ms for book-300p, 96 ms for cells-10k, 17 ms for deck-50. The cost follows item
count more than bytes, so item 1 does not help beyond the media cut. The marker check could decode
the update and inspect only the marker root and the delete set, and the exact byte limit is already
enforced at save (`sourceDocuments.ts:541`). This caps typing throughput per room on the single
service thread today.

**The browser engine validates every remote PPTX update against a full copy.** `apply_update_v1`
hydrates a staged copy of the whole deck and deserializes the package for each remote update: 85 ms
native for jp_llm2 today, 43 ms after item 1.

**Lazy state (item 8).** XLSX and PPTX seeds are byte-identical across runs, so a NULL state can mean
`seed(base)` without two service instances diverging. The first real save stores the state. After a
publication without later edits the state goes back to NULL. DOCX seeds are not identical yet, so
two instances deriving their own seeds would produce different lineages.

## 6. Method, reproduction and caveats

Run the Node scripts from `cross-shrink/` with Node 22.19. They import the engine and Yjs through
`../storage/lib.mjs`.

| Script or record | Purpose |
| --- | --- |
| `pptx_meta.mjs`, `meta_small.jsonl`, `meta_large.jsonl` | `packageJson` composition, seed without `media` or `packageJson` |
| `pptx-no-package-json.patch`, `rust_before.jsonl`, `rust_after.jsonl`, `dumps/pptx-proto/` | Prototype diff, example output before and after, prototype seeds |
| `pptx_remaining.mjs` | Ids, keys and defaults in what remains |
| `baseline_det.mjs` | Baseline and seed determinism, seed and baseline times |
| `dump_values.mjs`, `dump_main.jsonl`, `dumps/` | Stored values today, XLSX decided baseline, effects variants after 100 edits |
| `encodings.mjs`, `encodings.jsonl` | gzip, brotli, zstd, Yjs v2 |
| `toast_wal_results.txt` | pglz and lz4 sizes, WAL per save, from the scratch Postgres |
| `marker_fix.mjs`, `marker_fix.out` | Marker variants, atomicity and collision checks |
| `per_update_cost.mjs`, `mk_nomedia.mjs` | Per-message service cost and draft encode |
| `combined_table.mjs` | Section 3 arithmetic |

The prototype ran in a detached worktree of the fork at `dfa3f05e`: `cargo test -p
betteroffice-pptx-edit` and `cargo run --release -p betteroffice-pptx-edit --example state_size`.
TOAST and WAL: values loaded with `pg_read_binary_file` into default-storage tables; sizes from
`pg_column_size`; WAL from `pg_wal_lsn_diff` around one `UPDATE` of the state.

Caveats:

- deck-50, book-300p, images-10 and the cells files are the storage report's generated fixtures.
  Real decks carry more layouts and relationships, which makes `packageJson` larger, not smaller.
- The XLSX and DOCX columns of the recommended scenario rest on the sibling assumptions in section
  3, not on their measurements.
- Timings are single runs on a 16-core Windows desktop, and native Rust timings understate WASM.
- "Media out" states come from deleting the key and re-encoding. That matched the prototype seed
  within 100 B for deck-50 with both keys removed.
- WAL per save came from one-row updates on an idle scratch server with default settings.
- The Hetzner and B2 prices come from their public pricing pages in September 2026 and are only
  indicative.
