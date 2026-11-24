# Typing on a busy board, 2026-11-23

Epo said yes on 2026-11-23 to three things: profile typing a label on a large
board, fix what holds it, and add more of the canvas's inputs to the gates.
The one measurement before was the PC's on 2026-11-06, in dev at 4x CPU on a
board of eight answers: a label's key blocked for 15.9 ms but its input p95
stayed near 470-500 ms, "held by other work"
([editor-perf](../../../openwiki/editor-perf.md#drawing-board-in-dev)).

## Short version

The dense board in a production build at 4x CPU on the Mac, the whole board
in view (its open's fit), 30 keys 100 ms apart per place. Each key is timed
from its keydown to the first task after its next frame, as `bench:canvas`
times inputs; p90 in milliseconds, with the Event Timing split of the
key's events (p90 of each part).

| Where the student types | Before | After | Before: input delay / processing / presentation | After |
| --- | ---: | ---: | --- | --- |
| A canvas label | 52 | 12 | 1 / 7 / 50 | 1 / 6 / 12 |
| A shape's label | 46 | 14 | 1 / 7 / 44 | 1 / 7 / 12 |
| A connector's label | 99 | 19 | 1 / 6 / 58 | 1 / 5 / 12 |
| A note card | 16 | 13 | 1 / 10 / 9 | 0 / 15 / 11 |
| A formula card | 64 | 41 | 3 / 29 / 22 | 1 / 10 / 9 |
| A plane card's label, in its editor | 16 | 6 | 2 / 16 / 22 | 0 / 3 / 13 |

- **What held a label's key** (canvas label, shape label, connector label):
  presentation delay, not the key's own handlers. Each key writes the element
  (its text and size, a connector's label box), its refresh marks its canvas
  dirty, and the next frame cleared that canvas and drew every element on it
  again: 25 plane cards' grids, axes and marks, 64 formulas' glyphs, 80
  strokes, though the label being edited is hidden while its editor is open.
  On this board every canvas element shares one canvas (its notes sit under
  them all), so that was all 200. Vendored local change 76 now draws again
  only the region the changed element covered and covers.
- **On the Canvas tab** (dev, the mock collaboration room) the same keys took
  157-196 ms, and most of it was processing: the mock room answered each
  key's save request at once, storing the whole board (an encode, base64 and
  sessionStorage) per key, and the save status went Saved → Saving → Saved
  per key, re-rendering the Canvas page each time. The service waits for its
  debounced store instead; the mock now does too.
- **A formula card's key** (about 40 ms) is MathLive's own: its input
  handler scrolls the field into view and lays out its toggles each key
  (`updateToggleLayout` forces a layout). Nothing of the board's; its 64 ms
  before came from a busier run (see After).
- **A note card and a plane card's label** were already fast.
- **No 470-500 ms.** Dev is 1.2-2x production here, with the same shape; the
  2026-11-06 figure did not come back on the Mac.
- **`bench:canvas` failed on main** (it last passed on 2026-11-07): its
  large board's notes were saved before their size was measured, and since
  local change 75 (2026-11-22) a tab
  opening the board writes the measured size only after 3 s, so the bench's
  double click on a card's last line, below the stored height, started a
  canvas text label. The bench's boards are now saved as a typed board is,
  and every tab now shows the size it measures at once, never writing it
  (proposal 1 (a), built 2026-11-24).
- **New inputs:** the dense board's cold open, typing in a canvas label, a
  note card and a formula card, and dragging a plane card's point in its
  editor, reported as `uncalibrated` until three CI runs give their medians.

## Setup

- Machine: the Mac (Apple M1, 8 GB, macOS 15.3.1), headless Chromium from
  Playwright 1.62.1, one worker, every run under the shared heavy-run lock
  (another builder shared the machine; the 1-minute load was 4 to 8).
- Code: `claude/canvas-typing` from origin/main 9c5de0266, BetterOffice at
  f18e63f35.
- Board: the dense board (`DENSE`, `makeDenseBoard` in
  `bench/editor/scripts/canvasBoards.ts`): eight answers of 1920 by 1200,
  four to a row; 25 plane cards with four named points, a segment, a curve,
  a line and two labels each; 64 formula cards; 32 note cards of two
  paragraphs; per answer 10 strokes, two labelled shapes joined by a
  connector and a canvas label. 127 KB saved, 201 canvas elements and 32
  blocks.
- Harness: `bench/editor/scripts/board-typing.canvas.ts`
  (`PERF_BOARD_TYPING=1`, report only). Each place on a fresh page: the board
  opened, its view set (the first answer at 100%, or the whole board as it
  opened), CPU at 4x, the editor opened by a double click as a student opens
  it, 30 keys. Event Timing entries are kept from 16 ms (the spec's floor), so
  a key under 16 ms has none; the split is per key, its longest event and the
  events presented in the same frame, as web-vitals attributes INP.
- Production: a `vite build` with `VITE_BENCH_ROUTES` on `/dev/drawing`, no
  MSW, as `bench:canvas`. Dev: this worktree's dev server with MSW, the same
  probe against it; the Canvas tab through the mock room with the board's
  state put where the mock reads it (`PERF_TYPING_VIA=room`).
- Profiles: V8's sampling profiler at 200 µs over the 30 keys
  (`PERF_PROFILE_DIR`), summarised per path; the raw profiles were deleted.

## Where the time went

Production, 4x, p90 ms (bench timing), before any fix:

| | First answer at 100% | Whole board |
| --- | ---: | ---: |
| Canvas label | 21 | 52 |
| Shape's label | 21 | 46 |
| Connector's label | 47 | 99 |
| Note card | 13 | 16 |
| Formula card | 41 | 64 |
| Plane card's label | 7 | 16 |

With the notes' layers interleaved (each note given its own index as the
note tool gives it, so the canvas elements split over several canvases),
every path stayed under 40 ms even with the whole board in view: the
canvas label 19, the connector's label 26, the formula 39. The cost grew with
what the label's canvas held, which is why the one-canvas board (the large
bench board's and a question's prepared cards' layering) is the one gated.

- **Labels:** the profile of 30 canvas-label keys with the whole board in
  view spent most of its busy time in `CanvasRenderer._render` →
  `_renderByBound`: the plane cards' drawing (`drawGraph`, Path2D), the
  formulas' replay (`fillText`, `strokeText`) and the strokes' paths. The
  key's own handlers (the editor's `_updateRect`, one `updateElement` for the
  size) took 7 ms of processing; presentation took 50.
- **Connector's label:** the same, twice over: the label's box is written
  each key, and the connector keeps a transparent local shape over its label
  as its hit area, which follows the box. Each moved the connector's canvas
  to a full redraw.
- **Formula card:** `onInput` → `scrollIntoView` and `updateToggleLayout`
  (MathLive) forcing a layout each key; the card writes the board only on
  Save.
- **Dev:** the same paths cost 1.2 to 2 times production (the canvas label 118
  ms whole, 24 at 100%), the same shape.
- **Canvas tab (dev, mock room), before:**

  | p90 ms | Answer at 100% | Whole board | Whole board: input delay / processing / presentation |
  | --- | ---: | ---: | --- |
  | Canvas label | 187 | 196 | 1 / 122 / 81 |
  | Shape's label | 223 | 136 | 1 / 77 / 67 |
  | Connector's label | 94 | 162 | 1 / 76 / 67 |
  | Note card | 90 | 90 | 1 / 81 / 29 |
  | Formula card | 48 | 41 | 1 / 15 / 23 |
  | Plane card's label | 19 | 21 | 1 / 3 / 29 |

  Processing was the mock room: every update a tab sent was acknowledged at
  once, the tab asked for a receipt, and the mock stored the whole board
  then and answered, so each key encoded the board twice (the store and the
  receipt's size), wrote it to sessionStorage as base64, and flipped the
  Canvas page's save status twice, each flip a React render of the page
  (`OwnCanvas`, its dialogs, `CanvasBoardStatus`, `LiveStatus`) whose layout
  the editor's next `_updateRect` and selection sync then forced. Over the
  30 canvas-label keys with the whole board in view the mock's receipts took
  1,667 ms of the profile (the store 1,202, of it base64 621), and
  `_updateRect`'s forced layouts 487 ms. The
  service's note room answers a request at once only with nothing to store
  and otherwise once its debounced store lands (`room.rs`), so a person
  typing sees Saving until a pause and no per-key store. Presentation was the
  same full redraw as on the board's own page. Provider updates, presence and
  the note size observers (local change 75) did not show in the profiles.

## Fixes

1. **Vendored local change 76** (`affine/blocks/surface`
   `renderer/canvas-renderer.ts`): a change to one element draws again only
   the part of its canvas that element covered and covers now. Each dirty
   canvas keeps a region in model units: for each changed element, where its
   drawing reached when last drawn and where it, and the groups holding it,
   reach now (its turned bound, what it draws outside it, 24 for
   antialiasing and glyphs, 8 times its stroke width, its shadow; a local
   element, such as a connector label's hit area, too). The frame clears that
   region in whole device pixels, clips to it and draws every element whose
   reach meets it, in order. A canvas that moved or changed size since its
   last frame, and any refresh of everything or of the main canvas, is drawn
   whole as before. Nothing else changes: what a canvas shows after a key is
   what a full redraw shows, to within a few pixels a few levels off on the
   GPU. On a canvas drawn without the GPU (reading the board canvas's pixels
   back moved it off here: every edge shifted a little), a stroke crossing
   the region's edge came out up to 49 of 255 levels off on 17 pixels there.
   Review fixes (2026-11-24) below.
2. **The mock room's receipts** (`src/mocks/collaboration.ts`): a board
   room answers a checkpoint request at once only when nothing waits to be
   stored, and otherwise once its debounced store lands, as the service's
   note room does: 300 ms after the last update, and at most 10 s after the
   first unstored one, the service's cap (`config.rs`). Dev only.
3. **The bench's boards** (`canvasBoards.ts`, `saveMeasured`): saved once
   every note card holds its measured height, as a board a person typed is
   saved (the editing tab stores the measured size with the save, local
   change 75).
4. **Every tab shows its measured note size at once** (proposal 1 (a),
   local change 75 amended, 2026-11-24): a note whose text measures unlike
   its stored size shows the measured size in every tab, as a local value
   it never writes, so the hit test, the selection frame and attached
   connectors match the text. Writing is as before: the editing tab once
   typing pauses, other editors after 3 s of difference, viewers never.
   Pinned by `e2e/editor/board-note-size.spec.ts` (a double click on the
   last line of a note stored shorter, right after an editor's board opens,
   enters the note; a viewer's click there selects it, its frame round the
   text, and writes nothing; an editor's drag of a note showing its text's
   size starts from that size, its frame not jumping, the size stored first
   and untracked, so its Undo moves the note back alone) and
   `noteSize.test.ts`. A writable tab stores the sizes it shows before any
   tracked step and before a gesture, so previews and tabs that have not
   drawn the note see it as shown.

### Review fixes to local change 76 (2026-11-24)

- **Which elements a region draws:** those a whole pass would draw there:
  the element's turned bound in the canvas's cull bound (as a whole pass
  culls), and its reach in the region's cleared pixels. Before, a region
  took every element whose reach met the cull bound and the cleared pixels,
  which could draw an element just outside the cull that a whole pass
  leaves out.
- **Placement:** each canvas remembers the origin, scale and size it was
  last drawn at (the main canvas also which layers fell back to it), and a
  canvas whose placement differs is drawn whole. Before, a stacking canvas
  compared its bound and size, and the main canvas only its size and CSS
  transform, so a main canvas panned under a held refresh (the mobile
  viewport's `SKIP_REFRESH_DURING_GESTURE`, which Capy leaves off) would
  have taken a region at its old origin. A stacking canvas emptied when its
  layer left the view forgets its placement.
- **Settle pass:** 1 s after the last region pass (each one restarts the
  timer; a whole pass cancels it), the board is drawn whole once, a plain
  timer and then a frame, so any region's edge ends as a whole pass draws
  it. Keys 100 ms apart never pay it.
- **Clip leak:** upstream's `_renderByBound` skipped an element with no
  renderer after `ctx.save()` without restoring; it restores now, or a
  region's clip would stay on for the rest of the pass.
- **Per-frame cost:** a reach reads the element's turned bound
  (`getBoundWithRotation`, from its parsed `xywh`) and a connector's label
  box, not `elementBound`, which parses `xywh` again each call. Every whole
  pass records each drawn element's reach, so a pan or zoom pays this per
  element per frame. The large board, production build, 4x CPU, p50 / p90 /
  max ms of 20 wheel pans and 20 Ctrl+wheel zooms, one `bench:canvas` run
  each on the Mac:

  | Large board | `elementBound` (before) | `getBoundWithRotation` (after) |
  | --- | ---: | ---: |
  | Wheel pan | 11 / 42 / 59 | 10 / 41 / 49 |
  | Ctrl+wheel zoom | 41 / 54 / 58 | 40 / 49 / 56 |

  The same runs' typical board: pan 8 / 22 / 37 and 6 / 21 / 23, zoom 23 /
  26 / 29 and 23 / 26 / 30. The differences are within one run's noise on
  the shared Mac (an earlier run with `elementBound`, 2026-11-23, measured
  the large pan at 10 / 40 / 54 and zoom at 40 / 49 / 53): a pan or zoom
  frame's time is the drawing itself, and a reach per drawn element is a
  small part of it either way. "Before" is the final code with only the
  reach taken from `elementBound`.

- **The e2e test** ("a change draws again only what it reaches, on the
  canvas under a note and the one over it, as a whole board's redraw draws
  it", `e2e/editor/drawing-board.spec.ts`) now makes visible changes on a
  board of about 70 elements with a note between a stacking canvas and the
  main one: a shape moved off the board and back, a shape a connector joins
  shrunk, keys in a text label, a shape's label typed until it wraps and
  grows the shape and then Backspace, and keys in a connector's label. Each
  draws more than 0 and fewer than 10 elements a pass (seen: 1 to 4), and
  then a whole redraw changes fewer than 20 pixels of every canvas by more
  than 96 levels (read through a copy, each step's count logged for
  software-drawn runners: a region's edge drawn without the GPU is off by up
  to about 64 levels, a stale dark stroke by 200 or more, so even a short
  stale piece of a stroke or an arrowhead counts). A pause after a key
  brings one whole pass, and a stacking canvas that grows is drawn whole.
  Checked to fail: with the drawn extents left out of a region (only where
  an element reaches now), the shape moved off the board left 584 pixels
  behind (581 more than 96 levels off) and its pass drew nothing; with no settle pass, no whole pass came
  in 3 s; with placements always taken as kept, the grown stacking canvas
  took a region over its cleared pixels and 50,683 pixels differed.

## After

Production, 4x, p90 ms (bench timing), with fixes 1 and 2:

| | Answer at 100%, before | after | Whole board, before | after |
| --- | ---: | ---: | ---: | ---: |
| Canvas label | 21 | 12 | 52 | 12 |
| Shape's label | 21 | 13 | 46 | 14 |
| Connector's label | 47 | 19 | 99 | 19 |
| Note card | 13 | 11 | 16 | 13 |
| Formula card | 41 | 40 | 64 | 41 |
| Plane card's label | 7 | 7 | 16 | 6 |

Every key's presentation delay is now about one frame (12 ms p90 where
Event Timing saw the key), whatever the view. A first build of local change
76 without local elements left the connector's label at 54 ms with the whole
board in view: the label's hit area, a local element, still asked for its
whole canvas each key. The formula card writes the board only on Save, so
the fix doesn't touch its keys: its 64 ms before came from a busier run (its
profile 739 ms busy against 294 after, no canvas drawing in either; the
interleaved board's run before the fix measured 39). About 40 ms is
MathLive's own, either way.

Dev, 4x, whole board in view, p90 ms (bench timing), before and after:

| | Board's page, before | Board's page, after | Canvas tab, before | Canvas tab, after |
| --- | ---: | ---: | ---: | ---: |
| Canvas label | 118 | 15 | 196 | 23 |
| Shape's label | 73 | 14 | 136 | 23 |
| Connector's label | 98 | 21 | 162 | 25 |
| Note card | 15 | 14 | 90 | 22 |
| Formula card | 40 | 39 | 41 | 40 |
| Plane card's label | 9 | 6 | 21 | 20 |

With the fixes dev is no slower than production on these paths, so dev's
extra time before was in the full redraws. On the Canvas tab the mock room's
part of a canvas label's 30 keys went from 1,667 ms of the profile to 13 ms
(relaying the updates).

## The bench's failure on main

`bench:canvas` failed three times out of three on main 9c5de0266 (runs
45174430580, 45174458165 and 45174485643): on the large board, the note
typing's double click never put the caret in the card. The large board's 30
note cards are added 120 high with three paragraphs that wrap to 193, and
were saved in the same task, before anything was drawn and measured. Before
local change 75 (2026-11-22) every tab wrote a note's measured size as soon
as it measured it, so the open put each card at 193 before the bench
clicked. Local change 75 (the note size saved once typing pauses) keeps a
viewer's tab from writing for 3 s; the bench clicked 2 s after the open, on
the card's last line at about 852 in the board's units, below the stored
bottom at 820, which the board's hit test reads as empty canvas: an answer
board's double click there starts a canvas text label (the symbol row the CI
snapshot shows). The canvas job last ran on 2026-11-07, so its first failing
run is not known; nothing in the failure points past local change 75.

Checked on the Mac against a production build: the same board saved after
its sizes were measured (193) took the double click into the card at 2 s;
the card set back to 120 started a text label at 2 s and entered the card at
4 s, after the tab wrote 192.8.

So it was the bench's board, not a double click that stopped entering
notes: a card a person typed is saved with its measured height. The bench's
boards are now saved that way, and `bench:canvas` passes again locally
(below). What a person can still meet is in Proposals.

## Gates

`bench:canvas` now also opens the dense board and times four of its inputs,
each on a fresh page at the open's fit (every element in view), at 4x:

- `denseOpenMs`: its cold open, the median of three.
- `denseLabelP90Ms`, `denseNoteP90Ms`, `denseFormulaP90Ms`: 30 keys in a
  canvas label, a note card and a formula card on the first answer.
- `densePlaneDragP90Ms`: 40 moves 32 ms apart dragging a plane card's first
  point in the plane's editor (Select, the editor's first tool), and the point
  must have moved.

They are in `timings` with no median in `MEDIANS`, so the report lists them
under `uncalibrated` and nothing gates them yet. To fill them in: dispatch the
Performance workflow with only `canvas` three times on one commit; take each
figure's median over the three runs' `timings` (artifact
`canvas-perf-results`); add them to `MEDIANS` with the run ids, as the
existing entries are; check the three runs against each other first, since
one runner has come out 40-60% slower on every figure (leave such a run out
and take another). `budgetOf` then gates each at 1.3 times its median,
inputs no lower than 30 ms.

Mac, one `pnpm bench:canvas` run with the fixes (the Mac is about 2-3 times
faster than the runner, so these are no budgets):

| Figure | Mac | p50 / max |
| --- | ---: | --- |
| `denseOpenMs` | 1,532 (1,532 / 1,514 / 1,538) | settled 1,901 |
| `denseLabelP90Ms` | 11 | 10 / 16 |
| `denseNoteP90Ms` | 11 | 10 / 19 |
| `denseFormulaP90Ms` | 41 | 36 / 50 |
| `densePlaneDragP90Ms` | 6 | 5 / 8 |

The gated figures passed in the same run: blank open 501 ms, typical open
1,294, pan 21, pen 9, typing 10, zoom 27, the hidden mount's longest frame
377 and Draw 24. With the review fixes (2026-11-24) the gated figures
passed again: blank open 477 ms, typical open 1,348, pan 21, pen 10, typing
11, zoom 26, the hidden mount's longest frame 387 and Draw 24; the dense
open 1,531 and its label, note, formula and plane drag p90s 13, 12, 41 and
7 ms. An earlier run with the fixture fix and the first build of
local change 76 (before its local-element part) passed too, the typical open
at 1,434 ms and the large board's note typing at a p90 of 22 ms.

## Proposals

1. **A note's hit area while its stored height is behind what it shows**
   (built as (a) on 2026-11-24, fix 4).
   For up to 3 s after a board opens, or up to about 2 s while a peer's tab
   holds the size of the note it types in, a note whose stored height is
   less than its text (fonts that wrap differently, a card added by code)
   shows its text past its stored bottom, and a double click there starts a
   canvas text label over the card instead of entering it (seen on the large
   bench board: the new label's symbol row over Card 1's last line; on the
   workspace canvas the same double click would place a new note, local
   change 59, not checked). Local
   change 75 keeps viewers from writing for 3 s on purpose. Options: (a)
   every tab shows its measured height at once as a local value, never
   written (the selection frame and the hit area follow the text; local
   change 75's "every other tab holds nothing" changes); (b) leave it: the
   window is short and boards a person typed carry their sizes.

## Not measured

- The Canvas tab against the real collaboration server: the mock now answers
  as the service, but the service's own per-key cost was not run.
- Phones and the PC; the dense gates' CI medians.
