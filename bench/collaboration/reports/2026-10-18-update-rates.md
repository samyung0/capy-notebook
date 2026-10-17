# Updates one connection sends while a person edits, 2026-10-18

Input for the collaboration server's per-connection rate limit (decision
2026-10-18 in `human/frontend/plate-editor.md`: a burst allowance plus a
sustained rate, in count and bytes, far above human typing and pasting,
measured before landing). The numbers below are what the editors send; the
limit itself is in [plate-editor.md](../../../openwiki/frontend/plate-editor.md#connection-lifetime-and-refusals).

## Short version

- **Typing sends one update per key** in notes and PPTX, up to the key rate:
  68 a second with a key held at macOS's fastest repeat (15 ms), 105 a second
  at most when keys come as fast as the page takes them. DOCX coalesces keys
  (at most 11 a second); XLSX sends one update per committed cell.
- **A paste, a photo or a large clear is one update** in notes, XLSX and
  PPTX: up to 1.46 MB (a 1.5 MB note paste), 0.99 MB (8,000 XLSX cells),
  1.13 MB (a photo under the Free image cap; Pro's 5 MiB cap makes it up to
  about 5 MB).
- **A DOCX paste is a burst of two updates per pasted paragraph** (2n − 1 for 100, 400 and 2,500 paragraphs): 3,993
  updates and 2.6 MB in 0.5 s for 1 MB of text in 2,000 paragraphs, 4,999
  updates and 2.0 MB in 0.7 s for 2,500 short lines (31 KB of text). The
  plan's starting values (a burst of 300 updates, then 60 a second) close the
  socket on any DOCX paste of about 150 paragraphs or more.
- **A reconnect replays a session as one update**: a note session of 600 keys
  and a 500 KB paste (602 updates, 503 KB) merges to one 497 KB step 2. The
  draft sweep sends over HTTP (`POST /drafts`), not the socket.
- **Awareness:** a note editor sends at most 20 cursor updates a second
  (the 50 ms throttle), about 310 bytes each.

## Setup

- **Machine:** the Windows PC (Ryzen 7 3700X), headless Chromium, unthrottled.
- **Code:** `editor/collab-ratelimit` on main ec6aa4072; the Office runtime
  from the main checkout's BetterOffice (8b50ac30; the pin is 79138d8d, no
  editing change between them that sends updates differently).
- **Harness:** `bench/collaboration/scripts/update-rates.rates.ts`
  (`pnpm bench:rates`): the Vite dev server with MSW and the perf seed, the
  real note, DOCX, XLSX and PPTX editors. Every update a mock room
  participant's document emits that did not come from its room is one the
  room provider sends as one SYNC message, so the counter on the mock rooms
  sees exactly what the socket would carry. Keys are pressed on the clock
  (a press is a round trip of about 10 ms, so 66 a second holds). Raw
  summaries: `bench/collaboration/.results/rates.jsonl` (gitignored).
- **Windows:** "max 1 s" is the most updates (or bytes) in any 1 s, sliding;
  "p99 1 s" the 99th percentile of the scenario's consecutive 1 s windows;
  "max 100 ms" the most in any 100 ms; "largest" the largest single update.

## Results

