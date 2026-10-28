# Compact, checked presence payloads, pointers and block selections

Status 2026-10-28: decided and measured, nothing built. Built by PC sessions
(editor, Rust and security work, per the machine split) from this plan.
Decisions: `human/frontend/plate-editor.md`, the 2026-10-28 presence lines.
Load test: `bench/collaboration/reports/2026-10-28-presence-load.md`: compact
JSON suffices (36 B a caret against 305 B, server egress per caret 194 B
against 886 B, the same CPU); no binary format.

## Why

- A note caret is 289 B per awareness message, ~210 B of it the two Yjs
  relative positions as JSON (`{"type":{"client":…,"clock":…},"tname":null,
  "item":{…},"assoc":0}`); `Y.encodeRelativePosition` writes one in 9 B. Every
  change resends the whole state, colour included, and y-protocols renews it
  every 15 s.
- A peer's `data.color` reaches the caret's `background: var(--remote-cursor)`
  unchecked (`RemoteCursors.tsx`, `tailwind.css` `.note-editor
  [data-remote-caret]::before`). `img-src` is report-only, so
  `url(https://…)` makes every co-editor's browser fetch an address of the
  sender's choosing (IP, user agent, when the caret is drawn).
- The server keeps and relays awareness entries as opaque bytes up to 64 KiB
  (`MAX_AWARENESS_ENTRY`): one editor can push its 2 MiB/s allowance and the
  room sends it to every other editor; 256 × 64 KiB held per room.

## Wire shapes

One field list per room kind, in Rust (`room.rs`) and TypeScript (the
receivers), tested on both sides. An awareness entry whose state has a field
the list lacks, a value of the wrong type or out of bounds, or more than
4 KiB, is not kept or relayed (dropped silently: presence is best effort).
A removal (`null`) is always taken.

Note rooms (content documents):

| field | value | bounds |
| --- | --- | --- |
| `s` | caret anchor: base64 of `Y.encodeRelativePosition` | ≤ 64 base64 characters |
| `f` | focus, the same; absent when the selection is collapsed | ≤ 64 |
| `p` | pointer `[blockId, x, y]` or `null` | id ≤ 64 characters; x, y integers 0–1000 |
| `b` | block selection runs `[[firstId, lastId], …]` | ≤ 16 runs, ids ≤ 64 |
| `uploads` | upload placeholder ids (unchanged, `uploadPresence.ts`) | ≤ 100 ids ≤ 32 characters |

Source rooms (Office): `cursor` as `isOfficeCursor` bounds it, except DOCX
`anchor` and `head` become base64 strings (≤ 1,368 characters, 1,024 bytes)
and PPTX `shapeId` becomes `shapeIds` (≤ 16 ids). Later `p` with the format's
anchor (below).

Items rooms (quiz, set, Mermaid) and a quiz's keys room: no fields; any
entry dropped. Read-only and viewer channels: as today (no awareness either
way; `without_uploads` goes, since `uploads` is checked per field anyway and
a read-only channel's list is dropped by the same check).

## Work

### A. Collaboration server (Rust)

- `room.rs` `on_awareness`: parse each entry's state with serde_json and keep
  it only when it passes the room kind's list; `MAX_AWARENESS_ENTRY` 4 KiB.
  The relayed bytes stay the sender's (no re-serialising). A malformed
  y-protocols frame stays a refusal as today; only the state check drops.
- Replace `without_uploads` with the per-field check (a read-only channel's
  `uploads` is a field it may not send).
- Tests in `crates/server/tests/rooms.rs`: a valid note caret relays; an
  unknown field, a 65-character `s`, `p` x = 1001, 17 runs, a 4,097-byte state
  are not relayed and the channel stays joined; an Office cursor relays.

### B. Note carets and colour

- Replace slate-yjs's `sendCursorPosition` (already wrapped by
  `throttleCursorPosition`) so the state is `{s, f?}`; read peers in
  `useRemotePeers` / `resolvePeer` from `s`/`f` (`Y.decodeRelativePosition`
  in a try, like today's resolve) instead of `CursorEditor.cursorStates`.
- No `data` and no colour: each receiver colours a peer from the room
  presence's `person` number (one palette, `person % palette.length`), so
  everyone in the room sees the same colour; delete `cursorColor` in
  `NoteEditorCore.tsx`.
- The receiver drops a state that fails the same list (`RemoteCursors.tsx`,
  `uploadPresence.ts` keep their own reads).

### C. Pointer and block selection (notes first)

- Pointer: on `pointermove` over the editor, `target.closest('[data-block-id]')`
  (every element has a stable UUID, `stableElementIds.ts`), x and y as
  0–1000 of its box; at most every 50 ms (`CURSOR_SEND_MS`), `p: null` on
  leave. Receiver: look the element up by id (as `roomSwap.ts` does), place
  the pointer in its box, nothing drawn when the block is not rendered.
- Block selection: `BlockSelectionPlugin`'s selected ids folded into
  contiguous runs in document order, at most 16, none past that.
- Look of the pointer and of a peer's block selection: mock first (Epo,
  every UI proposal as a mock).

### D. Show others' presence switch

- One device setting in `noteEditorPrefs.ts`, on by default: off hides
  co-editors' carets, selections, pointers and block selections; the avatar
  group stays. Switch in `ToolbarEditorSettingsDialog.tsx`; Office cursors
  (`officeCursors.ts`) read the same setting, with its switch in the file
  header's ⋮ menu (mock first).

### E. Office

- Capy's adapter (`officeCursors.ts`, `officeProtocol.ts`): DOCX positions as
  base64 in awareness, number arrays to and from the frame as today.
- BetterOffice (`capy-ci`): PPTX `shapeIds`; later pointers anchored to the
  DOCX page, the PPTX slide (`slideId`), the XLSX sheet and cell, x and y
  0–1000 of that box, reported and drawn by the frame.

### F. Docs and tests

- `openwiki/frontend/plate-editor.md`: room presence, remote cursors, Office
  cursors, upload presence (the 64 KiB lines), the switch.
- `openwiki/test-catalog.md`: the new Rust and Vitest cases, and the
  `stress.ts` caret load (`STRESS_CURSOR_HZ`, `STRESS_CURSOR_PAYLOAD`).
- Update `bench/collaboration/scripts/stress.ts` `compact` shape if the final
  shape differs, and rerun `200-compact` from the harness below.

### G. Stress script drops (Epo 2026-10-28, `human/editor-perf.md`)

- `stress.ts` simulates an offline drop as a lost network does: close the
  peer's socket without the provider's clean Leave (today
  `peer.provider.disconnect()` sends one, which expires the session's id),
  so its offline typing reconnects under the kept id (Q236, Q472). Today
  every room with drops fails to converge (`collaboration-unassigned-id`,
  Q213); the `Performance` workflow has failed since 2026-10-22. Then rerun
  the presence steps with the default drops.

## Open

- A sender's worst case is near the cap: 100 upload ids of 21 characters
  (~2.4 KiB) plus 16 runs of UUIDs (~1.3 KiB) plus a caret and a pointer.
  Proposed: the sender leaves `b` out when the state would pass 4 KiB.
  Needs Epo's sign-off.

## Load test harness

`capy-harness/2026-10-28-presence-load/box` (prepare-P.sh on the Mac,
build-P.sh and ladder.sh on the prod box, plan-P.txt, summarize.mjs). Rooms of
3 typing peers and a watcher, an edit every 8 s per peer, carets at 20 Hz in
today's or the compact shape, no offline drops; results in the report above.
The box's spare cores generate about 200 rooms at 20 Hz, not more.
