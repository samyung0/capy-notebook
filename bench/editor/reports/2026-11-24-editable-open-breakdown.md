# Opening the near-limit note for editing, phase by phase: 2026-11-24

Why `open-large-document` reports the interactive open at about 4× the read-only
one on a production build (CI on `5b054df3a`, AMD EPYC 7763: 8,491 and 9,119 ms
against 2,137 and 2,279 ms; blocking 3,025 and 3,122 ms against 364 and 429 ms).

## Short answer

- **The 4× is mostly the measurement.** The read-only case stops about 10 ms
  after its click: `getByRole('main').getByText(readyText)` matches the note's
  title in the left panel (`data-testid="left"`, a `SPAN`), which is on screen
  while the gate still shows. The document itself paints about 2.4 s later at CI
  speed and is never waited for. The interactive case ends with about 1.0 to
  1.4 s of tail after the editor is live and painted: Playwright runs
  `getByText` over the 26,470-element editable at about 0.33 s a poll, with
  backoff between polls.
- **Measured fairly, editing costs about 1.3× read-only.** At CI speed the
  editable is painted at about 6.7 to 7.2 s. The read-only document is painted
  at about 5.3 s. The interactive path paints its first 100 blocks at 3.6 to
  3.8 s, sooner than read-only paints anything.
