# Capy Office against Google Docs, Sheets and Slides (2026-11-21)

The perf track's Google gap (Epo 2026-10-15: match Google's RAM and FPS; measure
the gap first). One run on the Windows developer PC after Q691's two rounds:
Capy at `bcbac375b` with BetterOffice `b3b0e6bc8`, the `bench:office`
production build over its HTTPS mode (Q788 A); Google anonymous, on Epo's shared
Drive copies of the same fixtures. Raw sessions, scripts, profiles and the full
min-max tables are in the harness, `2026-11-21-google-gap/` (`gap-tables.md`,
`tables.md`, `summary.json`, `scripts/README.md`).

## Where Capy stands

- **DOCX: behind on opening, editing and memory, level on short-document typing and on scrolling.**
  - First content comes 3.5-4.3x later.
  - A key lands 2.2-4.1x later going straight to Edit.
  - Memory after idle is 2.2-4.3x Google's.
  - Typing is level up to 62 pages, then 10-11x slower at P50 on 248-496 pages.
- **XLSX: behind on opening, level or ahead on typing and scrolling.**
  - Opens are 1.6-2.1x later; 1.2-1.7x without the bench mock's API delay.
  - Capy sends half the bytes.
- **PPTX: behind on opening, ahead on typing.**
  - Opens are 1.5-3.3x later; 1.1-2.1x without the mock delay.
  - Typing is about 2x faster, and stepping through slides is level or faster.
- **Every format: warm reopens are the worst ratio.** They take 2.2-22x as long, because Capy parses and lays the file out again.

## Gap tables

Cells are Capy / Google (Capy÷Google), medians of three. Capy's ranges are within ±5%. Google's are within ±10% except a few rows (see the harness tables).

Terms:
- **Editable:** the first key the editor takes, from navigation.
- **Through View:** Edit is clicked the moment View is ready.
- **No mock delay:** a side run with the bench's API delay at 0 (see "What the bench inflates").
- **Painted page:** the bench's own DOCX `keyToFrame` (to the next `docx-pages-presented`).

### DOCX (exchange plan 14 pages, 62, 248, 496)

| Row | plan | 62 p | 248 p | 496 p |
|---|---|---|---|---|
| Open cold, first content, s (Capy View) | 5.3 / 1.5 (3.6x) | 7.0 / 1.6 (4.3x) | 11.6 / 2.7 (4.3x) | 18.5 / 5.2 (3.5x) |
| Capy straight to Edit, ready, s | 5.0 | 6.8 | 14.2 | 24.1 |
| Capy View, modelled link (7,500 KiB/s, 40 ms), s | 7.1 | 8.9 | 13.4 | 21.1 |
| Capy View, no mock delay, s | 4.2 (2.8x) | 6.2 (3.8x, 1 run) | - | - |
| Open warm, s (Capy reopens in Edit) | 4.2 / 0.90 (4.6x) | 6.5 / 0.92 (7.1x) | 13.8 / 1.02 (13.5x) | 24.4 / 1.12 (22x) |
| View to Edit, s (Capy only) | 2.2 | 4.1 | 11.2 | 21.5 |
| Editable through View, s | 7.1 / 2.3 (3.1x) | 11.0 / 2.6 (4.3x) | 23.9 / 3.8 (6.3x) | 42.4 / 7.8 (5.4x) |
| Editable straight to Edit, s | 5.2 (2.2x) | 7.3 (2.8x) | 15.5 (4.1x) | 26.9 (3.4x) |
| Memory after open, tab MB (Capy View, Capy Edit / Google) | 372, 513 / 266 | 528, 774 / 344 | 666, 1,578 / 501 | 891, 2,670 / 561 |
| Memory after 5 min idle, tab MB | 447 / 206 (2.2x) | 735 / 254 (2.9x) | 1,540 / 359 (4.3x) | 2,505 / 611 (4.1x) |
| of which JS heap + WASM, MB | 56+61 / 63 | 91+267 / 89 | 216+797 / 171 | 382+1,435 / 303 |
| After close, +10 s; after forced GC, MB | 392 / 218; 163 / 112 | 548 / 132; 169 / 126 | 1,141 / 138; 188 / 132 | 1,653 / 581; 210 / 139 |
| Scroll, changed frames/s; longest gap ms | 36 / 35; 73 / 62 | 38 / 38; 66 / 72 | 38 / 36; 61 / 90 | 39 / 31; 58 / 111 |
| Typing start, next frame P50/P90 ms | 17/24 vs 14/19 | 18/32 vs 15/20 | 209/440 vs 21/31 | 408/1,324 vs 37/48 |
| Typing start, from the key's timestamp, P50 | 17 / 15 | 19 / 15 | 369 / 21 | 1,219 / 38 |
| Typing start, Capy painted page P50 | 33 | 101 | 193 | 357 |
| Typing end, P50/P90 (painted page P50) | 17/24 vs 14/18 (36) | 20/52 vs 15/20 (77) | 153/368 vs 18/23 (117) | 382/1,329 vs 45/48 (323) |
| Downloads cold, MiB / requests | 8.1/386 vs 7.3/71 | 9.1/367 vs 7.2/69 | 12.4/367 vs 7.4/69 | 16.8/367 vs 7.4/69 |
| View to Edit adds, MiB | 4.4 | 4.4 | 4.4 | 4.4 |

