---
type: Guide
title: 'Editor performance checkpoints'
description: 'Playwright editor budgets, the GitHub Actions snapshot compare against median-of-5 and best green, and why relative deltas stay warn-only.'
tags: [frontend, testing, playwright, performance, github-actions]
---

# Editor performance checkpoints

`pnpm bench:editor` measures the Plate editor on a **production** build (Vite's
production mode, production React, minified) with MSW in the page for the backend.
It is a regression tripwire, not a production SLO. Absolute `BUDGET` ceilings in
[`bench/editor/scripts/editor.perf.ts`](../bench/editor/scripts/editor.perf.ts) are the only hard fail
and they gate production promotion. GitHub Actions adds a delta table on top
so a human can see drift against recent and best green runs.

File inventory lives in [test-catalog.md](test-catalog.md). Editor architecture
and why a save cycle must not re-render the tree live in
[frontend/plate-editor.md](frontend/plate-editor.md).

## Local run

```bash
pnpm bench:editor
```

The harness ([`playwright.perf.config.ts`](../bench/editor/scripts/playwright.perf.config.ts))
runs `vite build` in production mode, as UAT's `pnpm build` does, with
`NODE_ENV=production` and the benches' switch `VITE_BENCH_MSW=true`, which turns on
MSW, the mock collaboration provider, mock auth and the mock scenario panel in a
production build (Epo 2026-11-24, "Yes, production mode"). Every deploy pins the
switch off (`scripts/env/config.py`, checked in `scripts/env/test_config.py`), and
`vite.config.ts` refuses to build with it when `VITE_APP_ENV` names a deploy (`uat`
or `production`, which `config.py` sets on every deploy build). It also refuses it
outside production mode or beside `VITE_USE_MSW=false`, so the switch never silently
overrides another choice, and beside `SENTRY_AUTH_TOKEN`, `VITE_SENTRY_DSN` or
`VITE_POSTHOG_KEY` (from a developer's shell, say): a bench build uploads no source
maps and reports to no one. The build reads an empty env directory (`CAPY_ENV_DIR`),
so a developer's `deploy/.env` stays out. It builds through
[`vite.cap.config.ts`](../bench/editor/scripts/vite.cap.config.ts), shared with the
canvas-at-cap harness, which adds two things to the app's config:

- a service worker of its own, `bench-msw.js`, generated into the build's output (never
  in `public/`, so no deploy ships it), which loads MSW's worker for everything but the
  build's chunks. MSW's worker answers each request it handles by asking the page's
  main thread, so chunk loads through it waited on a busy page (the dev bench paid the
  same). Its install step adds a static route (`addRoutes`, the service worker static
  routing API) sending `/assets/*` on its own origin to the network, so those requests
  never reach a worker, as on UAT; where that API is missing, its fetch listener stops
  them, same origin only, before MSW's listener runs, and the browser fetches them
  itself. `startMockServer` registers it only when the build defines
  `__CAPY_BENCH_MSW_WORKER__`;
- in a checkout whose BetterOffice engines are not built (`pnpm office:prepare`), each
  missing engine file becomes an empty module, with a warning naming it. In CI
  (`CI` set) a missing one fails the build and no export is shimmed: with the engines
  built nothing is missing, and a gap would mean measuring a build UAT's would fail
  on.

The build goes to `bench/editor/.results/editor-dist` and `vite preview` serves it on
port 4517 (`PERF_PORT`); the build takes about two minutes in CI. `PERF_BASE_URL`
points the specs at such a preview that is already running and builds nothing.
`/api` keeps the dev server's mock latency (1.0 to 1.22 s a call,
`src/mocks/handlers.ts`).

What still differs from UAT's build (`deploy-environment.yml` runs `config.py build`,
which runs `pnpm build` in production mode with `VITE_USE_MSW=false`):

- the mocks run in the page: MSW, the mock collaboration room (it pulls yjs and
  slate-yjs into boot) and the mock scenario panel start before the first render
  (`src/main.tsx`), and the mock modules are in the build;
