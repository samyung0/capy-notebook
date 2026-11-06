# Office room memory after edit histories, 2026-10-17

How much memory an Office collaboration room's yrs document holds, and how
large its encoded state gets, after realistic edit histories in DOCX, PPTX
and XLSX. Earlier collaboration reports measured only seed sizes and the
whole process's working set. This run measures one room at a time, in
process, with the fork's own edit APIs making the edits. Nothing here changes
product code.

## Short version

- **A room holds 8–14× its encoded state in memory** for DOCX and PPTX
  (long-handbook: 12.6 MiB for a 1.2 MiB seed; jp_llm2: 8.0 MiB for 0.7 MiB),
  and about 4× for XLSX cell and style entries (37.5 MiB for 9.2 MiB after
  10,000 edits). A struct costs 4–12 allocator blocks.
- **After 10,000 edits** the rooms hold 5.7–39.5 MiB (DOCX), 11.2 MiB (PPTX)
  and 37.5 MiB (XLSX). Typing barely counts: 58–82 B per DOCX keystroke,
  189 B per PPTX one, 420 B per typed XLSX value.
- **Which edit dominates:** within its format, each one dominates. DOCX table
  row inserts are 6% of the DOCX edits and 80–86% of the growth in the files
  that have tables: about 28–40 KB held and 64–80 KB on the wire per insert.
  XLSX range styling is 20% of the XLSX edits and 90% of its growth: 17.8 KB
  held and 8.5 KB on the wire per range of about 58 cells, so about 310 B
  held and 146 B on the wire per styled cell. One table row insert costs as
  much room memory as two range styles, and 8–9 times their wire bytes.
  The row's wire cost grows with the table: each insert rewrites the
  table's whole `rows` value. Over this mix XLSX styling adds more in total
  (33 MiB against 23 MiB) because it is chosen three times as often.
- **The XLSX engine replica outweighs the room.** The gradebook's replica
  holds 161 MiB whatever the edits (the pool estimates 178 MiB); the room
  holds 0.1 MiB at the seed and 37.5 MiB after 10,000 edits.
- **The whole-state encode every Office save does** takes 0.5–2.6 ms at the
  seed and 2–15 ms after 10,000 edits (max 63 ms, long-handbook); the delta
  row 0.2–0.9 ms.
- **A fold does not shrink a live room.** A room reloaded from the folded
  state holds 1–3.5% less than the live one: no durable cover yet, and
  fewer garbage-collected runs (890 against 1,399 in long-handbook).
  The fold's scratch document holds as much as the room, for 6–139 ms.
