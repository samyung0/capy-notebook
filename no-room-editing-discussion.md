# No-room editing discussion

Design note, 2026-10-12. Developer Epo with Claude (Opus 5.5) in Claude Code. Parked: no code changed, and nothing starts before the Rust collaboration port and the Office optimizations settle.

**Parked state, in one paragraph.** Today every editor joins a collaboration room, even alone, and signed-in viewers join one read-only (Epo, 2026-10-10). This note describes storing every edit as an append-only update log and letting the browser hold the live document, so the server only stores, forwards and checks updates. There are two versions: **solo no-room** (documents only their owner can edit skip the room) and **full no-room** (no document holds a room). If the Rust server with the Office optimizations sustains a much higher load, full no-room is much less attractive, because rooms are already cheap for notes (below). The log is useful either way: it fixes stuck offline drafts and makes server writes and offline edits the same thing. Revisit after the port, starting with the log, then solo, then full only if measurements ask for it.

---

## Where this started

- **Google Docs offline.** "Make available offline" does not download a .docx. Chrome or Edge with the Docs Offline extension keep Google's own document data and the editor code in browser storage. Recent files go offline automatically when there is space. Offline edits sync and merge on reconnect. It is per device, one account per browser profile, no private windows, no Safari or Firefox. ([Google help](https://support.google.com/docs/answer/6388102))
- **Capy today.** Offline editing already works without a toggle: unsaved Yjs updates go to IndexedDB (`capy-edit-drafts`, see [plate-editor.md](openwiki/frontend/plate-editor.md#offline-editing-and-drafts)). The gap: drafts only sync when that file is opened again, usually after a room or save error left them behind.
- **The web's limits.** `navigator.storage.persist()` and Safari's exemption for installed web apps cover the whole origin, IndexedDB included, so OPFS is not needed for persistence (an OPFS log measured the same as IndexedDB behind the drafts worker). Safari deletes script storage after 7 days without a visit unless the app is installed. Background sync is Chromium only. Another browser can never see this one's storage, so on the web the server stays the source of truth and local storage is a cache plus an outbox. Real local files need the desktop app.

## Yjs in five lines

- A document is a list of **items** (a character run, a block, a map value). Each has an id `(clientID, clock)`: every editing session picks a random `clientID` and counts its own edits 0, 1, 2…
- An item stores the id it was inserted next to, not an index, which is why concurrent edits do not clash. Deletes only mark ids as deleted.
- An **update** is a binary blob: "these new items" plus "these ids were deleted". The room receives exactly these blobs today, wrapped in a sync header.
- Updates can be applied in any order, applying one twice changes nothing, and many updates merge into one blob of the same format. A **snapshot** is all updates so far merged into one.
- A **state vector** is "highest clock I have per client". An update whose anchor has not arrived waits as pending, which is how a missing update shows up.

So a snapshot plus the updates after it holds the whole document. A room is the server keeping that rebuilt document in memory.

## What a room does today

1. **Stores** the document (checkpoints).
2. **Forwards** each update to the other sessions.
3. **Holds the rebuilt document** to check each update before accepting it: the allowed top-level parts, a cheap growth bound per update with an exact measurement near a limit (`materialUpdateGrowth`), and updates it cannot place yet (it asks the sender to resend). See [plate-editor.md](openwiki/frontend/plate-editor.md#document-limits-and-rejection).

Only the third needs memory. The 2026-10-11 bench ([report](bench/collaboration/reports/2026-10-11-prod-capacity-rust.md)) puts the Rust server at 1,400 note and DOCX editors on 0.76 of a core (about 0.05-0.07% of a core per editor) and 151 KB per idle connection (mostly a 128 KiB read buffer, a one-line setting). The heavy part is Office: 30 large-file rooms held 1.65 GiB, with save engines at 4 GiB each.

## Shared by both versions

### Storage: an append-only update log

- Every writer appends: the browser, the other devices, the agent, study-tool commands. Nothing overwrites the document.
- A background merge folds "snapshot plus updates up to sequence N" into a new snapshot and keeps the updates after N. Concurrent appends are safe because nothing replaces what they wrote.
- The merge also produces what needs the whole document: the exact limit check, the Plate projection, search indexing, thumbnails, and for Office the saved file. Notes and text files are cheap to merge. Office reprocesses and publishes on save anyway.
- To check during the port: whether the Rust server stores a full snapshot per checkpoint (as Hocuspocus does) or a snapshot plus updates. Switching storage to a log is much cheaper during the port than after it.

### Sending and acknowledging

1. The edit goes to IndexedDB first, as today.
2. The browser sends the update to the server, which appends it, gives it a sequence number and answers. That answer is the receipt: the browser deletes its local rows only after it, as checkpoint receipts do now, and resends until then. Resending is harmless, and the merge drops duplicates.
3. The server publishes `{seq, update}` to the document's channel only after appending, so nothing is shown live that the log does not hold.

Because sending is a plain HTTP call with raw updates, it does not need the editor mounted. The once-per-load sweep that already checks stored drafts can also send them, and in Chromium the service worker can send them with no tab open. That fixes stuck drafts.

### Forwarding and lost messages

- Forwarding runs on our server, plus BroadcastChannel between tabs of one browser for free. Our server has to know which login session holds each socket anyway: Clerk session tokens carry a `sid` claim that is verified locally, so the gateway puts it in the collab token without calling Clerk. Clerk's API is only for listing or revoking sessions.
- Forwarding is best effort; the log decides what is true:
  - a subscriber that sees sequence 41 then 43 fetches 42 from the log;
  - a periodic heartbeat (every 15-30 s) carries the latest sequence number, so a dropped last message is caught too, as are reconnect, resubscribe and focus;
  - between tabs (no sequence numbers), compare state vectors (Yjs sync step 1/2).
- Viewers: on open, snapshot plus newer updates, then subscribe. No document is held on the server for them.

### Checks that need only the update

On append, without the document:

- size, well formed, rate;
- each `clientID` is bound to one session, so nobody writes under someone else's id;
- a clock index (highest clock per client) next to the log: each client's clocks must continue from the last one. This rejects a struct placed twice (the yrs push guard case), clock skips and forged ids before forwarding;
- writes to unknown top-level parts or the server-owned contributors map: items created at the top level carry the part's name;
- an anchor that never arrives stays pending and is dropped at merge.

### Server writes

Agent edits already work without a room ([editCommands.ts](collaboration/src/editCommands.ts), [persistence.ts](collaboration/src/persistence.ts)): `inspect_document` returns block ids and text; `edit_document` sends commands ("`replace_text` in block X, expected text …, new text …"); the service locks the material, builds a scratch document from stored state plus the live room's unsaved state, applies the commands through a headless Slate editor, checks the structure and limits exactly, and commits the new state, an undo record and the update sent into the room. In the log design the base becomes snapshot plus log, and the update is appended and forwarded like any other edit.

The expected text catches anything already sent. The gap is offline edits not yet sent: the check passes against stale text and Yjs merges both, so a user typing inside a sentence the agent replaced keeps stray characters beside the agent's version. Rare and visible, not lost. When an editor is open, the write could go to that browser and be applied there as a local edit instead.

Note: this reads the Node `collaboration/`. Check whether the Rust port kept this path.

## Version 1: solo no-room

**Solo** means no one but the owner can edit or comment. Viewers do not count: they only read the log and the forwarder. The same owner on several devices or tabs is fine: their updates merge, and nothing is rejected for being concurrent.

- No room. Checks on append as above. Limits and structure are checked exactly at merge.
- **Late rejection is safe here.** Nobody else builds on the owner's updates, so when a merge finds updates from clock X onwards breaking a limit, it drops that client's updates after X and they go back as a refused draft, as today. Caveats:
  - the owner's other devices may have built on them: merge before forwarding to other devices, or they get the refusal too;
  - server writers: run them against merged state only;
  - live viewers do not build on top; they reload from the log after a refusal.
- **Becoming shared.** The server tells the browser on its next send ("room required"). The browser joins a room; what it already sent is merged anyway. Sharing never changes whether edits are kept, only how fast others see them.
- **Office.** If the browser's BetterOffice can build the saved file for a solo document, the server's save engines are out of the loop for most Office files. That is the largest saving in this version. To check: whether the browser engine can produce the same save the server does, and what an uploaded save from an untrusted browser must pass before others download it.

## Version 2: full no-room

Everything in version 1, plus documents edited by several people.

### Limits as approximations

The current bound is already an approximation that uses the document only to price edits. Without it:

- **Bytes:** inserted text and attribute values are inside the update, so their size is known; add a small flat overhead per insert for not knowing which run it joins. Overestimates, which is the safe side.
- **Node count:** count inserted elements and ignore deletes. Drifts up, also safe.
- **Depth:** a new block's depth depends on its parent, which the update names by id. Keep a small index next to the log of block id to depth (blocks only, not characters). The index can store block types too, which helps the type checks below.
- The merge measures exactly and resets every bound, so drift never outlives a merge, and the limits have slack for it.
- **Blind spot:** one formatting update over a long span repeats its attribute on every run it splits, and the update does not say how many. Normal editing does not come close; deliberate abuse is caught only at merge.

### Comment mode

Probably checkable from the update: comment marks are formatting entries whose key starts with `comment`, and a commenter's deletes can be limited to their own items. Simpler: move comments out of the content document into their own document or table, so permission is just "can edit or not".

### Two different jobs

| Job | Protects against | How |
|---|---|---|
| Hardened apply + clock index | Malicious updates that crash or hang other browsers | Update checks on append; every browser applies updates with a yrs/Yjs build that refuses bad input safely and asks for a resync |
| Exact check at merge + Plate repair + version check | Honest edits that merge into something invalid | The merge measures and validates; browsers repair structure; old clients are refused |

Honest browsers only send updates their own editor made, so these are valid one at a time. The merged document can still be invalid:

- two valid edits combine into an invalid one (uneven table rows, a list item whose parent another user deleted, two users each under the limit and together over it). Rooms have this today too;
- two browsers repair the same broken merge at once (two empty paragraphs instead of one);
- an old tab or a long-offline device runs an older schema: sending needs the same lineage check as `room_schema` and refuses old versions into recovery;
- editor bugs or a half-written IndexedDB draft.

What is left for hardening after the clock index is updates whose damage depends on what they attach to: wrong parent types (mostly covered by the type index) and failures inside Yjs's placement that only show when applied. **Epo prefers hardened clients** over holding forwarding until the merge (seconds of delay) or keeping rooms for untrusted co-editors. Testing it is fuzzing: random and mutated updates into the Yjs and yrs apply paths, checking for refusal without crashing or hanging, with each crash found getting a CI test that fails when its fix is reverted (the security regression rule, 2026-10-08).

## Why this may not be worth it

- Rooms in Rust are cheap for notes (numbers above). Removing them for notes saves little memory and adds the late-rejection path.
- The cost is Office memory and saves. If the Office optimizations bring that down, full no-room gains little.
- The log on its own still pays: stuck drafts sync, offline edits and server writes become plain appends, and the "two ways into storage" problem goes away.
- A middle ground to weigh before full no-room: keep rooms, but open them on the first send and close them after a short idle.

## To check after the Rust port

- Snapshot-per-checkpoint or snapshot plus updates in the Rust server's storage.
- Whether the agent edit path (scratch document plus live state) survived the port.
- What an idle solo room costs against a batched send plus merge, measured on the prod box.
- Whether the browser BetterOffice can produce saves, and what a browser-built save must pass.
- How the read-only live View channel (2026-10-10) maps onto the forwarder.
- A fuzzing plan for hardened apply in Yjs (notes) and yrs (Office).
- Installing as a web app plus `persist()`, and what Safari's 7-day deletion means for drafts.