- mock auth stands in for Clerk, and there is no Sentry or PostHog;
- a service worker handles the API calls (MSW's), not the chunks.

Four budget specs always run. Two V8 profile specs run only with
`PERF_PROFILE=1`, which also leaves the build unminified so the profiles name
functions (React stays in production mode); the budget numbers of such a run are
not comparable. Default CPU throttle is `PERF_CPU=4` via CDP after load. Open
cost is measured unthrottled because that path is already tens of seconds.

### What the near-limit opens measure

`open-large-document` opens the near-limit note twice, each in a fresh context
after the small note: once answering the heavy-document gate with Read only
(`readOnly.openMs`), once with Open anyway (`interactive.openMs`). Both run from
navigation until the frame that first shows the note's first block has been
rendered (`waitForNote` in [`editor.perf.ts`](../bench/editor/scripts/editor.perf.ts)).
The page checks every animation frame (`waitForFunction`, `polling: 'raf'`) and,
once it holds, resolves from a task posted in that frame, which runs after its
style, layout and paint:

- **Read-only:** the first block (`[data-slate-node="element"]`) of the static
  document (`material-preview`) holds the note's first text and is visible.
- **Interactive:** the room is live (save state Synced, Syncing or Saved), and
  the first block of Plate's editable (`[data-slate-editor="true"][contenteditable="true"]`)
  holds that text and is visible. Plate's editable by name: MathLive's fields are
  contenteditable too, in the read-only document and in the paint the editor
  takes over from, which stays in the DOM, hidden, until the page is idle. The
  read-only case's "never mounts an editable surface" check uses the same
  selector.

Until 2026-11-24 ([breakdown](../bench/editor/reports/2026-11-24-editable-open-breakdown.md))
the opens measured something else. Read-only waited for the note's text anywhere
in `main`, which matched the note's title in the left panel, on screen behind the
gate, so it stopped about 0.1 s after its click and never waited for the
document. Interactive waited for the page's first contenteditable (a MathLive
field in the hidden paint until its DOM left), then ran `getByText` over the
26,470-element editable (about 0.33 s a poll, with `expect`'s backoff between
polls), then checked live. On the Mac at CI speed (2.2x CDP throttle, medians
of interleaved runs on one build) the fix moved read-only from 2,450 to
4,599 ms and interactive from 8,867 to 6,587 ms. Read-only stays the cheaper
way in, so its assertion stays. The budgets (`large.interactiveOpenMs`,
`large.readOnlyOpenMs`) were set again on the fixed measure from CI the same
day ([Recalibrating on the production
build](#recalibrating-on-the-production-build)).

Until 2026-11-24 the harness measured the Vite dev server (Epo, "Yes, move it",
in place of Q560's "budgets unchanged", then "Yes, production mode" for the
build's Vite mode): unminified modules, React's development mode and
StrictMode's double render inflated every figure, and a production promotion
was gated on numbers no user sees. The budgets were recalibrated on this build
from CI on 2026-11-24 ([Recalibrating on the production
build](#recalibrating-on-the-production-build)); earlier numbers are not
comparable. One run of each on the Mac on 0ec9f8134
(2026-11-24): the dev server, a production build in Vite's development mode, and
this build (production mode, the benches' worker):

| Case | Dev | Development mode | Production mode |
| --- | ---: | ---: | ---: |
| Interactive open (ms) | 8,624 | 5,375 | 5,212 |
| Read-only open (ms) | 2,834 | 2,642 | 1,721 |
| Near-limit typing p95 (ms) | 80 | 40 | 72 |
| Near-limit blocking per keystroke (ms) | 16.3 | 0 | 1.4 |
| Save cycle blocking (ms) | 186 | 22 | 63 |
| Small-document typing p95 (ms) | 32 | 24 | 16 |
| Scroll (FPS) | 42.6 | 50.6 | 53.1 |
| Scroll longest frame (ms) | 134 | 83 | 83 |

Three more near-limit typing runs on the last build, at a load of 5 to 10 from
other sessions, spread 48 to 104 ms (p95) and 42 to 126 ms (save cycle), so
single Mac runs don't tell those builds apart. On that build, chunks past MSW
(the benches' worker) against through MSW's worker, alternating, three each:
interactive open 4,917 to 6,113 ms (median 5,472) against 5,505 to 7,241
(6,002), read-only 2,197 to 2,583 (2,363) against 1,753 to 2,739 (2,197).

Numbers from a Windows laptop are not comparable to Linux CI. Different OS,
different Chromium raster path, different CPU. Keep local runs for debugging
(`typingProfile.perf.ts` / `saveCycleProfile.perf.ts`). Use Actions for
deltas.

`.github/workflows/ci.yml` does not run `pnpm bench:editor`.

## Drawing board in dev

The dev server pre-bundles the board's BlockSuite and runs no vanilla-extract plugin
(Q683; how, and why a vendored edit then needs `vite --force`:
[frontend/plate-editor.md](frontend/plate-editor.md#blocksuite-on-main)). Measured on the
PC on 2026-11-06 against the config before it, MSW's module pass-through in both,
alternating, medians of 3, at 3-25% CPU load from other sessions. Usable means the plane
is painted and the pen button is there.

| Workspace Canvas tab, blank board | Before | After |
| --- | --- | --- |
| Cold start (empty cache): click to usable | 10.5 s | 1.4 s |
| Restart (cache kept): click to usable | 11.2 s | 1.3 s |
| Warm (same server, new tab): click to usable | 3.4 s | 0.85 s |
| Reload with the canvas in the URL: reload to usable | 5.7 s | 2.9 s |
| Requests after the click, warm | 2,212 (27.9 MB) | 192 (12.9 MB) |

Nothing else got slower. A plain workspace load after a cold start took 17.5 s against
18.3 s (the dep scan 4.8 s against 7.2 s, the bundling 8.9 s against 7.2 s, esbuild's
memory 2.6 GB against 2.3 GB while it runs), after a restart 9.1 s against 9.2 s. A DOCX
opened in 6.2 s after a restart and 4.1 s warm, both ways. `drawing-board.spec.ts` at
one worker takes 2.0 min from an empty cache and 1.8 min warm, against 8.6 min on the
dev setup before both MSW's pass-through and this.

`axisNumber` (`src/features/graph/view.ts`) keeps one `Intl.NumberFormat` per
decimals and notation. On a large board (8 answers: 25 plane cards, 64 formulas, 32 note
cards) at 4x CPU in dev, zooming went from 23.5 to 28.5 FPS and from 1.66 s to 0.81 s of
blocking, and typing a label from 28.7 to 15.9 ms of blocking per key; the label's input
p95 stays near 470-500 ms, held by other work. On the Mac on 2026-11-23 that board's
label keys took a p90 of 118 ms in dev and 52 ms in a production build at 4x with the
whole board in view (no 470-500 ms): presentation delay, the canvas drawing every
element on it again per key, until vendored local change 76 drew only the label's part
(12 ms in production, 15 in dev); on the Canvas tab the mock room's per-key store held
them too, 196 ms in dev, 23 once it answered as the service does
(`bench/editor/reports/2026-11-23-board-typing.md`).

## Office runtime (`pnpm bench:office`)

[`bench/editor/scripts/runtime.office.ts`](../bench/editor/scripts/runtime.office.ts)
runs against a production build ([`playwright.office.config.ts`](../bench/editor/scripts/playwright.office.config.ts)
builds in Vite's production mode with `NODE_ENV=production`, the benches' switch
`VITE_BENCH_MSW` (Vite's development mode before 2026-11-24), an empty env directory
and `VITE_LOAD_TEST_SEED`, then serves it
with the runtime on the next port of `localhost`: another origin on the same
site, as `office.capynotebook.com` is to the app, so the iframe is cross-origin
and shares the app's renderer process as in production). The build takes a few
minutes. Its web server, [`office-server.mjs`](../bench/editor/scripts/office-server.mjs),
is a Node script so the bench starts on Windows as on Linux. With
`PERF_OFFICE_TLS_KEY` and `PERF_OFFICE_TLS_CERT` (a self-signed localhost pair,
the openssl line in the config) both origins answer over HTTPS and Chromium
starts with `--ignore-certificate-errors`, which MSW's service worker needs
there. Local runs on the Windows developer PC use it (Q788 A): its antivirus
(ESET) holds the last 100 KiB of every plain-HTTP answer until the answer ends
and scans the packed `.zst` faces 0.15-0.5 s more, a different amount each run,
and leaves HTTPS alone (harness `2026-11-11-q691/ja-link/repro/results.txt`).
CI runs plain HTTP. It covers one small and one large file per format:

| Format | Small | Large |
| --- | --- | --- |
| DOCX | `exchange-plan.docx` (15 pages, 66 KB) | `long-handbook.docx` (62 pages, 41 KB, [`gen_long_docx.py`](../bench/editor/scripts/gen_long_docx.py)); `long-handbook-250.docx` (241 pages on the f18e63f35 pin, 74 KB, the same generator at 96 sections, generated per run) |
| XLSX | `course-guide.xlsx` (3 sheets, ~55k styled cells, 145 KB) | `large-gradebook.xlsx` (8 class sheets of 2,000 rows with SUM, AVERAGE and IF per row, plus a cross-sheet Summary; 224k cells, 48k formulas, 1.4 MB, [`gen_large_xlsx.py`](../bench/editor/scripts/gen_large_xlsx.py)) |
| PPTX | `lecture.pptx` (20 slides, 25 pictures, 311 KB) | `jp_llm2.pptx` (84 slides, 69 pictures, 24 MB; the committed parser fixture in `bench/parsers/fixtures/docs/`) |

The small files are the e2e rich-content fixtures. The large files are seeded
only under `VITE_LOAD_TEST_SEED`; their checkpoints come from
`scripts/dev/seed-scenario-office.ts`. The ~250-page DOCX (Q832 A: a long
handbook with headings, a table of contents, tables, pictures, a
`PAGE`/`NUMPAGES` footer and Traditional and Simplified Chinese, the Google gap
round's file: 288 headings, 48 tables, 96 bullet lists, 32 inline pictures) is
committed as its generator only: before the build the web
server runs `gen_long_docx.py exchange-plan.docx <out> 96 text` (Python 3.12
or later; `python` on Windows, `python3` elsewhere) and seeds its checkpoint
with the pinned engines' Node bundle (`office-checkpoint.mjs`, from
`pnpm office:prepare`), about 2 s in all, into the gitignored
`bench/editor/.results/office-fixtures/`, which `src/mocks/officeFixtures.ts`
picks up with `import.meta.glob` (a build without those files has no such
fixture). The generator's fixed seed and zip timestamps give the same bytes
every run on one Python; its zlib sets the compression, so the file is 74,310
bytes with zlib-ng (Python 3.14 on Windows, the gap round's twin) and 74,928
with zlib 1.3.1, the parts identical. The checkpoint is seeded each run with a
random client id, as the committed ones were.

The size ladder for the Office limits (opt-survey PLAN.md section 4) comes
from the same generators: `python3 bench/editor/scripts/gen_office_ladder.py`
writes DOCX text, table and picture-heavy files (`gen_long_docx.py`
`[sections] [text|table|picture]`, 24 to 192 text sections = 62 to 496 pages),
XLSX formula, values and style-heavy files (`gen_large_xlsx.py`
`[sheets] [rows] [formula|values|style]`, 8 sheets of 2,000 to 8,000 rows =
6 to 33 MiB unzipped) and PPTX text and picture-heavy decks
([`gen_large_pptx.py`](../bench/editor/scripts/gen_large_pptx.py)
`[slides] [text|picture]`) to the gitignored `bench/editor/.results/ladder/`,
with `sizes.json`: per file (the six bench fixtures included) the zipped
bytes and the unzipped bytes of XML parts, media and other parts
([`office_sizes.py`](../bench/editor/scripts/office_sizes.py), which also
runs on any Office file; `--only docx|xlsx|pptx` limits the ladder). Its
rule, which the size limit (XML parts only) can reuse: a picture, audio or
video extension is media (SVG too); otherwise `.xml`, `.rels` and `.vml`
parts, and parts whose `[Content_Types].xml` type ends in `+xml` or `/xml`,
are XML; the rest (embedded fonts, `.bin` parts, embedded packages) is other. Pictures are noise PNGs, which do not compress, like
photos. The generators' default output stays the committed
`long-handbook.docx` and `large-gradebook.xlsx` byte for byte, so their
checkpoints stay valid. The ladder files are not committed: they are 150 MB
together and regenerate in about 20 s.

Per file it reports:

- open to first paint: the file click, on the host's clock, to the message
  a viewer sends once its first pages, grid or slide (pictures included) are
  painted, with the runtime's own `timings` (`loadMs` frame start to `load`,
  `paintMs` `load` to that paint; `OfficeReadyTimings`): `ready` for XLSX and
  PPTX, the first `painted` for DOCX, whose View paints its first pages before
  the rest are in (and sends `painted` again as its page count grows). DOCX
  also reports the click to `ready`, every page in, as `open.allPagesMs`
  (report-only), and its page count from `ready`. Its `openFirstPaintMs` budget comes
  from medians measured to `painted` (Q804 A, Q832 A);
- View to Edit: the mode toggle click to the edit frame's `ready`, its first
  painted pages, grid or slide, with timings (`edit.firstPaintMs`). DOCX gates
  that as `editReadyMs`; XLSX and PPTX gate `editReadyMs` on
  `collaboration-ready` (the editor's replica, reported in the same React
  commit as the editor's first real paint), which their medians are measured
  to, and report their first paint only;
- keystroke to frame: 40 keys at 120 ms (p50, p90, max, unpainted keys).
  DOCX types `a` and a space into body text and waits for the next
  `docx-pages-presented` in the frame. XLSX types `7` with Enter every sixth
  key from `F5` (`E3` in the large file, which its formulas read), reached
  with the arrow keys, and PPTX double-clicks a text box on the first slide and types at the
  end of its text; both apply input on the frame's main thread, so a
  key's frame is the first task after the next animation frame following its
  last event (keydown, keypress, input);
- the same 40 keys at the end of the file (`typingEnd`, report-only, with
  `at` saying where): DOCX after Ctrl/Cmd+End (the body's end, where no later
  page is laid out again), XLSX after Enter and Ctrl/Cmd+ArrowDown (the
  column's last used row), PPTX at the end of a text box on the last slide
  with text (`end` per fixture). Unpainted keys and typing that sends no edit
  fail here too;
- heap after open, after View to Edit, after typing and after the end typing
  (`afterTypingEnd`); the workers are read only from `afterTyping` on (and in
  the report-only cases), since their forced GC and object queries before
  View to Edit or typing would change what the budgets were calibrated
  under, so `afterOpen` and `afterEdit` have `workers: null`: CDP
  `Runtime.getHeapUsage` after a forced GC (`jsMB` V8 heap, `backingMB` array
  buffers and external strings) for the page's isolate, which holds the
  runtime frame (same site, same process), plus `wasmMB`, the linear memory of
  the WASM instances still alive in any frame (an init script keeps a weak
  handle on each instance's exported memory; CDP does not count WASM memory),
  split per module in `wasmModules`. A module is named by its wasm-bindgen
  classes (`editsession` for DOCX editing, `xlsxdocument+xlsxeffectsreader`,
  `pptxdocument+pptxrenderer`, the viewers' `*viewdocument`), or by its first
  export when it has none (`rezip_docx` for OPC, `build_display_list_json`
  for layout, `decode` for parsing), since workers give no URL to name it by.
  `unattributedWasmMB` is memory no module exports (created in JS and
  imported; negative when several instances export one memory).
  `workers` lists each dedicated worker of the page (`name`, script `url`,
  `jsMB` after a GC, `wasmMB`, `wasmModules`, `unattributedMB`), with
  `workersJsMB` and `workersWasmMB` summed: the DOCX engine worker holds the
  largest single item (~0.8 GB at 62 pages in the 2026-10-06 survey).
  Playwright gives workers no CDP session, so a browser CDP session attaches
  to each one unflattened (`Target.sendMessageToTarget`), forces a GC and
  finds the live `WebAssembly.Memory` and `WebAssembly.Instance` objects with
  `Runtime.queryObjects`. Every call is bounded (5 s) and a worker's detach
  fails what is pending, so a worker that ends or stops answering is listed
  with `missing` (and counted in `workersMissing`), never waited on. Linear memory never shrinks, so `wasmMB` is also
  the high-water mark; the modules grow it in steps of up to 64 MiB
  ([frontend/office-files.md](frontend/office-files.md)), so it can run ahead
  of what an engine holds by one step. `performance.measureUserAgentSpecificMemory` would
  need cross-origin isolation, which the app does not have;
- downloads (`downloads`, report-only): what every fetch of every realm (the
  host page, the runtime frames and their workers) downloaded during the open,
  from the workspace's load to the Edit click (`open`, so the app shell is in
  it), and during View to Edit, from that click to 5 s after the edit's
  `ready` (`edit`, so fonts that load after the first paint count). Per kind
  (`appJsCss`, `officeRuntimeJs` from the runtime's origin, `engineWasm` with
  each module in `engineWasmModules`, `fonts` with the CJK slice indexes
  (`slices.json`), `fontDecoder` for `fontpack.wasm`, `sourceFile`, `other`
  with the MSW answers, and `total`; `downloads.ts`), each as the browser
  reports its fetches: `requests`, `bodiesSent` (fetches whose body crossed
  the wire), `transferredKiB` (what crossed the wire from vite preview,
  headers included: it gzips text, JavaScript, CSS and JSON responses over
  1 KB and sends WASM, fonts and other binaries as built), `encodedKiB` (the
  bodies as they arrived, also those not sent), `decodedKiB` (the same
  decoded) and `withStoredBrotliKiB` (`transferredKiB` with each WASM and TTF
  body at the brotli-11 `.br` the Office Worker stores and serves; packed
  `.zst` faces go as stored either way, and the gzipped text stays as vite
  preview sent it, where production's edge compresses with brotli). A filter
  that decodes plain-HTTP answers before the browser sees them (the Windows
  developer PC's antivirus, 2026-11-20) makes `encodedKiB` equal `decodedKiB`
  for text there over plain HTTP. A fetch the HTTP cache or MSW's service worker answered (the app's origin only: its API, the source
  file and most app chunks, bench only) transfers nothing in its realm's
  timing, and a revalidation (vite preview sends ETags) only its headers. The
  test's context starts cold and keeps no disk cache, so `docx_edit` downloads
  twice per DOCX View to Edit here (harness `2026-11-11-q691/REPORT.md`,
  section 7), and Edit, a frame of its own, asks again for the CJK slices
  the View loaded, which the cache answers with headers only. The web server stages the build with
  `workers/office/stage.mjs` into `.results/office-stage` for those sizes,
  which adds about a minute before the tests. Each realm raises its
  resource-timing buffer and sends its resource and navigation entries to
  the test as console messages as fetches end: the DOCX viewer worker ends as
  soon as it answers and the View's frame goes at View to Edit, so a read at
  the end would miss them. Workers get the probe once Playwright reports
  them; one that ends first counts in `unprobedWorkers`;
- `runner`: the CPU model and core count of the machine that ran it, in every
  Office result (the shared runner pool mixes EPYC models);
- view-mode heap over full passes (a second case per file, for the view-mode
  creep): open in View, then two full passes (every
  page, every sheet's rows and columns, or every slide, then back to the
  start), with the heap after open and after each pass. The first pass warms
  caches; growth on the second is what keeps creeping;
- view-mode heap over open and close (a third case for the small files and
  the long DOCXs): with a plain text file open, open the Office file in View,
  then switch back to the text file (the workspace has no close button), five
  times, with the heap after each close. Every sample also counts the
  renderer's live `documents`: a closed runtime frame that stays counted is a
  leak, and its WASM memory would no longer be visible to the probe.
  The first close keeps the host's Office code (about 2 to 3 MB). The later
  closes still add about 0.25 MB each over the first ten cycles, which is no
  leak (2026-10-05, 30 cycles per format with heap snapshots): V8's optimized
  code for host functions that run on every switch (`InstructionStream`, deopt
  data, feedback vectors) accounts for over 90% of it and levels off after
  about 20 cycles. The rest comes from TanStack Router. A superseded match's
  aborted `AbortController` has a `DOMException` reason, and that exception's
  captured stack keeps the matches of the navigation that aborted it. The
  chain runs from `router._cache` and adds about 5 KB per navigation. It is
  freed at the first navigation after the router's `defaultGcTime` (5 min).
  No runtime frame context survives a close. Under MSW each mocked response
  also leaves a transferred stream's `MessagePort` among Blink's pending
  activities. That is native memory outside `jsMB`, and the app has no MSW
  in production. So the five-close growth shows JIT warm-up, not a creep.

A fourth case per file (`co-editor`, report-only) opens the file in Edit,
reads the heap with the workers (`heap.afterEdit`), then applies ten remote
edits from a second peer: the mock room's own Yjs client (exposed as
`window.__capyMockRooms` in the load-test build only) inserts `peer ` after
the first character of the first text run of two or more characters, in the
DOCX body or in the first PPTX slide's first story with one, or writes a
number into the fixture's XLSX cell (a base cell override, the form the
editor stores), so the host forwards each as a remote `update` to the
runtime frame. In the frame it times, per edit, with p50, p90 and max:
`queue` (the host's postMessage, the event's timestamp, to the frame
starting to handle it: the rest of the host's task on the shared main thread
and the wait), `apply` (receipt to the end of the runtime's synchronous
handler: the receipt comes from a listener the init script registers before
any page script, the end from one added after the runtime's, since a
window's message listeners run in registration order, capturing or not,
as measured on 2026-10-06; the XLSX and PPTX editors apply there, the DOCX editor only hands
the update to its engine worker, `applyScope: "handoff only"`), `toFrame`
(receipt to the next `docx-pages-presented`, a real paint, or for XLSX and
PPTX to the first task after the next animation frame, which an
asynchronous render could miss, `frameSignal: "next frame"`) and the long
tasks from the post to that frame (`longTask`). It fails when an edit never
arrives or never reaches its frame, or the runtime reports an error; XLSX
also checks the cell reads the peer's last value. It runs on its own page,
so the typing figures stay comparable with earlier runs. XLSX also reports
`toPaint` (receipt to the next painted grid: an init script records when the
grid canvas is cleared for a frame, `window.__xlsxPaints`), the long tasks up
to that paint, and `longestTask`, since the editor's workbook worker paints
after the frame the apply returned in.

PPTX first applies one edit on its own and reports the main thread's busy
time after it (`busyAfterOneEdit`, report-only, Q692), which `toFrame`
misses: after that frame the editor decodes and recolours the slides'
pictures again (~800 ms on `jp_llm2.pptx` at the 0.5.1 pin against ~290 on
the old one, harness `2026-11-06-office-track/office-baseline/REPORT.md`). A
Chrome trace (`disabled-by-default-devtools.timeline` and
`blink.user_timing`) runs for 8 s from the edit; a listener added after the
runtime's marks the receiving task. `busyMs` sums the renderer main thread's
tasks (DevTools' `RunTask`, all sizes: on that baseline trace the long tasks
alone were about 340 of its ~810 ms) from that task until the thread is idle,
no task of 1 ms or more for 500 ms (an untouched open editor runs only
sub-millisecond timers); `settleMs` is the wall time to that point,
`longestTaskMs` and `tasks` describe the stretch, and `idle: false` means the
trace ended first. The ten edits follow it.

XLSX has three more report-only cases. `large paste and row insert` posts a
peer's 8,000-cell paste (1,000 rows by 8 columns from the fixture's cell) and
row insert (a whole recalculation) straight to the runtime as host updates;
the XLSX engine in Node (the fork's loader) makes each from the fixture and
its room's state under its own client id, so the room never sees them. Then
it pastes the same block one row on from the clipboard, so every cell
changes, and runs Insert › Row above as a menu command: per operation the
longest and summed long tasks and the delay to the painted grid (a peer's)
or until the formula bar shows the result (the user's; the paste keeps its
top-left cell active). `typing while a peer pastes and inserts a row` types
twenty values with Enter into the gradebook's column while the same kind of
updates arrive, checks the selection walked on by twenty and every value is
in its cell, and reports the typing span and the long tasks meanwhile.
`rows-50k.xlsx: open to Edit and scrolling` opens one 50,000-row sheet
(`gen_large_xlsx.py 1 50000 values`, seeded with the load-test files) in Edit
and scrolls it 60 and 600 px a frame for 3 s: grid paints and animation
frames per second, the longest gap between paints, the long tasks, and the
heap with the workers. Its scrolling is gated by a fixed ceiling
(`SCROLL_BUDGET`, Q692) instead of 1.3x a median, whose spread was too wide
(the slow run's longest gap 31 to 60 ms over three PC runs on 2026-11-07):
both runs fail on a paint gap
over 100 ms (six frames) or fewer than 50 paints per second. Its open and View
to Edit stay report-only. The typing cases report the keystroke p95 and, for
XLSX, Enter to the painted grid (`enterToPaintP50Ms`, `enterToPaintP95Ms`).

It runs unthrottled: CDP's CPU throttle reaches neither the runtime frame nor
the engine workers. Every file fails on unpainted keys, typing that sends no
edit to the room, a viewer `ready` without timings, a worker fallback, or a
missed budget (open, View to Edit, key p50 and p90 per fixture); the
50,000-row sheet fails on its scroll ceiling. The spec
keeps what each budget is taken from (`MEDIANS`) and derives each budget
(`budgetOf`): 1.3x that figure, rounded up to 5 ms below a second and 50 ms
above, and no keystroke budget below `KEY_BUDGET_FLOOR_MS` (30 ms), since a
one-frame wobble fails anything smaller. The figures come from two builds and
both of the pool's runners (Q839 B, after the move to a production build on
2026-11-24). The production build's three `office` jobs (45330694331,
45330707441 and 45330721726 on 5b054df3a, 2026-11-24) all drew the fast Intel
Xeon 6975P-C, where they match Q832's Xeon run of the earlier build (the
250-page DOCX's View to Edit 5,818-5,948 ms against 6,205, `exchange-plan.docx`'s
open 2,723-2,980 against 2,968). A budget from them would fail on the AMD EPYC
7763, which in Q832 took up to 1.3 times as long as the Xeon to open and 1.3
to 1.5 times as long from View to Edit. So:

- open and View to Edit (an open too) are 1.3x the slower of Q832's two EPYC
  7763 runs (45174430580 and 45174458165 on 69be9249e, 2026-11-23, the build
  in Vite's development mode), a safety net on the slow runner;
- keys, which differ little between runners, are 1.3x the medians of the
  three production runs.

The fast runner's medians sit beside the gate (`RUNNER_MEDIANS`, by the
result's `cpuModel`; the slow runner's figures are the gate's own). Each
result's `runnerDelta` is the run less its runner's figures (negative is
faster), report-only, so a gain shows on either runner; another CPU model gets
the gate and `runnerDelta: null`. Per fixture, the runs, the figure taken and
the budgets (ms; open, View to Edit, key p50, key p90):

| Fixture | Open, EPYC 7763 | Open, Xeon 6975P-C | View to Edit, EPYC 7763 | View to Edit, Xeon 6975P-C | Key p50, Xeon 6975P-C | Key p90, Xeon 6975P-C | Budgets |
|---|---|---|---|---|---|---|---|
| exchange-plan.docx | 3699/3467 -> 3699 | 2723/2880/2980 -> 2880 | 2531/2717 -> 2717 | 1901/1956/1640 -> 1901 | 23/24/23 -> 23 | 28/37/28 -> 28 | 4850, 3550, 30, 40 |
| long-handbook.docx | 3875/3885 -> 3885 | 3135/3167/2942 -> 3135 | 3881/3989 -> 3989 | 2643/2788/2728 -> 2728 | 74/76/76 -> 76 | 82/86/84 -> 84 | 5100, 5200, 100, 110 |
| long-handbook-250.docx | 5063/5215 -> 5215 | 3837/4131/4049 -> 4049 | 9271/9496 -> 9496 | 5818/5948/5890 -> 5890 | 173/181/173 -> 173 | 180/194/182 -> 182 | 6800, 12350, 225, 240 |
| lecture.pptx | 2024/2298 -> 2298 | 1769/2221/1855 -> 1855 | 835/852 -> 852 | 660/687/674 -> 674 | 8/11/11 -> 11 | 9/14/12 -> 12 | 3000, 1150, 30, 30 |
| jp_llm2.pptx | 4468/4463 -> 4468 | 3656/3647/3586 -> 3647 | 1982/1977 -> 1982 | 1425/1509/1444 -> 1444 | 36/42/36 -> 36 | 41/45/41 -> 41 | 5850, 2600, 50, 55 |
| course-guide.xlsx | 1932/2168 -> 2168 | 1685/1734/1833 -> 1734 | 975/1040 -> 1040 | 798/829/798 -> 798 | 5/5/5 -> 5 | 11/9/11 -> 11 | 2850, 1400, 30, 30 |
| large-gradebook.xlsx | 2373/2326 -> 2373 | 2122/2301/2360 -> 2301 | 2948/3026 -> 3026 | 2186/2168/2184 -> 2184 | 5/5/6 -> 5 | 9/11/10 -> 10 | 3100, 3950, 30, 30 |

The bench's earlier medians (2026-11-23 on 69be9249e, Q832 A; 2026-11-20 on
65bdfc1e8, Q757 A; 2026-11-07 on 97e63a68a, Q692; 2026-10-04 before the 0.5.1
pin) are in its history; the PC baseline the second BetterOffice
sync is compared against is
harness 2026-11-06-office-track/office-baseline/REPORT.md.

Since the Q813 and Q814 pin (2026-11-22) the DOCX editor's resident worker
does every layout and the page adopts it, where the page used to lay each
pass out as well, and a pass over an unchanged input (a web-font load) is
skipped (Q813 A, Q814 A, Q824 A). The medians above were measured on it.

Heap and download figures stay report-only: they go to the results JSON
(`budget.heap`, `budget.downloads`, and `budget: "report-only"` in the heap and
co-editor cases), the job summary
and the artifact, and fail nothing. Fields are only ever added to these
files, so a result compares with an older run's field by field.
TODO: decide what a heap ceiling means (retained
after GC or peak, which of JS, array buffers and WASM, per format or per
file), then gate it from three CI runs.

A laptop run is faster than the runner on typing and slower under load, so a
local miss is not a regression by itself.

## Drawing board (`pnpm bench:canvas`)

[`bench/editor/scripts/board.canvas.ts`](../bench/editor/scripts/board.canvas.ts)
measures the drawing board (BlockSuite's edgeless editor on `/dev/drawing`) in a
production build without MSW ([`playwright.canvas.config.ts`](../bench/editor/scripts/playwright.canvas.config.ts)).
The route is in that build only because the bench sets `VITE_BENCH_ROUTES=true`
(`src/router.ts`, and `vite.config.ts` keeps the route for it); `scripts/env/config.py` pins it to `false` for every deploy, and
`scripts/env/test_config.py` checks that. The build takes a few minutes.

Its boards are made in the page through BlockSuite's API and saved, so they
always match the board's current format (Q686 A):

- **Blank:** the plane card alone, as a new answer opens.
- **Typical:** a drawn answer on the plane card: 40 pen strokes of 30 points,
  3 shapes, 2 formulas and 2 note cards of two paragraphs below it.
- **Large:** far past an answer: 200 strokes, 30 shapes, 10 formulas and 30
  note cards of three paragraphs over a 2400 by 1600 area.
- **Dense** (2026-11-23): eight answers of 1920 by 1200, four to a row, as
  the board of the 2026-11-06 label measurement: 25 plane cards with four
  named points, a segment, a curve, a line and two labels each, 64 formula
  cards, 32 note cards of two paragraphs, and in each answer 10 strokes, two
  labelled shapes joined by a connector and a canvas label. Its notes sit
  under every canvas element (notes placed before the drawing, as a
  question's cards), so its 200 canvas elements share one canvas.

Each board is saved once its note cards hold their measured heights
(`saveMeasured`), as a board a person typed is saved. Saved at once, a card
whose text wraps taller than the 120 it was added with keeps 120, and a tab
opening the board writes the size it measures 3 s later (local change 75), a
write of every card inside the measured inputs. Before each tab showed its
measured size at once (2026-11-24), a double click on the card's last line
met empty canvas until that write and started a text label. That is why the
bench failed on main 9c5de0266 (runs 45174430580, 45174458165 and
45174485643; it last passed on 2026-11-07): the large board's note typing
never entered its card.

What it measures:

- **Opens:** three fresh contexts per board, each a cold open and then a warm
  one on the same page (the build's files cached); navigation to the first
  task after the frame that holds every element, the median of the three. The
  blank board opens at 1x, the others at `CPU_RATE` (4x by default). It also
  reports the mount's synchronous cost, when the main thread settles (the last
  long animation frame within 5 s) and the blocking time in that window.
- **Inputs, on the typical and the large board at `CPU_RATE`:** typing 30 keys
  in a note card (100 ms apart), a pen stroke of 40 moves (32 ms apart), 20
  wheel pans and 20 Ctrl+wheel zooms (100 ms apart). Each input is timed from
  its first event to the first task after its next frame, as Office times
  keys; the p50, p90 and maximum are reported.
- **Draw, as a drawing question runs it (fix 4), on the typical board at
  `CPU_RATE`:** three fresh contexts load the module without mounting
  (`/dev/drawing?unmounted`), mount the board with its answer area out of sight
  (opacity 0 and `inert`, as `DrawingBoardScreen`'s `hidden`), mount it again,
  then show it and fit it as Draw does. Reported: each hidden mount's longest
  animation frame (the page's first, cold, and the second, warm) and showing to
  the first task after the next frame.
- **The dense board at `CPU_RATE`:** its cold open (three, as the others),
  and, each on a fresh page at the open's fit (every element in view), 30 keys
  typed into a canvas label, a note card and a formula card on the first
  answer (`startTyping` in `canvasBoards.ts`), and 40 moves (32 ms apart)
  dragging the first point of a plane card in the plane's editor.
- **Bytes:** the JS and CSS each cold open requested, raw and gzipped from the
  build, with the five largest chunks.

Gated: the blank and typical cold opens, the typical board's four input
p90s, the cold hidden mount's longest frame, Draw's first frame and the dense
board's five figures (`denseOpenMs`, `denseLabelP90Ms`, `denseNoteP90Ms`,
`denseFormulaP90Ms`, `densePlaneDragP90Ms`).

The dense board's figures come from three `canvas`-only Performance runs on
0ec9f8134 (2026-11-24), 45296309908, 45296327983 and 45296345446, dispatched
by the Windows Editor (Epo, "Windows Editor runs them"):
- **Inputs:** their medians. Label 21/23/23, note 20/23/24, formula 47/50/50
  and plane drag 9/12/12 ms, so the budgets are 30, 30, 65 and 30 ms.
- **Open:** the third run's 3,610 ms, so the budget is 4,700 ms. That run was
  40-60% slower on every open than the other two (dense open 2,228 and
  2,205 ms, blank open 564-567 against 782). It is the slower runner the opens
  below were calibrated on (blank open 807 ms there). A budget from the faster
  runs (2,900 ms) would fail whenever a run lands on it. It rests on one run
  of that runner so far; take the median once three are in.

The CI pool mixes CPU models (the same runs' Plate jobs were on two Intel Xeon
6975P-C and one AMD EPYC 7763), so each result now names its runner
(`runner`, as Office's do). Calibrate an open on runs of the slower runner,
and an input on all three. A Mac run with the fixes (2026-11-23) measured the
dense open at 1,532 ms and the label, note, formula and plane drag p90s at 11,
11, 41 and 6 ms. Reported only: warm opens
and mounts, the large board and the bytes. It fails on a
page error, an input with no painted frame, typing that doesn't reach the
card, a stroke that draws no brush, a plane point that doesn't move, or a
missed budget. The budgets are 1.3x
the medians in `MEDIANS`, Office's rule (`budgetOf`, rounded up to 5 ms below
a second and 50 ms above, inputs no lower than 30 ms). `MEDIANS` holds three
runs on 630705a96 (2026-11-07): blank open 805/821/807 ms, typical open
2784/2921/3036, pan p90 43/38/43, pen 33/33/33, typing 25/22/21, zoom 61/76/77,
so the budgets are 1050, 3800, 60, 45, 30 and 100 ms. The hidden mount and
Draw (Epo 2026-11-07, "just put this into a perf gate", in place of splitting
the cold mount) are the medians of three later runs on 3249ce018: longest frame
539/728/738 ms, Draw 43/62/61 ms (warm mount 230/303/316,
report-only), so the budgets are 950 and 80 ms. A Mac run on 805e3c1f1 measured
381 and 23 ms. A figure with no median in `MEDIANS` is reported, not gated
(`uncalibrated`). The first calibration (7d470b2e5,
three runs on 4cf06a4b6, 2026-11-06) measured the large board and the blank
open at 4x, so it doesn't carry over; it also showed one runner 40-60% slower
on every figure, so rerun before reading a miss as a regression.

The boards both benches open are made by
[`canvasBoards.ts`](../bench/editor/scripts/canvasBoards.ts).
[`board-typing.canvas.ts`](../bench/editor/scripts/board-typing.canvas.ts)
(`PERF_BOARD_TYPING=1 pnpm bench:canvas board-typing`, report only) times
each place a student types on the dense board (a canvas label, a shape's
label, a connector's label, a note card, a formula card and a plane card's
label in its editor) with the first answer at 100% and with the whole board
in view, and splits each key by Event Timing into input delay, processing and
presentation delay. `PERF_CANVAS_BASE_URL` runs it against a running build or
dev server, `PERF_TYPING_VIA=room` there types on the Canvas page through the
mock collaboration room, and `PERF_PROFILE_DIR` writes a CPU profile summary
per path. Its 2026-11-23 findings and the fixes they led to (vendored local
change 76, the mock room's receipts) are in
[the report](../bench/editor/reports/2026-11-23-board-typing.md).
[`board-stages.canvas.ts`](../bench/editor/scripts/board-stages.canvas.ts)
(`pnpm bench:canvas board-stages`, report only) answers how long the board takes
to show (Epo 2026-11-07): the blank and typical boards' cold opens split into the
app's start, the board chunk's download, its parse and evaluate (chunk done to
`board:mount-start`), the mount and the first full frame, at 1x and 4x CPU, local
and over a 10 Mbps, 50 ms link; and `drawBoardPreview` on the typical and large
boards at 180 by 120 and 600 by 400: the SVG string, the image's decode and its
paint. On main 33ae38a79 on a Mac (about 2-3x faster than the runner), a typical
board's preview took 3.4 ms plus a 3.4 ms decode at 4x, while its full open took
1,252 ms at 4x locally (parse and evaluate 443 ms) and 2,754 ms over the link
(download 927 ms). Fixes 4, 6 and 7 of the canvas-open report (Epo 2026-11-07)
then cut the board chunk from 884 to 648 KB gzipped (data-view and the full icon
set left it, vendored local changes 26 and 27): the typical open at 4x went from
1,237 to 1,105 ms, parse and evaluate from 443 to 308 ms, and the download over
the link from 927 to 740 ms. The probe also times Draw with the module already
evaluated (`/dev/drawing?unmounted`): the first mount on the page, a second one,
and showing a board mounted ahead out of sight, with the JS heap and DOM nodes a
board adds.

A canvas at its size cap is measured apart, by hand, by
[`board-open.cap.ts`](../bench/editor/scripts/board-open.cap.ts)
(`node_modules/.bin/playwright test --config=bench/editor/scripts/playwright.cap.config.ts`,
report only, in no workflow): a production build with MSW (`bench:editor`'s,
production mode since 2026-11-24, Vite's development mode in the figures below) opens a blank canvas
and boards of about 2 MiB and 4 MiB (`CANVAS_BOARD_MAX`) of the growth bench's
mixed hour through the mock collaboration room, and the same states with no
room on `/dev/drawing`. On the Mac at 28a77f5f0 (2026-11-18, medians of 3),
first paint through the room was 2,210 ms blank, 2,726 ms at 2 MiB and 3,312 ms
at 4 MiB; the last long frame ended at 2,210, 2,927 and 3,526 ms; the longest
frame was 176, 678 and 1,186 ms; the JS heap after a GC 30, 94 and 155 MB (27,
67 and 104 MB with no room). At 4x CPU the 4 MiB board painted at 9.4 s and
settled at 12.5 s. MSW's latency is in every total, and the service, a network,
phones and typing on the open board were not measured:
[report](../bench/editor/reports/2026-11-18-board-open-at-cap.md).
After the trace's fixes (the same day, at 75feaf8f6 plus the fixes): a build's
`/assets/` chunks pass MSW by, the mock room encodes once per join and skips
its probe for an empty tab, and vendored BlockSuite's local changes 66 to 69
(no selection read after a rangeless editor's render, the surface found once
per store, one grid search for the views added in one go, no draw before the
fit). At 4x CPU the 4 MiB board then painted at 5.7 s and settled at 9.0 s
(10.0 and 13.3 s at HEAD; 6.4 and 9.6 s with the mock fixes alone), its longest
frame 2.95 s (5.0 s); the bench now opens three times at 4x and waits for the
machine's load under `PERF_CAP_MAX_LOAD`:
[report](../bench/editor/reports/2026-11-18-board-open-fixes.md).

## Formula parity audit (`pnpm bench:formula`)

[`bench/editor/scripts/formula-parity.audit.ts`](../bench/editor/scripts/formula-parity.audit.ts)
inserts each of MathLive's 13 Insert commands and 25 matrix sizes, empty and
filled, inline and block (152 cases), and fails when View and Edit differ in
size, per-glyph geometry (0.1px), font or text, or the LaTeX does not round
trip. It left the editor e2e suite on 2026-10-06 (about 5.5 minutes of CI per
run); run it by hand when MathLive is upgraded. It uses the editor e2e seed
(`VITE_E2E_EDITOR_SEED`, [`playwright.formula.config.ts`](../bench/editor/scripts/playwright.formula.config.ts))
and writes each case's captures and the geometry JSON to the gitignored
`bench/editor/.results/formula-parity/`. No workflow runs it.

## Mermaid rendering (`node bench/editor/scripts/mermaid-probe.mjs`)

Mermaid draws in a Web Worker (see
[frontend/plate-editor.md](frontend/plate-editor.md)), so the page's main
thread only sanitizes and inserts the SVG. With the app's dev server running,
`node bench/editor/scripts/mermaid-probe.mjs` (`MERMAID_PROBE_URL`) draws the
near-limit flowchart and mindmap (`src/mocks/nearLimits.ts`) on the page, as
before the worker, and in the worker, at 1x and 4x CPU throttle, and prints the
longest main-thread task and frame gap. CDP throttles the page's thread only:
a device 4x slower also draws 4x slower in the worker, which puts the
near-limit flowchart past the 30 s render limit there. No budget gates it.
Numbers: [2026-10-22-mermaid-worker.md](../bench/editor/reports/2026-10-22-mermaid-worker.md).

## Collaboration stress (`pnpm bench:stress`)

[`bench/collaboration/scripts/stress.ts`](../bench/collaboration/scripts/stress.ts)
starts the e2e Docker stack through `e2e/global-setup.ts` with
[`docker-compose.stress.yml`](../bench/collaboration/scripts/docker-compose.stress.yml)
and [`docker-compose.stress-run.yml`](../bench/collaboration/scripts/docker-compose.stress-run.yml)
layered on (`E2E_COMPOSE_OVERRIDES`). The first, which the capacity harness
also uses, replaces the memory blob store (which the API serves under
`/api/e2e/blobs/`, so uploads skip a bucket) with
[`fake-s3.mjs`](../bench/collaboration/scripts/fake-s3.mjs) on the stock Node
image, served over TLS under a `*.backblazeb2.com` name the server accepts with
a throwaway certificate. The owner uploads `exchange-plan.docx` as the app
does: a ticket whose turn comes, then one request (`POST .../sources/uploads`)
streams the metadata, then the bytes, through the gateway, which writes them
to the fake. It
also creates a Plate note, then `STRESS_PEERS` peers (20) per room, with API
tokens, type
unique markers for `STRESS_MINUTES` (3), about one per `STRESS_EDIT_MS`
(1500); each drops offline for 1 to 5 s at `STRESS_DROP_PER_SECOND` (0.02) and
keeps typing, sending on reconnect. A watching peer that never drops times
each marker typed while its peer was connected and synced, scanning only the
text each change inserts, so the client's own cost stays flat. Then:

- every peer and a late joiner hold the same text (convergence);
- every typed marker is there exactly once (no lost or doubled update);
- the collaboration service logged no error;
- p95 marker latency within `STRESS_P95_BUDGET_MS`, 45 ms, in the first
  phase (~1.3x the slower
  room's median of three CI runs on 2026-10-04: Office 34/33/34, Plate
  35/34/35 ms). The service's 30 ms broadcast batching (the Node server's
  `flushDelay`, the Rust server's `FLUSH_WINDOW`) put most of that there:
  before it the runs gave Office 5/5/3 and Plate 8/9/5 ms against a 10 ms
  budget. A loaded laptop measures more, so set the variable for local runs.
  Back to back on one Windows host (2026-10-08), the Rust and Node servers
  both met it (p95 Office 40 / 37, Plate 39 / 37 ms), and in the near-limit
  phase the Rust server held its scheduling lag under 0.1 s where Node's
  reached 0.8 s on each 4 MiB text save
  ([report](../bench/collaboration/reports/2026-10-08-rust-node-stress.md)).

A second phase follows on the local stack (`STRESS_LIMIT_ROOMS`, default
`note-limit,text`; empty on UAT and external stacks, where a text source would
be indexed): `STRESS_LIMIT_PEERS` peers (5) per room for another
`STRESS_MINUTES` in the near-limit note (the app's load-test note,
`buildBiologyLoadTestValue`, ~2.0 MB and ~7,400 nodes, 96% of the size limit,
so the service measures the whole room on every update) and a text source of
`STRESS_TEXT_MIB` (4: with its saved state each text source holds about twice
its size, and two of them, here and in the cost window, have to stay inside
the e2e owner's 100 MB Free storage quota; at 8 MiB three local runs in one
stack exhausted it). Text markers go just
before characters of the seeded text, through relative positions taken
before anyone types, so they never land inside another marker and no peer
scans several MiB per marker. The same convergence, marker and error checks
apply (a failed one fails the run); a setup error of this phase (an upload,
the note's creation) is listed in `reportOnlyFailures` and fails nothing,
and the budgeted phase's results are already written: `stress.json` is
rewritten after each phase and cost window. Their latency is report-only (`byKind[kind].budgeted: false`,
`limitClientLoopDelayMs`). It runs after the first phase, not beside it, so
its cost (~50-90 ms of service CPU per near-limit note update before the
per-update bound) does not move the budgeted rooms' latency. Fewer peers
than the first phase keep the service from saturating on that note before
the bound lands, with the same count before and after. The report records
the runner's CPU (`runner`).

The collaboration server is measured from outside, so the same scenarios can
judge another build of it: the driver only speaks the protocol (capy-sync
with Yjs sync, the app's
`checkpoint-request` stateless message and its `checkpoint-persisted`
receipt) and reads the server's containers through the Docker Engine API
(`DOCKER_HOST` when it is a `unix://` socket, else `/var/run/docker.sock`; a
Docker context without either, Colima for one, needs `DOCKER_HOST` set).
It times the probe endpoint below and ignores its answer, and reads the
service's logs only for the error check. It measures three containers,
since a save's cost is split between them: `collaboration`, `api` (the Go
gateway, which does the database side of every checkpoint and projection)
and `db` (Postgres), and records what they run (`server.images`: image name
and ID). Per phase, `server.main` and `server.limit` give each container's
CPU time over the phase and per typed marker (joins, settling and late
joiners included) and its working set before and after. A Docker read that
fails around a phase (or for `server.images`) leaves those figures empty and
is a `reportOnlyFailures` entry; the phase's rooms are still judged and
written. Outside the
budgeted phase (calibrated without it), `probe` gives the answer time to an
endpoint that touches only the server's event loop, every 250 ms
(`STRESS_PROBE_PATH`, the service's `/livez`; `/healthz` pings Postgres and
Redis and `/metrics` needs the service secret, so neither is used), p50, p99, max and
failures: it grows with whatever holds the event loop or scheduler. Read it
beside `clientLoopDelayMs`, which bounds what the client can see. Then the
cost windows (`STRESS_COST_ROOMS`, local default
`office,plate,note-limit,text`, empty elsewhere) take one room kind at a time
with `STRESS_COST_PEERS` peers (5), report-only, in `cost[kind]`: per
container in `server`, `idleCpuMsPerS` (the quietest window before the room,
the probe's own cost included, taken out of everything below; `idleMeasured`
false and `server` empty when the server never went quiet), `loadCpuMs` and
`memoryMBPerRoom` (loading the room for its peers until the server is quiet
again, `loadS`), `cpuMsPerUpdate` over `STRESS_COST_SECONDS` (30) of typing
(the debounced saves and projections it causes included, until the server
is quiet), `memoryMBAfterTyping`, and `cpuMsPerSave` with `saveMs`, the
median of three explicit saves of a one-marker edit from a quiet server
(`flush` in source rooms, as the app's Save sends it; the note's save waits
for its debounce), CPU until quiet again and time until the receipt; plus
`probe` while typing. Quiet means three ~2 s windows in a row (rates over
the measured interval) under max(50, 2x idle) ms of CPU per second (30 s at
most). A cost window that breaks (a receipt not back in 30 s, a Docker read)
is a `reportOnlyFailures` entry, as is a kind skipped because the windows
passed `STRESS_COST_MAX_MINUTES` (8); the CI summary prints them apart from
correctness failures. The memory figures carry the server's
garbage-collection timing, so read them over several runs.

To point the scenarios at another server: on the local stack set
`STRESS_COLLABORATION_IMAGE` with `E2E_PREBUILT_IMAGES=true` (the stress-only
overlay swaps the `collaboration` service's image; it gets the same
environment, and `SSL_CERT_FILE` and `NODE_EXTRA_CA_CERTS` name the fake S3's
certificate). Without `E2E_PREBUILT_IMAGES=true` the run refuses to start,
since compose would build the Node service under the other image's name.
On another stack use `STRESS_STACK=external` with `STRESS_SERVER_CONTAINER`,
`STRESS_API_CONTAINER` and `STRESS_DB_CONTAINER` naming its containers (the
same for `E2E_SKIP_COMPOSE=true`), `STRESS_PROBE_PATH` its cheap endpoint,
and `STRESS_COST_ROOMS` and `STRESS_LIMIT_ROOMS` set as wanted.

A failed check exits 1, a missed budget alone exits 2. SIGINT and SIGTERM tear
the stack down and remove the throwaway key. Under heavy load
(load 34) a run logged a projection deadlock (`40P01`), a store statement
timeout and a source access 500, with p95 over 40 s: worth a look on the CI
runner before the budget is trusted.

Capacity runs on one box start the stack themselves and run several
generator processes against it: `STRESS_STACK=external` (`E2E_API_URL`,
`E2E_AUTH_SECRET`, `E2E_BASE_URL` name the seeded stack, store-only uploads,
`STRESS_WORKSPACE` per process, raw latencies in `latencies.json`),
`STRESS_KINDS` (room kinds to cycle), `STRESS_OFFICE_FILES` (Office files to
cycle: DOCX and PPTX peers type into story text, XLSX peers write their own
cells of the first sheet), `STRESS_JOIN_CONCURRENCY` and `STRESS_IDLE=true`
(connected peers that never type). The fake S3 takes multipart uploads, so
large files work. Method and results:
[2026-10-05 production-box capacity](../bench/collaboration/reports/2026-10-05-prod-capacity.md).

`STRESS_TARGET=uat` runs the same peers against the UAT deployment
(`node --env-file=deploy/.env.uat --import tsx bench/collaboration/scripts/stress.ts`,
never `pnpm run` in a worktree). `STRESS_ROOMS` rooms (2), alternately Office
and Plate, each get `STRESS_PEERS` peers. Each Office and Plate pair gets a
disposable Clerk test-mode user, as the UAT journeys use: created with the
backend API with the run id in its private metadata, then signed in one at a
time with a sign-in ticket under Clerk's testing token, as a native Frontend API
client. Each user also gets its own workspace. The workspace has auto process
off before its note exists, and the DOCX is a store-only upload
(`parseMode=none`), so nothing is parsed or indexed. The only jobs are
export-only `source_refresh` publications, which the collaboration service runs
itself, so nothing reaches the shared ingest host. Collaboration errors come
from the host's logs and its `/metrics` failure counters (read inside the
container with the service secret) over SSH
(`STRESS_UAT_SSH`, `STRESS_UAT_SSH_KEY`). Cleanup deletes the workspaces, then
the users. `uat-resources.json` in `STRESS_OUT` lists them if cleanup fails.
On UAT the budget is 1 s, including the client's round trip (about 300 ms from
Asia). Peers join 16 at a time. One client machine has lost its network at
about 200 peers, so split bigger steps across machines rather than processes.

## GitHub Actions

Workflow [`Performance`](../.github/workflows/perf.yml) (named `Editor perf`
before the Office job joined it) runs on manual
dispatch and by `workflow_call` from `promote-production.yml`, which passes the
candidate SHA as `revision`. Pin is `ubuntu-24.04`. Typical wall time is 15 to
25 minutes.

It has three jobs. `perf` is the editor suite below; production promotion's
`editor_perf` job calls the file and `deploy_production` needs it, so these
budgets gate promotion (check name `editor_perf / perf`).
`scripts/review/validate-review-boundaries.mjs` fails CI if promotion stops
calling `perf.yml` or the file stops being dispatchable and callable. `office`
runs `pnpm bench:office` on dispatch only (input `office`, default true; a
`workflow_call` defaults it to false, so promotion skips it); its CI-calibrated
budgets fail the job and the run. Its results go to the job summary and the
`office-perf-results` artifact. `canvas` runs `pnpm bench:canvas` the same way
(input `canvas`, default true on dispatch, false on `workflow_call`), with its
results in the job summary and the `canvas-perf-results` artifact.
`stress` runs `pnpm bench:stress` (below) on dispatch only (input `stress`,
false on `workflow_call`) against the `e2e_stack` images, built from the same
GitHub Actions layer cache. A failed check (exit 1) or a missed latency
budget (exit 2, p95 over 45 ms; four runs with the 30 ms broadcast batching
sat at 33 to 35 ms) fails the job and the run, and its summary marks a
correctness failure as such.
`stress.json` goes to the summary and the `collaboration-stress-results`
artifact.

Steps of the `perf` job:

0. Check out the BetterOffice submodule and run `pnpm office:prepare` (with
   the BetterOffice WASM cache), as the `canvas` job does: the production
   build imports the fork's WASM and stylesheet, and in CI a missing one fails
   the build rather than being stubbed.
1. Run `pnpm bench:editor` with `PERF_SNAPSHOT_DIR` set. It builds the app first,
   inside the step (about two minutes; the job took about 4.5 minutes on the dev
   server, timeout 40), then `reportMetrics` writes one JSON file per budget
   case. The build in `.results/editor-dist` is a folder, which assembling skips.
2. [`bench/editor/scripts/compare-cli.ts`](../bench/editor/scripts/compare-cli.ts) assembles a
   `PerfSnapshot` (build, commit, CPU model, Playwright version, `PERF_CPU`,
   cases). The build (`buildLabel`) is `production`, `production-unminified`
   for a `PERF_PROFILE` run and `external` for a `PERF_BASE_URL` run: the
   config records it as `metadata.build`, `reportMetrics` writes it to
   `build.txt` beside the cases, and assembling fails without that file. `PERF_COMMIT` carries
   the measured revision because `GITHUB_SHA` is the caller's SHA under
   `workflow_call`.
3. Download `perf-snapshot` from the last 10 successful runs of `perf.yml` and
   of `promote-production.yml` (promotions call this workflow, so their green
   runs count). Expired or missing artifacts are skipped.
4. [`bench/editor/scripts/snapshot.ts`](../bench/editor/scripts/snapshot.ts) keeps the
   snapshots of the current one's build, sorts them by creation
   time and writes two columns: vs the **median of the newest 5** ("are we
   drifting") and vs the **best over all retained** (a floor that cannot creep
   upward one checkpoint at a time). A snapshot of another build, or one with
   no build (the dev server's, before 2026-11-24), is left out and counted in
   the summary, so the first production runs read as first runs, not as large
   deltas. Artifacts expire at 90 days, which bounds the lookback.
5. Write the table to the job summary. Relative deltas never fail the job.
6. Upload `perf-snapshot.json` (90 days). Assemble and upload run even when
   budgets fail; the job then fails on the budget result.

First dispatch has nothing to diff, and neither has the first production run.
That is expected. After that, GHA-vs-GHA only. Do not check in a laptop JSON.

You can dispatch from any branch. Baselines are not automatically `main`.
`share_pages` is the exception: its `uat` environment admits only `main`, so
on another branch GitHub rejects that job before it starts.

## What the relative table includes

[`bench/editor/scripts/snapshot.ts`](../bench/editor/scripts/snapshot.ts) `RELATIVE_METRICS` (lower is
better):

- large-document interactive `openMs`
- large-document typing `blockingPerKeystrokeMs`
- large-document save-cycle `loafTotalBlockingMs`

Left out on purpose: small-document typing (already 2.5 to 7.7ms of noise), INP (a
single unlucky keystroke), scroll FPS / longest frame (software raster on GHA,
no GPU). Profile specs stay forensic.

The summary still dumps the full case payloads as context. A CPU-model mismatch
gets a warning because the shared Ubuntu pool is mixed Azure hardware. Chrome's
CPU throttle is a multiplier of the host, so it does not cancel that spread.

## Why this stays warn-only

Absolute ceilings are the gate. They were recalibrated on 2026-11-24, on the
production build, from three GHA runs on one SHA (below). A human lowers a ceiling when a
real improvement lands; nothing raises one automatically.

### Recalibrating on the production build

Last done on 2026-11-24 on 5b054df3a (Epo, "approve for now"); the results
follow the steps. The steps are also in the `BUDGET` comment of [`editor.perf.ts`](../bench/editor/scripts/editor.perf.ts):

1. The Windows Editor dispatches the Performance workflow three times on one
   commit, with only the editor suite (`office`, `canvas`, `stress` and
   `share_pages` unticked). The Mac never dispatches it.
2. Download each run's `perf-snapshot` artifact (`build: "production"`). It
   holds the cases and the runner (`cpuModel`). Check the runs against each
   other first; a run far off the other two is left out and another
   dispatched.
3. The opens are taken on the slowest CPU model in the runs (AMD EPYC 7763 so
   far), as `bench:canvas`'s open was (Epo's "Yes, slower runner"): opens
   differ 40 to 60% across the pool, and the dev build's read-only open budget
   (4,050) was already missed on that runner (4,230). `large.interactiveOpenMs`
   and `large.readOnlyOpenMs` are 1.3x the median of that runner's runs once
   three exist, and 1.3x its one run until then (with two, the slower), from
   `open-large-document`'s `interactive.openMs` and `readOnly.openMs`. Later
   dispatches that draw it replace the figure with the median once there are
   three.
4. The inputs are 1.3x the median of all three runs, whatever runner:
   `typing-large-document`'s `typing.p95SlowKeyEventMs`,
   `typing.blockingPerKeystrokeMs` and `saveCycle.loafTotalBlockingMs`, and
   `scroll-large-document`'s `longestFrameMs`. The `avgFps` budget is its
   median divided by 1.3 (higher is better). `typing-small-document`'s
   `p95SlowKeyEventMs` takes 1.5x (event durations come in 8 ms steps), and its
   `blockingPerKeystrokeMs` keeps the 10 ms floor while 1.3x its median is
   under it.
5. Round as `bench:canvas`'s `budgetOf` does: up to 5 ms below a second and
   50 ms above; FPS down to a whole frame.
6. Replace each `BUDGET` number with its budget and a comment naming the three
   runs (ids, runner, values) and the median, as `MEDIANS` in
   [`board.canvas.ts`](../bench/editor/scripts/board.canvas.ts) does, and rewrite
   the numbers in this section.

The 2026-11-24 runs on 5b054df3a: 45330694331 and 45330707441 on AMD EPYC 7763,
45330721726 on AMD EPYC 9V45 (values in that order; opens from the slower 7763
run, the rest from the median of all three):

| Budget | Runs | Budget (dev build's) |
| --- | --- | ---: |
| `large.interactiveOpenMs` | 8,491 / 9,119 / 7,399 | 11,900 (20,000) |
| `large.readOnlyOpenMs` | 2,137 / 2,279 / 2,602 | 3,000 (4,050) |
| `large.saveCycleBlockingMs` | 118 / 115 / 64 | 150 (475) |
| `large.typingBlockingPerKeystrokeMs` | 1.2 / 1.5 / 0.3 | 5 (275) |
| `large.typingP95KeyEventMs` | 72 / 72 / 64 | 95 (395) |
| `scroll.avgFps` (higher is better) | 52.7 / 50.3 / 53.4 | 40 (38) |
| `scroll.longestFrameMs` | 83 / 100 / 117 | 130 (370) |
| `small.typingP95KeyEventMs` | 32 / 32 / 32 | 50 (84) |
| `small.typingBlockingPerKeystrokeMs` | 0 / 0 / 0 | 10 floor (10) |

The two opens in that table were on the old measure. The fixed measure
(`waitForNote`, [above](#what-the-near-limit-opens-measure)) set them again on
2026-11-24 (Epo, "Set them now") from three runs on 276d1de7e: 45362191070 on
Intel Xeon 6975P-C, 45362210464 and 45362227226 on AMD EPYC 9V74 (values in
that order). None drew the EPYC 7763, so by step 3 the opens are 1.3x the
slower run of the slowest runner present, the 9V74; the first runs that draw
the 7763 replace them. Office's figures put the 7763 25 to 60% slower than the
Xeon at opening, so a 7763 run may miss these until then. The other budgets
passed on these runs and stay as in the table.

| Budget | Runs | Budget (old measure's) |
| --- | --- | ---: |
| `large.interactiveOpenMs` | 4,701 / 4,963 / 5,010 | 6,550 (11,900) |
| `large.readOnlyOpenMs` | 3,573 / 3,719 / 3,824 | 5,000 (3,000) |

The tightest margins are the longest frame (a run at 117 against 130) and the
interactive open (5,010 against 6,550).

Typing is gated on the p95 key event and on blocking per keystroke (large: 95
and 5 ms, 1.3x the medians 72 and 1.2; small: 50 ms, 1.5x the median 32,
because event durations come in 8 ms steps and 1.3x would sit one step above
the median, plus the 10 ms blocking floor). The single worst keystroke
(`inpApproxMs`) is still reported. Over 85 ms (small) or 500 ms (large) it adds
a `warning` annotation and a `[perf]` log line. It never fails the run: it
measures one GC pause, or two keystrokes queued into one frame, because at x4 a
near-limit keystroke costs ~200 ms while the harness types every 40 ms. On one
SHA it spread 80 to 128 ms (small) and 336 to 528 ms (large) across six runs.

The near-limit read-only open was rebaselined on 2026-10-04 to 4,050 ms (1.3x
the median 3,118 of six runs on 37fa7e53; it was 1,952 on 2026-09-03). The
read-only render itself did not change (click to text 65 to 90 ms). The time was
the workspace page's startup in the dev build, see the open item below. On the
production build it measured 2,137 to 2,602 ms (2026-11-24, budget 3,000) on
the old measure, and 3,573 to 3,824 ms (budget 5,000) once it waited for the
document's first block.

Standard GitHub-hosted runners are a mixed CPU pool. Independent PassMark
samples of ubuntu-24.04 x64 (same Azure fleet, mid-2026) land around 2200 to 2670
single-thread. A relative fail against the best green would fire whenever the
candidate draws a slower host than the luckiest baseline. Treat the table as a
human-read delta, not a gate.

Other caveats that already apply to the absolute budgets:

- The build is UAT's, but the network is MSW in the page with a fixed
  latency, and the throttled CPU is a multiple of a shared runner. Deltas are
  not user-facing SLOs.
- MSW save-cycle work runs on the main thread. A real collab server does that
  work elsewhere. The mock keeps it to the projection write: a checkpoint
  appends the room's updates since the last one rather than re-encoding the
  whole Y.Doc (`src/mocks/collaboration.ts`).
- Artifacts expire after 90 days. A green run may still be listed with no file
  left to download; it is skipped.

If relative fail ever becomes a merge gate, leave the shared `ubuntu-24.04`
pool. Larger GitHub runners need a Team/Enterprise org. A labeled self-hosted
Linux box is the cleanest signal and a snowflake. Do not pay for dedicated
third-party runners until a few manual GHA series show that host mix is what
breaks the deltas.

## Open items

- **Trim the workspace page's startup imports** to bring the read-only open
  down (2,600 ms was the dev build's target; the production build measured
  2,137 to 2,602 ms on 2026-11-24). Since 2026-09-03 the page went from 399 to 806 loaded
  modules (309 to 518 before the first API request), the i18n message bundle
  on that path from 6.2 to 10.6 MB, and the generated zod validators
  (`src/api/gen/validators.ts`, 2,911 to 5,449 lines) hold 12.8 MB of heap
  after open. Split the workspace route's static imports, load the generated
  validators and the active locale's paraglide messages lazily, and keep the
  mocks and the mock scenario panel out of the startup graph (`chaosPeers`
  pulls the whole note plugin kit into every MSW page). Then lower
  `readOnlyOpenMs` again.
