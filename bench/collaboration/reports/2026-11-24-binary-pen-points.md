# Binary pen points: a pen board's bytes and heap (2026-11-24)

A canvas stroke's points were `[[x, y, pressure?], ...]`, a Yjs value per number.
They are now one binary value: a 4-byte header, then little-endian Float32s
(`src/features/blocksuite/strokePoints.ts`, vendor/blocksuite local change 79, Epo
2026-11-24). This compares the two on the same 6,000-stroke board, twice: the
server's yrs heap on recorded strokes in the side bench, and a tab's yjs heap on
seeded strokes with a script in the repository.

## Method

- **Server (side bench, not in the repository).** The `bytes-room` bench of the
  2026-11-24 bytes-room audit (side-session notes
  `canvas-build/audits/2026-11-24-bytes-room/bench`: the fork's yrs at BetterOffice
  pin 45d220dcd, `collaboration-rs/crates/ydoc` at 0ec9f8134); its crate lands
  with the bytes-room work, so these figures can't be re-run from here yet.
  `STROKES=6000 bytes-room gen pen` and `gen pen-binary` write one of the recorded
  mixed hour's 41-point strokes as the editor writes one: the element with its
  first point, then its points and box at about half and at all 41 points (three
  point writes, five updates), a new tab every 1,000 strokes. The binary variant
  was changed to this format (the header `[2,0,0,0]`, then f32 pairs). The
  recorded points are whole or Float32-exact (halves), as pointer positions at 100%
  are; `ZOOM=1.1` divides them by 1.1, as a stroke drawn at another zoom lands.
  `bytes-room mem` applies the board's updates to a live yrs document as the room
  admits them and reads the heap held (counting allocator, usable bytes), the
  footprint, and a fresh joiner's whole encode. M1 MacBook Air, 8 GB, release
  build with debug info.