| Scenario | Updates | Max 1 s | p99 1 s | Max 100 ms | Bytes max 1 s | Largest |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Note, typing 15 keys/s | 300 | 16 | 16 | 2 | 400 B | 25 B |
| Note, key held 33/s | 300 | 34 | 34 | 4 | 850 B | 25 B |
| Note, key held 66/s | 300 | 68 | 67 | 8 | 1.7 KB | 25 B |
| Note, Backspace held 66/s | 300 | 68 | 67 | 8 | 748 B | 11 B |
| Note, Enter held 66/s | 100 | 56 | 56 | 7 | 7.3 KB | 130 B |
| Note, keys as fast as the page takes (two runs) | 300 | 105 | 101 | 13 | 2.1 KB | 27 B |
| Note, undo held 66/s (typing grouped) | 7 | 7 | 7 | 5 | 731 B | 347 B |
| Note, redo held 66/s | 7 | 7 | 7 | 5 | 9.9 KB | 8.5 KB |
| Note, paste 300 KB of HTML | 1 | 1 | 1 | 1 | 348 KB | 348 KB |
| Note, paste 1.5 MB of text | 1 | 1 | 1 | 1 | 1.46 MB | 1.46 MB |
| Near-limit note (2 MB), select all, Delete | 1 | 1 | 1 | 1 | 104 B | 104 B |
| DOCX, typing 15 keys/s | 74 | 10 | 9 | 2 | 218 B | 25 B |
| DOCX, key held 66/s | 17 | 8 | 7 | 2 | 251 B | 44 B |
| DOCX, Backspace held 66/s | 34 | 11 | 10 | 2 | 121 B | 11 B |
| DOCX, undo held 66/s | 28 | 9 | 9 | 2 | 99 B | 11 B |
| DOCX, paste one 2 KB paragraph | 1 | 1 | 1 | 1 | 2.0 KB | 2.0 KB |
| DOCX, paste 50 KB in 100 paragraphs | 199 | 199 | 199 | 199 | 128 KB | 774 B |
| DOCX, paste 200 KB in 400 paragraphs | 799 | 799 | 799 | 590 | 515 KB | 775 B |
| DOCX, paste 1 MB in 2,000 paragraphs | 3,993 | 3,993 | 3,993 | 880 | 2.58 MB | 776 B |
| DOCX, paste 31 KB in 2,500 short lines | 4,999 | 4,999 | 4,999 | 939 | 2.03 MB | 776 B |
| DOCX, insert a photo (Free cap) | 1 | 1 | 1 | 1 | 1.13 MB | 1.13 MB |
| XLSX, a number and Enter, 15 keys/s | 50 | 7 | 7 | 2 | 909 B | 131 B |
| XLSX, paste 8,000 cells (23 KB of text) | 1 | 1 | 1 | 1 | 993 KB | 993 KB |
| XLSX, Delete those 8,000 cells | 1 | 1 | 1 | 1 | 10 B | 10 B |
| PPTX, typing 15 keys/s | 150 | 19 | 16 | 5 | 679 B | 274 B |
| PPTX, key held 66/s | 150 | 63 | 56 | 10 | 1.8 KB | 29 B |
| PPTX, Backspace held 66/s | 150 | 75 | 69 | 12 | 825 B | 11 B |
| PPTX, undo held 66/s | 100 | 73 | 51 | 11 | 2.0 KB | 27 B |
| PPTX, insert a photo (Free cap) | 1 | 1 | 1 | 1 | 850 KB | 850 KB |
| Note session of 600 keys and a 500 KB paste, replayed | 1 | 1 | 1 | 1 | 497 KB | 497 KB |
| Note editor awareness while typing | – | 20 | 19 | 3 | 6.4 KB | 321 B |

Not measured: the PPTX text paste (the clipboard paste into a slide's text
sent no update in this harness), drags (DOCX and PPTX commit a move or a
resize as one update on release, read from the code), and an item editor's
typing (one update per key into a Y.Text, as notes).

## What it means for the limit

- **Count.** Keys never pass 105 a second, and at a person's fastest key
  repeat 68. The only bursts are DOCX pastes, two updates per paragraph
  arriving at 7,000 to 8,000 a second; a 100-page document is about 3,000 to
  5,000 paragraphs.
- **Bytes.** Typing is a few KB a second. The largest bursts are a DOCX
  paste (2.6 MB in 0.5 s) and single updates up to about 1.5 MB measured,
  5 MB for a Pro photo, the 4 MiB note sync cap and the source state cap
  for anything larger. A reconnect's step 2 is bounded by the offline caps
  (2 MiB of unsaved note edits).
- **Failure mode.** A connection over the limit is closed and its editor
  resyncs once (its step 2 then carries everything in one update), so an
  extreme paste beyond the burst costs one reconnect, not edits.
