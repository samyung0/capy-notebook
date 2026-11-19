# A full canvas's open, before and after the trace's fixes, 2026-11-18

The trace of a 4 MiB canvas's open (12.5 to 14.6 s settled at 4x CPU, see
[`2026-11-18-board-open-at-cap.md`](2026-11-18-board-open-at-cap.md)) found
work the mock alone does and work the page does. Both were fixed, and the
open-at-cap bench was run three times: at HEAD, with the mock fixes, and with
the mock and the product fixes. Times are milliseconds from the navigation's
start, medians of three opens, the range in brackets where it matters.

## Short version

At 4x CPU, the 4 MiB board through the mock room:

| | HEAD | Mock fixes | Mock and product fixes |
| --- | ---: | ---: | ---: |
| First paint | 9,961 (9,866 to 17,528) | 6,372 (6,364 to 6,397) | 5,739 (5,719 to 5,808) |
| Settled | 13,292 (13,195 to 25,044) | 9,616 (9,553 to 9,954) | 8,985 (8,944 to 9,105) |
| Longest frame | 4,994 | 3,544 | 2,950 |
| Blocking time of the long frames | 6,772 | 5,128 | 4,598 |

- The mock fixes take 3.6 s off first paint and 3.7 s off settled. That time
  was never the product's: it was MSW answering each chunk request and the mock
  room's extra copies of the state.
- The product fixes take 0.6 s more off each, and 0.6 s off the longest frame.
- A blank canvas at 4x paints at 2.8 s (4.9 s at HEAD), all of it the mock
  fixes.
- The note trickle after first paint (settled less painted, 3.2 to 3.3 s at
  4x) did not shorten. The fix aimed at it (local change 66) removed its forced
  style recalcs, and the frames' own recalcs then did the same work (below).

## Setup

- Machine: the Mac (Apple M1, 8 GB, macOS 15.3.1), headless Chromium from
  Playwright 1.62.1, one worker. A server-side builder shared the machine:
  each open began once the 1-minute load was under 5 (`PERF_CAP_MAX_LOAD=5`,
  new in this round), and each open's load before and after is in the run's
  record. The one HEAD outlier (17.5 s painted) ran while the load rose to 7.6.
- Code: `claude/canvas-collab` at 75feaf8f6.
  - HEAD: the trace's own build at 75feaf8f6 (the same production build with
    MSW and hidden source maps).
  - Mock fixes: HEAD's vendored BlockSuite, this round's `src/` changes.
  - Mock and product fixes: this round's changes as they stand, served from a
    build in which local change 69 of an earlier draft (in-view notes render
    first) is turned off in the bundle; that change was then taken out of the
    source (see Dropped).
