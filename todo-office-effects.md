# Office room memory and save-path effects: open work

From the 2026-10-17 investigation into how Office files sit in yrs and what a
save costs. Nothing here is decided yet; the open questions for Epo are at the
end. The resident-memory measurement started the same day on branch
`claude/infallible-cannon-5d2677` (report under `bench/collaboration/reports/`).

## What a room holds

- **DOCX:** one Y.Text per story (body, headers, footnotes, each table cell).
  Every paragraph mark is a nested Y.Map embed, and formatting is pairs of
  format items.
- **PPTX:** a flat `pptx:shapes` map (one Y.Map of about 15 keys per shape)
  plus a Y.Text per text box.
- **XLSX:** the seed writes **no cells**. Only edited cells become entries in
  the `contents` / `styles` maps, keyed by JSON topology points (about 124 B
  each). The engine's parsed workbook ("replica", about 22 B of heap per
  unzipped byte) is the big XLSX cost, not yrs.
- yrs costs, measured with a scratch probe on the fork's yrs:
  - an `Item` is 160 B and a nested type's `Branch` is 232 B;
  - a DOCX-like doc of 20k paragraphs is **48 MiB of heap** against 3.6 MiB
    encoded and 1.2 MB of text, about 2.4 KB per paragraph;
  - continuous typing costs about 1 B per character, scattered typing about
    17 B encoded and 350 B of heap per keystroke;
  - deleted text shrinks to a counter (GC is on), but the 160 B struct stays.
- Items only fragment. Splits from inserts, deletes or formatting never re-join
  across a tombstone. Only a publication into a new epoch (fresh seed from the
  exported file) clears history. A **deferred** publication (editors active)
  keeps the old base and epoch, so a busy room never sheds tombstones.

## What one Office save does today

`start_source_store` (`collaboration-rs/crates/server/src/room.rs`) and
`Sources::store` (`collaboration-rs/crates/sources/src/store.rs`):

1. Snapshot plus delta row, the only thing stored
   (`source_document_updates`).
2. **Encode the whole state** (every struct, tombstones included).
3. Copy the **whole base file and whole state** into a frame and pipe it to
   the room's engine child process.
4. In the child:
   - **DOCX:** parse the file, decode the state into a second yrs doc, run the
     parsed file through a JSON round trip, and list every paragraph's full
     text.
   - **PPTX:** open the deck from the state plus the file, and list every
     paragraph's full text.
   - **XLSX:** rebuild a yrs doc and a full model from the whole state on
     the cached parse.
5. Send every paragraph's text back as JSON. The server compares it with the
   cached indexed baseline (`unshifted_effects`), trims the effects
   (`trim_effect`) and estimates `net_tokens`.
6. POST the checkpoint to Go.

Steps 2–5 exist only to produce `pending_effects` and `net_tokens`. Steady
save p95 was 343 / 569 / 771 ms at 10 / 20 / 30 large rooms
(`bench/collaboration/reports/2026-10-11-prod-capacity-rust.md`). Each save
briefly holds several whole-document copies across the server and the child.

## Who reads the effects

| Consumer | Needs |
| --- | --- |
| Chat and Generate prompts (`pipeline/pipeline/retrieval/pending.py`) | the right text in before/after excerpts; a missed change only degrades to stale text |
| `resolve_source_change` (`pipeline/pipeline/retrieval/tools.py`) | exact image id and hash, checked by the gateway |
| Publication trigger (`collaboration-rs/crates/sources/src/refresh.rs`) | rough tokens, but "something changed" must be right: a file is only a candidate if `net_tokens > 0` or effects are non-empty |
| Too-large notice, Generate's `pending_sources_too_large`, maintenance status, quota bytes | rough |
| Editor session API (`pendingEffects`) | nothing; the frontend only reads it in mocks. Remove it |

The agents don't need paragraph vs heading or labels, only "text, image or
table added, removed or changed" with enough context to find the passage.

## Proposal: effects straight from the room's yrs doc

Replace steps 2–5 with an in-process reader. The engine stays for export,
publication rebase, AI edit commands and fetching image bytes on demand.