- **Tab (in the repository).**
  [`bench/collaboration/scripts/pen-points-heap.ts`](../scripts/pen-points-heap.ts)
  (`pnpm exec tsx bench/collaboration/scripts/pen-points-heap.ts [zoom]`) builds the
  board both ways in yjs 13.6.31: 6,000 seeded 41-point random walks in whole board
  units, written the same three times each into a room document that collects
  overwritten values, as the server's does. It prints the updates' bytes, the
  room's state bytes, and the memory a fresh Y.Doc holds after the state is applied
  (as a tab opens the canvas), after a forced GC: its JS heap and its ArrayBuffers,
  where binary values live (about 2 MB of points on this board), each way in a
  process of its own. Node 26, the same Mac. Two runs each, the memory below their
  mean: the memory within 1%, the bytes within 0.6% (the clients' ids differ).

## Results

6,000 strokes of 41 points, 30,001 updates.

Server, recorded strokes (side bench):

| | number arrays | binary | change |
|---|---|---|---|
| state, 100% (whole and halves) | 4,223,952 B | 3,785,832 B | −10% |
| state, 110% | 6,709,296 B | 3,869,062 B | −42% |
| updates sent, 110% | 10,324,924 B | 6,084,776 B | −41% |
| server heap (yrs), 100% | 47.0 MiB | 28.2 MiB | −40% |
| server heap (yrs), 110% | 47.0 MiB | 28.2 MiB | −40% |
| joiner's encode, peak | 8.4 ms, 9.2 MB | 3.6 ms, 5.0 MB | −57%, −46% |

Tab, seeded strokes (`pen-points-heap.ts`):

| | number arrays | binary | change |
|---|---|---|---|
| state, 100% (whole only) | 3,119,846 B | 3,582,195 B | +15% |
| state, 110% | 6,456,430 B | 3,905,253 B | −40% |
| updates sent, 100% | 4,420,170 B | 5,172,175 B | +17% |
| updates sent, 110% | 9,760,324 B | 5,977,575 B | −39% |
| Y.Doc memory (heap and ArrayBuffers), 100% | 78.7 MiB | 35.0 MiB | −56% |
| Y.Doc memory (heap and ArrayBuffers), 110% | 85.3 MiB | 35.3 MiB | −59% |

Raw `mem` records from the side bench (bytes):

```json
{"file": "pen-6000", "sent_bytes": 6438146, "doc_state_bytes": 4223952, "held_usable": 49238944, "footprint": 48988416, "join_fresh": {"ms": 8.367, "peak": 9175408}}
{"file": "pen-binary-6000", "sent_bytes": 5827376, "doc_state_bytes": 3785832, "held_usable": 29558944, "footprint": 28426496, "join_fresh": {"ms": 3.563, "peak": 4981104}}
{"file": "pen-zoom-6000", "sent_bytes": 10324924, "doc_state_bytes": 6709296, "held_usable": 49250784, "footprint": 49414272, "join_fresh": {"ms": 8.859, "peak": 9175408}}
{"file": "pen-binary-zoom-6000", "sent_bytes": 6084776, "doc_state_bytes": 3869062, "held_usable": 29570784, "footprint": 29966464, "join_fresh": {"ms": 3.35, "peak": 4981104}}
```

The script's records:

```json
{"points":"arrays","sent_bytes":4420170,"state_bytes":3119846,"tab_heap_bytes":82176232,"zoom":1}
{"points":"binary","sent_bytes":5172175,"state_bytes":3582195,"tab_heap_bytes":36668264,"zoom":1}
{"points":"arrays","sent_bytes":4402170,"state_bytes":3106844,"tab_heap_bytes":82776216,"zoom":1}
{"points":"binary","sent_bytes":5172175,"state_bytes":3582195,"tab_heap_bytes":36646312,"zoom":1}
{"points":"arrays","sent_bytes":9760324,"state_bytes":6456430,"tab_heap_bytes":89474432,"zoom":1.1}
{"points":"binary","sent_bytes":5977575,"state_bytes":3905253,"tab_heap_bytes":36962248,"zoom":1.1}
{"points":"arrays","sent_bytes":9706324,"state_bytes":6417424,"tab_heap_bytes":89487488,"zoom":1.1}
{"points":"binary","sent_bytes":5977575,"state_bytes":3905253,"tab_heap_bytes":36982456,"zoom":1.1}
```

The side bench's own tab measure of its recorded boards (the same yjs, a
collecting room's state applied to a fresh Y.Doc, its JS heap alone, so without
the binary points): 85,101,048 and 34,208,760 bytes at 100%, 88,888,168 and
34,258,824 at 110%.

## Conclusion

- **Heap.** The server's yrs document holds 40% less for a pen board and a tab's
  Y.Doc 56 to 59% less, whatever the coordinates: a number array was a yrs `Any`
  (and a JS array) per point and per number. The tab figure is the Y.Doc's memory
  alone (its heap and the points' ArrayBuffers), not the tab's: the canvas's
  models and views come on top. What a stroke
  holds now is mostly its other keys and their history (box, colour, order, the
  overwritten writes), about 4.9 KB a stroke in yrs.
- **Bytes.** Yjs writes a small whole number in 2 bytes, a Float32-exact one in 5
  and any other in 9, against 4 bytes a value as binary; pen pressure, a WebIDL
  `float`, is always Float32-exact (5 bytes against 4). So the state goes from
  +15% (whole points at exactly 100%, the seeded board) to about −40% (any zoom a
  fit or pinch gives, the 110% rows). At exactly 100%, or a power of two, Chrome's
  pointer and layout positions are Float32-exact, about 12 bytes a point as
  arrays against 8, so about −15 to −25%; the recorded hour, its points whole
  and halves, measured −10%. A board opens fitted to what it holds, capped at
  100%: a large one opens below it, at a zoom that takes the −40% case, and a
  small one at exactly 100%. At 110% the 6,000 strokes no longer fit the 4 MiB
  canvas cap as arrays; as binary they fill 92% of it.
- **Precision.** Points are relative to the stroke's box, so Float32 keeps a stroke
  10,000 units long to about a thousandth of a unit anywhere on the board.
- **Saved drawing answers.** The saved copy still rounds points to whole pixels: the
  Float32s keep their size, but 200 random 41-point strokes gzip to 23,876 bytes
  rounded against 60,056 exact (66,400 raw), and the bucket keeps them gzipped.
