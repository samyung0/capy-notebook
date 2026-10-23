# Mermaid in a Web Worker: main-thread blocking

Windows 11, AMD Ryzen 7 3700X, 32 GB, Chromium 151.0.7922.34 (Playwright, full
Chromium, headless), Vite dev server in MSW mode, mermaid 11.16.1 on linkedom
0.18.13. `node bench/editor/scripts/mermaid-probe.mjs`: two runs per case, each
in a fresh page after a small warm-up draw, Linear Light, a 760 px box. Other
development work was running on this PC.

Fixtures (`src/mocks/nearLimits.ts`), both just under `MERMAID_SOURCE_MAX`
(50,000 characters): the flowchart has 300 nodes with 120-character labels and
495 edges (mermaid's cap is 500); the mindmap has 42 branches of 20 leaves with
50-character labels.

"Page" draws as mermaid did before the worker (`drawOnPage`); "worker" is the
app's path (`renderMermaid`: the worker draws, the page sanitizes with
DOMPurify and `withSafeLinks`, then the probe inserts the SVG). The longest
task comes from the Long Tasks API, the frame gap from `requestAnimationFrame`.

| Case | Page: longest task | Page: frame gap | Worker: longest task | Worker: frame gap |
| --- | ---: | ---: | ---: | ---: |
| Flowchart, 1x | 11,528-12,118 ms | 11,516-12,111 ms | 117-137 ms | 158-208 ms |
| Mindmap, 1x | 7,737-8,041 ms | 7,733-8,041 ms | 206-218 ms | 325-342 ms |
| Flowchart, 4x page throttle | 72,280-78,344 ms | 72,280-78,338 ms | 647-667 ms | 992-1,008 ms |
| Mindmap, 4x page throttle | 42,210-43,216 ms | 42,206-43,215 ms | 1,170-1,219 ms | 1,833-1,992 ms |

What stays on the main thread is the sanitize pass over the SVG (3.3 MB for
the flowchart, 1.5 MB for the mindmap) and inserting it.

Draw time, page vs worker, at 1x: flowchart 11.7-12.3 s vs 11.4-11.7 s,
mindmap 8.7-8.9 s vs 8.2-8.4 s. Before the shim skipped stylesheet rules by
their last compound (`mayMatch`), the worker took 14-15 s and 10-13 s.

CDP throttles the page's thread only, so the 4x rows slow the sanitize and
insert but not the worker's draw. On a device 4x slower the worker would take
about 46 s for the flowchart and 33 s for the mindmap: both stop at the 30 s
limit with "too large to draw on this device", where the page path held the
tab for 72-78 s and 42-43 s.

## Bundle

`vite build` of the app pages (the Office runtime page left out: it needs
BetterOffice's built styles), main at de8c1c627 against this branch, gzip
sizes:

| | main | branch |
| --- | ---: | ---: |
| The app page's startup JS (index.html and its static imports) | 472.7 KB | 472.8 KB |
| All emitted JS | 5,225 KB | 6,039 KB |
| The worker: its entry (shim, linkedom) | - | 66 KB |
| The worker: its entry with mermaid and every diagram type | - | 1,026 KB |
| The page's mermaid with every diagram type | 1,121 KB | 1,122 KB |

The worker carries its own mermaid build, so the emitted JS grows by about
0.8 MB, all of it loaded only when a diagram draws. A diagram now loads the
worker's mermaid instead of the page's, plus DOMPurify on the page (11 KB);
the page's mermaid loads only for "Draw diagram" or an export of such a type.
No bundle budget exists in `bench/editor` or the editor perf checks.

Note (2026-10-23): the page drawing path ("Draw diagram", and exports drawing
on the page) is gone since 1ce8514ee, so the last table row no longer
applies. A build of index.html and share.html has no mermaid code in any page
chunk (review r2); only the worker carries mermaid.

## Editor perf budgets

`pnpm bench:editor` on this branch: the near-limit open cost, small-note
typing and near-limit typing and save cycle pass. The near-limit scroll
budget (average FPS over 38 at 4x) does not: 22.7-31.9 FPS over four runs,
against 42.5-44.7 for main at de8c1c627 run the same way on this PC. With
diagrams kept from drawing it scores 45.8-46.1, and with the diagram drawn
on the page instead of the worker 32.8-33.9.

The load-test note's one diagram sits more than a screen below the top, so
it now draws during the measured scroll, not while the note opens: the
worker starts and loads mermaid (about 4 s in the dev build), then the page
sanitizes and inserts the SVG. In this harness (a Vite dev build with MSW)
the worker's module requests pass through MSW's service worker, which asks
the page about each one, so the long frames during the scroll are mostly
MSW's message handlers. In a separate probe of the same scroll (its own
frame count, not the budget's), the rate went from 34 to over 100 frames a
second when the diagram had drawn before the scroll started.

With the worker started and mermaid loaded at idle once a diagram mounts
(`warmMermaid`, Epo 2026-10-23), the same budget scores 32.6-39.3 FPS over
three runs (2026-10-23): what is left in the scroll is the diagram's own draw
arriving, then its sanitize and insert. The budget is judged on the manual
Performance workflow.