1. **Flatten** with a thin bit of schema knowledge (which roots hold text,
   `_kind` on embeds, the `del` attribute):
   - **DOCX:** each story in `stories`, split into units at the pilcrow
     embeds, skipping text marked `del`. Other embeds become placeholders
     (image with its `src`, table with its cell stories flattened, math,
     field).
   - **PPTX:** the same over `pptx:stories`; slides added or removed come
     from `pptx:slide-order`.
   - **XLSX:** the `contents` overrides. A base-run key is the source row
     and column, i.e. the cell as indexed; other runs are inserted rows or
     columns.
2. **Baseline:** flatten once right after the seed is applied at epoch start.
   When the state is NULL, the seed is the indexed version. A deferred
   publication's indexed version is seed + `published_state` instead. Keep
   `(hash, text)` per unit, which is roughly the document's plain-text size
   (about 1.2 MB for 20k paragraphs). It has to be kept apart from the doc:
   GC removes deleted text, so yrs `diff_range` against an old snapshot
   cannot give "before".
3. **Dirty stories:** admission already walks each new struct up to its root
   and key. Record those keys, plus the parents of deleted items.
   Over-marking only costs a re-read.
4. **At save:**
   - flatten only the dirty stories;
   - align units with the baseline by hash;
   - emit the existing `NetEffect` shape (`kind` text, image or table;
     `operation` insert, update or delete);
   - reuse `trim_effect` and `effect_tokens`.

Known gaps:
- Moves become delete plus insert.
- XLSX has no "before" value (it lives in the file); send the address and new
  value or formula text.
- Seeded images are `media:<part>`, so their hash is filled when resolved.
- Excerpts may differ slightly from the ingest parser's text (list numbers,
  field results). Today's engine effects have the same gap.

**The risk to check first is misses.** If the reader misses the only change in
a file, its effects come out empty and the file never auto-publishes. Before
switching:
- build it as a bench;
- run the same scripted edits (typing, cross-paragraph delete, Enter, image
  insert, table row insert, cell edits) through both paths on
  `book-30p.docx`, `exchange-plan.docx` and the large collaboration fixtures;
- compare misses, differences, wall time and peak heap.

If it lands, keep a full engine compare as a check (on publication, or every
N saves) that logs any mismatch.

## Notes get pending effects too

Today chat sees a note's edits only after the full re-index:
1. 30 s idle, then projection to `materials.content`;
2. 15 s idle, then an ingest job is queued;
3. the job chunks and embeds.

Until that job finishes, chat gets no notice that the note changed.

Notes are cheaper than Office here, because every save already builds the
whole Plate value in-process (`validate`).

- **Baseline:** the note's per-block index text at its last index:
  `store.MaterialIndexText.Blocks` from Go's `materialdoc.ExtractIndexBlocks`.
  The embeds round built the matching Rust extraction (`notes::index_text` on
  branch `embeds/index`, golden fixtures shared with Go in
  `server/internal/materialdoc/testdata/index_text/`). It follows the embed
  catalog's per-element rules: titles and captions, labels, chart, plot and
  graph data, the whole Mermaid source, no HTML embed, and embedded quizzes
  and flashcard sets inside the note at their reference (quiz stems and
  options only, never answer keys, worked solutions or ordering items; Epo
  2026-10-18). Use `from_doc` for a live room and `from_content` for stored
  content. Align blocks by element id (an id-less block gets ""), and diff
  the live list against the recorded one. A heavy data diff (over ~150
  tokens) becomes a placeholder resolved through `resolve_source_change`,
  which returns only what index text holds.
- **At save:** compare the value just built with the baseline, and write
  `pending_effects` and `net_tokens` on the material.
- **Clear** both when the index job completes.
- **Plumbing:**
  - new `materials` columns: effects, tokens, indexed marker;
  - `note_store::append` writes them;
  - `pending.load` reads notes as well as files;
  - the notice and too-large paths cover notes.

With effects covering chat, the note index gaps could grow (or move to a token
threshold like Office) to spend less on embeddings.

## How fresh the effects are

