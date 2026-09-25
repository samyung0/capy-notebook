# C1 fixes, recheck

Date: 2026-09-25. Scope: the uncommitted C1 fixes in the working tree on top of `a26c7ddc`,
checked against findings 1, 2, 3, 4, 5 and 7 of `review-c1.md`, any regression the fixes
introduce, and the two decided follow-ups against record 20 of `human/frontend/office-files.md`.
Finding 6, the gateway and pipeline timeouts, and the cross-instance marker gap are out of scope.
Nothing in the repository was changed apart from this file.

## Result

| Finding | Status |
| --- | --- |
| 1. Markers can be deleted or forged | Fixed for a single instance. The origin rule has no test of its own. |
| 2. Trap masked by `dispose()` | Fixed |
| 3. Missing tests | Partly fixed |
| 4. Save shared across Document instances | Fixed |
| 5. Stale `handedOff` | Fixed, with the accepted cost described below |
| 7. Draft database upgrade | Partly fixed: the message is localized, the rest is unchanged |
| Record 20 follow-ups | Match the record |
| Regressions from the fixes | None found |

## What was run

- `pnpm test:collaboration`: 22 files, 140 tests pass.
- `vitest run src/features/files src/mocks/collaboration.test.ts`: 13 files, 47 tests pass.
- `tsc --noEmit` on `collaboration/tsconfig.json` and the root `tsconfig.json`: no errors.
- Scratch scripts, kept outside the repository:
  - `marker-bypass.mjs` and `marker-recheck.mjs` run crafted and honest updates against the
    working-tree `contributors.ts`, and against the `a26c7ddc` copy for comparison.
  - `forged-test-ds.mjs` rebuilds one committed test's update to see what it actually tests.
  - `auth-retry-fix.mjs` copies the `createSourceProvider` wrapper verbatim and runs it against a
    real `@hocuspocus/server` 4.5.0 and `@hocuspocus/provider` 3.4.4.

## Per finding

### 1. Fixed for a single instance

The fix is in `collaboration/src/contributors.ts`:

- `:87` and `:161`: each room's current marker client is recorded.
- `:110`: an origin or right origin on the marker client counts as a marker, at any clock.
- `:118`: any struct under the marker client that the room does not hold is rejected, GC and
  Skip structs included.
- `:130-133`: a delete range on the marker client that reaches past the held clock is rejected.

Measured:

- **The original attacks are rejected.** Both `review-c1.md` attacks are now refused with "client
  update changed collaboration metadata". The room text is unchanged, and a later honest edit
  keeps its marker (`[ 'u_honest' ]`).
- **The origin rule works on its own.** I hand-encoded an update holding a single item whose
  origin is the next marker clock, with an empty delete set. The fix rejects it; `a26c7ddc`
  accepted it.
- **Honest flows still pass.** Edits from two clients, a full state resent after a store cleared
  the markers, and an offline client's diff with its whole delete set are all accepted.

**Test gap:** `contributors.test.ts:141` does not pin the origin rule. Its `forged` update (`:159`)
also deletes the stand-in marker at `(marker, held)`, so the delete-range rule alone already
rejects it. `forged-test-ds.mjs` shows the delete set `[[1, 1]]` with held clock 1. The test
would still pass if the origin rule were removed. The code itself is correct.

### 2. Fixed

- `collaboration/src/officeRuntime.ts:121-122` defines `BROKEN_OBJECT`. `:165` restarts the
  worker on a trap or on a matching message.
- All three strings are present in the pinned `docx.wasm`, `xlsx.wasm` and `pptx.wasm`:
  "attempted to take ownership of Rust value while it was borrowed", "recursive use of an object
  detected" and "null pointer passed to rust".
- `officeRuntime.test.ts:50` checks that a refusal keeps the worker and a broken-object error
  replaces it.
- Still not reproduced with a real trap.

### 3. Partly fixed

Now covered:

- **Office worker:** `officeRuntime.test.ts:50` and `:72` cover a refusal against a broken
  object, and a timeout where the queue moves to a new worker and the late result is dropped.
- **Save queue:** `persistence.test.ts:738` covers one running and one queued save, and a failure
  reaching every caller that shares it. `:752` covers a reloaded document.
- **Size estimate:** `persistence.test.ts:771` covers the GC over-count and the exact measurement,
  through `updateFitsRoom`.
