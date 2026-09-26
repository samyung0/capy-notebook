# Recheck of the C5 review fixes

Date: 2026-09-26. This file rechecks the "Review fixes" section of `c5.md` against `review-c5.md`.
M2 is out of scope because C6 owns it. I changed nothing except this file.

## Runs

- `pnpm test:collaboration`: 23 files, 153 tests pass.
- `go run ./cmd/testdb ./internal/store/...`: everything passes except the known `TestColumnLimits`
  (`pdf_annotations.text`).
- A scratchpad copy of the new `officeRoots.test.ts` setup (a real Hocuspocus 4.5.0 server and a
  3.4.4 provider), run three ways. In each run the unheld keystroke is handled differently:

  | Variant | Room text | Unsynced | Connection |
  | --- | --- | --- | --- |
  | `resync`: the shipped mechanism | `hello world!` | none | no close |
  | `throw`: the old refusal | `""` | yes | closed, not re-authenticated |
  | `drop`: read-only for that message, no step 1 sent | `hello world!` | none | no close |

Counts: 0 high, 0 medium, 1 low, 4 nit.

## Low

### L1. `endOfficeResync` makes a connection writable even if it was read-only before the resync

`collaboration/src/officeRoots.ts:176-187`.

**What is wrong.** `resyncOfficeConnection` sets `readOnly = true`, and `endOfficeResync` always
sets it back to `false`. It does this even when the connection was already read-only before the
message arrived. A writer is read-only in two such cases:

- it answered `source-handoff-ready` (`server.ts:742`);
- the handoff window is closing it (`sourceHandoff.ts:242`).

In both cases the connection must stay read-only until `reset`.

**Failure scenario.**

1. A writer answers ready during a handoff. Its sync step 2 then arrives and is dropped, because the
   connection is read-only.
2. The writer types one more keystroke before the runtime goes inert. That keystroke refers to the
   dropped content, so it is unheld and gets resynced.
3. `afterHandleMessage` makes the connection writable. The next step 2 and later updates are
   applied to the room after the handoff persisted it, and are acknowledged `true`.
4. Those edits exist only in the old epoch's memory. The client's receipts decide whether it goes
   to recovery, so I found no loss, but the invariant "a ready writer stays read-only" is broken.

The path is narrow.

**Fix.** Skip the resync when `connection.readOnly` is already true, because Hocuspocus drops the
message anyway. Alternatively, record the prior value in the WeakSet and restore it.

## Nit

- **The M1 test does not exercise the server's step 1.** In `officeRoots.test.ts`, the handshake's
  own step 2 recovers the dropped keystroke. My `drop` variant, which sends no step 1, also ends
  `hello world!` with nothing unsynced. The extra step 1 is harmless: it costs one small step 2
  per drop. But the test comment ("the room's step 1 brings a step 2") claims more than the test
  shows.

  I found no ordering in which the handshake's step 2 has already landed and the room still lacks
  something the client holds. Rooms do not reload while connections are open. So the step 1 is
  belt and braces.

  The test does fail with the old refusal (`throw` variant). Keep the step 1 or drop it, but fix the
  comment.
- **`openwiki/backend-storage-quota.md:210-218` is stale.** It says maintenance publications "skip
  the storage gate at publication", and that the store-only export "is gated ... at publication".
  Both now also apply at finalize (`source_refresh.go:199-214`). Say "at finalize and
  publication".
- **The chrome-font skip deviates from record 16.** Record 16 registers faces "under the Office
  family names". The skip (`officeFonts.ts:38-56`) changes that for families in the runtime's root
  stack: in practice only `Inter`, since the generic names never match. A document set in Inter is
  now measured with Liberation Sans and painted in the iframe's Inter or system font, so its
  wrapping can differ. This is the lesser evil and it is documented, but the record does not cover
  it.

  The skip reads `getComputedStyle(document.documentElement)` when a face is registered. If that
  ever ran before `office-runtime.css` applied, it would read the UA default (often
  `Times New Roman`) and skip a common document font. I did not find a path where that happens
  (registration follows an async font load), so this is a note only.
