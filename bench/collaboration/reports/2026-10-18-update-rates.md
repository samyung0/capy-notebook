# Updates one user sends while editing, 2026-10-18

Input for the collaboration server's update allowance (decisions 2026-10-18
in `human/frontend/plate-editor.md`: a burst plus a sustained rate, in count
and bytes, far above human typing and pasting, belonging to the user across
their sockets, reconnects and draft sends; no update over 8 MiB; every
client sends in pieces of at most 2 MiB). The numbers below are what the
editors emit, before the tab's socket cuts and paces them; the limits are in
[plate-editor.md](../../../openwiki/frontend/plate-editor.md#connection-lifetime-and-refusals).

## Short version

- **Typing sends one update per key** in notes and PPTX, up to the key rate:
  about 68 a second with a key held at macOS's fastest repeat (15 ms), 105 a
  second at most when keys come as fast as the page takes them (an earlier
  run; 81 in the recorded one). DOCX coalesces keys (at most 11 a second);
  XLSX sends one update per committed cell.
- **A paste, a photo, a large clear or a redo is one update** in notes, XLSX,
  PPTX and DOCX (redo): up to 1.46 MB (a 1.5 MB note paste), 2.03 MB (redo of
  a 2,500-line DOCX paste), 0.99 MB (8,000 XLSX cells), 1.13 MB (a photo
  under the Free image cap; Pro's 5 MiB cap makes it up to about 5 MB).
- **A DOCX paste is a burst of two updates per pasted paragraph** (2n − 1 for
  100 and 2,500 paragraphs): 4,999 updates and 2.1 MB in 0.8 s for 2,500
  short lines (31 KB of text), 3,993 updates and 1.7 MB in 0.4 s for 1 MB of
  text in 2,000 paragraphs. **Replace All** is one update per replacement
  (2,500 in 0.4 s). Its undo is one 14-byte update; select all and bold is
  one 49-byte update.
- **Under the shipped allowance** (10,000 updates or 8 MiB, then 200 updates
  and 2 MiB a second, per user), no scenario is over it unpaced: the 2,500-line
  paste leaves 5,163 of the 10,000, and the paced socket waits 0 ms in every
  scenario. A 2,500-line paste, its undo, redo and Replace All in a row is
  about 7,500 updates.
- **A reconnect replays a session as one update**, computed here by merging
  the session's own updates as `applyDrafts` merges stored rows: 600 keys and
  a 500 KB paste (602 updates, 499 KB) merge to 493 KB. Over 2 MiB, the socket
  now sends it in pieces; the draft sweep (HTTP `POST /drafts`) does the same
  and takes from the same allowance.
- **Awareness:** a note editor sends at most 20 cursor updates a second (the
  50 ms throttle), about 310 bytes each. It is not counted.

## Setup

- **Machine:** the Windows PC (Ryzen 7 3700X), headless Chromium, unthrottled.
- **Code:** `editor/collab-ratelimit` on main be4058307; the Office runtime
  from the main checkout's BetterOffice (8b50ac30; the pin is 79138d8d, no
  editing change between them that sends updates differently).
- **Harness:** `bench/collaboration/scripts/update-rates.rates.ts`
  (`pnpm bench:rates`): the Vite dev server with MSW and the perf seed, the
  real note, DOCX, XLSX and PPTX editors. Every update a mock room
  participant's document emits that did not come from its room is one the
  room provider sends, so the counter on the mock rooms sees each update
  before the provider cuts it into pieces. Keys are pressed on the clock (a
  press is a round trip of about 10 ms, so 66 a second holds). `headroom`
  scores each scenario against the shipped allowance, unpaced (updates over
  it) and paced (the longest wait).
- **Record:** every row below is from one run, the record committed beside
  this report ([2026-10-18-windows-pc/rates.jsonl](2026-10-18-windows-pc/rates.jsonl),
  36 scenarios from one series of runs), except the 105 a second noted above.
  In that run the Office test's "docx paste 200 KB text" sent no paste (its
  clipboard paste did not land after the undo scenario); the DOCX paste test
  covers DOCX pastes instead.
- **Windows:** "max 1 s" is the most updates (or bytes) in any 1 s, sliding;
  "p99 1 s" the 99th percentile of the scenario's consecutive 1 s windows;
  "max 100 ms" the most in any 100 ms; "largest" the largest single update;
  "left" the fewest updates the allowance held before an update, unpaced.

## Results

