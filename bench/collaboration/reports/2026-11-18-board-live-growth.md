# How a board's live Yjs state grows, 2026-11-18

Step 0 of the collaborative canvas plan. The canvas is moving into a
collaboration room, and a room keeps Yjs history that the saved copy does
not, so decision 3 (a cap on the live state's bytes, refused before relay)
needs a number. The only one so far was the comment on the board's `save()`:
"200 plane clicks were 606 KB live, 7.5 KB this way", from before a plane
kept one entry per element. This run drives the real board through each kind
of work and through a mixed hour, and measures what a tab, a room and the
save each hold. It picks no cap; three candidates are at the end. KB and
MiB are multiples of 1,024 bytes throughout.

## Short version

- **A room holds about what the save stores, not what the tab holds.** The
  606 KB was the tab's undo history: Yjs keeps deleted content only in a
  document whose undo can bring it back. A document that is sent the same
  updates and has no undo history (a room, another person's tab, this tab
  after a reload) drops it. After the mixed hour the tab holds 467 KB, a
  room 395 KB and the save 340 KB (gzipped 77, 68 and 67 KB).
- **A room is larger than the save in one place: pen strokes.** The save
  rounds a stroke's points to whole pixels; a room keeps what the pen sent.
  A 40-point stroke is 708 B in a room against 576 B saved (1.23 times), a
  120-point stroke 1,560 B against 1,188 B (1.31 times). Everything else is
  within 1% of the save, or 0 to 3 bytes an action over it.
- **Deleting shrinks a room.** A stroke or a shape that is added and then
  deleted leaves 22 B, a typed and deleted note 61 B, in a room and in the
  save alike: the save copies those leftovers too, so it is not free of
  history either. In the tab the same stroke leaves 710 B until a reload.
- **The old figure today.** One plane point written 200 times, the measure
  behind 606 KB, is now 13.3 KB in the tab (65 B a write, down from about
  3 KB), 0.6 KB in a room and 0.6 KB saved. A point moved with the mouse
  costs 107 B in the tab and 8 B in a room.
- **What fills a board is its content: pen strokes first, then typed
  notes.** At the paces assumed below, nonstop pen strokes add 20.7 KB a
  minute to a room, typing in notes 5.4 KB, labelled shapes 3.8 KB, plane
  points 1.4 KB, and dragging, resizing or moving points 0.1 KB or less.
- **A note's text costs about 28 B a character**, in the tab, a room and
  the save: 80 characters are 2.2 KB. An inline note writes its new size
  after each key, and typed with no gap between keys the same note is
  0.9 KB. This is content, not history, and no copy drops it.
- **Against 2 MiB** (today's cap, on the save): the mixed hour's room is 19%
  of it and its save 16%. A room reaches 2 MiB after 5.2 hours of the mixed
  hour, or after 99 minutes and 2,960 strokes of nonstop pen; the save
  after 6.0 hours, or 3,640 strokes.

## Setup

- **Machine:** the Mac (Apple M1, 8 GB, macOS 15.3.1), headless Chromium
  from Playwright 1.62.1, unthrottled, one worker. Other sessions were
  running: the load average was between 5 and 16 during the run.
- **Code:** `claude/canvas-collab` at d3fb322c8, Yjs 13.6.31. The worktree
  was being edited for step 1 while this ran, so the dev server served a
  copy of that commit (`GROWTH_BASE_URL`), not the worktree.
- **Harness:** `bench/collaboration/scripts/board-growth.growth.ts`
  (`pnpm bench:growth`): the Vite dev server with MSW, the Canvas page
  (`/canvas`, the workspace canvas's board) in a 1280 by 800 window at 100%.
  The board is driven with the mouse and keys through its own toolbar:
  the pen, the eraser, the shapes panel, double clicks for notes and
  labels, the Graphs slot and the plane's editor, the Delete key, ⌘Z. Two
  things are not input: the view is moved between stretches of clear canvas
  by a viewport call (the view is not in the document), and the old
  figure's row calls the plane's own write as the e2e spec that produced
  606 KB does.
- **Three sizes**, each as `Y.encodeStateAsUpdate` bytes and gzipped at the
  default level:
  - **Tab** (`live` in the record): the board's own document as it is
    (`snapshot()`), undo history included. It is also what the device's
    unsaved copy stores (`useCanvasBoard.ts`, `keep`).
  - **Room**: a second Yjs document in the runner that is sent every update
    the board emits, as it happens, and has no undo history. It stands in
    for the Rust room, which runs yrs with garbage collection on
    (`ydoc::doc_options`); the run checks at every measure that it holds
    every change the board does.
  - **Saved** (`cleaned`): what `save()` stores today, the document copied
    into a fresh one with places rounded (`roundPlaces`).
- **Acceleration:** actions run as fast as the page takes them, with no
  thinking time. A stroke is 40 pointer moves, one point each (41 points
  stored); a drag is 10 or 40 moves. Keys are 30 ms apart: what a note stores depends on the gap up to 20 ms a key and not
  beyond (80 characters: 908 B at 0 ms, 1,934 B at 10 ms, 2,236 B at 20, 40,
  80, 150 and 300 ms). A stroke stores the same within 1% at 0, 16 and 33 ms
  a move.
- **Pace:** a phase's per-minute figure is its per-action figure times an
  assumed pace for that kind of work done alone and without pause. The
  paces are assumptions; the per-action figures scale to any other.
- **Record:** every number below is from one run of 19.5 minutes, kept
  beside this report
  ([2026-11-18-mac-m1/board-growth.jsonl](2026-11-18-mac-m1/board-growth.jsonl)).
  Across four runs a 40-point stroke was 708 to 722 B and a labelled shape
  773 to 805 B; the other rows that type nothing repeated within 2 B an
  action. Three of those runs typed with no gap between keys, so their note
  rows are not comparable.

## Bytes per action

Each kind of work on a fresh board. Bytes are the growth of the whole state
per action. "Sent" is the bytes of the updates the board emitted, what a
relay would carry.

| Action | Count | Tab | Room | Saved | Tab ÷ saved | Room ÷ saved | Updates | Sent |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Pen stroke, 40 points | 100 | 708 | 708 | 576 | 1.23 | 1.23 | 5 | 1,063 |
| Pen stroke, 120 points | 20 | 1,560 | 1,560 | 1,188 | 1.31 | 1.31 | 13 | 5,081 |
| Shape dragged | 60 | 41 | 8 | 8 | 5.1 | 1.00 | 1 | 58 |
| Shape resized | 60 | 71 | 11 | 8 | 8.9 | 1.38 | 1 | 88 |
| Plane point plotted | 60 | 145 | 145 | 145 | 1.00 | 1.00 | 1 | 154 |
| Plane line through two points | 20 | 258 | 162 | 162 | 1.59 | 1.00 | 2 | 281 |
| Plane point moved | 40 | 107 | 8 | 8 | 13.4 | 1.00 | 1 | 125 |
| Plane point written, the old measure | 200 | 65 | 0.4 | 0.4 | 170 | 1.08 | 1 | 92 |
| Note typed, 80 characters | 20 | 2,229 | 2,229 | 2,213 | 1.01 | 1.01 | 155 | 7,594 |
| Note edited, 10 characters deleted and 10 typed | 20 | 64 | 54 | 54 | 1.19 | 1.00 | 27 | 812 |
| Note deleted | 20 | −213 | −2,226 | −2,210 | – | – | 1 | 222 |
| Shape placed and labelled, 12 characters | 30 | 774 | 773 | 772 | 1.00 | 1.00 | 14 | 991 |
| Stroke drawn, then erased | 30 | 710 | 22 | 22 | 32 | 1.00 | 6 | 1,097 |
| Stroke drawn, then undone | 30 | 713 | 22 | 22 | 32 | 1.00 | 6 | 1,104 |
| Shape placed, then deleted | 30 | 774 | 22 | 22 | 35 | 1.00 | 2 | 795 |
| Note typed (80 characters), then deleted | 10 | 2,025 | 61 | 61 | 33 | 1.00 | 156 | 7,798 |

- A pen point is 10.7 B in a room and 7.7 B saved, a ratio of 1.39 that a
  stroke nears as it gets longer; a stroke's fixed part is about 270 B in a
  room and 260 B saved. A long stroke is written 13 times as it is drawn
  (about every ten points), so 5.0 KB is sent for 1.5 KB of state.
- A drag, a resize and a point's move each write once, at the release. The
  first half of those phases used 10 pointer moves a drag and the second 40:
  a shape's drag cost the same in both (8 B in a room, 41 B in the tab), and
  a resize and a point's move differed by 6 B in a room, in opposite
  directions, so the count of moves is not what is written.
- Growth is even: every other phase's first and second half agree within 1%
  (the record's `perActionByHalf`).
- The old measure: after 200 writes of one point the board is 13,624 B in
  the tab, 642 B in a room and 645 B saved.
- The twenty notes typed, edited and deleted leave 1,416 B on an empty board
  that started at 289 B: 56 B a note, in a room and in the save.

## Per minute, an hour and a working day

One kind of work, nonstop, at the assumed pace. Eight hours of one thing
without a pause is a ceiling, not a day anyone works.

| Action | Assumed a minute | Tab KB/min | Room KB/min | Saved KB/min | Room after 1 h | Room after 8 h | Tab after 8 h |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Pen stroke, 40 points | 30 | 20.7 | 20.7 | 16.9 | 1.22 MiB | 9.72 MiB | 9.72 MiB |
| Pen stroke, 120 points | 30 | 45.7 | 45.7 | 34.8 | 2.68 MiB | 21.4 MiB | 21.4 MiB |
| Shape dragged | 12 | 0.5 | 0.1 | 0.1 | 0.01 MiB | 0.04 MiB | 0.23 MiB |
| Shape resized | 6 | 0.4 | 0.1 | 0.05 | 0.00 MiB | 0.03 MiB | 0.20 MiB |
| Plane point plotted | 10 | 1.4 | 1.4 | 1.4 | 0.08 MiB | 0.66 MiB | 0.66 MiB |
| Plane line through two points | 6 | 1.5 | 0.9 | 0.9 | 0.06 MiB | 0.44 MiB | 0.71 MiB |
| Plane point moved | 10 | 1.0 | 0.1 | 0.1 | 0.00 MiB | 0.04 MiB | 0.49 MiB |
| Note typed, 80 characters (200 characters a minute) | 2.5 | 5.4 | 5.4 | 5.4 | 0.32 MiB | 2.55 MiB | 2.55 MiB |
| Note edited | 6 | 0.4 | 0.3 | 0.3 | 0.02 MiB | 0.15 MiB | 0.18 MiB |
| Shape placed and labelled | 5 | 3.8 | 3.8 | 3.8 | 0.22 MiB | 1.77 MiB | 1.77 MiB |
| Stroke drawn, then erased | 15 | 10.4 | 0.3 | 0.3 | 0.02 MiB | 0.15 MiB | 4.88 MiB |
| Stroke drawn, then undone | 15 | 10.4 | 0.3 | 0.3 | 0.02 MiB | 0.15 MiB | 4.90 MiB |
| Shape placed, then deleted | 10 | 7.6 | 0.2 | 0.2 | 0.01 MiB | 0.10 MiB | 3.54 MiB |
| Note typed, then deleted | 2 | 4.0 | 0.1 | 0.1 | 0.01 MiB | 0.06 MiB | 1.85 MiB |

- One plane holds 100 marks at most, so a full plane of points is 14.2 KB;
  the plane rows past that are across planes.
- Adding and deleting, the worst case for history, grows a room by 0.3 KB a
  minute. It grows the tab by 10 KB a minute, which a reload gives back.

Each test's board at its end, in bytes:

| Board after | Tab | gzip | Room | gzip | Saved | gzip |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 100 strokes of 40 points | 71,078 | 8,881 | 71,078 | 8,881 | 57,853 | 8,415 |
| and 20 strokes of 120 points | 102,287 | 12,546 | 102,287 | 12,546 | 81,609 | 10,958 |
| 6 labelled shapes, 60 drags | 7,325 | 1,567 | 5,344 | 1,428 | 5,321 | 1,436 |
| and 60 resizes | 11,570 | 2,293 | 6,006 | 1,604 | 5,801 | 1,563 |
| A plane with 60 points | 9,260 | 2,632 | 9,260 | 2,632 | 9,269 | 2,649 |
| and 20 lines | 14,412 | 3,754 | 12,504 | 3,533 | 12,507 | 3,542 |
| and 40 points moved | 18,699 | 4,227 | 12,827 | 3,715 | 12,830 | 3,720 |
| 20 notes of 80 characters | 44,868 | 14,512 | 44,868 | 14,512 | 44,540 | 14,441 |
| each edited | 46,145 | 14,935 | 45,945 | 14,959 | 45,617 | 14,914 |
| each deleted | 41,876 | 11,342 | 1,416 | 728 | 1,416 | 728 |
| 30 labelled shapes | 23,503 | 4,416 | 23,473 | 4,419 | 23,428 | 4,507 |
| 100 things added and deleted, none left | 86,435 | 14,474 | 2,892 | 1,358 | 2,892 | 1,358 |

Strokes gzip to an eighth, shapes to a fifth and notes to a third, so the
gzipped room is close to the gzipped save even where the raw room is larger:
a stroke's unrounded digits compress.

## A mixed hour

One board, 60 simulated minutes in 9.8 real ones. Each minute: 8 pen
strokes with the last one undone, a shape dragged twice and resized once,
40 characters typed into a note, and a plane opened for a point and either a
line or a moved point. Every other minute starts a new labelled shape and a
new note, every fourth edits its note first, and every tenth deletes its
shape and its note and starts a new plane. That is about 14 gestures and 45
keys a minute: 480 strokes (60 undone), 30 shapes, 120 drags, 60 resizes, 30
notes with 2,400 characters, 60 plane points, 30 lines and 30 moved points
in the hour.

| Minute | Tab KB | Room KB | Saved KB | Tab gzip | Room gzip | Saved gzip | Updates | Sent KB | On the board |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 5 | 40.0 | 35.5 | 30.8 | 8.0 | 7.5 | 7.1 | 746 | 69 | 35 strokes, 3 shapes, 3 notes, 1 plane with 8 marks |
| 10 | 77.8 | 65.9 | 56.7 | 14.0 | 12.4 | 12.0 | 1,473 | 136 | 70 strokes, 4 shapes, 4 notes, 1 plane, 15 marks |
| 15 | 118 | 101 | 87.5 | 20.9 | 18.8 | 18.4 | 2,219 | 205 | 105 strokes, 7 shapes, 7 notes, 2 planes, 23 marks |
| 20 | 156 | 132 | 113 | 26.5 | 23.5 | 23.0 | 2,986 | 274 | 140 strokes, 8 shapes, 8 notes, 2 planes, 30 marks |
| 25 | 196 | 167 | 144 | 33.6 | 29.9 | 29.3 | 3,732 | 344 | 175 strokes, 11 shapes, 11 notes, 3 planes, 38 marks |
| 30 | 234 | 198 | 170 | 39.6 | 34.7 | 34.0 | 4,459 | 411 | 210 strokes, 12 shapes, 12 notes, 3 planes, 45 marks |
| 35 | 274 | 233 | 201 | 46.3 | 41.2 | 40.5 | 5,205 | 481 | 245 strokes, 15 shapes, 15 notes, 4 planes, 53 marks |
| 40 | 312 | 263 | 227 | 51.8 | 45.9 | 45.2 | 5,972 | 549 | 280 strokes, 16 shapes, 16 notes, 4 planes, 60 marks |
| 45 | 352 | 299 | 258 | 58.7 | 51.7 | 50.8 | 6,718 | 619 | 315 strokes, 19 shapes, 19 notes, 5 planes, 68 marks |
| 50 | 389 | 329 | 284 | 65.0 | 56.6 | 55.3 | 7,445 | 686 | 350 strokes, 20 shapes, 20 notes, 5 planes, 75 marks |
| 55 | 429 | 365 | 314 | 71.5 | 63.3 | 62.0 | 8,191 | 755 | 385 strokes, 23 shapes, 23 notes, 6 planes, 83 marks |
| 60 | 467 | 395 | 340 | 77.2 | 68.0 | 66.9 | 8,958 | 824 | 420 strokes, 24 shapes, 24 notes, 6 planes, 90 marks |

- Per minute: 7.8 KB in the tab, 6.6 KB in a room, 5.7 KB saved; 149
  updates and 13.7 KB sent. Growth is a straight line.
- After the hour the room is 1.16 times the save and the tab 1.37 times.
  The room's excess is the strokes' unrounded points (420 strokes at about
  130 B) and little else.
- A working day of it, eight hours with no pause: 3.08 MiB in a room,
  2.66 MiB saved, 3.65 MiB in a tab that is never reloaded.

## Against today's limits

- **`CANVAS_BOARD_MAX`, 2 MiB** (`fieldlimits.CanvasBoardBytes`), on the
  saved copy before gzip. The mixed hour's save is 16% of it and its room
  19%. The save passes 2 MiB after 6.0 hours of the mixed hour and a room
  after 5.2; with pen strokes alone, the save after 3,640 strokes of 40
  points (two hours at 30 a minute) and a room after 2,960 (99 minutes).
  So today's cap is a limit on content: deleted work counts 22 to 61 B a
  thing towards it, in the save as in a room.
- **A drawing answer's board, 250 KiB**, stays local (decision 7) and is
  not affected.
- **A note room has no cap on its state** (`backend-storage-quota.md`, Yjs
  storage growth): its content is bounded at 2 MiB of JSON, 10,000 nodes and
  depth 16, each update at 8 MiB (`ydoc::MAX_UPDATE_BYTES`), and its update
  log is folded at `max(256 KiB, state)` or 1,000 rows. A full state of
  256 KiB or more is answered within its user's open budget; the mixed
  hour's room passes 256 KiB at about minute 39.
- **A text file's room is capped at about 1.94 MiB of state**, history
  included (the 2 MiB text cap less admission's 64 KiB reserve).
- **The update allowance** (200 updates and 2 MiB a second per user, after
  a burst of 10,000 or 8 MiB): a note sends two updates a key, a 120-point
  stroke 13 updates and 5.0 KB, the mixed hour 149 updates and 13.7 KB a
  minute. Nothing here is near it.

## Candidate caps

Not a recommendation. Each is a cap on the room's state, in raw bytes, with
what it allows by this run's figures.

| Cap on the room's state | Pen strokes of 40 points | Typed characters in notes | Labelled shapes | Hours of the mixed hour | Gzipped, mixed |
| --- | ---: | ---: | ---: | ---: | ---: |
| 2 MiB | 2,960 | 75,000 | 2,700 | 5.2 | about 0.34 MiB |
| 3 MiB | 4,440 | 113,000 | 4,100 | 7.8 | about 0.52 MiB |
| 4 MiB | 5,920 | 150,000 | 5,400 | 10.4 | about 0.69 MiB |

- **2 MiB**: today's number, moved from the save to the room. Every kind of
  board keeps what it has today but a pen-heavy one, which gets 2,960
  strokes of 40 points where the save's 2 MiB gives 3,640 (19% fewer; 24%
  fewer when strokes are 120 points long). It is also near the text room's
  1.94 MiB.
- **3 MiB**: the first round number above what 2 MiB of saved pen strokes
  can weigh in a room (2.46 MiB at 40 points a stroke, 2.63 MiB at 120,
  2.78 MiB at the per-point ratio of 1.39). No board that fits today's cap
  would be refused.
- **4 MiB**: twice today's. It is where other apps' object limits fall in
  this board's bytes: tldraw's default of 4,000 shapes a page is 2.7 MiB of
  40-point strokes or 2.9 MiB of labelled shapes here, and the 5,000
  objects under which Miro advises keeping a board are 3.4 to 3.7 MiB.
- The ceiling on any of them is 8 MiB, the largest update the server takes.
- The other apps' limits are from section 4 of the plan page, which cites
  tldraw's `options.ts` and Miro's "Board performance and loading issues"
  help page; they were not read again for this report. The same section
  found no document size limit for AFFiNE (32 MiB an update), none
  confirmed for Excalidraw, and 2 GB of memory a file for Figma. None of
  them caps a board by Yjs bytes.
- The gap between a room and the save on pen strokes is the rounding the
  save applies afterwards. Rounding points before they are written would
  close it; that is a code change this run did not make or measure.

## Not covered

- **yrs.** The room copy is Yjs in Node, not the Rust room. Both drop
  deleted content and keep a marker for it; whether yrs keeps the same
  bytes per marker was not measured.
- **More than one person.** One client made every change. Two people
  editing in turn split the runs of markers that one client's deletions
  merge into, so leftovers per deleted thing would be somewhat larger.
- **Open time and memory at the candidate sizes.** `pnpm bench:canvas`
  opens a board of 200 strokes and 30 notes at most; a 2 to 4 MiB board was
  not opened or timed.
- **What was not driven:** images, GIFs, stickers, link and material cards
  (an image is not in the document, only its id), charts, formula cards,
  connectors, groups, mind maps, the highlighter, shape presets, plane
  labels, curves and formulas, lists and formatting in notes, card-style
  notes, paste, duplicate, Clear all and redo.
- **A stylus.** Strokes were drawn with the mouse. Whether a pen's
  pressure adds bytes per point was not measured.
- **Drags written as they move.** Today a drag writes once, at the release.
  If the room build writes a drag's position as it moves, so that others see
  it, each write leaves a marker, and dragging must be measured again.
- **The mechanism of a note's 28 B a character.** The count of updates (155
  for 80 characters) shows a size written after each key; that this is what
  keeps the characters from being stored as one run is inferred from the
  bytes, not read out of the document.
- **Human paces.** The paces are assumptions, and nobody works one kind of
  action for an hour. The mixed hour is one made-up session, not a recorded
  one.
- **The tab's own growth** has no bound but a reload. Whether a tab left
  open for days on a busy board becomes a problem was not tested.

## Run

```sh
pnpm bench:growth
```

It starts the dev server itself; `GROWTH_BASE_URL=http://127.0.0.1:<port>`
measures one already running. One run is 19.5 minutes on this machine under
load (14.5 in an earlier run with no gap between keys), of which the mixed
hour is 9.8.
