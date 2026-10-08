---
type: Guide
title: 'Editor performance checkpoints'
description: 'Playwright editor budgets, the GitHub Actions snapshot compare against median-of-5 and best green, and why relative deltas stay warn-only.'
tags: [frontend, testing, playwright, performance, github-actions]
---

# Editor performance checkpoints

`pnpm bench:editor` measures the Plate editor against a Vite **dev** build and MSW. It
is a regression tripwire, not a production SLO. Absolute `BUDGET` ceilings in
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

Four budget specs always run. Two V8 profile specs run only with
`PERF_PROFILE=1`. Default CPU throttle is `PERF_CPU=4` via CDP after load. Open
cost is measured unthrottled because that path is already tens of seconds.

Numbers from a Windows laptop are not comparable to Linux CI. Different OS,
different Chromium raster path, different CPU. Keep local runs for debugging
(`typingProfile.perf.ts` / `saveCycleProfile.perf.ts`). Use Actions for
deltas.

`.github/workflows/ci.yml` does not run `pnpm bench:editor`.

## Office runtime (`pnpm bench:office`)

[`bench/editor/scripts/runtime.office.ts`](../bench/editor/scripts/runtime.office.ts)
runs against a production build ([`playwright.office.config.ts`](../bench/editor/scripts/playwright.office.config.ts)
builds with `NODE_ENV=production`, MSW and `VITE_LOAD_TEST_SEED`, then serves it
with the runtime on the next port of `localhost`: another origin on the same
site, as `office.capynotebook.com` is to the app, so the iframe is cross-origin
and shares the app's renderer process as in production). The build takes a few
minutes. It covers one small and one large file per format:

| Format | Small | Large |
| --- | --- | --- |
| DOCX | `exchange-plan.docx` (15 pages, 66 KB) | `long-handbook.docx` (62 pages, 41 KB, [`gen_long_docx.py`](../bench/editor/scripts/gen_long_docx.py)) |
| XLSX | `course-guide.xlsx` (3 sheets, ~55k styled cells, 145 KB) | `large-gradebook.xlsx` (8 class sheets of 2,000 rows with SUM, AVERAGE and IF per row, plus a cross-sheet Summary; 224k cells, 48k formulas, 1.4 MB, [`gen_large_xlsx.py`](../bench/editor/scripts/gen_large_xlsx.py)) |
| PPTX | `lecture.pptx` (20 slides, 25 pictures, 311 KB) | `jp_llm2.pptx` (84 slides, 69 pictures, 24 MB; the committed parser fixture in `bench/parsers/fixtures/docs/`) |

The small files are the e2e rich-content fixtures. The large files are seeded
only under `VITE_LOAD_TEST_SEED`; their checkpoints come from
`scripts/dev/seed-scenario-office.ts`.

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

- open to first paint: the file click to the runtime's `ready`, on the host's
  clock. Every viewer sends it once its first pages, grid or slide (pictures
  included) are painted, with the runtime's own `timings` (`loadMs` frame
  start to `load`, `paintMs` `load` to first paint; `OfficeReadyTimings`);
