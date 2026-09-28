# Office save write path: trace, measurements, options

Investigation only. No repo file was changed. Scripts, raw results and logs are
next to this report (`measure_saves.mts`, `measure_fastpath.mts`,
`seed_diff.mts`, `cadence_model.py`, `hourly.py`, `savebench/main.go`,
`results/*.json|log`). The disposable Postgres container and the scratch Go API
were removed after the runs.

## 1. Short answer

- A save today does far more than "write the state". Per save the collaboration
  service fetches the whole durable state from Go (436 KB of JSON for
  `exchange-plan.docx`), decodes and re-encodes the whole Y.Doc twice, runs the
  Office engine over the whole document, and posts the whole state back as
  base64 JSON (another 436 KB). Go wraps both ends in locking transactions
  (36 SQL statements per save), and Postgres rewrites the TOASTed state
  (57.6 KB of WAL for `exchange-plan.docx`, 84 KB for `book-30p.docx`).
- Measured per save (quiet host): DOCX 80-128 ms, PPTX 54-56 ms, XLSX 190 ms to
  1.4 s. Of that, the engine is 30-45 % for DOCX/PPTX and 80-99 % for XLSX; JSON
  and HTTP transport of the full state is most of the rest.
- Save frequency is the multiplier. The browser asks for a checkpoint 1 s after
  every local pause, and Office rooms (unlike Plate rooms) save immediately on
  that request, on top of the 2 s / 10 s server debounce. Modeled: about 320
  saves an hour for one sentence-paced typist, 510 for a dense typist, 700 for
  three typists in one room. That is 22-49 MB of WAL an hour for
  `exchange-plan.docx`.
- A cache is not the fix. Redis in this deployment has no durable persistence
  (default RDB snapshots only, AOF off, anonymous volume). Acknowledging Saved
  from Redis or memory contradicts the recorded decision that Saved requires a
  durable database checkpoint acknowledgment.
- Smallest change with the biggest win: let the automatic 1 s request only
  register a receipt, as Plate already does, and save from a longer server
  debounce (5 s idle, 30 s max). Explicit saves (Ctrl/Cmd+S, File > Save, leave
  Edit, handoff, pause) still flush at once. Modeled saves drop 3-6x (322 → 107,
  514 → 122, 701 → 121 an hour). Every per-save cost drops with them: WAL,
  engine CPU, Go JSON work and bytes. Saved keeps its meaning; it just shows
  ~5 s after the last keystroke instead of ~1-2 s. Two cheap follow-ups: stop
  the blob-refs trigger from jsonb-encoding the whole row on every save, and
  stop round-tripping the full state through the session endpoint.
