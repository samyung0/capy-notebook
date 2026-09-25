# Review of C1 (commit a26c7ddc): paused before completion

Date: 2026-09-25. Adversarial review of `a26c7ddc` ("office: handoff always completes, banner,
drafts, worker queue (C1)") against `human/frontend/office-files.md` records 17-20, the C1
section of `artifacts/2026-09-25-office-implementation-plan.md`, the handoff review 1.5
(problems 5, 7, 8) and `pptx-and-shared-overhead.md` 5.4. The coordinator paused the review;
this file holds the findings so far and the areas not yet checked. Nothing in the repository
was changed apart from this file.

## What was run

- `pnpm test:collaboration`: 21 files, 129 tests pass.
- `vitest run src/features/files src/mocks/collaboration.test.ts`: 12 files, 44 tests pass.
- `go run ./cmd/testdb -- -run 'TestSourceSession|TestSourceCheckpoint|TestSourceDocument'
  ./internal/httpapi/ ./internal/store/`: pass. The disposable containers were removed.
- Three scratch experiments, kept outside the repository (session scratchpad):
  - `marker-bypass.mjs` imports the committed `collaboration/src/contributors.ts`, and the parent
    commit's copy, and sends crafted Yjs updates through the same check-then-apply sequence the
    server uses.
  - `save-cost.mjs` times the engine part of one source save (`officeBaseline` +
    `compareBaselines`) with the pinned `vendor/betteroffice/shared/office-checkpoint.mjs`.
  - `auth-retry.mjs` runs a real `@hocuspocus/server` 4.5.0 and `@hocuspocus/provider` 3.4.4. It
    closes an editor with 4408, refuses its reconnect while a lock is held, and watches when the
    editor authenticates again.

## Findings, ranked

### 1. High (regression): a writer can delete or forge the marker the room writes for its own update

`collaboration/src/contributors.ts:94-125` (check) with `:147-173` (dedicated marker client).

**Defect:** The decoded-update check only looks at marker structs the room already holds.
Meanwhile, the marker for the incoming update is written under a stable, publicly visible
client id at a predictable clock, inside the same transaction. A delete range or an origin
that points at that future marker therefore passes the check. It then hits the marker when
the room applies the update.

**Evidence** (`marker-bypass.mjs`, committed code):

- **A: an edit plus a delete set over the marker client from its next clock onward.** The check
  does not throw. `documentContributors(room)` is `[]` after the attacker's edit, and still `[]`
  after a later honest edit, because Yjs keeps the range in `pendingDs` and reapplies it to every
  later marker. The room text holds both edits, and the marker client id never rotates.
- **B: an item whose origin is the marker the room is about to write.** The check does not throw,
  and the marker becomes `{userId: 'u_victim', nonce: 'forged'}`.
- **Against the parent commit's `contributors.ts`, both attacks fail.** Markers were written
  under the room's own id, which Yjs rotated to a fresh random id after every remote
  transaction, so the next marker id could not be predicted. The copy-based check had the same
  blind spot, but the rotation hid it. The dedicated id (item 5) exposes it.

**Failure scenario:** A collaborator with edit access sends one crafted message. Every later
store finds no contributors and takes the fast path in `sourceDocuments.ts:567`. That path
returns the durable checkpoint without writing the room state. `server.ts:880` still sends
`checkpoint-persisted` receipts, so the clients mark themselves saved and clear their drafts
(`useSourceSession.ts` `markSaved`). When the room unloads, every edit since the attack is
lost. The same message also removes the attacker from the per-contributor recheck, or pins
their edits on another user (variant B).

Material rooms use the same tracker and check.

**Lazy fix:** Keep the current marker client per document, for example in a
`WeakMap<Y.Doc, () => number>` filled by `attachDocumentContributorTracker`. Then in
`assertUpdatePreservesContributors`, reject:

- any `origin` or `rightOrigin` that names the marker client at a clock the room does not hold;
- any delete range on the marker client that reaches past `getState(markerClient)`.

Honest clients never reference marker clocks the room has not written. Add the two attack
updates as cases in `contributors.test.ts`.

### 2. High: the trap check misses the usual trap path, so a poisoned engine keeps serving every room

`collaboration/src/officeRuntime.ts:147,160` and `vendor/betteroffice/shared/office-checkpoint.ts`
(for example `:960`, `:1031`, `:1048`).

**Defect:** The worker restarts only when
`error instanceof WebAssembly.RuntimeError`. But every engine entry point frees its
wasm-bindgen object in `finally { session.dispose() }` or `catch { doc.free(); throw }`. After a
trap in the middle of a borrowed call, `free()` throws a plain `Error`, and that error replaces
the `RuntimeError`.

**Evidence:**

- `docx.wasm`, `xlsx.wasm` and `pptx.wasm` contain "attempted to take ownership of Rust value
  while it was borrowed".
- The glue's `__wbindgen_throw` throws `new Error(...)`.
- The storage probe hit exactly this masking in practice (`storage-footprint.md:517-521`). A
  fresh instance then opened the same state.

I did not force a real trap here.

**Failure scenario:** An allocation failure or a panic occurs inside `officeBaseline` for a
large workbook. The error that reaches the worker is the ownership error, so `trap` is false
and the worker is not replaced. Every later call from every room runs on the poisoned
instance. Each save that fails there becomes an `OfficeEngineError`, which is reported and
never retried (record 17). This lasts until the process restarts.

**Lazy fix:** In the worker's `catch`, also count wasm-bindgen's poisoned-object errors ("attempted
to take ownership", "recursive use of an object") and messages naming `unreachable` as traps. On
the fork side, stop `dispose()` from masking the first error.

### 3. Medium: the risky paths have no tests, and one plan-required assertion is missing

- **Handoff test gap.** The plan asks for a test that "the silent editor's client lands in
  recovery". `sourceHandoff.test.ts` asserts only the 4408 close, one persist and the
  epoch-changed broadcast. No client-side test exists for `prepare` → ready, `replace()`
  (banner versus recovery, including the token path), or skipping covered drafts.
- **Office worker.** No test covers the one-call-in-flight queue, the timeout, the trap restart,
  or a late result after a timeout (`officeRuntime.ts`).
- **Save queue.** No test covers one running plus one queued save per room, or a queued save's
  failure reaching every caller that shares it (`server.ts:844-863`).
- **Size check.** No test covers the estimate crossing the cap, or the stateless rejection being
  sent before the close.
- **Handoff mix.** No test covers a ready editor and a silent editor together, where only the
  silent one is closed, or a persist failure after the window.
- **Marker check.** The contributor tests cover rotation and a resent state, but not dangling
  references (finding 1).

### 4. Low: a queued save can be shared across two Document instances of the same room

`collaboration/src/server.ts:847`.

**Defect:** `persistSource` returns an existing queued promise keyed by room name only. That
queued save snapshots the document of whichever caller created it.

**Failure scenario:** A handoff or checkpoint-request save for the old instance is still queued
when the room unloads and reloads. The new instance's persist then shares the old snapshot,
and its claimed checkpoint ids are acknowledged against state that lacks its edits. The window
is narrow, because Hocuspocus waits for its own debounced store before unloading.

**Lazy fix:** Share only when the queued entry's document is the same object; otherwise chain a
new save.

### 5. Low: `handedOff` goes stale

`src/features/files/useSourceSession.ts:329`.

**Defect:** `handedOff` is set just before `sendStateless`, whether or not the provider is still
the connection the server is waiting on. Only a `source-handoff-cancel` received on a live
connection resets it.

**Failure scenario:** A client misses the cancel while disconnected and keeps a stale
`handedOff`. A later completed handoff learned through `token()` then counts it as saved and
clears its drafts. This needs a crash or other lost-persist between the two handoffs to lose
data.

**Lazy fix:** Reset `handedOff` on disconnect, or when the token epoch still matches the
session's. The cost is a false recovery prompt, not data loss.

### 6. Low: checkpoint cost and contract drift

- **Checkpoint still reads the whole row.** `SaveSourceCheckpoint` reads the full row back
  (`server/internal/store/source_documents.go:319`, `readSourceSession`: state, baseline,
  effects) only to return `checkpoint` and `operation`. The HTTP body is trimmed as the plan
  asks, but Postgres still returns up to 100 MB per save to Go. The `old` read also loads the
  whole state just for `len(old.State)`. A `RETURNING checkpoint` and `octet_length` would do.
- **Nullability mismatch.** `openapi.yaml` `SourceSession` still requires `indexedBaseline` as a
  non-null string, but the editor read now sends `null`. No frontend code validates it, and the
  `view=true` path already sent `null` for `pendingEffects`.
- **Rest of the contract matches.** Go, `openapi.yaml`, the generated client and all three
  service callers of `SourceCheckpointSaved` agree.

### 7. Low: the draft database upgrade

`src/features/files/sourceDraft.ts:31,108`.

- **Existing drafts are dropped.** Version 3 deletes every existing store, including unsaved v2
  drafts. The plan's ground rules allow this, since there is no production data.
- **Old tabs break.** Tabs still running the old code then fail every draft write with a
  `VersionError` and show an error until reloaded.
- **A missing base blocks opening.** When a base row is missing, `readSourceBase` fails the
  whole session load with an unlocalized "Source draft base is missing", so the file cannot be
  opened in Edit at all. Bases are keyed by file and SHA. An empty SHA (a never-seeded session)
  is not content-addressed, so two such lineages could share the wrong base.

## Checked, nothing serious found

- **Handoff ordering.** Hocuspocus 4.5 processes each connection's messages in order
  (`Connection.processMessages`) and sends `SyncStatus(true)` only after applying an update.
  So a ready sent once `hasUnsyncedChanges` is false arrives after the updates it covers. A late
  update from a ready editor is dropped as read-only, which bumps `sequence` above
  `handedOff`, so that client goes to recovery, not the saved banner.
- **Pending input.** `flushHandler(true)` applies the iframe's `flushed` bytes before the
  unsynced check.
- **4408 close.** It closes the socket, and the provider reconnects with backoff.
- **Epoch-change paths.** Both the stateless path and the token path call `replace()`. There is
  no remount: `shared` is kept and `setGeneration` remains only for Discard. Saved clients get
  the banner and cleared drafts, unsaved clients get recovery, and the views block editing when
  `replaced` is set.
- **Draft cadence and skipping.** At most one write every 250 ms, latest state only. A receipt
  arriving before the timer skips the write. A write already under way lands in `latestDraft`,
  which `markSaved` clears. The unmount flush skips covered state.
- **Base store cleanup.** The count after the delete runs in the same IndexedDB transaction, so
  the last user of a base removes it.
- **Worker timeout versus a late result.** The `worker !== created` guard drops messages from a
  replaced worker. Queued calls survive a restart.
- **Size estimate.** It counts the load, Redis and server-side updates. Crossing the cap triggers
  one exact measurement. The stateless `recoverable: false` message is sent before the close,
  and the client goes to recovery and disconnects.
- **Saves queued behind a running save** snapshot when they start, so sharing is safe within
  one Document.

## The two open questions (now decided; measurements for the targets)

### Acknowledgement deadline (target: about 60 s)

The deadline has to cover the window plus the handoff persist. The persist can wait behind a
running save, because the Office worker queue is shared by every room.

Measured engine time for one save on the pinned runtime, three runs each (`save-cost.mjs`):

| Fixture | Cold (first call) | Warm |
| --- | ---: | ---: |
| `rich-content/course-guide.xlsx` (145 KB, 7.7 MB state) | 31-41 s | 5-8 s |
| `jp_llm2.pptx` (24 MB) | | 0.5-0.9 s |
| `rich-content/exchange-plan.docx` | | 0.15-0.2 s |

The storage report measured 25 s at 50k cells and 76 s at 100k.

- **Worst case for the XLSX fixture.** A 10 s window, then a running save, then this save, on a
  cold worker, already approaches or passes 60 s. After the acks come the rebase and the publish.
- **Lock and watchdog.** The lock (`sourceHandoff.ts:306`, 120 s) and the watchdog (`:181`, 125 s)
  must be sized from the new deadline plus the rebase, or the publication fails with "lease
  expired".
- **Timeout restart loop.** With `CALL_TIMEOUT_MS = 120_000`, a cold baseline of a large
  workbook can time out. The restart makes the next call cold again, so that room can loop.
- **Cost of the current 15 s.** Today's 15 s fails this fixture whenever one editor is silent or
  a save is running. C6's two-actor journey on `course-guide.xlsx` would be flaky under it.

### Refused reconnect during a publication (target: retry after a short delay, no error unless the retry fails)

Current behaviour, measured with `auth-retry.mjs` and a 5 s lock:

| Time | Event |
| --- | --- |
| 0.3 s | 4408 close |
| 1.3 s | Reconnect refused; the client receives `authenticationFailed "permission-denied"` |
| 5.3 s | Lock released |
| 33.1 s | Provider closes its own idle socket (30 s `messageReconnectTimeout`) |
| 34.1 s | Re-authenticated |

So the provider does retry, but only after about 30 s. The server's own deadline for an
unauthenticated socket is 60 s. During that gap, Capy's `onAuthenticationFailed` calls `fail()`
(`useSourceSession.ts:278`), which shows the raw "permission-denied" as an error.

Notes for the target:

- **Server.** Hocuspocus sends `error.reason ?? 'permission-denied'` and keeps the socket open.
  To make the lock case recognisable, throw an error with a distinct `reason` from
  `onAuthenticate` when the room is locked.
- **Client.** On that reason, suppress the error, then `disconnect()` and `connect()` after a
  short delay. Only a second failure should surface.

## Not yet checked

- The iframe side of `flush`, IME composition and the XLSX input commit (`src/office-runtime/`)
  under `set-capabilities canEdit: false`, including a flush that outlasts the 10 s window.
- The eviction and compaction paths that share the handoff lock (`capy:collaboration:evicting:*`)
  and the failed-store runner under the new save queue.
- Multi-instance behaviour through the Redis extension with real instances: a late `ready` hset
  after the publisher's `del`, `activeInstances` membership, and a `complete` arriving while
  another instance is still persisting.
- `e2e:slow` Office journeys and `pnpm typecheck` were not run. Mock scenarios under MSW
  (`scenarioJourneys.ts`) were not run.
- Whether the openwiki text matches every edge. It was only read for the handoff, banner, draft
  and worker paragraphs.
- The agent-edit path (`applyEdit`) through the receipt-only checkpoint response. Its test
  passes, but the path was not read in depth.

## Summary

C1 implements all seven plan items, and the main flows behave as the records say. A started
handoff completes: silent editors are closed after 10 s and a disconnect no longer fails it.
Epoch changes show the banner or recovery without a remount. Drafts skip covered writes and
store the base once. The worker queue times calls from send. The per-room save queue passes
failures to every caller that shares it. Two defects need fixing before C1 is relied on.
First, the dedicated marker client id makes the next marker's id predictable. Neither the new
decoded check nor the old copy-based one rejects references to markers not yet written, so any
writer can erase or forge provenance with one crafted update. Every later store then skips
persistence while clients are told their edits were saved, which is silent data loss; this is
reproduced, and the parent commit resists it. Second, the trap-only restart rule is defeated,
because `dispose()` in `finally` replaces the `RuntimeError` with a plain wasm-bindgen error,
so a poisoned engine stays in service. The rest is test coverage of the risky paths, and a few
low-severity edges in the save queue, `handedOff`, the checkpoint read-back and the draft
upgrade. For the two decided questions, the measurements say the 60 s target needs the lock and
watchdog resized and is tight for a cold worker on the rich XLSX fixture. They also show the
provider already retries a refused reconnect, but only after about 30 s, and shows "permission-denied"
until then.