- **The 2.2 s `setTimeout` task** is `NoteEditorCore.tsx:2206` (the
  `initializeTimer` callback that calls Plate's `yjs.init`). About 75% of it is
  React's first render of all 3,652 blocks, on the sync lane, in one task.
  Yjs takes about 3%: the update apply and the Yjs→Slate conversion. GC takes
  8 to 13%. The bind's normalize takes 9%, most of that a 2 MB `JSON.stringify`
  built for an exception message nobody reads. The mock room doing the
  service's work takes 4%.

## Method

- **Build.** `5b054df3a`'s tree came out through `git archive` into a scratch
  directory, outside the worktree, with the worktree's `node_modules` (the
  lockfile is the same) and its `vendor/betteroffice` (the same pin) linked
  in. `vendor/blocksuite` and the generated late-merge WASM were linked or
  copied from the worktree. They are board-only and not on this path. The
  build used the bench's own config: `vite build --config
  bench/editor/scripts/vite.cap.config.ts`, production mode,
  `VITE_BENCH_MSW=true`, `VITE_LOAD_TEST_SEED=true`, an empty `CAPY_ENV_DIR`,
  minified. A wrapper config added only `build.sourcemap: 'hidden'` and
  `cacheDir: '.vite-room-memory'`. The build was served by `vite preview`.
  No BetterOffice artifact was stubbed.
- **Chunk check.** In this build, LoAF names the worst task as
  `TimerHandler:setTimeout` in `NoteEditor-D1tYMPH5.js` at
  `sourceCharPosition` **121849**, the same position as CI, so the chunk
  matches CI's at that point. Through the source map, character 121849 maps to
  `src/features/notes/NoteEditorCore.tsx:2206:39`, `const initializeTimer =
  setTimeout(() => {`, the callback running `editor.getApi(YjsPlugin).yjs.init({
  autoConnect: true, id: collaborationToken.room, value: null })`.
- **Driving the opens.** A probe drove the page the way `editor.perf.ts` does:
  a fresh context per choice, the small note first, then the large note with
  `&mode=edit|view`, the gate, the bench's own waits, and 1.5 s of settle. It
  also recorded:
  - landmarks: per-frame `requestAnimationFrame` checks for the gate, the
    static paint's `h1`, and an editable `h1`; the save-state attribute
    through an attribute-only MutationObserver; the mock room's creation
    through `window.__capyMockRooms`.
  - timings: LoAF, longtask and resource timing (buffer raised to 10k), plus
    a `fetch` wrapper.
  - traces: a Chrome trace (`devtools.timeline`, `v8.execute`,
    `disabled-by-default-v8.cpu_profiler`, `loading`) on the first run.
- **Analysis.** CPU samples were symbolicated through the hidden maps.
  Phases were split by landmarks into idle, script, GC and native time, with
  trace style, layout and paint events. The init task was split by what is on
  each sample's stack.
- **Load.** The Mac (M1, 8 GB) was loaded by other sessions (load average
  2 to 4). An unthrottled run reads about 1.7× faster than CI. With CDP CPU
  throttling at **2.2×** (applied from the warm-up on), the bench's own
  numbers come out at 8.1 s / 2.8 to 2.95 s blocking (interactive) and
  2.4 s / 0.41 to 0.45 s (read-only), matching CI. The tables below use 2.2×
  as "CI-equivalent". Tracing adds about 10%.

## Raw runs

Untraced. Times are in ms from navigation. `doc` is the rAF of the first frame
showing the static `h1` in read-only, or the editable `h1` in interactive; that
frame's own style and layout come after it.

| Run | CPU | Choice | gate frame | click | static paint | room join | saved (live) | doc | bench `openMs` | blocking |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 1× | interactive | 1612 | 2030 | 3440 | 3785 | 4766 | 4769 | 5402 | 1265 |
| 2 | 1× | interactive | 1706 | 2033 | 3293 | 3658 | 4607 | 4609 | 5139 | 1254 |
| 3 | 1× | interactive | 1575 | 2016 | 3290 | 3694 | 4655 | 4657 | 5276 | 1279 |
| 1 | 1× | read-only | 1702 | 2009 | – | – | – | 3901 | 2166 | 123 |
| 2 | 1× | read-only | 1607 | 2012 | – | – | – | 3752 | 2049 | 121 |
| 3 | 1× | read-only | 1708 | 2012 | – | – | – | 3891 | 2106 | 122 |
| 1 | 2.2× | interactive | 2095 | 2272 | 3641 | 4282 | 6092 | 6097 | 8107 | 2762 |
| 2 | 2.2× | interactive | 2058 | 2356 | 3837 | 4515 | 6617 | 6626 | 8123 | 2950 |
| 1 | 2.2× | read-only | 2174 | 2297 | – | – | – | 4771 | 2435 | 408 |
| 2 | 2.2× | read-only | 1976 | 2267 | – | – | – | 4782 | 2390 | 447 |

Bench read-only "visible" came 7 to 57 ms after its click in every run.

`open-paint.mjs` on this build at 1× (median of 3, from the click):

| Open | paint | editable | token → editable | blocking |
|---|---:|---:|---:|---:|
| first open | 1,375 ms | 3,009 ms | 1,756 ms | 989 ms |
| reopen from the device copy | 840 ms | 2,881 ms | 1,744 ms | 962 ms |

On the first open the paint comes 1.6 s before the editable. That gap is the
interactive-only part.

Document shape (its read):

| Measure | Value |
|---|---:|
| top-level blocks | 3,652 |
| Slate nodes | 7,402 |
| text leaves | 3,707 |
| JSON | 2,018,726 chars |
| editable DOM | 26,470 elements |
| static read-only DOM (`main`) | 16,448 elements |

## The interactive open, navigation to editable (CI-equivalent, 2.2× untraced run 1)

The CPU split comes from the traced 2.2× run.

| Phase | ms | Thread / kind | What it is | Path |
|---|---:|---|---|---|
| Navigation → gate painted | 2,095 | Main: about 0.9 s script, 0.26 s native, about 1.0 s idle (network wait) | Cached chunk graph (305 requests). Module evaluation, including MSW and the mock DB's load-test seed (0.45 s long task: zod, `validateQuestion`, `createMaterialDocument`; mock-only). MSW worker start. 8 boot API calls in parallel from about 0.7 s, each 1.03 to 1.23 s of MSW wait. The materials list decides the gate. | Shared |
| Gate → click | 177 | Playwright | Locator polling and the click | Bench, shared |
| Click → static paint (first 100 blocks) | 1,369 | Main mostly idle (0.9 s): network wait | `GET /api/materials/:id` (1.19 s) in parallel with `GET …/collaboration-token` (1.19 s) and `POST /api/materials/readable`. Paint render 0.1 to 0.2 s (`MaterialPreview` chunk) | Read shared. Token interactive-only but parallel: 0 ms on the path |
| Paint → room join | 641 | Main busy: script about 0.63 s, layout/paint 0.2 s | Editor chunks requested about 90 ms after the read answers: `plugins` 551 K, `index` 341 K, `NoteEditor` 135 K, `mathlive` 807 K, all from cache in under 20 ms, then evaluated. Drafts and copy reads, `NoteEditorCore` mount, embeds in the paint (MathLive, Mermaid). MSW request matching on the main thread (`msw`, `cookie`, `tough-cookie`, `path-to-regexp`, `URL`): about 0.3 s, mock-only. `discussions` asked here, not waited for. | Interactive-only |
| Init task | 1,810 (2,102 run 2; 2,302 traced) | Main script, 0 idle | Join, sync, bind, first editable render; split below | Interactive-only |
| First editable frame | about 600 | Main native: style 105, layout 383, pre-paint 52 ms | Style and layout of 26,470 elements. It lands in a `pointerout` dispatch from the probe's earlier click | Interactive-only |
| Painted → bench sees text, then live | about 1,400 | Main: Playwright `normalizeWhiteSpace`, `elementText`, `query` (0.26 to 0.33 s a poll), two React re-renders of 90 ms each, idle | Context changes when `discussions` and the embedded quiz/set reads answer: `propagateContextChanges` walks the 7.4k-node fiber tree. Then polling backoff | Bench artifact, plus 0.18 s interactive-only |
| **Bench `openMs`** | **8,107** | | | |

The read-only open at the same speed:

| Read-only phase | ms |
|---|---:|
| Navigation → gate painted | 2,174 |
| Click | 2,297 |
| Bench "visible" | 2,434 (`openMs` 2,435) |
| `GET /api/materials/:id` | 2,349 → 3,534 |
| Full static render of 3,652 blocks; `h1` frame | 4,771 |
| That frame's layout (about 0.5 s, traced) | ends about 5,300 |

The full static render is one task of 1.65 s when traced:

| Part of the static render | ms |
|---|---:|
| `NoteHeading` `autosize` forcing layout (reads `scrollHeight`) | 585 |
| lodash merge | 200 |
| Plate `mergePlugins` | 93 |
| Plate static render | the rest |

Only about 0.4 s of that lands inside the bench's blocking window.

Other threads: compositor and viz threads stay under 100 ms per phase. The MSW
service worker (`mockServiceWorker.js`, `bench-msw.js`) and the
`draftStore.worker` together take under 30 ms. No `.wasm` is requested on
either open. The late-merge worker is not loaded.

Idle gaps: navigation to gate is 46% idle (MSW), click to paint 61% idle
(MSW). There is no idle time from the paint until the editable frame ends.

## The init task (`NoteEditorCore.tsx:2206`), split by stack

| Step | 1× traced (1,008 ms) | 2.2× traced (2,302 ms) | Where it runs |
|---|---:|---:|---|
| React render of the editable (sync lane, `processRootScheduleInMicrotask` → `performSyncWorkOnRoot`) | 489 (48.5%) | 1,187 (51.6%) | Main |
| React commit, layout and passive effects (incl. MathLive `connectedCallback`) | 215 (21%) | 518 (22.5%) | Main |
| GC | 131 (13%) | 195 (8.5%) | Main |
| Bind normalize: `Node.get` error message (`Scrubber.stringify` of the editor, Yjs root included) | 72 (7.2%) | 158 (6.9%) | Main |
| Bind normalize, the repair itself | 19 | 43 | Main |
| `Y.applyUpdate` of the room state into the tab's doc | 25 | 61 | Main |
| Yjs→Slate (`YjsEditor.connect` → `yTextToSlateElement`) | 7 | 15 | Main |
| Mock room: seed from the Slate value | 25 | 56 | Main; the service's work in production |
| Mock room: `encodeStateAsUpdate` / vector | 10 | 26 | Main; the service's work in production |
| Mock room: unlisted-type scan | 2 | 6 | Main; the service's work in production |
| Other (Plate init, native) | about 13 | about 37 | Main |

LoAF puts this task's frame at 1,213 ms at 1×: 1,008 ms of script plus 205 ms
of rendering. That matches CI's 1.6 to 2.3 s of script and 1.9 to 2.6 s of
blocking.

**The React render.** Inclusive at 1×, out of 489 ms:

| Part | ms | Notes |
|---|---:|---|
| Plate's inject-node-props pipeline: `getRenderNodeProps` → `pipeInjectNodeProps` → `pluginInjectNodeProps` | 173 (35%) | Every plugin with `inject.nodeProps` runs for every element and leaf. `getInjectMatch` and object spreads for each |
| Store hooks per element (`useEditorRef` / `usePlateStore`) | 123 | |
| Selector hooks (`usePluginOption`, jotai-x / zustand selectors) | about 100 | |
| slate-react `Element` / `Text` | about 90 | |
| Our own `transformProps` | about 85 | `trailingHint` 26, block selection 25, `navigationFeedback` 18, `GhostText` 18 |

**The stringify.** Slate's own normalizer inserts an empty leaf; `writesNothing`
lets that op through. `@platejs/list`'s `apply` then looks up
`PathApi.next(affectedPath)`, which does not exist, so slate's `Node.get`
throws. Its message is built with `Scrubber.stringify(root)`, which is
`JSON.stringify` with a replacer over the whole editor, including
`sharedRoot.toJSON()`. Plate swallows the error. Any edit whose affected node
is the last child pays the same on this document. That may feed the
near-limit typing cost, but it was not checked.

## Where the Yjs steps run, and what moving them would save

All of it is JavaScript on the main thread:

| Step | Production | The bench |
|---|---|---|
| Receiving the sync | `ws.onmessage` (`socket.ts`) → `RoomProvider` → `Y.applyUpdate` (`roomProvider.ts:1043`) | The in-page mock room, synchronously inside `provider.connect()` in the init task |
| Conversion, normalize, React, DOM | Main thread | Main thread |

The only WASM in the app is the late-merge worker (`lateMerge/`, not on this
open path) and the Office engines. That confirms the premise.

What the Slate value costs to hand across threads, measured in the page on
this document:

| Operation | 1× | 2.2× |
|---|---:|---:|
| `postMessage` serialize | 1.3 ms | 2.8 ms |
| Deserialize on the receiving side (first `event.data` read) | 4.2 ms | 6.1 ms |
| `structuredClone` | 3.2 ms | 6.9 ms |
| `JSON.parse` | 2.3 ms | 5.4 ms |

It is cheap: few objects (7.4k nodes) holding long strings.

What each move would save at CI speed:

| Option | Saving | Notes |
|---|---:|---|
| Decode and apply in a worker | 0 as things stand | slate-yjs needs a main-thread `Y.Doc` (it observes the shared types and writes local ops into them), so the update would still be applied on main. It pays only if the binding moves: the doc lives in a worker and main holds a Slate value kept by ops. Ceiling at open: 61 + 15 ms, minus about 6 ms to hand the value back, so about 70 ms (3% of the task). The rewrite would cover slate-yjs, Undo, carets and relative positions, drafts and the device copy. |
| Conversion in a worker | about 9 ms | 15 ms of conversion against 6 ms to deserialize the result |
| WASM decoder (yrs, `collaboration-rs/crates/ydoc`) | at most about 50 ms | Replaces at most the 61 ms apply. Something still has to build JS `Y` types for slate-yjs, or the binding gets rewritten on yrs, and the module has to load and instantiate. Not worth it for the open. |
| Render incrementally (cut 1 below) | 2.0 to 2.4 s | The only option that changes the picture |

The mock room's 88 ms is the service's work. A real deployment instead pays to
receive a 2 MB socket message and decode it on main: roughly the apply cost
above.

## Cuts, by time removed (CI-equivalent)

1. **Render the editable incrementally.** Make the first screenful (the
   paint's 100 blocks, at `paintedPosition`) editable, and render the rest in
   idle slices or as chunks near the viewport. This goes through slate-react's
   chunking (`renderChunk` with measured placeholders), since React cannot
   slice a sync-lane update.
   - **Saving:** the render (1.19 s), commit and effects (0.52 s), most of
     the GC (about 0.15 s) and the first frame's style and layout (0.6 s),
     against about 0.07 s for 100 blocks (about 0.65 ms per block at 2.2×).
     That is **−2.0 to −2.4 s to editable** and the 2 s long task gone.
   - **Risk:** high. slate-react maps points through rendered DOM, so the
     selection, select-all and copy, find-in-page, TOC and citation jumps,
     remote carets, comment anchors and drag handles all need nodes that are
     not rendered yet. Needs the editor e2e suite and the bench.
   - **Lower-risk partial:** move the bind's render off the sync lane. Plate's
     selector stores use `useSyncExternalStore`, so this needs a change there.
     It removes the long task but not the time.
2. **Cut the per-node render pipeline.** The inject-node-props pipeline is 35%
   of render, and per-element store and selector hooks another large share.
   - **Fix:** limit injecting plugins with `targetPlugins` or `isBlock` so
     leaves skip them, fold our four `transformProps` into one, and drop
     per-element store subscriptions where a prop would do.
   - **Saving:** about −0.4 to −0.6 s, about a third of render plus its GC.
     It also helps the read-only static render.
   - **Risk:** medium-low. These are our plugins and Plate options, but each
     visual behaviour needs checking.
3. **Stop the 2 MB exception message.** Patch slate's `Node.get`, or the
   `@platejs/list` `apply`, to check the path before getting the node
   (`NodeApi.has` / `getIf`).
   - **Saving:** −0.16 s (−72 ms at 1×). Possibly the same per edit at the
     note's end.
   - **Risk:** low, a `pnpm` patch.

**Measurement fixes** move the reported ratio more than any product cut:
- Read-only should wait for the document, for example the static `h1` inside
  the note column, not anywhere in `main`. Its number becomes about 5 s at CI
  speed.
- Interactive should wait for live first, then check a cheap editable
  locator: the `h1` element, not `getByText` across 26k elements. That takes
  about −1.0 to −1.4 s.
- Budgets would need rebaselining.

**Mock-only costs** in the interactive number:

| Cost | 2.2× |
|---|---:|
| Mock room's service work | 0.09 s |
| MSW request matching on the main thread before the join | about 0.3 s |
| Mock DB seed evaluation at boot (shared) | 0.45 s |

MSW's two sequential 1.0 to 1.22 s waits before the editor (the boot calls,
then the read and token) are the same count the read-only document needs.

The read-only static render, outside the bench's window: `NoteHeading`'s
`autosize` forces a full-document layout (585 ms at 2.2×) once the static
document is in the DOM.

## After the cheap cuts (same day, `claude/plate-open`)

Epo: "do the cheap one first". Cuts 2 and 3 and the measurement fixes landed;
cut 1 (incremental rendering) did not.

**Changes.**

- **The bench's opens** (`editor.perf.ts`, `waitForNote`): both end once the
  frame first showing the note's first block is rendered, checked every
  animation frame in the page. Read-only looks in the static document
  (`material-preview`); interactive waits for live, then looks in Plate's
  editable (`[data-slate-editor="true"][contenteditable="true"]`). A finding
  on the way: MathLive's fields are contenteditable. The old interactive wait
  took the page's first contenteditable, which was a field in the paint. The
  paint is hidden once the editor shows, but its DOM leaves only when the page
  is idle, about 0.8 s later at 2.2×, so the old number waited for that too.
  For the same reason, the read-only "never mounts an editable surface" check
  only held because it ran before MathLive upgraded the document's fields. It
  now checks for Plate's editable.
- **The 2 MB exception message** (`@platejs/slate` patch): `NodeApi.get`
  uses `Node.getIf`, and `editor.api.node` checks `Node.has` before a path
  lookup. A missing path is now `undefined` without slate's throw. The
  stringify is gone from the bind, and from Enter, typing, Backspace, arrows,
  marks, block changes and removal at a block's or the note's end
  (`missingPaths.test.ts`).
- **The node-prop pipeline:**
  - The `@platejs/core` patch skips, before any per-node work, a plugin
    limited to the other kind of node (`isLeaf`, `isElement`, `isBlock`).
  - The list plugin is elements only, in the editor and the static kit.
  - The mark styles check a value only after Plate has found the mark
    (`styleMarkNodeProps`).
  - Our per-block hooks read through the editor and element they are handed,
    not Plate's per-element stores (`useEditorRef`, `useElement`,
    `usePluginOption`, `useBlockSelected`). That covers block selection's
    `slate-selectable` and context menu (`useSelectableProps`), the selection
    overlay, navigation feedback and the ghost text, which is now
    CopilotPlugin's `belowNodes` with props.
  - The trailing hint is folded into the block placeholder's node props: one
    pipeline pass instead of two. Merge order is kept: the hint's classes,
    then the placeholder's, and the placeholder's text over the hint's.
- **The title** (`NoteHeading.tsx`): `field-sizing: content` where the
  browser has it. The JS autosize, and its read of `scrollHeight`, stays only
  as the fallback.

**Same DOM.** The near-limit note's editable (30,431 lines of serialized
elements, sorted attributes and text) and its read-only document (19,187
lines) serialize identically before and after, block ids aside (random per
seed). `blockProps.test.tsx` covers what the snapshot cannot show: the
trailing hint, the focused placeholder over it, the selection overlay and the
ghost text. The title box is 0.4 to 1 px shorter: it is now exactly its
text's height, where `scrollHeight` was rounded up and came out 1 px over at
whole pixels (54 against 55 px on one line at desktop width, 39.6 against 40
at 360 px, 150 against 151 on three lines). The text does not move.

**Method.** Two production bench builds, as above: `before` from the
branch's base (0c808ed6e) and `after` from the branch, each served by
`vite preview`. A probe drove both, alternating build per round, at 2.2×,
with the bench's new wait (and, in other rounds, its old one) and the same
landmarks as above. Load average was 1.4 to 7 (other sessions). The figures
are medians of six rounds per build (new wait) and four (old wait), in ms,
from the click on the gate unless noted.

| Measure (2.2×, Mac) | Before | After | Change |
|---|---:|---:|---:|
| Interactive `openMs`, fixed (navigation → editable's first frame rendered) | 6,587 | 5,921 | −666 |
| … from the click | 4,299 | 3,597 | −702 |
| Init `setTimeout` task (`NoteEditorCore.tsx:2206`) | 1,802 | 1,073 | −729 |
| … its long frame | 2,226 | 1,481 | −745 |
| First editable frame (its rAF) | 3,807 | 3,107 | −700 |
| … rendered | 4,298 | 3,595 | −703 |
| Interactive blocking (LoAF, whole run) | 2,660 | 1,899 | −761 |
| Read-only `openMs`, fixed (navigation → document's first frame rendered) | 4,599 | 4,238 | −361 |
| Read-only document painted (first frame rendered) | 2,442 | 2,082 | −360 |
| Read-only render frame (LoAF) | 1,150 | 828 | −322 |
| … forced layout in it | 359 | 65 | −294 |
| Interactive `openMs`, old wait | 8,867 | 8,022 | −845 |
| Read-only `openMs`, old wait | 2,450 | 2,432 | (title in the left panel) |

On the old wait, the fix moves the near-limit opens by −2.3 s (interactive)
and +2.1 s (read-only). Read-only stays cheaper than interactive on the fixed
measure (4,238 against 5,921), so the bench keeps that assertion.

**Where the init task's time went** (one traced run per build at 2.2×; the
task took 2,065 and 1,236 ms there):

| Part | Before | After | Change | From |
|---|---:|---:|---:|---|
| Bind normalize's `Node.get` message (`Scrubber.stringify`) | 143 | 0 | −143 | `@platejs/slate` patch |
| Node-prop pipeline's own work (`pipeInjectNodeProps`, `pluginInjectNodeProps`, self) | 187 | 58 | −129 | `@platejs/core` patch, list `isElement`, mark checks |
| The rest of React's render (per-block store and selector hooks; `usePluginOption` alone was 112 inclusive) | 878 | 575 | −303 | per-block hooks through props, trailing hint fold |
| … of which the selection overlay | 58 | 10 | −48 | `BlockSelection.tsx` |
| … of which the ghost text | 45 | 7 | −38 | `belowNodes` with props |
| React passive effects (store subscriptions) | 239 | 114 | −125 | the same hooks |
| GC | 186 | 74 | −112 | all of the above (fewer allocations) |
| Commit, Yjs, mock room, other | 432 | 415 | −17 | unchanged |

The read-only render frame lost 32 ms of script (the static kit's list and
mark changes, and the core patch) and 294 ms of forced layout (the title).
Its own rendering took about 50 ms more, because the layout it no longer
forces now happens there.

**`pnpm bench:editor`, once, on the Mac** (`PERF_BASE_URL` at the after
build; opens unthrottled, the rest at CPU x4; budgets in brackets):

| Case | Figure |
|---|---:|
| Interactive open | 4,555 ms (11,900) |
| Read-only open | **3,719 ms (3,000): fails** |
| Small typing p95 / blocking per keystroke | 16 ms (50) / 0 (10) |
| Near-limit typing p95 / blocking per keystroke | 48 ms (95) / 0 (5) |
| Save cycle blocking | 26 ms (150) |
| Scroll average FPS / longest frame | 51.6 (40) / 66 ms (130) |

The read-only miss is the fixed measure against the old measure's budget, as
expected. It waits on recalibration. Read-only is still the cheaper open
(3,719 against 4,555 ms), though that assertion, after the budget's, did not
run.

**Also seen, not changed:** after the read-only document is in, web font
loads (JetBrains Mono, the KaTeX fonts MathLive asks for) and a MathLive timer
each relayout the whole document (about 130 ms each at 1×). They come after
the first paint, so the fixed measure does not count them.