- View to Edit: the mode toggle click to the edit frame's `ready`, its first
  painted pages, grid or slide, with timings (`edit.firstPaintMs`). DOCX gates
  that as `editReadyMs`; XLSX and PPTX still gate `editReadyMs` on
  `collaboration-ready` (the editor's replica, reported in the same React
  commit as the editor's first real paint), which their budgets were
  calibrated against, and report their first paint only until recalibrated;
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
  the high-water mark. `performance.measureUserAgentSpecificMemory` would
  need cross-origin isolation, which the app does not have;
- `runner`: the CPU model and core count of the machine that ran it, in every
  Office result (the shared runner pool mixes EPYC models);
- view-mode heap over full passes (a second case per file, for the view-mode
  creep item in `todo-office.md`): open in View, then two full passes (every
  page, every sheet's rows and columns, or every slide, then back to the
  start), with the heap after open and after each pass. The first pass warms
  caches; growth on the second is what keeps creeping;
- view-mode heap over open and close (a third case for the small files and
  the long DOCX): with a plain text file open, open the Office file in View,
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

XLSX has three more report-only cases. `large paste and row insert` posts a
peer's 8,000-cell paste (1,000 rows by 8 columns from the fixture's cell) and
row insert (a whole recalculation) straight to the runtime as host updates;
the XLSX engine in Node (the fork's loader) makes each from the fixture and
its room's state under its own client id, so the room never sees them. Then
it pastes the same block from the clipboard and runs Insert › Row above as a
menu command: per operation the longest and summed long tasks and the delay
to the painted grid. `typing while a peer pastes and inserts a row` types
twenty values with Enter into the gradebook's column while the same kind of
updates arrive, checks the selection walked on by twenty and every value is
in its cell, and reports the typing span and the long tasks meanwhile.
`rows-50k.xlsx: open to Edit and scrolling` opens one 50,000-row sheet
(`gen_large_xlsx.py 1 50000 values`, seeded with the load-test files) in Edit
and scrolls it 60 and 600 px a frame for 3 s: grid paints and animation
frames per second, the longest gap between paints, the long tasks, and the
heap with the workers. The typing cases report the keystroke p95 and, for
XLSX, Enter to the painted grid (`enterToPaintP50Ms`, `enterToPaintP95Ms`).

It runs unthrottled: CDP's CPU throttle reaches neither the runtime frame nor
the engine workers. Every file fails on unpainted keys, typing that sends no
edit to the room, a viewer `ready` without timings, a worker fallback, or a
missed budget (open, View to Edit, key p50 and p90 per fixture). The spec
keeps the medians (`MEDIANS`) and derives each budget (`budgetOf`): 1.3x the
median, rounded up to 5 ms below a second and 50 ms above, and no keystroke
budget below `KEY_BUDGET_FLOOR_MS` (30 ms), since a one-frame wobble fails
anything smaller. The medians come from three runs of the `office` job below,
all on 2026-10-04:

- DOCX: runs 37174928433, 37174944257 and 37174959817 (every metric within
  3% of its median).
- XLSX and PPTX View to Edit and keys: runs 37197306625, 37197311546 and
  37197316994 on 15136468, all three on AMD EPYC 7763 runners. Their spread
  was within 8% of the median except the key timings of a few milliseconds
  (p50 11 to 14 ms, up to 18% apart), which the floor covers.
- XLSX and PPTX open: runs 37200395852, 37200390235 and 37200383976 on
  253762ea (one EPYC 9V45, two EPYC 7763), the first runs since their
  viewers' `ready` moved to after the first paint. Against the earlier
  medians, open moved +2% for course-guide.xlsx, -2% for
  large-gradebook.xlsx, +5% for lecture.pptx and +26% for jp_llm2.pptx, whose
  first slide's pictures now count (5,728 against 4,530 ms). The other XLSX
  and PPTX metrics of those runs stayed within 80% of their budgets, so their
  medians are unchanged.

Heap figures stay report-only: they go to the results JSON (`budget.heap`,
and `budget: "report-only"` in the heap and co-editor cases), the job summary
and the artifact, and fail nothing. Fields are only ever added to these
files, so a result compares with an older run's field by field.
TODO: decide what a heap ceiling means (retained
after GC or peak, which of JS, array buffers and WASM, per format or per
file), then gate it from three CI runs.

A laptop run is faster than the runner on typing and slower under load, so a
local miss is not a regression by itself.

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

## Collaboration stress (`pnpm bench:stress`)

[`bench/collaboration/scripts/stress.ts`](../bench/collaboration/scripts/stress.ts)
starts the e2e Docker stack through `e2e/global-setup.ts` with
[`docker-compose.stress.yml`](../bench/collaboration/scripts/docker-compose.stress.yml)
and [`docker-compose.stress-run.yml`](../bench/collaboration/scripts/docker-compose.stress-run.yml)
layered on (`E2E_COMPOSE_OVERRIDES`). The first, which the Office
storage-charging bench and the capacity harness also use, replaces the memory blob
store, whose `memory://` URLs the collaboration service cannot fetch, with
[`fake-s3.mjs`](../bench/collaboration/scripts/fake-s3.mjs) in the collaboration
image, served over TLS under a `*.backblazeb2.com` name the server accepts with
a throwaway certificate. The owner uploads `exchange-plan.docx` as the app
does: it reserves the upload (`POST .../sources/uploads`), PUTs the bytes to
the presigned URL and completes it (`.../complete`). The presigned URL names
the fake inside the Docker network, so the client sends it to the fake's
plain HTTP port, which only the stress-only overlay publishes, on
`STRESS_S3_PORT` (the fake checks no signatures). For a stack started
elsewhere, `STRESS_UPLOAD_ORIGIN` names the fake's plain HTTP origin
(`http://s3:9000` for a generator inside the stack's network, as in the
capacity harness); with `E2E_SKIP_COMPOSE=true`, set `STRESS_S3_PORT` to the
running stack's published port. It
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
  35/34/35 ms). The service's 30 ms broadcast batching (`flushDelay` in
  `collaboration/src/server.ts`) put most of that there: before it the runs
  gave Office 5/5/3 and Plate 8/9/5 ms against a 10 ms budget. A loaded laptop
  measures more, so set the variable for local runs.

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
judge another implementation of it (the planned Rust server on yrs): the
driver only speaks the protocol (Hocuspocus/Yjs sync, the app's
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
(`STRESS_PROBE_PATH`, the Node service's in-memory `/metrics`; its
`/healthz` pings Postgres and Redis, so it is not used), p50, p99, max and
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
from the host's logs and its `/metrics` failure counters over SSH
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
`office-perf-results` artifact.
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
   the BetterOffice WASM cache), as `ci.yml`'s `e2e_editor` does: the app
   imports the fork, and without it Vite's dependency scan fails before any
   budget runs.
