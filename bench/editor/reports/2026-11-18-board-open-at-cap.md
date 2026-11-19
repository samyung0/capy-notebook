# A canvas's open at its size cap, 2026-11-18

A canvas room's state is capped at 4 MiB (`CANVAS_BOARD_MAX`, Epo 2026-11-18),
a number picked from the growth report
([`2026-11-18-board-live-growth.md`](../../collaboration/reports/2026-11-18-board-live-growth.md))
before any board that size had been opened. This run opens a blank canvas,
one of 1.99 MiB and one of 3.98 MiB on the Mac, and gives the times and the
heap. It recommends nothing. A trace of the open found work the mock alone did
and work the page did; both were fixed and the open measured again:
[`2026-11-18-board-open-fixes.md`](2026-11-18-board-open-fixes.md) (4x, 4 MiB:
first paint 10.0 s to 5.7 s, settled 13.3 s to 9.0 s). MiB and KiB are multiples of 1,024 bytes; MB of
heap is 1,000,000 bytes; times are milliseconds from the navigation's start.

## Short version

- First paint, through the mock room: 2,210 ms blank, 2,726 ms at 2 MiB,
  3,312 ms at 4 MiB. The board's size adds 0.5 s at 2 MiB and 1.1 s at 4 MiB;
  the rest is on every canvas in this harness (see Limits).
- Settled, the end of the last long frame: 2,210, 2,927 and 3,526 ms. The 4 MiB
  board adds 1.3 s to a blank canvas's open, the 2 MiB board 0.7 s.
- The open has one frame in which the page answers nothing: 1,186 ms at 4 MiB,
  678 ms at 2 MiB, 176 ms blank.
- JS heap after a forced GC: 30 MB blank, 94 MB at 2 MiB, 155 MB at 4 MiB
  through the room, where the mock room's own copy of the document is in the
  tab too. With no room: 27, 67 and 104 MB.
- At 4x CPU (one open each): first paint 4.6 s blank, 7.2 s at 2 MiB, 9.4 s at
  4 MiB; settled 4.7, 7.6 and 12.5 s; the longest frame 0.7, 2.7 and 4.8 s.
- On the open board, a wheel pan's frame takes 48 ms at 4 MiB (median), 24 ms
  at 2 MiB, 2 ms blank. A pen move takes 9, 5 and 2 ms.

## Setup

- Machine: the Mac (Apple M1, 8 GB, macOS 15.3.1), headless Chromium from
  Playwright 1.62.1, one worker. Other sessions were running: the 1-minute
  load was 7.4 as the run began and 5.4 as it ended.
- Code: `claude/canvas-collab` at 28a77f5f0, Yjs 13.6.31. A production build
  with MSW (`bench/editor/scripts/playwright.cap.config.ts`), served by
  `vite preview` on the same machine. The checkout has no built Office
  engines, so the build leaves them out (`vite.cap.config.ts`); no Office
  file is opened. The two commits after it on the branch (f928df1fc,
  7e8333eca) were not built.
- Harness: `bench/editor/scripts/board-open.cap.ts`, a 1280 by 800 window.
  Each open is a navigation in a fresh browser context, so nothing is cached.
