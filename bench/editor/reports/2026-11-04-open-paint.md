# A note's one way of opening: 2026-11-04

`bench/editor/scripts/open-paint.mjs` on production builds with MSW, the Mac under
its usual load, run back to back: `claude/study-all` at `1502caab7` with `&mode=edit`
(the switch's fastest path to Edit) against `claude/open-highest`. Medians of 3. MSW
adds about 1.1 s to every `/api` call, so only the differences mean anything.

| Note, path            | On screen (ms)  | Editable (ms)   | Blocking (ms) |
| ---------------       | --------------- | --------------- | ------------- |
| near-limit, first     | 4005 to 1542    | 4208 to 4253    | 953 to 1073   |
| near-limit, reopen    | 3883 to 484     | 4072 to 4061    | 842 to 933    |
| small, first          | 4948 to 3494    | 4951 to 4888    | 209 to 230    |
| small, reopen         | 5041 to 2337    | 5043 to 4664    | 184 to 134    |

Token to editable, the gap C4 and C5 leave a person holding edits: 1697 ms first and
1700 ms reopen on the near-limit note, 396 and 453 ms on the small one, against 1495,
1373, 244 and 479. The token is asked for earlier now (next to the paint, not behind
the editor's chunk), so this gap holds the editor's other reads too, which is why it
widened while the total did not.

## What it took not to be slower

The first build painted early and made the near-limit note editable 1.1 s later
(5279 and 5202 ms). Each step, measured:

- One paint across the read: a reopen painted the note, then again when its read
  answered, at another place in the tree. Same frame and key: blocking 1494 to 1004.
- The token and the editor's chunk start next to the paint: small notes passed the
  baseline here.
- The paint's DOM unmounts when idle, not in the commit that shows the editor.
- The frame paints the first 100 blocks until the reader nears their end: a
  near-limit note's whole static DOM slowed the hidden editor's build. On-screen time
  on a reopen went to about 500 ms. The scrollbar's thumb changes as the editor takes
  over on such a note.
- The hidden editor shows as it finishes, with no wait on a paint behind the note:
  it was laid out twice. This took the last 700 ms off the near-limit note.

## Limits of this measure

MSW's own latency sets the paths' order. Nothing here says what a real network does
with the read and token overlapped, and the near-limit note's "This note is large"
gate (PE:259) comes before any of this, copy or no copy.