- Harness: `bench/editor/scripts/board-open.cap.ts` with
  `PERF_CAP_REUSE=1`, on the kept states of 2,086,120 and 4,174,033 bytes (the
  same as the first report's). Each case is three cold opens through the room at
  1x, three with no room, and now three through the room at 4x (one before).
- "Painted" is the first task after the first frame holding every element;
  "settled" the end of the last long frame before 3 s with none. Both are the
  first report's.

## Through the room

| | HEAD | Mock fixes | All fixes |
| --- | ---: | ---: | ---: |
| Blank, 1x: painted / settled / longest | 2,341 / 2,341 / 173 | 1,691 / 1,691 / 167 | 1,736 / 1,736 / 179 |
| Blank, 4x | 4,908 / 5,043 / 717 | 2,725 / 3,188 / 696 | 2,831 / 3,141 / 711 |
| 2 MiB, 1x | 2,965 / 3,165 / 712 | 2,184 / 2,377 / 527 | 2,162 / 2,361 / 456 |
| 2 MiB, 4x | 7,691 / 8,869 / 2,789 | 4,905 / 6,216 / 2,092 | 4,605 / 5,952 / 1,816 |
| 4 MiB, 1x | 3,417 / 3,626 / 1,237 | 2,725 / 2,927 / 941 | 2,479 / 2,688 / 778 |
| 4 MiB, 4x | 9,961 / 13,292 / 4,994 | 6,372 / 9,616 / 3,544 | 5,739 / 8,985 / 2,950 |
| 4 MiB, room's read to painted, 4x | 5,286 | 3,801 | 3,222 |
| 4 MiB, JS heap after GC (MB) | 155.9 | 155.6 | 155.8 |

The 1-minute load across the runs' opens was 4.1 to 5.9 before and after each,
except the HEAD outlier above (whose open is the 4x range's top).

With no room (`/dev/drawing`, no MSW calls in the open but MSW still started),
the 4 MiB board at 1x painted at 2,031 (1,805 to 2,537) at HEAD, 1,627 with the
mock fixes and 1,500 (1,435 to 1,700) with all; blank at 974, 756 and 753.

On the open 4 MiB board (1x), a wheel pan's frame took 47, 44 and 47 ms
(median): unchanged. One write's garbage collection fell from 224 ms to 4 ms
(the mock room's text copy is now built in chunks).

## What each fix is

Mock only (the bench now measures the page, not the mock):

- `src/mocks/browser.ts`: a build's own chunks (`/assets/`) go past MSW's
  handlers, as the dev server's modules did. Each chunk request ran every
  handler (cookie parsing, URL matching), 2.5 s at 4x.
- `src/mocks/collaboration.ts`: a join encodes the room's state once and gives
  it to the probe and the tab; a tab whose document is empty brings nothing, so
  the probe document (an apply and an encode of the whole state) is skipped; a
  board room reads the tab's text copy only on the page's first open, the page
  holding its rooms' states as bytes. Admission at the cap, refusals and
  presence are unchanged (`src/mocks/collaboration.board.test.ts`).
- `src/lib/base64.ts`: a plain loop instead of `Uint8Array.from` with a mapper
  (0.76 s for the 4 MiB state at 4x), and the text built in chunks (the mock
  room's own `base64` is gone for it). Same output (`src/lib/base64.test.ts`).

Product (vendored BlockSuite, `vendor/blocksuite/README.md`):

- 66, `syncInlineRange`: an editor with no range, which has held none since it
  last found the selection outside it and has no focus, reads no selection after
  it renders. The open now reads `rangeCount` once instead of 42 times.
- 67, `GfxBlockElementModel.surface`: kept per store while the store holds it.
- 68, the viewport element: one grid search for the views added in one go.
- 69, the surface block: no draw in `firstUpdated`; `attach`'s refresh draws in
  the next frame, after the board's `mountLayer` fitted the view.

## Where the product fixes' time went (traced)

One traced open per build at 4x (Chrome's timeline, 4 MiB), twice each. The
trace's own overhead is in these numbers; compare them across builds only.

| | Mock fixes | All fixes | All but 66 |
| --- | ---: | ---: | ---: |
| Forced style recalcs (ms) | 1,553 / 1,517 | 140 / 102 | 1,637 / 1,614 |
| Frames' own style recalcs (ms) | 68 / 37 | 1,500 / 1,535 | 46 / 41 |
| Forced layouts (ms) | 199 / 167 | 358 / 315 | 438 / 442 |
| Layerize (ms) | 511 / 502 | 757 / 761 | 766 / 756 |
| Longest task (ms) | 3,633 / 3,487 | 3,152 / 2,216 | 2,248 / 2,204 |

- 66 moved the style work and did not remove it: 1.5 s either way. The trace
  of the first report read its 42 forced recalcs as avoidable; each frame
  recalculates as much without them. What makes a trickle frame's recalc that
  large (about 7,400 elements a frame) was not found.
- The layer sort, the grid searches and the first draw (67 to 69) are where the
  0.6 s came from: the longest task fell by about 0.5 to 1.3 s.
- Forced layouts rose by 0.15 to 0.25 s with 67 to 69 (with or without 66).
  Which change, and why, was not isolated.
- Layerize rose by 0.25 s with the dropped in-view-first change (below), and is
  in the "All fixes" column of this table, which was traced before it was
  turned off.

## Dropped, and not done

- In-view notes rendering first (`scheduleUpdateChildren`): built, traced and
  dropped. Every note still rendered, so neither painted nor settled moved, and
  each frame's Layerize grew (0.25 s more in all at 4x). Rendering off-screen
  notes only once they come into view would shorten the trickle, but an idle
  note is read at open (its height check, a peer's caret, the image export's
  `html2canvas`), so it was not tried.
- Yielding inside the mount: `mountDrawingBoard` builds the store and renders
  the board synchronously and hands its handle back at once to
  `useCanvasBoard` (another agent's file), which uses it straight away; a yield
  needs that caller to wait. Not done.
- The DPR budget path (`_syncCanvasBudgetForViewportZoom`) still draws at once
  when a fit changes the effective device scale, on screens above 1x. The bench
  runs at 1x, so it is not in these numbers.

## Limits

- Three opens a case on a shared machine; the spread at 4x is a few hundred
  ms, so differences under that are not findings.
- The trace table has two opens a build, traced.
- No real service, network or device other than the M1 (see the first report).

## Files

- `bench/editor/scripts/board-open.cap.ts` (three 4x opens, the load knob and
  record).
- The runs' records: `2026-11-18-mac-m1/board-open-fixes-base.json`,
  `-mock.json` and `-final.json`.
