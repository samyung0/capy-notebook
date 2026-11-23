# What fills a canvas room's memory, 2026-11-22

Epo asked what uses a canvas room's memory, and why it is 9 to 10 times the
board's bytes. The capacity audit (A1) put a full board at 9 to 13 times its
encoded state, from one debug unit test, and gave a cause it did not check.
This run measures the room's yrs document in a release build on the Mac and
on Linux glibc. It covers boards of 1 MiB and 4 MiB of each kind of content,
names every allocation the document holds, and tests the cuts that could be
tried cheaply. Nothing in any repository was changed for the run; cuts 1 to 3
landed afterwards ([What landed](#what-landed)).

How to read the numbers: **measured** means run for this report, from the
records kept beside it. **est.** means reasoned from those measurements or
from code, with the reasoning given. **code** means read from origin/main,
not run. MiB and KiB are powers of 1,024. Ratios are memory divided by the
board's encoded state (`encode_state_as_update_v1` from an empty state
vector).

## Short version

- **The ratio depends on what is on the board** (measured, 4 MiB boards; ratios at 1 MiB are the same within 0.1):

  | content | Mac heap | Linux heap |
  | --- | ---: | ---: |
  | pen, 400-point strokes | 9.5× | 11.1× |
  | pen, 41-point strokes | 12.5× | 14.2× |
  | the recorded mixed hour | 13.7× | 15.3× |
  | labelled shapes | 16.2× | 17.3× |
  | typed board notes | 17.0× | 18.6× |
  | typed Plate note, for comparison | 10.4× | 11.2× |

  So a full 4 MiB board holds 45 to 84 MiB of heap on Linux (39 to 77 MiB on
  the Mac). The audit's 9 to 13 times came from 400-point strokes, the
  lightest content there is.
- **On Linux a board loaded from storage takes twice its heap in RSS**
  (measured, with glibc as shipped and with the production settings): 22 to
  38 times its state, which is 90 to 152 MiB for a lone 4 MiB board. The reason is that `room.rs`
  `load` keeps the scratch document alive while it builds the room's document
  above it. glibc cannot give back the hole the scratch leaves. When four
  rooms load one after another the cost is 1.25 times heap per room. If the
  scratch is dropped first, or the state is replayed straight into the room's
  document, the cost is 1.0 times. A board that grew in the room
  (live) costs about 1.0 times heap in RSS.
- **Where the bytes go:** most of it is yrs's per-struct overhead. Content is
  the smaller part (measured, Linux, per unit):
  - **A struct (one map value, one text run, one deleted value):**
    - a 160-byte `Item` box (176 bytes with glibc's header);
    - a 24-byte slot in its client's block list, which keeps up to 2 times
      slack;
    - for a map value, a 96-byte `Vec<Any>` that holds one 24-byte value.
      This is the fork's decode patch: the Vec is grown from empty, so its
      capacity is 4.
    - one 32 to 48-byte key string for each element and key;
    - its share of the map's hash table.

    Together that is 300 to 350 bytes, against 15 to 25 bytes encoded.
  - **A pen point:**
    - the point itself: a 64-byte `Arc<[Any]>` (80 bytes with glibc's
      header);
    - its 24-byte slot in the stroke's array.

    That is 88 bytes on the Mac and 105 on Linux, against 10.7 bytes
    encoded: 8 to 10 times.
  - **Deleted values:** every replaced map value keeps its whole `Item`
    (only the content is dropped). That is 8% of a pen board, 14% of the
    mixed hour and 37% of typed board notes. A board note writes its size
    after every key, which leaves one deleted value per key and keeps every
    typed character in a struct of its own.
- **The cuts, ranked** (savings measured where marked, est. otherwise; the
  full table is [below](#what-would-cut-it)):
  1. **Load:** drop the scratch before building the room's document, or
     replay straight into it. The RSS of a loaded room goes from 2.0 to 1.0
     times heap on Linux (measured). This is a few lines in `room.rs`.
  2. **Board notes:** write the note's size once typing settles, not after
     every key. A typed note takes 74% less memory and 68% fewer state bytes
     (measured, synthetic). This is a BlockSuite change.
  3. **The fork's yrs:** give a decoded value's `Vec` back its unused
     capacity. This saves 2 to 15% of heap on every room kind (measured).
     It is one line.
  4. **Pen points stored as one binary value:** a pen board takes 37 to 40%
     less memory (measured), and an est. 25% less on mixed boards. This is
     a BlockSuite schema change.
  5. **Hibernate idle rooms:** est. 90% of an idle room saved.
  6. **`malloc_trim` after unloads:** a dropped 4 MiB room leaves 106 to
     224 MiB resident until a trim, and about 1 MiB after one (measured).
  7. The rest (block list slack, interned keys, lazy observers, the joiner
     encode cache, the trial copy, the store's measure encode) are each worth
     1 to 8%, or are transient only.

  mimalloc does not help (measured: +8 to +23% RSS for live rooms). The
  production glibc settings do not change a single room's RSS (measured).

## Setup

- **Machine:** Apple M1, 8 GB, macOS 15.3.1, rustc 1.98.0. The load average
  was 2 to 11 from other sessions' cargo builds and tests.
- **Linux:** Docker Desktop 29.6.2, linux/arm64, `rust:1.98-slim-bookworm`.
  That image has glibc 2.36, the same as the server's `debian:bookworm-slim`
  runtime. The Docker VM had 2 GiB and 6 CPUs.
  - The runs used glibc as shipped, and the production settings from
    `deploy/docker-compose.prod.yml`: `MALLOC_ARENA_MAX=2`,
    `MALLOC_TRIM_THRESHOLD_=131072` and `MALLOC_MMAP_THRESHOLD_=131072`.
  - Production is x86_64. Rust's layouts and glibc's 16-byte chunks are the
    same there. hashbrown's control group is 16 bytes instead of 8, which
    adds 8 bytes per map table: est. under 0.5%.
- **Code:** yrs is the fork's `third_party/yrs` at the origin/main pin
  `bda081c7`. It is identical at `claude/atomic-pieces`' pin `bbbde1d4`.
  `collaboration-rs/crates/ydoc` is from origin/main `f31c386d2`.
  - Both were copied into a standalone scratch crate. The server was not
    built.
  - The yrs copy adds read-only accessors and an introspection module
    (`yrs-scratch.patch`). They change no field and no layout.
  - It also adds a `capy-shrink` feature, which is off except in the shrink
    runs.
- **Bench:** a standalone scratch crate, not in the repository ([Run](#run)).
  `gen` writes a board's updates to a file. `measure` runs in a fresh process
  and builds the room from that file. Then:
  - **Heap** is from a counting global allocator: requested bytes, usable
    bytes (`malloc_size` or `malloc_usable_size`) and live blocks, across
    threads, from the baseline to the built room. On Linux "heap" means glibc
    chunks: usable plus the 8-byte header.
  - **RSS** is macOS `phys_footprint` (resident plus compressed, so pressure
    from other sessions does not shrink it), or Linux `VmRSS`, from the
    baseline to the built room.
  - **The model** walks the store and lists every allocation by category and
    requested size, then rounds each with the platform's size classes. It
    matches the measured heap within 0.2% on every board (1.6% on a 38 KiB
    note), so the breakdowns below account for everything the document holds.
  - **Transients**, with `--transients`, are the peak of usable bytes above
    the room during each whole-board step:
    - a whole encode (a joiner's step 1, a store's measure);
    - a trial copy (encode plus apply into a scratch document, as
      `ydoc::trial`);
    - a store's `delta_update` with nothing new;
    - a load as `room.rs` does it.
- **How the room is built:**
  - **live:** every update applied as the room applies an admitted one
    (`ydoc::apply`, which also makes the broadcast update).
  - **loaded:** as `room.rs` `load` (lines 900-922): the stored state replayed
    into a scratch document, encoded, and applied into the room's document,
    with the scratch alive until the end.
  - **loaded, scratch dropped first** and **loaded directly** (replayed
    straight into the room's document): the two ways the load could be
    changed.
  - **four rooms loaded in turn.**
  - **live-threads and loaded-thread:** the build moved between four threads,
    as a room task moves between tokio workers, or the load on its own
    thread, as `spawn_blocking` does.
- **Boards** (`records/gen.jsonl`). All start from the board's first state
  (`server/fixtures/board-first-state.bin`).
  - **Recorded:** the four editor sessions in
    `crates/board/tests/fixtures/editor-sessions.json.gz`, from `4156cf7f3`
    (7,524 updates written by `pnpm bench:growth`).
    - They are replayed many times into one board, each replica in a fresh
      client-id space with its element and block ids renamed. The re-encoder
      is `bench/src/remap.rs`; with nothing renamed it gives back the same
      board.
    - *mixed*: "a mixed hour", a 10-minute run (67 KB). It took 16 replicas
      for 1 MiB and 63 for 4 MiB.
    - *shapes*: "shapes with text" (30 labelled shapes).
    - *notes*: "notes", cut where its state is largest, after the typing and
      edits and before it deletes every note (20 notes of 80 characters).
    - *all*: the four sessions as one unit, "adding then deleting" included.
  - **Synthetic pen** (`content.rs` `pen`): strokes written as the recorded
    mixed hour writes them.
    - The element comes with its first point, then the points and box are
      written twice as the stroke grows (half, then all 41). Each write is its
      own transaction.
    - The 41 points per stroke are the recorded strokes' own values: x whole,
      y fractional.
    - A new client every 1,000 strokes. 6,000 strokes make 4.03 MiB, 704 B a
      stroke, against the growth report's 708 B.
    - Variants on the same strokes:
      - `pen-once`: written once, whole;
      - `pen3`: `[x, y, pressure]`;
      - `pen-flat`: one flat number array;
      - `pen-binary`: little-endian f32 pairs in one binary value;
      - `pen-long`: 400-point strokes, as in the audit's unit test.
  - **Synthetic board notes** (`boardnote`): a note block and its paragraph,
    then 80 characters, each key followed by a new `prop:xywh`, as the
    recorded session does. It gives 2,262 B of state a note against the
    recording's 2,283 B, at 19.2 against 17.0 times its state.
    `boardnote-quiet` writes the size once, after the sentence.
  - **Plate notes:**
    - typed (`plate`): an embedded XmlText per 300 characters, one character
      per transaction, and a bold mark on every tenth word;
    - `load-note`: a 1.9 MiB note bootstrapped in one go, from the notes
      corpus `bootstrap.json.gz`.

## Results

### Ratios (measured)

Memory against encoded state, by content. Mac heap is usable bytes; Mac RSS is
`phys_footprint`. Linux runs used the production glibc settings (glibc as
shipped is within 1 to 2% in every column, `records/linux-default.jsonl`).

| board | state | Mac heap | Mac RSS, live | Linux heap | Linux RSS, live | Linux RSS, loaded as coded | Linux RSS, scratch dropped first |
|---|---:|---:|---:|---:|---:|---:|---:|
| pen, 400-point strokes | 4.07 MiB | 38.6 MiB (9.5×) | 39.6 MiB (9.7×) | 45.2 MiB (11.1×) | 45.2 MiB (11.1×) | 89.8 MiB (22.1×) | 45.3 MiB (11.2×) |
| pen, 41-point strokes | 4.03 MiB | 50.3 MiB (12.5×) | 51.5 MiB (12.8×) | 57.2 MiB (14.2×) | 56.9 MiB (14.1×) | 111.5 MiB (27.7×) | 57.2 MiB (14.2×) |
| mixed (recorded mixed hour) | 4.03 MiB | 55.1 MiB (13.7×) | 54.9 MiB (13.6×) | 61.8 MiB (15.3×) | 59.4 MiB (14.7×) | 117.6 MiB (29.2×) | 59.9 MiB (14.9×) |
| all four recorded sessions | 4.00 MiB | 61.2 MiB (15.3×) | 62.1 MiB (15.5×) | 67.3 MiB (16.8×) | 65.3 MiB (16.3×) | 126.2 MiB (31.5×) | – |
| labelled shapes (recorded) | 4.00 MiB | 64.7 MiB (16.2×) | 66.6 MiB (16.6×) | 69.4 MiB (17.3×) | 69.4 MiB (17.3×) | 139.0 MiB (34.7×) | 70.1 MiB (17.5×) |
| board notes, typed (recorded) | 4.01 MiB | 68.1 MiB (17.0×) | 70.3 MiB (17.5×) | 74.7 MiB (18.6×) | 73.7 MiB (18.4×) | 150.2 MiB (37.5×) | 77.6 MiB (19.4×) |
| board notes, typed (synthetic) | 4.01 MiB | 77.1 MiB (19.2×) | 73.0 MiB (18.2×) | 84.1 MiB (21.0×) | 78.0 MiB (19.4×) | 151.9 MiB (37.9×) | 94.2 MiB (23.5×) |
| mixed, 1 MiB | 1.02 MiB | 14.0 MiB (13.7×) | 14.1 MiB (13.8×) | 15.7 MiB (15.4×) | 15.2 MiB (14.8×) | 29.6 MiB (29.0×) | 14.9 MiB (14.6×) |
| pen, 1 MiB | 1.00 MiB | 12.6 MiB (12.5×) | 13.1 MiB (13.1×) | 14.3 MiB (14.3×) | 14.2 MiB (14.2×) | 27.9 MiB (27.8×) | – |
| shapes, 1 MiB | 1.01 MiB | 16.4 MiB (16.2×) | 16.7 MiB (16.5×) | 17.5 MiB (17.3×) | 17.6 MiB (17.4×) | 35.0 MiB (34.6×) | – |
| board notes, 1 MiB | 1.00 MiB | 17.0 MiB (17.0×) | 17.8 MiB (17.7×) | 18.7 MiB (18.6×) | 18.4 MiB (18.4×) | 37.7 MiB (37.6×) | – |
| Plate note, typed (synthetic) | 2.00 MiB | 20.7 MiB (10.4×) | 21.0 MiB (10.5×) | 22.5 MiB (11.2×) | 21.5 MiB (10.7×) | 44.0 MiB (22.0×) | – |
| Plate note, bootstrapped | 1.91 MiB | 7.1 MiB (3.7×) | n/a | 7.7 MiB (4.0×) | 7.9 MiB (4.2×) | 14.9 MiB (7.8×) | – |

- **Heap is deterministic:** reruns gave the same bytes, as in
  `records/var-*-base.jsonl` against `records/mac.jsonl`. RSS repeated within
  a few percent (117.6 against 117.7 MiB, for example).
- **The ratio does not move with size:** it is the same at 1 MiB and 4 MiB.
  It moves with content.
- **Mac against Linux:**
  - glibc's chunks add 10 to 17% over the bytes requested: an 8-byte header,
    16-byte rounding, 32 bytes at least.
  - macOS's size classes add 1 to 7% (`scripts/overhead.py`).
  - The mean request is 93 to 155 bytes, so glibc's header alone is 5 to 9%.
- **Linux RSS, live:** 0.93 to 1.0 times heap. RSS can sit below heap
  because the unused tail of a block list larger than 128 KiB is mmapped and
  never touched.
- **Mac RSS of the bootstrapped note** is a warm-up artifact: its only update
  is the whole state, which the warm-up had already built and dropped.

### Where the bytes go (measured, Linux glibc, model rounded)

Struct sizes (`records/sizes.json`, `size_of` on arm64, the same on x86_64):

| type | bytes | in the document as |
| --- | ---: | --- |
| `Item` | 160 | one `Box` per struct, live or deleted; content dropped on delete, header kept |
| `Block` (a list slot) | 24 | one per struct or collected run, in its client's `Vec`, grown by doubling |
| `Branch` | 232 | one `Box` per Y type (an element's map, a note's text) |
| `Observer`, twice per `Branch` | 56 inline | each makes an `Rc<RefCell<Vec>>` of 48 bytes at once, used or not |
| `Any` | 24 | each value, each array entry |
| `ItemContent` | 32 | inside the `Item` |

`Item`'s 160 bytes hold:

- `id` 16 and `len` 4;
- `left` 8 and `right` 8;
- `origin` 16 and `right_origin` 16;
- `content` 32;
- `parent` 24;
- `redone` 16;
- `parent_sub` 16;
- `info` 1.

**A pen stroke** (41 points; 704 B of state, 9,949 B of heap: 14.1×):

| category | blocks | requested B | glibc chunk B | share |
|---|---:|---:|---:|---:|
| point arrays `[x, y]` (an `Arc<[Any]>` of 2) | 41 | 2,624 | 3,280 | 33% |
| item boxes (11 live, 4 replaced `points`/`xywh`) | 14 | 2,240 | 2,464 | 25% |
| `Vec<Any>` of each map value (capacity 4, holding 1) | 9 | 864 | 1,008 | 10% |
| the points array itself (16 + 41 × 24) | 1 | 1,000 | 1,008 | 10% |
| the element map's hash table (10 keys, 16 buckets) | 1 | 442 | 450 | 5% |
| block list slots | – | 393 | 393 | 4% |
| `color` value (`Any::Map`: table, keys, strings) | 4 | 277 | 368 | 4% |
| map keys (one `Arc<str>` per element and key) | 10 | 215 | 352 | 4% |
| strings (`index`, `type`, `id`, `xywh`) | 6 | 178 | 256 | 3% |
| `Branch` box and its two observers | 3 | 328 | 368 | 3% |

- **Values** are about 4.9 KB of it: points, the points array, the color map
  and the strings. Encoded, they are about 590 B (est., 41 points at 10.7 B
  plus the fixed fields), so about 8 times.
- **Structure** is about 5.0 KB: items, list slots, the Vec headers, the
  table, the keys and the branch. Encoded, it is about 110 B: 15 structs at
  about 7 B each, so about 45 times.

**A labelled shape** (804 B of state, 13,902 B of heap: 17.3×):

- item boxes 39% (31 items: 27 map values, the label's text, the element);
- `Vec<Any>` 22%;
- the hash table 12% (29 keys, 64 buckets);
- keys 8%;
- list slots 6%;
- strings 4%;
- branches and observers 5%;
- `color`/`strokeColor` maps 3%.

A shape is little but map entries, about 450 B of memory each.

**A typed board note** (recorded; 2,283 B of state, 42,466 B of heap: 18.6×):

- **Item boxes are 72%,** 173 items a note:
  - 70 one-character strings. The note's `prop:xywh` written after each key
    takes the next clock, so no two characters merge into one run.
  - 79 deleted size values, one per key.
  - The block and paragraph maps.
- List slots 12%.
- Branches, tables, observers and keys 11%.

The text itself is 80 bytes.

**The mixed hour, per 10-minute replica** (67,121 B of state, 1,023,418 B of
heap: 15.2×):

| category | share |
| --- | ---: |
| item boxes | 34% |
| point arrays | 23% |
| block lists | 10% |
| `Vec<Any>` | 9% |
| points arrays | 7% |
| map tables | 4% |
| `Any` maps | 4% |
| keys | 3% |
| branches | 3% |
| strings | 2% |
| observers | 1% |

Of its 1,954 structs, 718 are deleted:

- 318 note sizes;
- 152 shape and stroke boxes;
- 140 stroke points;
- the rest plane writes and text.

**A typed Plate paragraph** (636 B of state, 7,134 B of heap: 11.2×):

- item boxes 61% (25 items: about 13 text runs split by the bold marks, and
  their format markers);
- list slots 14%;
- formats 8%;
- text 5%.

Note text arrives in long runs that merge, which a board's content never does.

**Shares across boards** (measured, `scripts/overhead.py`, Linux):

| category | pen | mixed | shapes | board notes | notes on it |
| --- | ---: | ---: | ---: | ---: | --- |
| deleted items (`Item` 176 B + slot 24 B each) | 8% | 14% | 1% | 37% | |
| `Vec<Any>` | 10% | 9% | 22% | 4.5% | |
| map keys | 3.5% | 3.5% | 8.4% | 2.4% | |
| block lists | 4% | 10% | 6% | 12% | |
| branch observers | 1.3% | 1.4% | 1.8% | 2.1% | |

- **Map keys:** one `Arc<str>` per element and key, and shared only along
  one key's chain of replaced values (`integrate_item` copies it from a
  neighbour). 60,010 key strings hold 6,016 distinct names in the pen board.
  Interned, they would be 0.2 to 0.9%.
- **Block lists:** in the mixed board they are 5.9 MiB where the slots
  themselves need 2.9 MiB.

### Why 9 to 13 times, and when it is more

The audit's cause was half right:

- **Points:** a point `[x, y]` is its own `Arc<[Any]>`. That is 88 B on the
  Mac and 105 B on Linux, against 10.7 B encoded (8 to 10 times). Points are
  a third of a pen board and a quarter of the mixed hour. On 400-point
  strokes they dominate, and the whole board comes to 9.5 to 11.1 times. That
  is the audit's test, and its 9 to 13 times.
- **Structure:** the larger part is structure. Every map value, text run and
  replaced value costs 300 to 350 B in memory against 15 to 25 B encoded:
  - the 160 B `Item` (176 B on glibc);
  - its list slot of 24 B plus slack;
  - the 96 B `Vec<Any>`;
  - its key string and table share.
  
  A deleted value encodes in about 8 B and still costs its 200 B header.
  Content made of many small map entries (shapes, typed notes) therefore sits
  at 16 to 21 times; pen strokes at 12.5 to 14; long runs of text at 4 to 11.
- **Real boards:** the mixed hour is real editor traffic at 13.7 to 15.3
  times. Its replicas repeat one 10-minute session, so a 4 MiB board drawn by
  people will vary with its mix: from about 11 times (long strokes) to 21
  (typed notes) on Linux, est.

### Beyond the document

Held while the room is open (4 MiB board, 30 connections):

| what | size | source |
| --- | --- | --- |
| the yrs document | 45 to 84 MiB heap on Linux (39 to 77 on the Mac) | measured, above |
| durable cover (`ydoc::Durable`, state vector and delete set) | 0.66 to 2.5 MiB, 1 to 4% of the document; about 18 to 33 B per deleted run, more with many clients | measured. The audit's "kilobytes" holds only for boards with few deletions |
| awareness | at most 256 client ids × 4 KiB = 1 MiB; a board pointer is 40 to 100 B, so a few KB | code (`room.rs:47, 50`) |
| members, client-id owners, markers, receipts | KBs to about 100 KiB | code |
| 30 ms broadcast window | KBs; each member gets its own copy of the window's frame (`room.rs:3001-3032`), not a shared one | code |
| per connection | about 30 KiB idle (runbook 1.1); an outbox holds up to max(4 MiB, largest frame) before the reader is dropped as too slow, so about 8 MiB for a slow reader of a full board (`app.rs:65-80`) | code, report |
| in-memory update log, cached encode | none | code |

Transients for each whole-board step (measured on 4 MiB boards; Mac times in
release under load 3 to 11; Linux times in Docker were 2 to 4 times slower and
noisy):

| step | when | peak above the room | time (Mac) | avoidable? |
| --- | --- | --- | --- | --- |
| load as coded (`room.rs:900-922`) | each room load | 106 to 149 MiB: scratch and room documents, two encodes | 197 to 291 ms (one run 523 ms) | yes: dropping the scratch first peaks at 1 document plus encode; replaying straight into the room's document peaks at 1 document and takes 82 to 130 ms (measured, `records/mac-load.jsonl`) |
| trial copy (`ydoc::trial`) | each non-small edit, and every changing edit near the cap | 49 to 71 MiB (a second document) plus a 4 MiB encode | apply 60 to 111 ms, encode 7 to 15 ms | only by changing admission (audit finding 1) |
| whole encode | each joiner's step 1 and each store's measure (`validate`, `room.rs:5536-5539`) | 8.1 to 10.5 MiB: the buffer doubles, so 2.0 to 2.5 times the state | 7.5 to 15.3 ms | the store's: yes, admission already bounds a board. The joiner's: cache it. The answer is then copied twice more per joiner (`sync::encode`, `protocol::message`; code) |
| `delta_update` with nothing new | each store, on the room task | 1.3 to 5.5 MiB | 1.5 to 5.5 ms | small |
| fold and durable projection | each fold, unload, 5-minute cadence | est. one document plus two encodes, as the load less the room's document | est. 100 to 200 ms | the unload fold could encode the live document instead of replaying from Postgres (est.) |

What a peak leaves behind on glibc (measured, production settings):

- After a room was dropped, RSS stayed at its high-water mark: 168 to 224 MiB
  for a 4 MiB board whose run had held the room, a trial copy and a load.
- A room loaded as coded and then dropped left 106 to 148 MiB.
- `malloc_trim(0)` took either to 0.2 to 1.6 MiB.
- The production thresholds do not trim this. Only the top of the heap is
  trimmed, and the freed documents sit below live chunks.
- Freed space is reused by the next load or trial in the same arena. So a
  process pays its highest concurrent peak, not one per room.
- Built across four threads, glibc as shipped kept up to 45 MiB after drop
  and trim (typically 5 to 20 MiB), the production settings at most 14 MiB
  (typically about 1 MiB). That agrees with the allocator report.

### Allocator and glibc settings (measured)

- **The production glibc settings** match glibc as shipped within 1 to 2% for
  single rooms, live or loaded. They only help what multi-threaded work
  leaves after a trim (above).
- **mimalloc 0.1.52** with default options (`records/var-linux-mimalloc.jsonl`;
  heap counted without glibc's header):
  - heap: −5 to +5%;
  - RSS, live rooms: +8 to +23%;
  - RSS, a lone room loaded as coded: −21 to −57%, because mimalloc hides the
    scratch hole;
  - RSS, four rooms loaded in turn: −4 to −24%.

  With the load fixed, glibc is at 1.0 times heap and mimalloc only adds. The
  allocator report found mimalloc worse for the whole server too.

### Note rooms for comparison

- **A typed Plate note** is 10.4 times (Mac) and 11.2 times (Linux). A board
  of the same encoded size holds 1.2 to 1.9 times as much.
- **A note bootstrapped in one go** is 3.7 to 4.0 times: one client, one
  transaction, long merged runs.
- **Note rooms load the same way,** so a loaded note room is also 2 times its
  heap on Linux: 44.0 MiB for the 2 MiB typed note.

## What would cut it

The savings are from this run's numbers. Each is marked measured, where the
change was prototyped in the bench, or est.

| # | cut | saving | cost | risk |
| --- | --- | --- | --- | --- |
| 1 | **Load without the second document.** In `room.rs` `load`, `drop(scratch)` once it is encoded. Better, replay base and rows straight into the room's document, taking the fresh client id from the clients the decoded updates name. | **Measured:** RSS of a loaded room 2.0 → 1.0 times heap on Linux: −44 to −73 MiB per 4 MiB board; four rooms in turn 1.25 → 1.0 times. The load's peak falls from 2 documents plus 2 encodes to 1 document; replaying directly is about twice as fast (82 to 130 ms against 197 to 291 ms on the Mac). Applies to note rooms too. | a few lines | low |
| 2 | **Board notes write their size once typing settles,** not after every key (vendored BlockSuite edgeless note). | **Measured, synthetic, same 1,860 notes:** 77.1 → 20.4 MiB (−74%), state 4.1 → 1.3 MiB (−68%). A typed note's characters then merge into runs. For the mixed hour, est. −10 to −13% (its 318 size values a replica and 296 one-character strings). | an editor change; peers see the size a moment later | low to moderate |
| 3 | **Shrink a decoded value's `Vec` in the fork's yrs** (`ItemContent::decode`, Any). `Vec::with_capacity(len.min(remaining bytes))` keeps the existing guard against declared lengths. | **Measured (`shrink`):** shapes −14%, mixed and pen −7%, all four sessions −8%, notes −3%, Plate −2%, in heap and in live RSS. Every room kind that decodes values gains. | one line in the vendored yrs | very low |
| 4 | **Store pen points as one binary value** (BlockSuite brush and highlighter schema, f32 pairs) or as one flat array. | **Measured, same 6,000 strokes:** binary −37% (Mac) and −40% (Linux) heap, state −11%; flat array −18% and −23%. Est. −25% on a mixed board, more with long strokes. | high: client schema, renderers, the board crate's rules, previews and exports. No legacy data to migrate | moderate |
| 5 | **Hibernate an idle room:** keep its encoded state and durable cover, and rebuild on the next edit or the next step 1 that is not empty. | Est. −90 to −94% of an idle room (a 45 to 84 MiB document becomes 4 MiB plus 1 to 2.5 MiB). The first edit after waits for a rebuild, est. 100 to 250 ms with cut 1. | moderate to high: every path that reads `doc` | moderate |
| 6 | **Give memory back after unloads** (`malloc_trim(0)` at most every few seconds, after a room unloads or a large transient). | **Measured:** a dropped 4 MiB room's 106 to 224 MiB high-water mark goes to about 1 MiB. Lowers idle RSS between peaks; not a loaded room's own memory. | an FFI call, which needs an exception to `unsafe_code = "forbid"` or a crate | low |
| 7 | **Shrink block lists after a load or fold** (`Vec<Block>` capacity). | Est. 2 to 8%: lists are 4 to 16% of heap with up to half slack (mixed 4 MiB: 5.9 MiB held, 2.9 needed). Less in RSS on Linux, since an mmapped list's tail is never touched. | a small yrs patch | low |
| 8 | **Intern map keys** per document. | Est. 2 to 8% (keys 2.4 to 8.4% of heap, interned 0.2 to 0.9%); shapes most. | moderate yrs patch, a hash lookup per new key | low to moderate |
| 9 | **Make branch observers lazy** (no two `Rc`s per Y type until something subscribes). | Est. 1.2 to 2.1%. | small yrs patch | low |
| 10 | **Cache the joiner encode and share its frame** (`Bytes`). Pre-size the encode buffer. | Transient: 7.5 to 15 ms and 8 to 10 MiB per joiner of a 4 MiB board; 30 joiners' 4 MiB frames (est. about 120 MiB in outboxes) shared as one; the encode peak halves. | low to moderate | low |
| 11 | **Skip the board store's measure encode** (`validate` for `Model::Board`; audit finding 3). | Transient: 7.5 to 15 ms and about 9 MiB per store at 4 MiB. | trivial | low |
| 12 | **Avoid the whole-board trial copy** (audit finding 1). | Transient: a second document of 49 to 71 MiB and 60 to 111 ms per non-small edit at 4 MiB. On glibc it stays as the process high-water mark until reused. | high | moderate to high |
| 13 | **Write strokes once instead of growing them** (`pen-once`). | **Measured:** −7% per stroke (8,783 → 8,137 B on the Mac). Peers would no longer see a stroke while it is drawn. | client | not worth it |
| 14 | A slimmer yrs `Item` (`redone` and the origin fields kept elsewhere). | Est. −8 to −22% if `Item` lost 30% (item boxes are 25 to 72% of heap). | very high: deep divergence from upstream yrs | high |
| – | mimalloc. | **Measured:** worse for live rooms (+8 to +23% RSS); its gain on loaded rooms (−21 to −57%) is the hole cut 1 removes. | | not recommended |

Cuts 1, 3 and 6 apply to every room kind and are each small changes. Cuts 2
and 4 are where most of a board's memory goes, and both are editor changes.

## Not measured

- **The real server process:** not built or run. Sockets, tokio, awareness
  and outbox buffers are taken from code and earlier reports, not measured
  with full boards.
- **x86_64:** the runs were linux/arm64. The same glibc and layouts carry
  over (est. under 0.5% difference). CPU times are from the M1 under load 3
  to 11, and from Docker on it; none are from production's EPYC.
- **Boards drawn by people:** no recorded board reaches 4 MiB. These are
  replicas of 10-minute sessions, or synthetic strokes from mouse-drawn
  templates. A stylus (pressure) was not recorded; `pen3` estimates it at
  11.1 to 11.7 times, since the third number per point adds more state than
  memory.
- **Many rooms at once under traffic:** only four rooms loaded in turn, and
  one board built across four threads, were measured. A process's
  high-water mark with concurrent loads, trials and folds is est. from those.
- **Fold and durable projection transients:** est. from the load's
  measurement; not run.
- **Prototypes:** cuts 5 and 7 to 12 and 14 were not prototyped. Cuts 1
  (both forms), 3, 4 (on synthetic strokes), 2 (on synthetic notes), 13 and
  mimalloc were.

## Run

The bench crate and the raw records are not in the repository. The bench
builds against a copy of the fork's yrs with a scratch introspection module
(`capy_introspect`, which reads crate-private store fields to list every
allocation) and a `capy-shrink` feature, so it cannot point at
`vendor/betteroffice/third_party/yrs` as it is. The `records/` named above (one
JSON object per measure: heap, RSS, the model by category, counts, the durable
cover, transients, after-drop and after-trim RSS) and the crate stay with the
study's notes.

What the crate did, for a rerun built the same way:

- `gen <kind> <bytes> <file>` writes a board's updates (`mixed`, `notes`,
  `shapes`, `all`, `pen`, `pen-once`, `pen-long`, `boardnote`; `STROKES=6000 gen
  pen-binary 0` for the variants), and `note <bytes> <file>` a typed Plate note.
- `measure <file> live|loaded|loaded-drop-first|loaded-direct|loaded-many|live-threads|loaded-thread [--transients]`
  builds the room in a fresh process and prints one record.
- Linux runs used `rust:1.98-slim-bookworm` in Docker, with and without
  `MALLOC_ARENA_MAX=2 MALLOC_TRIM_THRESHOLD_=131072 MALLOC_MMAP_THRESHOLD_=131072`.

Generating every board takes under a minute; a measure takes under a second
(4 MiB boards with `--transients`: about 2 s).

## What landed

On `claude/room-memory-cuts` (2026-11-23):

1. **Load:** `room.rs` `loaded_doc` decodes the stored base and rows, picks
   the room's client id outside every client they name and every assigned id,
   and replays them straight into the room's document. No scratch copy, no
   whole encode. Tested by `room::tests` (each material room kind holds the
   state the scratch copy gave and writes on alike).
2. **Board notes:** the tab editing a note, or whose person just changed it,
   saves its size once that pauses (local change 75): 500 ms with no new
   measure, at most 2 s apart, and at once, untracked, when editing ends, the
   block disconnects, the page is hidden, the board is saved, a gesture starts
   or a tracked step of the store starts. Other tabs write a size only after
   3 s of differing with no new size arriving. Unlocking measures the notes
   again; before the board's document goes (the canvas room's `onLeave`, the
   drawing answer's last draft write, unmount) its sizes are saved or (room
   lost, refused, replaced) dropped, and every wait stops.
   Tested by `src/features/blocksuite/noteSize.test.ts` and
   `e2e/editor/canvas-presence.spec.ts`.
3. **The fork's yrs:** `ItemContent::decode` reserves a value list's declared
   length up to the bytes left (`Decoder::remaining`), so its `Vec` keeps no
   spare capacity. Tested in the fork's `src/block.rs` and
   `tests/decode_memory.rs`.