- **Found on the way (client side, not the room):** each XLSX edit restages
  the whole document and its update carries the client's entire delete set
  (see [Observations](#observations)).

## Setup

- **Machine:** Apple M1, 8 GiB, macOS 15.3.1, rustc 1.98.0. This Mac normally
  holds no Rust work; the bench is standalone and builds only the engines it
  needs (a few minutes cold).
- **Code:** Capy `56b23552` with BetterOffice at the pin `8b50ac30`.
- **Bench:** [`scripts/office-room-memory/`](../scripts/office-room-memory/),
  a standalone cargo crate, not a collaboration-rs member, so nothing ships.
  `run.sh <out-dir>` builds it and runs the five fixtures. `summarize.py`
  prints the tables below from the JSON records.
- **Client:** one replica per room makes the edits through the fork's APIs:
  docx-edit `EditingDoc` (seeded with `seed_from_docx`, whose state equals
  the server seed byte for byte), pptx-edit `DeckSession`
  (`open_from_update_with_source` on the server seed), and the
  betteroffice-xlsx `Workbook` (`open_collaborative`; its state equals
  `seed_collaborative`). Its cell and style edits go through the authority's
  `stable` module. Each transaction's update reaches the room through the
  client's update observer, as the editor sends it.
- **Room:** a `Doc` with `ydoc::doc_options(0)` (GC on), seeded with
  `office_service::seed`, which applies every update as it arrives. Every 25 edits
  it saves as `start_source_store` does (room.rs ~2583): a
  `ydoc::delta_update` row against its durable cover, and the
  whole-state encode for the engine, timed. It folds as `SourceStore::fold`
  does: the seed, stored state and rows replayed into `ydoc::scratch_doc()`,
  encoded over the seed's state vector, once the log passes max(256 KiB, the
  stored state) or 1000 rows. At each checkpoint it saves, measures, folds,
  then reloads a fresh room from seed plus folded state.
- **Edit mix, per 100 edits:**
  - **DOCX:** 70 keystrokes, 8 backspaces, 6 bold toggles on 5–40
    characters, 6 Enters, 4 cross-paragraph deletes, 6 table row inserts.
  - **PPTX:** the same, with 6 shape moves in place of table rows.
  - **XLSX:** 70 typed cell values, 10 cleared cells, 20 range styles
    (1–30 rows by 1–8 columns, bold or a fill).

  Typing comes in bursts of 20 keystrokes at one caret, which then jumps.
  An XLSX value moves the caret down one cell, as Enter does. A DOCX
  cross-paragraph delete runs from inside one text-only paragraph into the
  next; a first pass that let it span a table deleted every table in
  exchange-plan, and the DOCX records here are from the rerun. A PPTX one is
  `replace_text` with nothing. Row inserts go below row 0 of a random body
  table. A shape move picks a random top-level shape. Edits an engine
  refuses are retried with a new pick and counted (tables below). The seed
  is fixed, so runs are deterministic.
- **Memory:** a counting global allocator adds each live block's usable
  size (`malloc_size`), counted on the thread that holds the room, so the
  client replica and the engines' own allocations are left out. "Room held"
  is the doc plus its durable cover, as the room task keeps them. Dropping
  the room at the end frees exactly the counted bytes in every run.
  These are macOS usable sizes, not RSS; production's glibc has other
  size classes and per-block overhead, so expect a few percent of
  difference either way.
  Structs are counted from the store: live items, deleted items and
  garbage-collected runs.
- **Fixtures:** the 62-page `bench/editor/fixtures/office/long-handbook.docx`,
  `vendor/betteroffice/poc/fixtures/book-30p.docx` and `exchange-plan.docx`
  (they are in the fork's `poc/fixtures`, not in `bench/parsers`), the
  84-slide `bench/parsers/fixtures/docs/jp_llm2.pptx`, and the 16,000-row
  `bench/editor/fixtures/office/large-gradebook.xlsx`.

Raw records: [`2026-10-17-mac-m1/`](2026-10-17-mac-m1/): one JSON record per
fixture plus its `/usr/bin/time -l` output. The bench process peaked at
35–194 MiB, and 482 MiB for the gradebook with its replica.

## Results

Columns: *room held* is the doc and its durable cover; *wire* is the sum of
client updates; *log* is the rows not yet folded; *stored after fold* is the
fold's state over the seed; *reloaded* is a fresh room from seed plus that
state. Per-kind rows divide each kind's wire bytes and room-held change by
its count; deletes free memory, so theirs is negative.

### DOCX: long-handbook.docx

File 40 KiB, XML parts 326 KiB unzipped (353 KiB with media); seed state 1255 KiB (267 ms to seed); 18,879 live structs at the seed.

| stage | room held MiB | blocks | structs live/deleted/GC | state KiB | whole encode ms | wire KiB | log rows / KiB | stored after fold KiB | fold ms | reloaded MiB | reloaded structs live/deleted/GC |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| seed | 12.56 | 146,465 | 18,879/448/448 | 1255 | 2.6 | 0 | 0 / 0 | – | – | 12.40 | 18,879/448/448 |
| 1,000 edits | 15.64 | 182,725 | 21,558/1,111/490 | 1446 | 4.5 | 1509 | 9 / 320 | 375 | 44 | 15.46 | 21,558/1,111/479 |
| 10,000 edits | 39.49 | 462,453 | 41,556/7,286/1,399 | 2926 | 15.2 | 38868 | 3 / 763 | 1961 | 139 | 39.08 | 41,556/7,286/890 |

Saves: 400, whole-state encode median 9.2 ms, max 63.2 ms; delta row median 0.9 ms; folds during the run 33; edits took 122.1 s (10,056 attempts). Drop check: counted 41,409,568 B, freed 41,409,568 B.

| edit kind | done | refused | wire B per edit | room held B per edit |
| --- | --- | --- | --- | --- |
| backspace | 827 | 0 | 25 | -324 |
| bold | 616 | 0 | 43 | 691 |
| crossDelete | 319 | 56 | 285 | -5,696 |
| enter | 599 | 0 | 642 | 8,136 |
| tableRow | 608 | 0 | 64,383 | 39,787 |
| type | 7,031 | 0 | 19 | 82 |

Refused: crossDelete: next to a table (56).

### DOCX: book-30p.docx

File 47 KiB, XML parts 187 KiB unzipped (187 KiB with media); seed state 253 KiB (29 ms to seed); 3,374 live structs at the seed.

| stage | room held MiB | blocks | structs live/deleted/GC | state KiB | whole encode ms | wire KiB | log rows / KiB | stored after fold KiB | fold ms | reloaded MiB | reloaded structs live/deleted/GC |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| seed | 1.88 | 22,719 | 3,374/1/1 | 253 | 0.5 | 0 | 0 / 0 | – | – | 1.86 | 3,374/1/1 |
| 1,000 edits | 2.36 | 27,182 | 4,205/753/53 | 286 | 0.7 | 88 | 40 / 70 | 63 | 6 | 2.32 | 4,205/753/43 |
| 10,000 edits | 5.67 | 58,542 | 10,746/5,025/1,895 | 519 | 2.1 | 905 | 80 / 141 | 367 | 25 | 5.48 | 10,746/5,025/632 |

Saves: 400, whole-state encode median 1.7 ms, max 4.3 ms; delta row median 0.2 ms; folds during the run 2; edits took 47.8 s (10,652 attempts). Drop check: counted 5,945,872 B, freed 5,945,872 B.

| edit kind | done | refused | wire B per edit | room held B per edit |
| --- | --- | --- | --- | --- |
| backspace | 870 | 0 | 34 | -513 |
| bold | 649 | 0 | 43 | 879 |
| crossDelete | 400 | 0 | 373 | -7,564 |
| enter | 645 | 0 | 903 | 9,727 |
| tableRow | 0 | 652 | 0 | 0 |
| type | 7,436 | 0 | 18 | 58 |

Refused: tableRow: no tables (652).

### DOCX: exchange-plan.docx

File 64 KiB, XML parts 265 KiB unzipped (302 KiB with media); seed state 306 KiB (70 ms to seed); 4,071 live structs at the seed.

| stage | room held MiB | blocks | structs live/deleted/GC | state KiB | whole encode ms | wire KiB | log rows / KiB | stored after fold KiB | fold ms | reloaded MiB | reloaded structs live/deleted/GC |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| seed | 4.09 | 50,793 | 4,071/125/124 | 306 | 0.7 | 0 | 0 / 0 | – | – | 4.03 | 4,071/125/124 |
| 1,000 edits | 6.54 | 80,108 | 6,348/798/182 | 459 | 1.6 | 1616 | 1 / 21 | 256 | 17 | 6.46 | 6,348/798/162 |
| 10,000 edits | 24.40 | 291,829 | 21,333/6,345/1,904 | 1565 | 9.3 | 49186 | 6 / 1209 | 1399 | 99 | 24.12 | 21,333/6,345/672 |

Saves: 400, whole-state encode median 4.7 ms, max 16.1 ms; delta row median 0.6 ms; folds during the run 50; edits took 42.1 s (10,046 attempts). Drop check: counted 25,588,352 B, freed 25,588,352 B.

| edit kind | done | refused | wire B per edit | room held B per edit |
| --- | --- | --- | --- | --- |
| backspace | 819 | 0 | 43 | -547 |
| bold | 620 | 0 | 38 | 434 |
| crossDelete | 320 | 46 | 483 | -7,901 |
| enter | 598 | 0 | 933 | 10,487 |
| tableRow | 616 | 0 | 80,301 | 27,733 |
| type | 7,027 | 0 | 18 | 60 |

Refused: crossDelete: next to a table (46).

### PPTX: jp_llm2.pptx

File 23819 KiB, XML parts 1513 KiB unzipped (24974 KiB with media); seed state 712 KiB (208 ms to seed); 21,478 live structs at the seed.

| stage | room held MiB | blocks | structs live/deleted/GC | state KiB | whole encode ms | wire KiB | log rows / KiB | stored after fold KiB | fold ms | reloaded MiB | reloaded structs live/deleted/GC |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| seed | 7.96 | 78,588 | 21,478/267/0 | 712 | 1.3 | 0 | 0 / 0 | – | – | 7.77 | 21,478/267/0 |
| 1,000 edits | 8.35 | 81,818 | 22,431/822/26 | 743 | 1.4 | 51 | 40 / 36 | 35 | 14 | 8.15 | 22,431/822/26 |
| 10,000 edits | 11.23 | 105,895 | 29,133/6,629/398 | 977 | 2.3 | 497 | 60 / 51 | 288 | 28 | 10.91 | 29,133/6,629/357 |

Saves: 400, whole-state encode median 1.9 ms, max 3.2 ms; delta row median 0.2 ms; folds during the run 1; edits took 1.4 s (10,238 attempts). Drop check: counted 11,772,880 B, freed 11,772,880 B.

| edit kind | done | refused | wire B per edit | room held B per edit |
| --- | --- | --- | --- | --- |
| backspace | 773 | 67 | 9 | 52 |
| bold | 632 | 0 | 56 | 439 |
| crossDelete | 226 | 171 | 140 | -2,728 |
| enter | 618 | 0 | 250 | 3,313 |
| shapeMove | 619 | 0 | 47 | 322 |
| type | 7,132 | 0 | 35 | 189 |

Refused: backspace: caret at start (7); backspace: text range N..N crosses a paragraph boundary (60); crossDelete: one paragraph (171).

### XLSX: large-gradebook.xlsx

File 1331 KiB, XML parts 8274 KiB unzipped (8274 KiB with media); seed state 8 KiB (503 ms to seed); 169 live structs at the seed.

| stage | room held MiB | blocks | structs live/deleted/GC | state KiB | whole encode ms | wire KiB | log rows / KiB | stored after fold KiB | fold ms | reloaded MiB | reloaded structs live/deleted/GC | replica MiB |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| seed | 0.10 | 874 | 169/0/0 | 8 | 0.0 | 0 | 0 / 0 | – | – | 0.10 | 169/0/0 | 161.18 |
| 1,000 edits | 4.38 | 34,887 | 8,577/297/0 | 1117 | 1.0 | 1187 | 1 / 34 | 1109 | 7 | 4.29 | 8,577/297/0 | 161.18 |
| 10,000 edits | 37.46 | 298,031 | 70,996/12,950/0 | 9413 | 13.2 | 48999 | 57 / 1460 | 9406 | 67 | 36.80 | 70,996/12,950/0 | 161.18 |

Saves: 400, whole-state encode median 6.8 ms, max 19.8 ms; delta row median 0.5 ms; folds during the run 6; edits took 1407.9 s (10,000 attempts). Drop check: counted 39,276,944 B, freed 39,276,944 B.

| edit kind | done | refused | wire B per edit | room held B per edit |
| --- | --- | --- | --- | --- |
| clear | 1,021 | 0 | 4,189 | 429 |
| rangeStyle | 1,972 | 0 | 8,452 | 17,803 |
| type | 7,007 | 0 | 4,172 | 420 |

Replica at 10,000 edits: miss 1256 ms, hit 376 ms, held 161.18 MiB (the pool's estimate 177.76 MiB).

## Which edit dominates growth

Room-held change per kind, summed over the 10,000 edits:

| file | growth MiB | table rows / range styles | Enter | bold | typing | deletes |
| --- | --- | --- | --- | --- | --- | --- |
| long-handbook.docx | 26.9 | 23.1 (608 inserts, 86%) | 4.6 | 0.4 | 0.6 | −2.0 |
| exchange-plan.docx | 20.3 | 16.3 (616 inserts, 80%) | 6.0 | 0.3 | 0.4 | −2.8 |
| book-30p.docx (no tables) | 3.8 | – | 6.0 | 0.5 | 0.4 | −3.3 |
| large-gradebook.xlsx | 37.4 | 33.5 (1,972 ranges, 90%) | – | – | 2.8 (values) | 0.4 (clears) |

- **Per edit, a DOCX table row insert is the most expensive edit measured.**
  It holds 28–40 KB in the room and sends 64–80 KB. A range style holds
  17.8 KB and sends 8.5 KB.
- **Per unit of content, XLSX styling is cheap.** About 310 B held and
  146 B sent per styled cell; there is one entry per cell, and a cell
  styled again replaces its entry. The ~124 B per cell from the earlier
  probe is the encoded half of this.
- **The table row cost has two parts.** The update rewrites the table's
  whole `rows` value (docx-edit `ops/table.rs` writes `tblPr`, `grid` and
  `rows` together on every structural edit), so its wire size grows with
  the table. GC frees the old value, so neither the room nor the state
  keeps it: long-handbook's state grew 1.6 MiB while its updates came to
  38 MiB. What the room keeps, 28–40 KB a row, fits the row's new cell
  stories. Each has a paragraph mark, and an Enter in body text holds
  8–10 KB for one mark. I did not split it further.
- **What grows a room most depends on the document.** A table-heavy DOCX
  that gets rows added outgrows a styled XLSX per edit. A spreadsheet
  whose users format ranges grows faster per session, because styling is
  the common edit there. In both, typing is noise.

## Observations

- **XLSX client updates carry the whole delete set.** The authority stages
  each edit on a copy hydrated from the whole state (`hydrate_local_doc` in
  `betteroffice-xlsx/src/authority.rs` ~1015). It emits
  `encode_diff_v1(&state_vector)`, and every edit also encodes the whole
  state for its size check. A typed value's update was 131–137 B in the
  first edits and 174 B by edit 380; it averaged 4.2 KB over the run.
  The updates came to 49 MB against a 9.2 MiB state. The room is not
  affected: re-applied deletes are no-ops, and its rows come from
  `delta_update`. Every peer still decodes them. Edits averaged 141 ms on
  the M1 (1,408 s for 10,000), against 4–12 ms for DOCX and 0.14 ms for PPTX.
  Staging and encodes that are O(state) fit that, but I did not profile it.
- **The XLSX stored state is unbounded.** The seed writes no cells, so the
  folded state is the edits: 9.2 MiB after 10,000 edits. With a fold
  threshold of max(256 KiB, the stored state), the log may hold as much
  again before it folds.
- **Replica timings** (in process here, not the engine child): a miss
  costs 0.95–1.26 s. A hit costs 95 ms at the seed and 376 ms after
  10,000 edits, because the replica projects the given state on every call.
- **Office rooms are never evicted by size,** so these are the figures an
  open room keeps until it unloads.
- **Refusals:** PPTX refuses a backspace at a paragraph start (the editor
  then calls `delete_paragraph_break`, which the bench does not) and a
  cross delete in a one-paragraph story. The bench retried those with a
  new pick; the tables count them.

## Follow-ups

- XLSX client updates: emit only the transaction's own update, and stop
  restaging and re-encoding the whole document per edit. This is fork work
  on `betteroffice-xlsx` `authority.rs`, with the editor's per-keystroke
  cost to measure in `pnpm bench:office`.
- Rerun on the PC or the production box for glibc numbers, if allocator
  differences matter for a budget.