| Scenario | Updates | Max 1 s | p99 1 s | Max 100 ms | Bytes max 1 s | Largest | Left of 10,000 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Note, typing 15 keys/s | 300 | 16 | 16 | 2 | 320 B | 20 B | 10,000 |
| Note, key held 33/s | 300 | 34 | 34 | 4 | 680 B | 20 B | 10,000 |
| Note, key held 66/s | 300 | 68 | 67 | 8 | 1.4 KB | 20 B | 10,000 |
| Note, Backspace held 66/s | 300 | 70 | 67 | 9 | 770 B | 11 B | 10,000 |
| Note, Enter held 66/s | 100 | 45 | 45 | 6 | 4.0 KB | 88 B | 10,000 |
| Note, keys as fast as the page takes | 300 | 81 | 80 | 11 | 1.6 KB | 21 B | 10,000 |
| Note, undo held 66/s (typing grouped) | 7 | 7 | 7 | 5 | 396 B | 327 B | 10,000 |
| Note, redo held 66/s | 7 | 7 | 7 | 5 | 9.9 KB | 8.5 KB | 10,000 |
| Note, paste 300 KB of HTML | 1 | 1 | 1 | 1 | 348 KB | 348 KB | 10,000 |
| Note, paste 1.5 MB of text | 1 | 1 | 1 | 1 | 1.46 MB | 1.46 MB | 10,000 |
| Near-limit note (2 MB), select all, Delete | 1 | 1 | 1 | 1 | 104 B | 104 B | 10,000 |
| DOCX, typing 15 keys/s | 62 | 8 | 7 | 2 | 186 B | 26 B | 10,000 |
| DOCX, key held 66/s | 15 | 6 | 5 | 1 | 185 B | 45 B | 10,000 |
| DOCX, Backspace held 66/s | 34 | 9 | 8 | 2 | 99 B | 11 B | 10,000 |
| DOCX, undo held 66/s | 32 | 8 | 8 | 1 | 88 B | 11 B | 10,000 |
| DOCX, paste one 2 KB paragraph | 1 | 1 | 1 | 1 | 2.0 KB | 2.0 KB | 10,000 |
| DOCX, paste 50 KB in 100 paragraphs | 199 | 199 | 199 | 199 | 129 KB | 789 B | 9,817 |
| DOCX, paste 31 KB in 2,500 short lines | 4,999 | 4,999 | 4,999 | 790 | 2.08 MB | 791 B | 5,163 |
| DOCX, undo that paste | 1 | 1 | 1 | 1 | 14 B | 14 B | 10,000 |
| DOCX, redo that paste | 1 | 1 | 1 | 1 | 2.03 MB | 2.03 MB | 10,000 |
| DOCX, Replace All over the 2,500 lines | 2,500 | 2,500 | 2,500 | 753 | 105 KB | 42 B | 7,581 |
| DOCX, select all and bold | 1 | 1 | 1 | 1 | 49 B | 49 B | 10,000 |
| DOCX, paste 1 MB in 2,000 paragraphs | 3,993 | 3,993 | 3,993 | 1,008 | 1.71 MB | 518 B | 6,097 |
| DOCX, insert a photo (Free cap) | 1 | 1 | 1 | 1 | 1.13 MB | 1.13 MB | 10,000 |
| XLSX, a number and Enter, 15 keys/s | 50 | 7 | 7 | 2 | 911 B | 131 B | 10,000 |
| XLSX, paste 8,000 cells (23 KB of text) | 1 | 1 | 1 | 1 | 993 KB | 993 KB | 10,000 |
| XLSX, Delete those 8,000 cells | 1 | 1 | 1 | 1 | 10 B | 10 B | 10,000 |
| PPTX, typing 15 keys/s | 150 | 20 | 16 | 6 | 652 B | 274 B | 9,997 |
| PPTX, key held 66/s | 150 | 56 | 43 | 11 | 1.6 KB | 29 B | 9,997 |
| PPTX, Backspace held 66/s | 150 | 73 | 73 | 17 | 803 B | 11 B | 9,991 |
| PPTX, undo held 66/s | 100 | 63 | 63 | 10 | 1.7 KB | 27 B | 9,998 |
| PPTX, insert a photo (Free cap) | 1 | 1 | 1 | 1 | 850 KB | 850 KB | 10,000 |
| Note session of 600 keys and a 500 KB paste, merged (computed) | 1 | 1 | 1 | 1 | 493 KB | 493 KB | 10,000 |
| Note editor awareness while typing | – | 19 | 19 | 3 | 6.0 KB | 321 B | not counted |

The byte allowance never fell below 7.6 MB of its 8 MiB (the 1 MB DOCX
paste). Not measured: the PPTX text paste (the clipboard paste into a slide's
text sent no update in this harness), several Pro-size photos in a row
(each one update of up to about 5 MB: under the paced socket the second
waits about a second and the third about 2.5 s), drags (DOCX and PPTX commit a move or a resize as one update
on release, read from the code), and an item editor's typing (one update per
key into a Y.Text, as notes).

## What it means for the limit

- **Count.** Keys never pass 105 a second, and at a person's fastest key
  repeat 68. The only bursts are DOCX pastes (two updates per paragraph at
  7,000 to 10,000 a second) and Replace All (one per replacement); a 100-page
  document is about 3,000 to 5,000 paragraphs. The burst of 10,000 covers a
  paste of about 5,000 paragraphs; after one, the bucket takes about 25 s
  (4,999 / 200) to refill. The tab's socket paces its updates under the same
  allowance, so a larger paste waits a few seconds instead of closing the
  socket; only a second tab of the same user, unpaced against the first, can
  still trip it.
- **Bytes.** Typing is a few KB a second. The largest bursts are a DOCX
  paste (2.1 MB in 0.8 s) and single updates up to about 2 MB measured, 5 MB
  for a Pro photo. No room takes an update over 8 MiB, and the socket cuts
  every update over 2 MiB into pieces (a photo's binary goes whole).
- **Failure mode.** A connection over the limit is closed and its editor
  resyncs once (its step 2 then goes in pieces), so nothing is lost.