1. Run `pnpm bench:editor` with `PERF_SNAPSHOT_DIR` set. `reportMetrics` writes one JSON
   file per budget case.
2. [`bench/editor/scripts/compare-cli.ts`](../bench/editor/scripts/compare-cli.ts) assembles a
   `PerfSnapshot` (commit, CPU model, Playwright version, `PERF_CPU`, cases).
   `PERF_COMMIT` carries the measured revision because `GITHUB_SHA` is the
   caller's SHA under `workflow_call`.
3. Download `perf-snapshot` from the last 10 successful runs of `perf.yml` and
   of `promote-production.yml` (promotions call this workflow, so their green
   runs count). Expired or missing artifacts are skipped.
4. [`bench/editor/scripts/snapshot.ts`](../bench/editor/scripts/snapshot.ts) sorts them by creation
   time and writes two columns: vs the **median of the newest 5** ("are we
   drifting") and vs the **best over all retained** (a floor that cannot creep
   upward one checkpoint at a time). Artifacts expire at 90 days, which bounds
   the lookback.
5. Write the table to the job summary. Relative deltas never fail the job.
6. Upload `perf-snapshot.json` (90 days). Assemble and upload run even when
   budgets fail; the job then fails on the budget result.

First dispatch has nothing to diff. That is expected. After that, GHA-vs-GHA
only. Do not check in a laptop JSON.

You can dispatch from any branch. Baselines are not automatically `main`.

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

Absolute ceilings are the gate. They were set on 2026-09-03 to about 1.3x the
median of three GHA runs on the same SHA. A human lowers a ceiling when a real
improvement lands; nothing raises one automatically. Recalibrate the same way:
dispatch the workflow three times, download the `perf-snapshot` artifacts,
take the median per metric.

Typing is gated on the p95 key event and on blocking per keystroke (large: 395
and 275 ms, 1.3x the medians 304 and 209; small: 84 ms, 1.5x the median 56,
because event durations come in 8 ms steps and 1.3x would sit one step above
the median, plus the 10 ms blocking floor). The single worst keystroke
(`inpApproxMs`) is still reported. Over 85 ms (small) or 500 ms (large) it adds
a `warning` annotation and a `[perf]` log line. It never fails the run: it
measures one GC pause, or two keystrokes queued into one frame, because at x4 a
near-limit keystroke costs ~200 ms while the harness types every 40 ms. On one
SHA it spread 80 to 128 ms (small) and 336 to 528 ms (large) across six runs.

The near-limit read-only open was rebaselined on 2026-10-04 to 4,050 ms (1.3x
the median 3,118 of six runs on 37fa7e53; it was 1,952 on 2026-09-03). The
read-only render itself did not change (click to text 65 to 90 ms). The time is
the workspace page's startup in the dev build, see the open item below.

Standard GitHub-hosted runners are a mixed CPU pool. Independent PassMark
samples of ubuntu-24.04 x64 (same Azure fleet, mid-2026) land around 2200 to 2670
single-thread. A relative fail against the best green would fire whenever the
candidate draws a slower host than the luckiest baseline. Treat the table as a
human-read delta, not a gate.

Other caveats that already apply to the absolute budgets:

- Dev-build inflation (unminified, React StrictMode). Deltas are not
  user-facing SLOs.
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
  back under 2,600 ms. Since 2026-09-03 the page went from 399 to 806 loaded
  modules (309 to 518 before the first API request), the i18n message bundle
  on that path from 6.2 to 10.6 MB, and the generated zod validators
  (`src/api/gen/validators.ts`, 2,911 to 5,449 lines) hold 12.8 MB of heap
  after open. Split the workspace route's static imports, load the generated
  validators and the active locale's paraglide messages lazily, and keep the
  mocks and the mock scenario panel out of the startup graph (`chaosPeers`
  pulls the whole note plugin kit into every MSW page). Then lower
  `readOnlyOpenMs` again.