- **Handoff:**
  - `sourceHandoff.test.ts:213`: a ready and a silent editor, where only the silent one is closed.
  - `:258`: a 40 s persist inside the 60 s wait.
  - `:270`: a real server and provider receive `source-publishing`.
- **Publishing retry:** `sourceProvider.test.ts:49` and `:66`, with the provider mocked.
- **Client predicate:** `sourceCheckpoint.test.ts:26` tests `sourceChangesCovered`: silent
  editor to recovery, ready editor to banner, drafts skipped only for receipts.

Still missing:

- The stateless `recoverable: false` rejection sent before the close (`server.ts:551-568`).
- A persist failure after the window, and the cancel that follows.
- The client flow itself: `prepare` to ready, and `replace()` through the stateless path and
  the token path. Only the predicate is tested.
- An isolated test for the origin rule (see 1).

### 4. Fixed

- `collaboration/src/persistence.ts:1293` shares a queued save only when
  `saves.document === document`. Otherwise it chains a new save behind the tail (`:1294-1305`).
- `server.ts:833` routes source saves through it: `persistSource = roomSaveQueue(storeSource)`.
- Test: `persistence.test.ts:752`.

### 5. Fixed

In `src/features/files/useSourceSession.ts`:

- `:308-309`: every disconnect counts and clears `handedOff`.
- `:349` and `:360`: a `prepare` that saw a disconnect sends no ready.
- `:363`: `handedOff` is set only on the connection the server waits on.

Why a connected ready editor still gets the banner:

- The service sends `source-epoch-changed` before `closeConnections`, on the same socket.
- `closeConnections` sends a document CLOSE message, not a socket close, so no `disconnect`
  fires first.

Accepted cost: a ready editor that disconnects before it learns of the new epoch now lands in
recovery instead of under the banner. It gets a false recovery prompt; no data is lost.

### 7. Partly fixed

- **Missing base.** The message is localized (`sourceDraft.ts:109`, plus new `en` and `zh`
  strings). The session load still fails into status `error`, though, and Discard is offered only
  in `recovery` (`DocxView.tsx:116`, `SourceTextView.tsx:115`). If a base is ever missing, the
  file still cannot be opened in Edit. It is practically unreachable, because each draft and its
  base are written and removed in one transaction.
- **Not addressed:** old tabs fail draft writes with `VersionError` until reloaded. This is
  transitional.
- **Not addressed, theoretical:** a base stored under an empty SHA is shared by any never-seeded
  lineage.
- **Unchanged, allowed by the ground rules:** v2 drafts are dropped on upgrade.

## Decided follow-ups against record 20

**60 s acknowledgement wait: matches the record.**

- `sourceHandoff.ts:23` sets `ACK_WAIT_MS = 60_000`, used at `:344`.
- The lock is `ACK_WAIT_MS + CALL_TIMEOUT_MS` = 180 s (`:24`, `:328`).
- The watchdog is the lock plus 5 s = 185 s (`:25`, `:203`).
- `officeRuntime.ts` imports only `node:worker_threads`, so there is no import cycle and
  `LOCK_MS` is 180 000 when the module loads.
- The 10 s ready window is unchanged (`:22`).

**Refused editor retries quietly once: matches the record.**

- **Server:**
  - `server.ts:608-612` throws `SourcePublishingError` for source rooms while the lock is held.
    Its `reason` is `source-publishing` (`sourceHandoff.ts:30-35`), which Hocuspocus forwards to
    the client (`sourceHandoff.test.ts:270`).
  - Source rooms take that lock only to publish: `sourceHandoff.ts:327` is the only source-room
    writer, and compaction locks only material rooms.
- **Client, publishing refusal:** `sourceProvider.ts:39-72` handles the first refusal with a
  disconnect and a reconnect after 3 s, without calling the session. A second refusal reaches
  `useSourceSession.ts:297-304`, which shows `source_edit_publishing`.
- **Client, other refusals:** they are passed straight on, so they show as before.

Measured on a real server and provider, with the wrapper copied verbatim:

| Lock held | Refused | Retry | Outcome |
| --- | --- | --- | --- |
| 2 s | 1.3 s | 4.3 s | Re-authenticated and synced; no error shown |
| 10 s | 1.3 s | 4.3 s, refused again | Error shown at 4.3 s. After the lock is released at 10.3 s, the provider stays connected but unauthenticated until its own 30 s idle close, and re-authenticates at 37.1 s |

Record 20 does not say what happens after the retry also fails, so the 10 s case is not a finding.
During the quiet retry the session shows the `offline` status, not an error.