- **`TestStoreOnlyExportIsQuotaGated` publishes a state the service never sends.** It publishes a
  `RebasedState` with no later save (`ExpectedLatestCheckpoint == Checkpoint`). The service never
  sends a rebased state then, and Go does not refuse one. The fixture is fine for the quota
  assertion. If you want the contract tight, refuse `state != nil` when
  `doc.Checkpoint == in.Checkpoint` at `source_refresh.go:334-351`.

## Verified OK

- **M1 mechanism.**
  - Hocuspocus 4.5.0 processes one connection's messages strictly in order (`processMessages`:
    `beforeHandleMessage`, then `apply`, then `afterHandleMessage` in a `finally`). So two messages
    cannot interleave. A throw inside `apply` still reaches `endOfficeResync`, and
    `resyncOfficeConnection` is the last statement before `return`, so nothing throws after it.
  - Between the resync and `afterHandleMessage` there are only microtasks. The config has no
    `beforeSync` hook, and the Redis extension has no message hooks. So no Redis-driven handoff,
    pause or reset can run in between.
  - Real view and comment connections return before the check and are never added to `resyncing`,
    so they are never made writable.
  - A read-only update gets `SyncStatus(false)`, which the 3.4.4 provider does not count down. The
    step 2 reply is not counted up, and its `SyncStatus(true)` counts down one. So the provider's
    unsynced count balances for each drop.
  - Foreign roots and `pptx:meta` still refuse, even when the same update also holds unheld
    structs: the scan continues past unknown items.
  - I found no simpler sound mechanism in 4.5.0. Any throw closes the connection. Letting Yjs park
    the update as pending would store unchecked pending structs in the state.
- **L2 finalize bound.** Publication charges `S - F + E + Bl + st - D_p`, with effects of at least
  2 bytes (`[]`), `Bl` and `st` both at least 0, and `F` fixed by the revision check. So:
  - *No saves in between:* the bound is at most the charged growth.
  - *Saves after finalize (the row grows by Δ):* the bound falls by Δ, but the headroom also falls
    by Δ because the saves were charged. A refusal at finalize therefore implies a refusal at
    publication.
  - *Saves that shrink the row:* the bound only rises.
  - *Text:* it keeps its state, so its charged growth is `S - F + E_new - E_old`, and
    `D_f` includes the state growth. The bound stays below it.
  - *System jobs* are exempt.

  The only way publication fits where finalize refused is space the owner freed elsewhere in
  between, which is acceptable. A finalize refusal parks the file with `refresh_error` (not stale),
  so a paid parse is not retried until the next save. The test covers both the finalize refusal and
  the publication refusal.
- **L1.** The Office publication `UPDATE` clears `reprocess_at`. Text publications never carry a
  mark, and `applyExportTx` still sets the mark for export-only publications.
  `TestSourceRefreshRebasesNewerSavedOfficeState` asserts that the mark is cleared.
- **L3.** The switch at `source_refresh.go:334-351` has three branches:
  - text: neither a state nor a baseline;
  - NULL state: no baseline, the same checkpoint, and no effects;
  - rebased state: at most 100 MB, and a baseline exactly for DOCX and PPTX.

  The service's `rebasePublication` matches this (XLSX sends no baseline). The DOCX-without-baseline
  refusal is tested.
- **L4.**
  - `TestNullCaptureSurvivesALaterSave` runs the service's `CAPTURED_STATE_SQL` verbatim and would
    fail with `COALESCE`.
  - `TestOfficeStorageRuleMigrationKeepsTheLedger` rebuilds the pre-0032 shape: the candidate's
    triggers and `user_id`, the Office row, and a text row with a baseline. It compares the booked
    ledger with a recount before and after the real migration file. It would catch a missing
    candidate refund or a missing text-baseline booking.
  - The M1 test would fail with the old refusal.
- **Other nits.**
  - Client id: `|| 1` keeps the replica's id off 0, the DOCX and text seed client. The PPTX
    bootstrap client is `2^53-1`, and XLSX checks for conflicts itself.
  - Roots: they are read once at boot with a top-level await, so the message hook does no I/O and a
    broken bundle stops the service. A rejected import is no longer cached.
  - The XLSX save and resync wording in `openwiki/frontend/office-files.md` matches the code.
- **No regressions** in the areas I marked Verified OK: NULL state, copy-on-write, the 0032 ledger,
  the gates, 0033, R1-R6, and the Office hosts.