- Through the room: the Canvas page (`/canvas`). The state is given to the
  mock collaboration room as its stored state (the bench answers the mock's
  read of `sessionStorage` from memory, since a 4 MiB state as text is over
  the storage's quota), and the board gets it by joining the room, as it
  does from the service.
- With no room: the board's own page (`/dev/drawing`), the same state as a
  saved board. This is the drawing answer's board, not the canvas's; it is
  here to show the board without the Canvas page and the room.
- Three opens each at 1x, the median given with the range; one open through
  the room at 4x CPU.

### The boards

The mix is the growth report's mixed hour without its planes: a simulated
minute is seven pen strokes of 41 points (its 40-point stroke) and an eighth
drawn and removed, 40 characters typed into a note, and a shape moved twice
and resized once; every other minute starts a new shape with a 12-character
label and a new note, every fourth retypes ten characters, every tenth
deletes its shape and note.

| | 2 MiB board | 4 MiB board |
| --- | ---: | ---: |
| Room state | 2,086,120 B (1.99 MiB) | 4,174,033 B (3.98 MiB) |
| Gzipped | 301,725 B | 600,393 B |
| Simulated minutes | 328 | 654 |
| Pen strokes | 2,296 | 4,578 |
| Notes of 80 characters | 132 | 262 |
| Labelled shapes | 132 | 262 |
| Yjs structs | 54,145 | 107,683 |

The boards were not drawn and typed. Ten minutes of the mix were written on
the Canvas page through the board's own API, one transaction per stroke, key
and move; the rest was written into a Yjs document in the runner from copies
of what the board had written, in the same order, a transaction each. A
minute came to 6,503 B both ways, against 6,583 B for the mixed hour's
minute with its planes and real input. Per action, written against real
input: a stroke 691 B against 708 B, a typed note of 80 characters 2,451 B
against 2,229 B, a labelled shape 778 B against 773 B. Every open checks
that the board shows each stroke, shape and note as its own kind (no
placeholder) and that it wrote nothing while opening.

Both boards open at 10% zoom: the page fits a board to its content and 10%
is the smallest zoom. The 2 MiB board is 15,360 by 7,280 units and the 4 MiB
board 15,360 by 14,560; the window shows about 10,400 by 7,800 at 10%, so
part of each board is in view.

## Opening through the room

Medians of three, the range in brackets.

| | Blank | 2 MiB | 4 MiB |
| --- | ---: | ---: | ---: |
| First paint (ms) | 2,210 (2,101 to 2,317) | 2,726 (2,678 to 2,789) | 3,312 (3,311 to 3,385) |
| Settled (ms) | 2,210 (2,101 to 2,317) | 2,927 (2,873 to 2,976) | 3,526 (3,514 to 3,591) |
| Room's state read to first paint (ms) | 62 (62 to 91) | 734 (728 to 734) | 1,244 (1,235 to 1,261) |
| Longest frame (ms) | 176 | 678 | 1,186 |
| Blocking time of all long frames (ms) | 131 | 750 | 1,266 |
| JS heap after GC (MB) | 30.0 | 93.8 | 154.9 |

- First paint is the first task after the first frame in which the board
  holds every stroke, shape and note of the state.
- Settled is the end of the last long frame (50 ms or more) before 3 s with
  none. It stands for "interactive": the page takes input from then on.
- "Room's state read" is the moment the mock room reads its stored state,
  which starts the join.
- In the long frames, scripts entered from the build's `collaboration` chunk
  took 55 ms blank, 616 ms at 2 MiB and 1,112 ms at 4 MiB. That chunk holds
  the mock room and the tab's room provider, so this is the mock room
  turning the stored text into bytes, applying them to its own document and
  encoding it for the tab, together with the tab applying the state. The two
  were not split. For scale, Yjs in Node applies the 4 MiB state to an empty
  document in 119 ms and encodes it in 43 ms (59 and 23 ms at 2 MiB).

At 4x CPU, one open each:

| | Blank | 2 MiB | 4 MiB |
| --- | ---: | ---: | ---: |
| First paint (ms) | 4,639 | 7,198 | 9,381 |
| Settled (ms) | 4,738 | 7,646 | 12,482 |
| Longest frame (ms) | 675 | 2,683 | 4,756 |

## Opening with no room

The same states on the board's own page. Medians of three.

| | Blank | 2 MiB | 4 MiB |
| --- | ---: | ---: | ---: |
| First paint (ms) | 901 (873 to 913) | 1,342 (1,318 to 1,352) | 1,703 (1,691 to 1,732) |
| Settled (ms) | 901 | 1,558 | 1,944 |
| The mount call (ms) | 24 | 256 | 546 |
| Mount's start to first paint (ms) | 78 | 533 | 899 |
| Longest frame (ms) | 176 | 534 | 898 |
| JS heap after GC (MB) | 26.9 | 66.7 | 104.3 |

Here the board's size adds 0.4 s at 2 MiB and 0.8 s at 4 MiB to first paint,
against 0.5 s and 1.1 s through the mock room. Both heaps include the state
as text (2.8 and 5.6 million characters), which the bench hands the page.

## On the open board

After the board settled, on the first open through the room: 20 wheel pans
at 100 ms and one pen stroke of 40 moves at 32 ms. Each figure is the delay
from the event to the first task after its next frame.

| | Blank | 2 MiB | 4 MiB |
| --- | ---: | ---: | ---: |
| Wheel pan, median (ms) | 2 | 24 | 48 |
| Wheel pan, 90th percentile (ms) | 4 | 51 | 66 |
| Wheel pan, slowest (ms) | 7 | 76 | 111 |
| Pen move, median (ms) | 2 | 5 | 9 |
| Pen move, 90th percentile (ms) | 2 | 6 | 10 |
| Pen stroke, slowest move (ms) | 10 | 201 | 395 |

The slowest pen move is the one after which the stroke is written, and in
this harness a write is not the product's cost. The mock room encodes its
whole state and stores it as text for every write, twice (300 ms after its
last update, and when the tab asks for a receipt of it), on the page's
thread. One write was profiled apart, five times: the last stroke moved by
one unit through the board's API, and the 600 ms after it.

| One write, medians of five | Blank | 2 MiB | 4 MiB |
| --- | ---: | ---: | ---: |
| The board's own call (ms) | 0.4 | 2.0 | 3.7 |
| After it: under the `collaboration` chunk (ms) | 0.3 | 108 | 195 |
| After it: garbage collection (ms) | 0 | 90 | 188 |
| After it: every other script (ms) | 1.2 | 5.1 | 9.6 |

The board's own call includes Yjs's transaction, the board's listeners and
the hand-over of the update to the mock room. What the service spends on an
update to a board near its cap, where it measures the state exactly, was not
measured.

## Seen on the way

- A note whose stored height is not the height the board measures is written
  again when the board draws it. The first fill left such heights, and the
  board then wrote 19 notes on every open: a 2 MiB board settled at about
  11 s instead of 3 s. How much of that was the mock room storing the state
  after each write was not split. The kept states now carry the height the
  board measured for a note of 80 characters (104.390625 units), and the run
  fails if a board writes while it opens. Whether another device measures a
  different height for the same note, and so writes on its open, was not
  checked.
- Written on the Canvas page through the board's API, the mix slowed as the
  board grew: 150 simulated minutes took over five minutes, each fifty
  longer than the last. The cause was not found, and it is why the states
  are written in the runner. The single write in the table above moves a
  stroke; most of the mix's writes are keys in notes, which were not
  profiled.

## Limits: what was not measured

- The service. No Rust room, no database read of the room's state, no
  admission, no socket: the state reaches the tab from the same page's
  memory. How long 4 MiB (0.57 MiB gzipped) takes to arrive over a network,
  and whether the socket compresses it, was not measured.
- The mock's latency. MSW answers every `/api` call after about 1.1 s by
  design, and the Canvas page reads before it mounts the board: a blank
  canvas paints at 2,210 ms through the room and at 901 ms on the board's
  own page. Read the differences against blank, not the totals.
- Other devices and browsers. Chromium on an M1 only; the 4x CPU throttle is
  the one stand-in for a slower device, at one open each. No phone, no
  tablet, no Safari or Firefox.
- Memory other than the JS heap: the renderer's total, the canvas's backing
  stores and the GPU process were not measured.
- Other content. No images, planes, charts, formulas, links or connectors;
  one stroke length; notes of one size. A board of 120-point strokes or of
  long notes at the same bytes holds fewer, larger things.
- Other people. One tab alone: no presence, no update arriving during the
  open, no second tab joining.
- Real input. The states are written through Yjs from copies of what the
  board wrote; the per-action differences from real input are above.
- Typing. No key was typed into a note on the open board, so a key's delay
  on a board at the cap is not known.
- A second open in the same tab, an open from the device's copy, and an open
  with a warm HTTP cache.
- Spread. Three opens a case on a shared machine. A run 5 minutes earlier on
  the same states, under a load of about 7, gave 2,924 ms and 3,419 ms to
  first paint at 2 and 4 MiB.

## Files

- `bench/editor/scripts/board-open.cap.ts`, `playwright.cap.config.ts`,
  `vite.cap.config.ts`.
- The run's record: `2026-11-18-mac-m1/board-open-at-cap.json` (what
  `calibrate`, `fill` and `open` wrote).