Effects follow saves: 5 s after the last change, at most 30 s while typing
(`COLLABORATION_SOURCE_DEBOUNCE_MS` / `_MAX_DEBOUNCE_MS`). The 60 s idle and
3,000 tokens gate publication only.

- **Shortening the save debounce** multiplies Postgres rows and folds. Don't.
- **Live read for chat:** with a cheap flatten, the pipeline could ask the
  collaboration server for a loaded room's changes at request time
  (milliseconds, near-zero lag). Saved effects stay as the durable record and
  the publication trigger. The trade is that chat could see edits not yet
  saved, so the prompt's "exact net changes through each stated durable
  checkpoint" would have to change.

## Other memory levers found

- **Trial copy:** every update past the small-edit limit (more than 16
  structs, e.g. a paste) encodes the whole room and rebuilds a full copy for
  the trial (`ydoc::trial`). About 56–70 ms and +44–54 MiB on the probe docs.
- **Nested maps for data nobody edits concurrently** (pilcrow keys, shape
  properties, cell overrides) pay sequence-CRDT bookkeeping. Plain values or
  server-sequenced last-writer-wins would be leaner, at the cost of offline
  merging for that data.
- **XLSX cell keys** are about 50 B of JSON each.
- **`MAX_SOURCE_STATE_BYTES` = 100 MiB** is now only the shared ceiling:
  each room's cap is its seed plus the export cap less the base and a 1 MiB
  margin, and admission keeps a 64 KiB reserve under it (Epo 2026-10-17,
  `sources::state_cap`). Memory still runs about 13× the encoded bytes for
  text-heavy DOCX.
- **Rooms are never evicted by size.** A room unloads only when it is empty
  and clean.
- **Typing walks the list:** yrs `find_position` walks from the story start
  on every local insert (no position cache). It runs in the browser's wasm,
  and a long DOCX body is one story.
- **DOCX table rows:** inserting one rewrites the table embed's whole `rows`
  value, so two concurrent row inserts lose one.

## Follow-ups from the per-room cap

- **Offline drafts capped at the room's budget** (Epo 2026-10-17, its own
  branch after effects/limits lands). The browser still caps a device's
  unsaved source state at the 100 MB ceiling (`SOURCE_STATE_MAX_BYTES`,
  `useSourceSession.ts` `recordDrafts`), so offline edits can outgrow what
  the room admits and land in recovery on reconnect. Cap Office drafts at the
  session's `growthBudgetBytes` over the opened state instead, with the
  offline banner's limit message.
- **The ceiling in Go's budget.** A room's cap is also held under the
  100 MiB ceiling, which depends on the seed's size; Go never sees an Office
  seed (`seed_bytes` stays 0 for Office rows), so its `growthBudgetBytes`
  can stay positive for a file whose seed is near the ceiling, which then
  opens in Edit with its first change refused (as on main before the cap).
  Recording the Office seed size at the first save would let Go cap it.

## Open questions for Epo

1. Does the engine-free reader count as engine code in the server process,
   given the 2026-10-07 isolation decision? It reads yrs only and never
   parses the file.
2. Note pending effects: go ahead, and should the note index gaps move to a
   token threshold?
3. Live read for chat: is it acceptable for chat to see unsaved edits?
4. The state cap: tie it to the plan's file cap, or to a multiple of the
   seed?
5. Remove the unused `pendingEffects` from the editor session API?

## Parked

- Linked images: newly inserted DOCX/PPTX images stored as editor assets (B2) with only a `capy-image:<sha256>.<ext>`
  link in the document and stored file; materialized on Download, ingest and capture_page. Feasible but about 25–31
  days across the fork (DOCX parse/export and PPTX drop or corrupt links today), Go, pipeline and frontend; decisions
  open (link format, link-only vs embedded preview + link, cleanup, offline, limits). Report: private harness
  `2026-10-17-effects-misses/D-LINKED-IMAGES.md`. Parked by Epo 2026-10-17: images stay in the file with an
  insert-time budget.
- Pending (Epo 2026-10-21): chapter-level quizzes and flashcard sets stay unindexed, but the agent should find them by title, question text and answers through the same cheap lexical match the per-message hints use (no chunking, no vectors).