- Storing the state as a diff against the seed (the other subagent's topic)
  cuts WAL per save 11-18x for DOCX/PPTX (57.6 KB → 5.1 KB for
  `exchange-plan.docx`). With that in place an append-only update log saves
  only ~4 KB more per save, which does not pay for its blast radius.

## 2. Binding constraints (recorded decisions)

- `human/frontend/office-files.md`: "Office saving follows Plate: shared edits
  persist automatically, Saved requires a durable database checkpoint
  acknowledgment, Ctrl/Cmd+S flushes that checkpoint path". Also: a started
  handoff always completes, "the server persists the room once"; a save that
  fails inside the engine reports failure instead of retrying; storage is the
  top priority and the state stores only what users changed.
- `human/backend-storage-quota.md`: an Office source counts its source bytes +
  pending effects + state growth beyond `seed_bytes`.
- `human/agentic-retrieval.md` line 26: source evidence is the last indexed
  checkpoint plus exact net changes "through the latest durable editing
  checkpoint". Line 27: refresh at ~3,000 trimmed net tokens after 60 s without
  edits, or 7 days.
- `human/frontend/plate-editor.md`: no decision on debounce values. The Plate
  model itself: the browser's 1 s `checkpoint-request` only registers a
  receipt; the server debounce does the store
  (`src/features/notes/NoteEditorCore.tsx:69,593-626`,
  `collaboration/src/server.ts:763-769`).

## 3. End-to-end trace

### 3.1 What triggers a save

| Trigger | Where | What runs |
| --- | --- | --- |
| Browser auto request, 1 s after the last local Yjs update (timer reset on every update) | `src/features/files/useSourceSession.ts:505-521` (`timer = setTimeout(checkpoint, 1000)` at 520), `checkpoint()` 305-313 | stateless `checkpoint-request` → `server.ts:770-774` calls `persistSource(document)` immediately for source rooms (material rooms only register the id, 763-769) |
| Browser sync (open Edit) | `useSourceSession.ts:449-455` (`onSynced` → `checkpoint()`) | same immediate save; with only a contributor marker it answers with the current checkpoint after a full bootstrap + merge |
| Explicit save: Ctrl/Cmd+S, DOCX File > Save, PPTX save button, XLSX save, leave Edit, export | `useSourceSession.ts:133-146` (`save()` → `active.checkpoint()`) | same immediate save; resolves on the receipt |
| Server debounce | Hocuspocus `debounce: 2000`, `maxDebounce: 10000` (`collaboration/src/config.ts:104-111`, `server.ts:651,658`) → `onStoreDocument` (`server.ts:776-785`) → `persistSource` | heavy only if new contributor markers exist, else one `SELECT checkpoint` |
| Room unload (last connection closed) | `unloadImmediately: false` (`server.ts:888`): the pending debounce fires on schedule, then the room unloads | same as debounce |
| Publication handoff | `sourceHandoff.ts:214-264` (`flush` → `this.persist(document)` at 263) | one save after writers answer ready |
| Maintenance pause | `server.ts:1765-1791` → `sourceHandoff.pause` → `flush` | one save |
| Failed-store retry | `server.ts:1365-1400`, every 5 s (`server.ts:1512`) | `sources.store` on the retained snapshot |
| Agent edit / Undo | `server.ts:1280-1292` → `SourceDocumentStore.applyEdit` (`sourceDocuments.ts:819-939`) | its own full commit (engine apply + effects + checkpoint); the live room then gets the update with origin `'service-edit'`, so the next room save finds no markers and is cheap |
| Shutdown | `server.ts:1799-1812` → `server.destroy()` flushes pending stores and waits for unload | debounced saves run immediately |

Every save goes through `persistSource` (`server.ts:917-921`) and a per-room
queue (`roomSaveQueue`, `collaboration/src/persistence.ts:1377-1403`): one save
running, at most one queued, later callers share the queued one. The client
request and the server debounce are not coordinated. In a room with several
typists, requests arrive faster than saves finish and saves run back to back.

### 3.2 One save, step by step (`storeSource` → `storeSnapshot`)

1. `server.ts:923-930`: `Y.encodeStateAsUpdate(room)` and `Y.applyUpdate(snapshot, …)`,
   a full encode plus decode on the main thread (DOCX 6-14 ms).
2. `sourceDocuments.ts:710-721`: read the contributor markers. With none, the
   cheap path runs one `SELECT d.checkpoint …` (713-719) and acknowledges.
3. `removeDocumentContributors(snapshot)` (`contributors.ts:236`).
4. Up to 4 CAS attempts (`sourceDocuments.ts:725-765`):
   - `sessionForRoom` (511-525) → `GET /internal/collaboration/files/{id}/bootstrap`
     (`huma_source_documents.go:85,135-144`) → `Store.SourceSession`
     (`source_documents.go:153-194`) plus a presign of the base URL
     (`huma_source_documents.go:101-111`). **The response always carries the
     full `state` (base64), `pendingEffects` and `indexedBaseline` when stored.**
     Measured: 436 KB for a 322 KB DOCX state.
   - `stateOf` (413-417): base64-decode the state, or `seed(base)` for a NULL state.
   - Merge (727-735): new Y.Doc, apply the durable state, `applyContentUpdate`
     of `encodeStateAsUpdate(snapshot)`, then `encodeStateAsUpdate(merged)`.
     That is a second full decode plus two full encodes (DOCX 10-23 ms).
     Markers alone return the current checkpoint (733-734).
   - `effects` (574-623) on the single shared Office worker
     (`officeRuntime.ts:137-251`, one call in flight for the whole process;
     arguments are structured-cloned, so the base bytes and state are copied on
     every call):
     - DOCX/PPTX: `indexedBaseline` (424-438; cached per base SHA when NULL,
       JSON-decoded from the session when stored), then
       `runOffice('officeBaseline', base, {state})`. The engine's `open()`
       re-parses the whole base package every call (`office-checkpoint.ts:825-1110`;
       DOCX `session.openDocx` 850, PPTX `openCollaborativeFromUpdate` 1045),
       loads the full state, projects the whole document and builds every entry
       (`officeBaseline` 1131-1146). Then `runOffice('compareBaselines', indexed, current)`
       (1148-1187), which clones both entry arrays again (500 entries / 85 KB of JSON
       for `exchange-plan.docx`).
     - XLSX: `runOffice('xlsxPendingEffects', base, {state})`
       (`office-checkpoint.ts:1299-1311`): `XlsxDocument.openCollaborative(baseBytes)`
       (950) parses the whole workbook each call.
     - Then caption carry-over against `session.pendingEffects` (610-621) and
       `trimEffect` (292-321).
   - `seedReport` (441-445): only for the first save over a NULL state.
   - `POST …/checkpoint` (`huma_source_documents.go:87,154-163`, 150 MB body
     limit) with `{actorIds, epoch, expectedCheckpoint, netTokens, pendingEffects, state: base64}`.
     Huma validates the JSON body, then `encoding/json` base64-decodes the state.
     The response is ~88 bytes (checkpoint and optional receipt).
   - A 409 from the CAS re-runs the whole attempt: a fresh bootstrap, merge
     and effects.
5. `server.ts:937-939`: clear the committed markers from the room and broadcast
   `checkpoint-persisted` to the room. The Redis extension also publishes that
   broadcast (`beforeBroadcastStateless`).
6. On failure (`server.ts:940-972`): broadcast `source-checkpoint-failed`.
   Recoverable errors keep the raw room state in `failedStores` for the 5 s
   retry. Engine errors are reported and not retried. Authorization or conflict
   errors evict the room.

### 3.3 SQL per save (from `pg_stat_statements`, track=all)

36 statements per heavy save across two transactions. No NOTIFY fires.

**Bootstrap transaction** (`SourceSession`, `source_documents.go:153-194`):
`pg_advisory_xact_lock(hashtextextended(file))`; `SELECT workspace_id FROM files`;
`SELECT user_id FROM workspaces … FOR UPDATE` (`storage.go:148-159`);
`SELECT … FROM users WHERE id=ANY(owner, actor) ORDER BY id FOR NO KEY UPDATE`
(`account_state.go:224-285`); the actor access check; `SELECT … FROM files … FOR UPDATE`;
`INSERT INTO source_documents … ON CONFLICT DO NOTHING` (no WAL once the row
exists); `SELECT format,…,state,indexed_baseline,pending_effects,net_tokens`
(detoasts and decompresses the full state); the edit-role check; account
access / effective plan tier; `COMMIT`. WAL: three row-lock records, ~160 B.

**Checkpoint transaction** (`SaveSourceCheckpoint`, `source_documents.go:256-360`):
the same `sourceLockTx` with `edit=true` (adds the owner account check); sizes
`SELECT … octet_length(indexed_baseline), seed_bytes, state IS NULL`; the paused
check for agent edits only; `SELECT revision FROM files … FOR UPDATE`; on the
first save `UPDATE files SET source_sha256`; `SELECT octet_length(NULLIF($1::jsonb,'[]')::text)`
(Postgres parses the effects JSON once more); when growth > 0 (almost every
save, since the state grows) `gateStorageTx` (`storage.go:345-377`) re-locks
the owner, computes the effective tier, `SELECT … FROM user_storage … FOR UPDATE`
and `SELECT sum(delta_bytes) FROM user_storage_deltas WHERE user_id`; the
copy-on-write `UPDATE source_refresh_candidates c SET state=d.state …` (0 rows
unless a refresh captured the current checkpoint); then
`UPDATE source_documents SET state=…, pending_effects=…, net_tokens=…, checkpoint=checkpoint+1, last_edited_at=now(), … RETURNING checkpoint`.

Row triggers on that UPDATE (`server/migrations/0001_init.sql`):
- `source_documents_blob_refs_after` → `account_blob_refs('base_blob_path')`
  (3114-3137, 3889-3891). It runs `to_jsonb(OLD)` and `to_jsonb(NEW)` on the
  whole row: it detoasts both states and hex-encodes them into two ~650 KB
  jsonb values, only to compare `base_blob_path`. EXPLAIN ANALYZE: 5.9-12.2 ms
  of a 6.7-15.6 ms UPDATE; with the trigger disabled the UPDATE takes 0.9 ms.
  An effects-only UPDATE still paid 5-28 ms, because `to_jsonb` detoasts the
  unchanged state.
- `source_documents_storage_after` → `account_source_storage` (3909-3925) →
  `append_user_storage_delta` (1769-1784): `ensure_user_storage_row` plus an
  `INSERT INTO user_storage_deltas` whenever `storage_bytes` changes. The
  generated `storage_bytes` column (`0033_office_storage_rule.sql:26-29`)
  re-serializes `pending_effects::text` on every update. That is one ledger row
  per save, folded only by the daily reconciliation (`server/cmd/api/usage_workers.go:56-57`,
  `storage.go:647`), and `gateStorageTx` sums them all on every save.

### 3.4 Redis

- Hocuspocus Redis extension (`server.ts:653-656`; `@hocuspocus/extension-redis`
  4.5.0): every document change publishes a SyncStep1 (`onChange`). Peers
  answer with SyncStep2. Awareness and every `broadcastStateless` (including
  `checkpoint-persisted`) are published too.
- Its `onStoreDocument` takes a Redlock with a 1 s TTL before a *debounced*
  store. If another instance holds it, that instance's store is skipped
  (`SkipFurtherHooksError`). The lock can expire mid-save, because saves take
  0.05-2.5 s. `checkpoint-request` saves bypass this lock entirely; the
  checkpoint CAS is the real guard.
- Capy's own keys: the instance registry hash, the eviction/publication lock
  `capy:collaboration:evicting:<room>` (the handoff holds it up to 180 s,
  `sourceHandoff.ts:23-26,397-399`), handoff acknowledgement hashes, and the
  eviction/handoff channels.
- Nothing in Redis is durable or used as durable state. Production `capy-redis`
  is `redis:7-alpine` with no config, volume or command
  (`deploy/docker-compose.prod.yml:64-73`). Checked on the same image: `save
  3600 1 300 100 60 10000`, `appendonly no`, `maxmemory 0`, `dir /data` on an
  anonymous volume. Production runs one collaboration replica (no `replicas`,
  no `stop_grace_period`).

### 3.5 Outside the save path, but on every keystroke

`beforeHandleMessage` calls `sources.assertConnectionAccess` for **every**
inbound Yjs update (`server.ts:587-592`) → `GET …/access` → `CheckSourceAccess`
(`source_documents.go:221-238`). That is a transaction with the advisory lock,
`workspaces … FOR UPDATE` and `users … FOR NO KEY UPDATE`. Measured 2.9-4.1 ms
and 153 B of WAL steady, 2.1 KB for the first call after a checkpoint (FPIs).
The Office iframe posts one update per local change (`src/office-runtime/main.tsx:138-143`),
so this is about one write-locking transaction per keystroke, and it
serializes the writers of a workspace on the workspace row.

## 4. Measurements

### 4.1 Method

- Disposable `pgvector/pgvector:pg16` in Docker on a random loopback port,
  default WAL settings, the same as production (full_page_writes on,
  wal_compression off, pglz TOAST, checkpoint_timeout 5 min, synchronous_commit on).
  Extra flags: `pg_stat_statements` (track=all), `track_functions=all`, and
  `autovacuum=off` so WAL diffs are clean; VACUUM was measured separately.
- The real Go API, built from the working tree with `go build -overlay` (the
  harness file lives only in the scratchpad), migrated with `store.Migrate`,
  served the internal collaboration routes. Base bytes came from an in-memory
  blob store behind a local URL.
- The real `collaboration/src/sourceDocuments.ts` `SourceDocumentStore.store()`
  plus the real contributor tracker and the real Office worker drove the saves
  (`measure_saves.mts`). A Yjs client with one client id typed 3,000 keystrokes
  (10 % backspaces, six paragraphs or text boxes), saving every 30 keystrokes
  (100 saves). XLSX used engine `set_cell` commits, 2 cells per save (30 / 20 /
  10 saves).
- Per save: wall time, every HTTP call's time and bytes (fetch wrapper), WAL
  as the `pg_current_wal_insert_lsn()` diff on an otherwise idle database, and
  for the first, second and last saves a phase breakdown that replays the same
  steps and `pg_stat_statements` per statement.
- "After CHECKPOINT" is one more save right after `CHECKPOINT`: the full-page-image
  worst case, which production pays once per page every 5 min.
- The host was shared with other sessions (load average 4-10), so wall times
  are noisy. DOCX timings come from a rerun in a quieter period. WAL and bytes
  are deterministic.

### 4.2 Per-save results

| Fixture | Seed state → after session | Stored (pglz) | WAL / save, steady | WAL, first save after CHECKPOINT | HTTP bytes / save (bootstrap response + checkpoint request) | Save wall ms, median (first save) | Engine ms (worker) | Yjs snapshot + merge ms | Go bootstrap / checkpoint ms | `UPDATE source_documents` ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| exchange-plan.docx | 313.0 → 322.3 KB | 51.7 KB | **57.6 KB** | 150 KB | 437 + 436 KB | 128 (215) | 53-59 + compare 1 | 10 + 20 | 7.6 / 31 | 4.9 |
| book-30p.docx | 259.2 → 269.2 KB | 76.2 KB | **84.0 KB** | 196 KB | 364 + 363 KB | 80 (155) | 26-31 + 1 | 6 + 12 | 7 / 27 | 6.0 |
| lecture.pptx | 109.1 → 122.7 KB | 29.1 KB | **32.4 KB** | 95 KB | 168 + 167 KB | 54 (104) | 22-24 + 1 | 5 + 5 | 5 / 17 | 2.7 |
| deck-50.pptx | 161.2 → 175.1 KB | 50.9 KB | **56.4 KB** | 156 KB | 237 + 237 KB | 56 (101) | 15-18 + 2 | 4 + 9 | 10 / 20 | 3.8 |
| course-guide.xlsx | 24.3 → 34.0 KB (60 cells) | 8.6 KB | 11.2 KB | 59 KB | 60 + 61 KB | 628 (670) | **450-570** | 1 + 1 | 13 / 21 | 2.0 |
| cells-10k.xlsx | 4.2 → 9.7 KB (40 cells) | 2.7 KB | 4.9 KB | 41 KB | 23 + 23 KB | 192 (333) | **139-260** | <3 | 8 / 11 | 0.6 |
| cells-100k.xlsx | 4.2 → 6.9 KB (20 cells) | 2.2 KB | 4.1 KB | 37 KB | 14 + 14 KB | 1,371 (2,487) | **1,355-1,949** | <1 | 9 / 17 | 0.4 |

Notes:
- The UPDATE is 85-95 % of each save's WAL. The rest is row locks (~50 B each),
  the ledger insert (239 B) and commits.
- Go handler time beyond SQL: the checkpoint call spent 31 ms against 6 ms of
  SQL for a 436 KB body, and 17 ms against 1.4 ms for a 14 KB body. That is
  roughly 10-15 ms of fixed overhead (handler, commit fsync) plus about
  40-50 ms per MB of base64 JSON (huma validation plus decode). This is derived,
  not measured separately.
- First save of a file whose SHA is not bound yet (a store-only upload): the
  base is downloaded 3-5 times, because `base()` skips the cache when `sha` is
  `''` (`sourceDocuments.ts:380-388`). On B2 that is up to 5 GETs of up to
  30 MiB.
- Dead TOAST: with autovacuum off, 100 saves grew the TOAST relation to
  5.4-7.9 MB for one live ~50-76 KB value. `VACUUM` then wrote 151-359 KB of
  WAL (1.5-3.6 KB per save). Production autovacuum does this work continuously
  and does not shrink the file.
- XLSX states are small (schema 8 overrides), so WAL is small there. The cost
  is the engine re-parsing the workbook on every save.
- Pending-effects JSON is rewritten on every save and grows with the edits
  (15 KB after 60 cell edits in course-guide.xlsx, 6 KB in exchange-plan.docx).

### 4.3 Probes for the options

**Incremental update log (option a).** For each save, the update the save adds
over the durable state was appended to a scratch table.

| Fixture | Median incremental update | Median log-append WAL | Full-rewrite WAL |
| --- | --- | --- | --- |
| exchange-plan.docx | 918 B | 1,160 B | 57.6 KB |
| book-30p.docx | 577 B | 904 B | 84.0 KB |
| lecture.pptx | 801 B | 1,024 B | 32.4 KB |
| deck-50.pptx | 622 B | 888 B | 56.4 KB |
| XLSX (all three) | 288-304 B | 504-536 B | 4.1-11.2 KB |

The probe used `encodeStateAsUpdate(doc, durableStateVector)`. That encoding
carries the document's *entire* delete set, so it grew from 0.5 to 1.4 KB over
the session. A real log should append the merged received updates instead,
which would be smaller still.

**State as a diff against the seed (option f, measured on each session's final state; reconstructs byte-identically).**

| Fixture | Full state | Diff vs seed | Stored diff (pglz) | Rewrite WAL: diff / full |
| --- | --- | --- | --- | --- |
| exchange-plan.docx | 322.3 KB | 9.7 KB | 4.3 KB | **5.1 KB / 55.6 KB** |
| book-30p.docx | 269.2 KB | 10.0 KB | 4.0 KB | 4.5 KB / 82.0 KB |
| lecture.pptx | 122.7 KB | 13.8 KB | 4.2 KB | 4.9 KB / 31.6 KB |
| deck-50.pptx | 175.2 KB | 13.9 KB | 4.0 KB | 4.5 KB / 54.8 KB |
| course-guide.xlsx | 34.1 KB | 9.8 KB | 3.0 KB | 3.6 KB / 9.6 KB |

**Skipping the bootstrap and the merge (option d prototype, `measure_fastpath.mts`).**
Saves alternated with the production path. The prototype posted the snapshot
state with the last known checkpoint as `expectedCheckpoint`.

| Fixture | Production median | Fast path median | Checkpoint request |
| --- | --- | --- | --- |
| exchange-plan.docx | 137 ms | 108 ms (−21 %) | 424 KB, no bootstrap response |
| book-30p.docx | 86 ms | 67 ms (−22 %) | 351 KB |
| lecture.pptx | 57 ms | 45 ms (−20 %) | 151 KB |
| deck-50.pptx | 65 ms | 47 ms (−27 %) | 221 KB |

**Metadata-only updates.** EXPLAIN (ANALYZE, WAL) of `UPDATE source_documents`
without touching `state`: 2.1 KB of WAL (the inline effects JSON rides in the
tuple), and still 5-28 ms of `account_blob_refs`.

### 4.4 Cadence and hourly totals (model, labelled)

`cadence_model.py` simulates a typist: 0.12-0.25 s between keys, 8-20 words per
sentence, pauses between sentences from a mixed distribution. It applies the
exact trigger rules: the client's 1 s request saves immediately and coalesces
through the queue, and the Hocuspocus debounce saves only if edits arrived
since the last save. Save duration is 0.3 s. Results are heavy saves per hour,
the mean of 10-20 seeds:

| Policy | Sentence-paced typist | Dense typist | 3 typists in one room |
| --- | --- | --- | --- |
| Current (client 1 s request + server 2 s / 10 s) | 322 | 514 | 701 |
| Plate-style (client request only registers; server 2 s / 10 s) | 279 | 370 | 354 |
| Server 5 s / 30 s | 107 | 122 | 121 |
| Server 10 s / 60 s | 58 | 63 | – |

Hourly WAL = saves × (WAL/save + vacuum/save) + 12 checkpoints × the FPI
penalty + keystrokes × 153 B of access checks (`hourly.py`):

| Fixture, typist | Current | Plate-style | 5 s / 30 s | 10 s / 60 s |
| --- | --- | --- | --- | --- |
| exchange-plan.docx, sentence-paced | 22.4 MB/h | 19.8 | 9.5 | 6.5 |
| exchange-plan.docx, dense | 34.3 | 25.7 | 10.7 | 7.2 |
| exchange-plan.docx, 3 typists | 49.1 | 28.2 | 14.2 | – |
| book-30p.docx, sentence-paced / 3 typists | 31.5 / 68.6 | 27.7 / 38.2 | 12.7 / 17.8 | 8.4 / – |
| deck-50.pptx, sentence-paced | 22.0 | 19.5 | 9.4 | 6.6 |

Two fixed costs stop scaling down with fewer saves: FPIs after checkpoints
(~1.1 MB/h per busy file) and per-keystroke access checks (~1.9 MB/h per
typist). At 5 s / 30 s these are already about 30 % of the total. With a
seed diff as well, a save costs ~5 KB, the saves themselves drop to about
0.6 MB/h, and the access checks become the largest WAL source.

Worker capacity, from the same cadence: at ~320 saves an hour, one typist uses
this much of the single Office worker: exchange-plan.docx ~18 s/h (0.5 %),
course-guide.xlsx ~160 s/h (4.5 %), cells-100k.xlsx ~440 s/h (12 %). About 8
concurrent large-sheet typists saturate the worker. Every room's save, and so
its Saved, then queues behind them, up to the 2-minute call timeout.

## 5. Options

| Option | Per-save effect (measured basis) | Durability / what Saved means | Multi-instance | Handoff / pause / maintenance | Quota | Effects / net_tokens / chat evidence | Recovery | Effort / blast radius | Needs a new decision? |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **e1. Plate-style triggers**: the automatic 1 s request only registers its receipt id; `flush: true` (explicit saves, onSynced if kept, handoff) still persists at once. If no store is pending, persist now so the receipt cannot strand. | Removes the duplicate trigger. Saves −13 % (sentence-paced), −28 % (dense), −50 % (3 typists). | Unchanged: the receipt is still sent only after the DB commit. Saved appears after the server debounce (~2 s) instead of ~1-1.5 s. | Unchanged (CAS). | Unchanged: handoff and pause call `persist` directly. | Unchanged. | Unchanged. | Unchanged: drafts stay until the receipt. | ~15 lines: `useSourceSession.ts` (a flag on `checkpoint()`), `server.ts` `onStateless`. | No; it brings Office in line with the recorded "follows Plate". Sign-off on the Saved timing is good practice. |
| **e2. Longer debounce** (e.g. 5 s / 30 s) on top of e1, or source-only tiers | Saves ÷3-6: WAL, engine, JSON, HTTP and DB transactions all scale down. | Saved still means durable, shown ~5 s after the last edit. The server memory window grows from ≤10 s to ≤30 s. Unacked edits stay in the browser's IndexedDB draft (250 ms) and resync on reconnect, so no new loss path while the tab stays open; the beforeunload warning covers closing. | Unchanged. | Unchanged (explicit flushes). Shutdown flushes more rooms at once; add a `stop_grace_period` to the collaboration container. | Growth is gated less often, in bigger steps. | `last_edited_at`, `pending_effects` and `net_tokens` lag the live room by ≤5-30 s. The refresh rule needs 60 s idle, so it is unaffected apart from a ≤5 s shift. Chat evidence stays "through the latest durable checkpoint"; that checkpoint is simply ≤30 s older during continuous typing. | As today. | Config: `COLLABORATION_DEBOUNCE_MS` / `MAX_DEBOUNCE_MS`. They are global, so Plate rooms change too unless source rooms get their own timer. | Yes: the timing values, and whether Plate shares them. No recorded decision conflicts. |
| **Trigger fix**: `source_documents_blob_refs_after` fires only when `base_blob_path` changes (`AFTER UPDATE OF base_blob_path` or a `WHEN (OLD.base_blob_path IS DISTINCT FROM NEW.base_blob_path)` clause; INSERT/DELETE unchanged). The same pattern exists on `source_refresh_candidates`. | −4 to −12 ms of Postgres CPU per save (70-90 % of the UPDATE), and no ~1.3 MB of hex/jsonb materialization. WAL unchanged. | – | – | – | – | – | – | One migration. | No (a pure inefficiency), but repo rules say to get a sign-off before fixing. |
| **d. No full-state round trip**: cache per room the last durable checkpoint and effects; POST with `expectedCheckpoint`; on 409, fall back to today's bootstrap + merge. Optionally send the state as `application/octet-stream` instead of base64 inside huma-validated JSON. | −20 to −27 % of save time; bytes per save 2× state → ~1.3× (1× with a raw body). Removes the Go state read (detoast + decompress + base64) and one full Yjs decode. | Unchanged. | Correct: CAS detects another writer (instance, agent edit, publication) and the fallback merges. Conflicts cost the old path. | Unchanged. | Unchanged. | Caption carry-over needs the cached previous effects. | Unchanged. | Medium-small; the Go raw-body endpoint is the bigger half. | No. |
| **f. State as a diff against the seed** (other subagent) | WAL 57.6 → 5.1 KB (exchange-plan), 84 → 4.5 KB (book-30p), 32-56 → ~4.5-4.9 KB (PPTX); bodies ~10-14 KB instead of 150-436 KB. Engine and Yjs CPU unchanged. | Unchanged. | Unchanged. | Readers compose seed + diff; the seed is deterministic and already cached. | `seed_bytes` accounting changes shape (their topic). | Unchanged. | Unchanged. | Their analysis. | Their analysis. |
| **a. Append-only update log as the durable ack**, compacted on idle, unload or a threshold | ~0.5-1.2 KB of WAL per append (measured probe) + ~2 KB if `pending_effects`/`net_tokens`/`checkpoint` still update per save, versus 32-84 KB today. After (f), the gain is only ~4 KB per save. | Saved = durable log row: satisfies the decision. | Easier than today: CRDT updates commute, so appends do not conflict (epoch fence only). | Every reader of `state` must read state + log or force a compaction first: `SourceSession` (browser, viewer, bootstrap), `ViewSourceSession`, `ClaimSourceRefresh` and `CAPTURED_STATE_SQL`, the candidate copy-on-write, `rebasePublication`, `inspect`/`applyEdit`, `resolve`, publish/maintenance writers, the reset migration template. Go cannot merge Yjs, so it would pass lists through. | The generated `storage_bytes` must include log bytes (a trigger or ledger per append). | Unless effects are also decoupled, the engine still runs per append. | Compaction failures need their own retry path. | Large. | Implementation only; the quota rule's meaning is unchanged. Not worth it once (f) lands. |
| **b. Redis or memory write-behind**, durable flush on idle/unload/interval | Removes most DB writes. | **Conflicts** with "Saved requires a durable database checkpoint acknowledgment". Production Redis is not durable (RDB only, AOF off, anonymous volume); a crash loses up to minutes. Worse: receipts clear the IndexedDB drafts (`useSourceSession.ts:271-281`), so an early receipt followed by a lost flush loses edits for good. | Needs flush ownership per room. | Handoff, pause and maintenance "publish all" read the DB and would each need flush-first. | Gating moves to flush time: a refused flush after Saved was shown. | Evidence reads the DB, so it lags until flush. | New failure mode. | Medium. | **Yes**, and it breaks a recorded decision. Not recommended. |
| **c1. Effects off the save path**: compute on idle (≥N s) or on demand for chat/scheduler | The engine is 30-45 % of DOCX/PPTX save time and 80-99 % of XLSX; moves it off most saves. | Unchanged. | – | Publication already recomputes (rebase). | `pending_effects` bytes count toward quota, so gating would lag or need its own gate. | **Conflicts** with evidence "through the latest durable checkpoint" unless chat computes on demand. The scheduler only needs `net_tokens` after 60 s idle, so idle computation suffices for it. | – | Medium. | **Yes** (agentic-retrieval line 26). |
| **c2. Cheaper engine**: keep a parsed base / engine session per room in the worker, apply incremental updates, recompute only changed entries (or at least stop re-parsing the base each call) | Could take DOCX from ~55 ms and XLSX from 0.5-1.4 s down to a few ms (estimate). | Unchanged. | – | – | – | Unchanged. | Worker restarts drop the caches. | Fork work in BetterOffice, plus memory per open room. | No. |

## 6. Recommendation

**Do e1 + e2 first.** It is the smallest change that cuts every cost at once,
and it keeps Saved's recorded meaning.

1. In `useSourceSession.ts`, give `checkpoint()` a `flush` flag. The idle timer
   (line 520) sends it without the flag; `save()` (133-146) and handoff
   preparation send `flush: true`. In `server.ts` `onStateless` (770-774), call
   `persistSource` only for `flush: true`, or when no store is debounced or
   running for the room, so a receipt can never strand. Otherwise only register
   the id. `storeSource` already claims registered ids (930) and acknowledges
   them (939).
2. Raise the debounce for source rooms to about 5 s idle / 30 s max. Either
   change the global config (which also changes Plate rooms), or give source
   rooms their own timer. Add `stop_grace_period` (e.g. 60 s) to the
   collaboration service in the compose files, so a deploy flushes all rooms.
3. Expected result (model): heavy saves 322 → 107 an hour for one typist and
   701 → 121 for three. For exchange-plan.docx: 18.5 → 6.2 MB/h of save WAL,
   17.7 → 5.9 s/h of engine time, and ~280 → ~93 MB/h of JSON between the
   collaboration service and Go. cells-100k.xlsx worker share drops from 12 % to
   4 % per typist.

**Then, independently of any decision: the trigger fix** (4-12 ms of Postgres
CPU per save), and **option d** (−20-27 % of save time, half the bytes).

**Take option f from the other subagent.** It is what makes each write small
(~5 KB). Once it lands, per-save DB work stops mattering, and an append-only
log is unnecessary. Revisit the engine (c2) only if XLSX load shows up; e1 + e2
already divide it by 3-6.

**Do not** use Redis or memory write-behind as the acknowledgment.

### Needs a user decision

- The new Saved latency and debounce values (e.g. 5 s / 30 s), and whether Plate
  rooms share them. This does not conflict with a recorded decision; e1 aligns
  Office with the recorded "follows Plate".
- Only if pursued: acknowledging Saved from Redis or memory (b) contradicts
  "Saved requires a durable database checkpoint acknowledgment".
- Only if pursued: computing effects off the save path (c1) contradicts
  evidence "through the latest durable editing checkpoint" (agentic-retrieval
  line 26), and it moves quota gating of effects bytes.
- The trigger fix and option d change no behaviour. Repo rules still say
  implementation issues get a recorded sign-off before being fixed.

## 7. Other findings

1. `account_blob_refs` detoasts and hex-encodes the full `source_documents` row
   twice on every save (`0001_init.sql:3114-3137`). The same trigger shape is on
   `source_refresh_candidates`, which also holds a `state`.
2. `SourceDocumentStore.base()` bypasses the base cache while the SHA is unbound
   (`sourceDocuments.ts:380-388`): 3-5 base downloads on the first save of a
   store-only upload.
3. A per-keystroke `CheckSourceAccess` transaction takes `workspaces … FOR UPDATE`
   (`server.ts:587-592`, `source_documents.go:221-238`, `storage.go:148-159`):
   ~3 ms, 153 B of WAL each, and it serializes a workspace's writers. After e2 +
   f it becomes the largest WAL source while typing (~1.9 MB/h per typist).
   Caching the check per connection for a few seconds, relying on the existing
   ACL eviction events, would remove it, but that needs a decision.
4. One Office worker per process (`officeRuntime.ts:137-251`) serializes every
   room's effects. A single cells-100k save holds it for 1.4-2.5 s.
5. The full Yjs encode/decode of the snapshot and merge (10-35 ms for DOCX) runs
   on the collaboration main thread on every save.
6. `user_storage_deltas` gets one row per save until the daily reconciliation,
   and `gateStorageTx` sums them all on every save.
7. The Redis extension's store lock TTL (1 s) is shorter than many saves. This
   only matters with more than one collaboration replica.
8. A diff made with `Y.encodeStateAsUpdate(doc, stateVector)` includes the whole
   delete set. Any log design should append the received updates instead.