### XLSX (course guide, large gradebook)

| Row | course guide | gradebook |
|---|---|---|
| Open cold, first content, s | 3.5 / 2.2 (1.6x) | 4.1 / 2.0 (2.1x) |
| Capy no mock delay, s | 2.6 (1.2x) | 3.3 (1.7x, 1 run) |
| Open warm, s | 4.0 / 1.28 (3.1x) | 6.0 / 1.35 (4.4x) |
| View to Edit, s | 1.1 | 2.9 |
| Editable through View; straight to Edit, s | 5.1 / 2.6 (2.0x); 4.4 (1.7x) | 7.3 / 2.0 (3.6x); 6.2 (3.1x) |
| Memory after open (Capy View, Edit / Google), MB | 306, 365 / 290 | 352, 521 / 341 |
| After idle, MB (Capy WASM part) | 301 / 231 (1.3x) (45) | 494 / 246 (2.0x) (216) |
| After close; forced GC, MB | 222 / 215; 121 / 121 | 221 / 230; 127 / 120 |
| Scroll, frames/s; longest gap ms | not comparable (Capy's sheet ends after about 1 s) | 40 / 37; 58 / 60 |
| Typing start P50/P90; end P50/P90, ms | 13/31 vs 17/33; 12/21 vs 17/30 | 13/28 vs 18/43; 15/31 vs 14/28 |
| Downloads cold, MiB / requests; View to Edit adds | 3.0/350 vs 8.1/74; 1.8 | 4.2/350 vs 8.6/77; 1.8 |

### PPTX (lecture 20 slides, 30 picture slides)

| Row | lecture | 30 pictures |
|---|---|---|
| Open cold, first content, s | 4.2 / 1.2 (3.3x) | 3.7 / 2.5 (1.5x) |
| Capy no mock delay, s | 2.7 (2.1x) | 2.7 (1.1x, 1 run) |
| Open warm, s | 3.3 / 0.65 (5.1x) | 4.1 / 1.9 (2.2x) |
| View to Edit, s | 0.94 | 1.6 |
| Editable through View; straight to Edit, s | 4.8 / 2.8 (1.7x); 3.9 (1.4x) | 5.4 / 2.7 (2.0x); 4.4 (1.6x) |
| Memory after open (Capy View, Edit / Google), MB | 350, 380 / 280 | 611, 672 / 307 |
| After idle, MB (Capy WASM part) | 301 / 225 (1.3x) (17) | 571 / 245 (2.3x) (197) |
| After close; forced GC, MB | 309 / 180; 131 / 122 | 586 / 168; 120 / 108 |
| Next slide, click to drawn P50/P90 ms | 24/30 vs 34/47 | 22/24 vs 24/28 |
| Typing start P50/P90; end P50/P90, ms | 9/11 vs 20/26; 8/9 vs 18/25 | 10/12 vs 18/26; 9/11 vs 19/26 |
| Downloads cold, MiB / requests; View to Edit adds | 4.0/356 vs 7.9/89; 1.6 | 26.7/354 vs 31.0/123; 25.3 (bench only, see below) |

**Largest downloads per open:**
- **Google:** its editor code; the largest is Docs' 2.6 MiB `kix_tertiary`. Sheets brings a 1.2 MiB calc WASM.
- **Capy DOCX View:**
  - the viewer WASM, 2.4 MiB;
  - the checkpoint, 0.3-8.8 MiB by file;
  - the CJK font slices, 0.9 MiB plus 0.25-0.74 MiB.
- **Capy View to Edit:** the edit WASM 3.1 MiB and the layout WASM 1.1 MiB for DOCX; 1.7 MiB for XLSX; 1.4 MiB for PPTX.

**Capy's two paths.** Going straight to Edit makes the first key land sooner than View then Edit, on every file:
- 1-2 s sooner on small files;
- 8-15 s sooner at 248-496 pages.

But a long document shows nothing for 3-6 s longer than View does. This answers Q610's measurement for Q608, a loading state against the saved file drawn read-only until the editor takes over:
- Drawing the file read-only first shows content sooner on every file.
- The first key lands at the straight-to-Edit time only if the editor loads alongside the viewer instead of after it.

## The largest gaps

1. **Long-DOCX typing, 10-32x.** The 496-page trace has the main thread busy 5.6 s of 6 s over 12 keys.
   - 64% of it (45% at 248 pages) is the toolbar's selection lookup: `currentYrsToolbarSelection` (`yrsToolbar.ts`), called from `handleYrsStateChange` in `PagedEditor.tsx`. It calls the engine's `selection_context` (`crates/docx-edit/src/read_state.rs`).
   - On every call that function builds the whole story's chunk snapshot (cached per edit, so every key misses) and the bounds of every paragraph, to read one or two paragraphs. That is about 940 ms per update at 496 pages and 260 ms at 248 (checked in the source at the pin).
   - It runs on selection changes too, so clicks and arrow keys pay it as well.
   - The edit itself in the worker is about 47 ms per key.
2. **Long-DOCX open and View to Edit, 3.5-6.3x.**
   - At 496 pages the viewer worker runs 13 s before `ready`: it lays out and serialises all 481 pages before showing one (3.5 s layout, 5.8 s building page data).
   - View to Edit (22 s) lays the document out again on the main thread (3.6 s) and a third time in the editor's worker (3.4 s). It then builds drawing data for every page (6.0 s) and encodes the state (1.6 s).
   - Google shows the first pages after 2-5 s.
   - Progressive DOCX View (C6, Q610 A) is the queued item for the first part.
3. **DOCX memory, 2.2-4.3x after idle.**
   - At 496 pages WASM holds 1.43 GB: 843 MB in the main thread's engines and 591 MB in the worker, the document and its layout held twice.
   - After close, 1.65 GB stays for at least 10 s until a collection (210 MB after a forced one).
4. **Small-file opens 1.5-3.6x and warm reopens 2.2-5.1x.**
   - About 1 s of each bench open is the mock API delay (below).
   - What remains on the small DOCX: app start to 0.9 s, the viewer WASM, the viewer worker from 2.5 to 4.4 s, and 33 font files (3.1 MiB) at about 4.1 s.
   - A warm reopen downloads about 1 KiB but parses and lays out from scratch; Google reopens in 0.65-1.9 s.
5. **Requests: 350-386 per cold open against 69-123.** 306 of them are app JS chunks (1.8 MiB). On the modelled link the request and byte counts add 2.1-4.3 s per open.

## What the bench inflates

These are bench conditions, not product behaviour, and they flatter Google:

- **Mock API delay.** `src/mocks/handlers.ts` holds every `/api/*` answer 1.0-1.2 s, and the open waits on one round of them. The no-mock-delay rows remove it.
- **No device copy of the file.** The source-byte cache (`src/lib/sourceCache.ts`, 2026-10-17) stores a file only when its bytes hash to the session's `baseSourceSHA256`. The mock names `mock-<id>-<revision>`, so nothing is cached in the bench. The run's refetches are bench-only:
  - the 30-picture deck's 23.4 MiB again on View to Edit and on a warm reopen;
  - the 496-page checkpoint twice when opening straight in Edit.

  Playwright's private contexts also keep at most about 6.25 MB per HTTP cache entry.
- **Collaboration is mocked.** Edit has no WebSocket round trip and no server load, which flatters Capy.

## Method

**Setup:**
- Headless Chromium 151 (Playwright 1.62.1), 1280x800, a raw DevTools connection on every page, frame and worker.
- Google never signed in. No cookie banner appeared, nor any CAPTCHA or sign-in wall, and anonymous editing was offered in compatibility mode.
- One file open at a time, at most five opens per file per hour.
- A Google lane and a Capy lane shared one gate, so active work never overlapped.
- CPU load and free memory were recorded before each session.
- Capy's tree-click opens match the round-2 baseline within 8%.

**Per metric:**
- **Open:** every compositor frame was recorded and the document area analysed. First content is the first frame holding at least 50% of the settled view's dark pixels. Cold is a fresh context; warm is the same tab after `about:blank`.
- **Editable:**
  - Google was probed from first content until a key landed (the caret moved, the cell editor or the slide text changed) within 300 ms.
  - Capy counted when its editor reported the change.
- **Memory:**
  - Operating-system private memory of the tab's renderer processes, frames matched to processes with per-frame marks.
  - JS heap per context after a forced collection, and WASM as the sum of WebAssembly memories.
  - The GPU process separately: 29-37 MB with no real GPU.
- **Scroll:** 120 wheel events of 100 px every 25 ms, measured as changed frames per second in the document area and the longest gap. For PPTX, 19 slide steps at 250 ms.
- **Typing:**
  - 40 keys at 120 ms at the start and 40 at the end; every sixth key is a space (XLSX: Enter).
  - Each key is timed to the first task after the next animation frame. For XLSX and PPTX that is exactly `runtime.office.ts` `timeKeys`. For DOCX the bench's painted-page figure is reported beside it.
  - Times from the key's own timestamp are also given; they include queueing.
- **Downloads:** bytes on the wire per request across every target, cache and service-worker answers counted as 0. They agree with Capy's server logs (8,309 vs 8,247 KiB).

**What the numbers can't remove:**
- **Network:** Google's real connection: 54 ms connect, 57-63 ms first byte from its static hosts and 207-236 ms from docs.google.com, mostly HTTP/3. Capy's is localhost or the modelled link.
- **Rendering model:** Google's server sends the document model and renders progressively; Capy parses the file or checkpoint in WASM in the browser.
- **Fonts:** Google draws CJK with the OS's fonts; Capy ships its own faces.
- **Page counts:** Google 14/59/231/461 against Capy's 15/61/241/481.
- **Sheet size:** Google sizes an imported sheet to its used rows.

**Twins** (Drive file → local fixture):
- exchange plan, course guide and lecture → the e2e fixtures;
- 62-page DOCX → `long-handbook`; gradebook → `large-gradebook`;
- 248/496-page DOCX and the 30-picture deck → the perf fixtures, through bench-only override slots.

The DOCX and lecture copies on Drive were Google re-saves (smaller files, same content).

## Not measured

- Google's version history (it needs sign-in); undo was verified by content instead.
- Capy against a real backend and network.
- Google on a throttled link.
- Where Google spends its time (no source maps).
- The no-mock-delay run for 248/496 pages.

Running these measurements has side effects: Google re-saves an Office file after any anonymous edit, even an undone one. This run re-saved 14 files in the Drive folder on 2026-11-21, with the same content and new bytes. A rerun should edit copies or measure view only.
