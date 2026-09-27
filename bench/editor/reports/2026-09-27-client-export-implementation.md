# Client export implementation measurements

Windows, AMD Ryzen 7 3700X, Chromium 151.0.7922.34. Production Vite bundle of the
actual client/worker export code. Other development work and the editor download
test ran on the PC during this diagnostic. Results are local measurements, not CI
budgets or mobile-device guarantees. Raw records are under ignored
`bench/editor/.results/export-2026-09-27/implemented.json`.

All cases return the final Blob to the main thread. Timing includes worker startup,
input transfer, flattening, asset handling, main-thread figure requests, serialization,
compression and result transfer. Input construction, resolving authenticated materials,
signed-URL requests and saving the downloaded file are outside these timings. A separate
real-editor Playwright test checks the toolbar, reference reads and both downloads.

Three runs per case follow a small warmup. The unique-formula case runs once per
format/throttle setting. The mixed case repeats the resolved feature matrix plus a
two-series chart 25 times: 1,300 top-level blocks, 100 questions, 50 flashcards,
formulas, diagrams, YouTube and charts. Figure caching reuses its repeated images.
The separate formula case contains 100 distinct equations and exercises uncached
DOM rendering. Both keep 5,000 ordinary paragraphs mounted beside the export.
This models a large DOM; it is not a mounted 5,000-block Plate editor benchmark.
YouTube poster requests use a valid local PNG stub to exclude network variability.

| Case | Source bytes | Markdown median | Page delay | DOCX median | Page delay |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1,000 nodes | 114,418 | 35 ms | 6 ms | 605 ms | 14 ms |
| 9,800 nodes | 832,139 | 49 ms | 7 ms | 1,061 ms | 15 ms |
| Near 2 MiB limit | 1,958,994 | 55 ms | 8 ms | 906 ms | 15 ms |
| 1,300 mixed blocks | 251,701 | 242 ms | 35 ms | 4,310 ms | 82 ms |
| 100 unique formulas | 8,293 | 22 ms | 7 ms | 9,084 ms | 44 ms |

Page delay is the median of each run's worst excess over a 16 ms timer, sampled
through 32 ms after completion. The worst normal-CPU mixed DOCX sample was 93 ms.
The returned mixed DOCX was 2.71 MB. These are responsiveness proxies, not INP or
input-to-paint measurements. The original main-thread library probe blocked the page
for roughly 1,333 ms for Markdown and 468 ms for DOCX near the node limit; its
conversion stages differ, so this is evidence of reduced blocking, not a clean speedup
comparison. See [the original diagnostic](2026-09-27-client-export.md).

| 4x page CPU throttle | Markdown median | Page delay | DOCX median | Page delay |
| --- | ---: | ---: | ---: | ---: |
| 1,000 nodes | 22 ms | 140 ms | 485 ms | 63 ms |
| 9,800 nodes | 53 ms | 22 ms | 959 ms | 95 ms |
| Near 2 MiB limit | 43 ms | 138 ms | 752 ms | 141 ms |
| 1,300 mixed blocks | 446 ms | 167 ms | 6,305 ms | 511 ms |
| 100 unique formulas | 18 ms | 323 ms | 31,155 ms | 557 ms |

CDP page throttling does not imply equal worker throttling. Delayed timer callbacks
after completion and background browser work can make sampled delay exceed export
elapsed time. The slow-page runs reveal a remaining limitation: DOM layout and
rasterization can still pause the page, with a 659 ms worst mixed-DOCX sample.
Serialization and packaging already run off the page; this does not establish a
sub-50-ms responsiveness budget on slower devices. Mathematical markup generation
runs in the worker; KaTeX layout/rasterization, Mermaid's DOM renderer and chart
rasterization require the main thread. Each unique figure yields, uses an isolated
document and is cleaned up afterward.

## Correctness and Word verification

- `pnpm test`: 83 source test files, 433 tests, plus four editor benchmark tests passed.
- `pnpm run typecheck`, `pnpm run fmt`, `pnpm run fix` passed.
- Real-editor Markdown and DOCX download test passed. It checks readable quiz/card
  contents, native video XML, bookmarks/hyperlinks, compatibility mode and colors.
- The actual feature matrix plus a chart was exported through the client worker
  with the real YouTube thumbnail and opened read-only in installed Word 16.0.
  Word reported the video as InlineShape type 16, a native web-video object.
  It rendered to seven PDF pages; callouts, quote/divider, formulas, Mermaid,
  answer key, flashcards and chart legend were visually checked. This does not
  verify playback in Word for the web or every viewer.
- Review corrections retain nested ordered/task lists and code containing pipes
  inside Markdown table cells. A parser reproduction confirms adjacent cell data
  survives. Repeated figure preparation is cached; failed content stops the export.

## Reproduce

In PowerShell, run `$env:EXPORT_CLIENT='1'; node bench/editor/scripts/export-probe-server.mjs`.
After the production build serves port 5200, run `node bench/editor/scripts/export-client.mjs`.
The server and browser are local; no backend export endpoint is used.
