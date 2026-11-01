# B. Local-first opens and a one-room workspace canvas

Written 2026-11-01 for the planned workspace canvas. Inputs:

- **Our code:** branch `blocksuite-notes` at `f2ad7b79f`, worktree
  `/Users/sam/web/capy-notebook/.claude/worktrees/blocksuite-notes`.
- **AFFiNE:** `canary` at `8cef09e1dd62` (2026-10-27). I read it from a sparse,
  shallow clone in this session's scratchpad (`affine-src/repo`). Paths below
  are relative to the AFFiNE repo root.

Method:

- Read-only. Nothing in the repo was edited, built, tested or stashed. The
  worktree shows three modified files under
  `bench/collaboration/scripts/layout-box/`. Those belong to the session running
  the RSS rerun, not to me.
- The web search budget ran out early, so the other apps are covered from pages
  and repos I fetched directly. Anything resting on memory or a single weak
  source is marked **unverified**.

---

## 0. Short answers

**Epo's question: does AFFiNE skip the collaboration room when one person is
there? No.**

- **The connection.** AFFiNE always connects. It holds one socket.io socket per
  server, opened when the *workspace* opens, not when a doc opens.
- **The joins.** A lone user still joins the workspace room and a per-doc
  subscription for each doc they open or sync.
- **Awareness.** A lone user still sends awareness on every selection change.
- **Why no loader.** The editor never waits for the socket to get content. Every
  doc renders from the local nbstore copy (IndexedDB on web, SQLite on desktop
  and mobile), and sync runs in a worker in the background.
- **Where AFFiNE does wait on the server:**
  - a device with no local copy;
  - a GraphQL permission check before the page renders, for members who are not
    owner or admin.
- **The server.** AFFiNE's server holds no document in memory at all: it
  appends updates to Postgres and merges them on read.

**Keeping one canvas room cheap.** Our server keeps every joined room's document
loaded in memory until the room is empty and stored.

- **The cost of one Y.Doc.** If the whole canvas is one Y.Doc, every open costs
  the sum of all its notes. At 13.0 MiB per near-limit blocks room, that is
  about 130 MiB for 10 such notes and 650 MiB for 50.
- **The first answer.** Every fresh joiner's first answer is the whole canvas,
  against a per-user open budget of 80 MiB.
- **What keeps it cheap.** "One editor, one room" can stay true for the user if
  the room becomes a namespace over many docs:
  - a small canvas doc, plus per-card docs that join inside the canvas's channel
    only when needed (our `NoteSeat` already does this for embedded quizzes);
  - level of detail, so cards not being read are previews, not rooms.

  Server cost is then the canvas doc plus the one to three notes in use.

**Our loader, and dropping it.** Today the loader waits for these steps, in this
order:

1. a token round trip to Go;
2. the drafts read from IndexedDB;
3. the socket and the JOIN;
4. the room load on the server when it is cold;
5. the full step 2 (the client always joins with an empty Y.Doc);
6. the editor's first paint.

Dropping the loader needs a persistent per-material replica, not just unsaved
drafts. It must be read before the token, and the JOIN must name the replica's
state vector and stored version. Several rules then need decisions: client ids,
lineage, late joins, access before the token, and whether note bodies may be
stored on the device at all (today they are explicitly never stored).

---

## 1. AFFiNE, from its source

### 1.1 The layers

```text
detail page (React)
  └─ DocsService.open(docId) ─► BlockSuite DocImpl.load()
        ├─ onLoadDoc(ydoc)          ─► DocFrontend.connectDoc        (main thread)
        └─ onLoadAwareness(aw)      ─► AwarenessFrontend.connectAwareness
                 │  ops over a MessagePort
nbstore worker (SharedWorker on web; Worker otherwise)
  ├─ local storages: IndexedDB* / Sqlite* (doc, blob, docSync, blobSync, indexer)
  │                  BroadcastChannel awareness (tabs)
  └─ Sync: DocSyncPeer, AwarenessSyncImpl, BlobSync, IndexerSync
        └─ remotes "cloud:<flavour>": CloudDocStorage, CloudAwarenessStorage,
           CloudBlobStorage, CloudIndexerStorage  ── one socket.io socket per server
                                                        │
                       SpaceSyncGateway (NestJS)  ──►  Postgres: snapshots + update rows
```

**Each AFFiNE doc is its own Y.Doc.**

- `DocImpl` creates one per doc id, in
  `packages/frontend/core/src/modules/workspace/impls/doc.ts`.
- The workspace root Y.Doc holds the doc list and its metadata.
- `DocImpl.load()` calls `onLoadDoc(spaceDoc)` and `onLoadAwareness(awareness)`.
- The workspace entity wires these to `engine.doc.connectDoc` and
  `engine.awareness.connectAwareness`
  (`packages/frontend/core/src/modules/workspace/entities/workspace.ts`).

### 1.2 What loads from local storage

**The doc itself.**

- `DocFrontend.connectDoc` schedules a `load` job
  (`packages/common/nbstore/src/frontend/doc.ts`).
- `jobs.load` reads `storage.getDoc(docId)` from the local doc storage and
  applies it with `applyUpdate`.
- The doc is then "loaded" (`connectedDocs`). It is also "ready" (`readyDocs`)
  if the local copy held any data.

**The frontend only ever talks to local storage.**

- Remote changes reach it as local storage updates:
  `storage.subscribeDocUpdate` → `event.onStorageUpdate` → an `apply` job.
- Local edits go `handleDocUpdate` → a `save` job → `storage.pushDocUpdate`.
- There is no direct UI-to-server path for document content.

**The storage is one database per workspace.**

- On web the storages are `IndexedDBDocStorage` and its siblings. The database
  is named `${flavour}:${type}:${id}`
  (`packages/common/nbstore/src/impls/idb/db.ts`).
- It has these stores (`impls/idb/schema.ts`):
  - `snapshots` and `updates`;
  - `clocks` and `peerClocks` (what was pushed to and pulled from each peer);
  - `blobs`, `blobSync` and `blobData`;
  - `locks`;
  - a full-text index (`indexerSync`, `indexerRecords`, `invertedIndex`).
- Tabs hear each other's writes on a BroadcastChannel.
- Desktop and mobile use the `Sqlite*` equivalents. The choice is made by
  `DocStorageType` in
  `packages/frontend/core/src/modules/workspace-engine/impls/cloud.ts`.
- A read squashes the snapshot and its pending updates, then writes a new
  snapshot back (`SnapshotDocStorageBase.getDoc`,
  `packages/common/nbstore/src/storage/doc.ts`).

**Other things cached on the device:**

- **The cloud workspace list.** The `revalidate` effect in
  `workspace-engine/impls/cloud.ts` caches it in `globalState`, per account.
- **The owner/admin flag.** `WorkspacePermissionStore.setWorkspacePermissionCache`
  (`modules/permissions/stores/permission.ts`) stores it in
  `WorkspaceLocalState`, which wraps the persisted `GlobalState`
  (`modules/workspace/impls/storage.ts`).

So a returning device paints the list, the shell and the doc without the network.

### 1.3 When the socket connects, and to what

**At workspace open.**

- `WorkspaceEngine.start()` (`modules/workspace/entities/engine.ts`) calls
  `nbstoreService.openStore(...)`. It then gives the root doc priority 100 and
  starts the doc frontend.
- In the worker, `StoreConsumer.initWithOptions`
  (`packages/common/nbstore/src/worker/store.ts`) connects the local storages,
  then every remote storage, then starts `Sync`.

**One socket per server endpoint.**

- `SocketManager` in `packages/common/nbstore/src/impls/cloud/socket.ts` is
  cached by endpoint (`SOCKET_MANAGER_CACHE`) and reference-counted.
- The doc, awareness, blob and indexer storages of every open workspace all ride
  on it.
- Cloud servers use the websocket transport only.
- socket.io's own reconnection is switched off. `AutoReconnectConnection`
  reconnects instead, with exponential backoff (`connection/connection.ts`).
- On web the store runs in a SharedWorker when the browser has one
  (`packages/frontend/apps/web/src/app.tsx`; the worker entry is
  `apps/web/src/nbstore.worker.ts`). So all tabs share one socket.

**What happens on connect.**

- `CloudDocStorageConnection.doConnect` (`impls/cloud/doc.ts`) sends
  `space:join-batch` for the workspace root doc and builds an id converter.
- It then listens for `space:broadcast-doc-updates` and
  `space:broadcast-doc-invalidation`.
- **To what:** `SpaceSyncGateway`
  (`packages/backend/server/src/core/sync/gateway.ts`).
  - `onJoinSpaceBatch` checks workspace access.
  - It adds the socket to the workspace's socket.io rooms (`sync` and
    `sync-027`).
  - It records one subscription per doc, after a per-doc permission check
    (`Doc.Read` and `Doc.Update`).
  - A batch takes up to 100 docs (`SPACE_JOIN_BATCH_LIMIT`).

**What the sync engine does: `DocSyncPeer.retryLoop`**
(`packages/common/nbstore/src/sync/doc/peer.ts`).

- **Connect.** It waits for the local, remote and sync-metadata connections,
  with a 30 s timeout.
- **Listen.** It subscribes to updates on both sides.
- **Collect docs.** It adds every local doc and loads the cached remote clocks.
  It asks once for every doc timestamp newer than the newest cached clock
  (`space:load-doc-timestamps`, which the server filters by `Doc.Read`). It then
  adds every remote doc.
- **Run jobs.** It runs per-doc jobs (`connect`, `pullAndPush`, `pull`, `push`,
  `save`) from a priority queue:
  - the root doc goes first (`getJobPriority` gives it `Infinity`);
  - the open doc comes next (`addPriority(pageId, 10)` in
    `desktop/pages/workspace/detail-page/detail-page-wrapper.tsx`).
- **No needless requests.** A doc whose clocks already match sends nothing.
- **Diffs, not documents.** `getDocDiff` sends the local state vector with
  `space:load-doc` and gets back only what is missing.
- **Failures.** On error the whole loop retries every 5 s. A permission error
  pauses that one doc only (`runRemoteDocJob`).

AFFiNE therefore replicates every readable doc of the workspace onto every
device, in the background.

### 1.4 Does the UI ever wait on the server?

**With a local copy, not for content.**

- **App shell.** `WorkspacePage` (`desktop/pages/workspace/index.tsx`) shows
  `AppContainer fallback` until the root doc is `ready`
  (`engine.doc.docState$(workspace.id)`). The local read satisfies that.
- **Doc page.** `DetailPageWrapper` (`detail-page-wrapper.tsx`) shows the page
  skeleton until three things hold:
  - the doc record exists (it comes from the root doc);
  - `DocsService.open` has returned (`modules/doc/services/docs.ts`; it calls
    `blockSuiteDoc.load()`);
  - `canAccess` is known.

  It shows a 404 only once the root doc has synced with the server
  (`watchDocListReady` in `modules/doc/stores/docs.ts`). A doc missing locally
  is therefore never a 404 while offline.
- **Editor.** `BlockSuiteEditor` (`blocksuite/block-suite-editor/blocksuite-editor.tsx`)
  shows `EditorLoading` until `page.root` exists (`slots.rootAdded`). It switches
  to a "longer loading" variant after 20 s. Local data gives a root as soon as
  the local read lands.

**Where it does wait on the server:**

- **Access for members who are not owner or admin.**
  - The page's `Component` (`detail-page.tsx`) calls
    `useGuard('Doc_Read', pageId)`.
  - `GuardService.can$` (`modules/permissions/services/guard.ts`) is `true` at
    once when the cached flag says owner or admin.
  - Otherwise it stays undefined, and the skeleton stays, until the GraphQL
    `getDocRolePermissionsQuery` returns (`stores/guard.ts`). That request is
    retried with unlimited backoff.
  - Those doc permissions live in memory only. So every doc a member opens for
    the first time in a session costs one HTTP round trip before anything
    renders.
  - Offline, by the source, it would stay on the skeleton. I read this from the
    code; I did not run it.
  - Epo, as a workspace owner, never hits this.
- **A device with no local copy** (§1.6).

### 1.5 One user alone: connection and awareness

A lone user holds the connection, joins, and sends awareness.

- **The socket** opens with the workspace and stays open while any workspace on
  that server is open (it is reference-counted).
- **Joins happen in three places:**
  - the root doc, at connect;
  - each doc the engine pulls or pushes (`joinDoc` runs before every
    `space:load-doc` and `space:push-doc-update`);
  - each opened doc, through awareness. `CloudAwarenessStorage.subscribeUpdate`
    (`impls/cloud/awareness.ts`) joins the doc with `space:join-batch`, then
    asks for the others' states with `space:load-awarenesses`.
- **Awareness sends.**
  - `AwarenessFrontend.connectAwareness`
    (`packages/common/nbstore/src/frontend/awareness.ts`) forwards every
    awareness `change`; BlockSuite keeps its selection there. They go out as
    `space:update-awareness` whenever the socket is connected.
  - The server relays them to other sockets subscribed to that doc, and to other
    instances through its event bus (`onUpdateAwareness`). Alone, that means to
    nobody.
  - It listens for `change`, not `update`. y-protocols renews its local state
    every 15 s (half its 30 s timeout, `node_modules/y-protocols/awareness.js`,
    1.0.7). Those renewals are not sent unless the state actually changed.
  - Ours sends both: `RoomProvider.awarenessUpdate` forwards every `update`.
- **Edits.** Each edit is saved locally and then pushed
  (`space:push-doc-update`).
  - The server stores it (`onReceiveDocUpdate`) and publishes it
    (`publishDocUpdate`).
  - The workspace room gets only an invalidation with a timestamp; sockets
    subscribed to that doc get the full update.

### 1.6 A new device with no local copy

- **Workspace list.** With no cache, the shell waits for the GraphQL list
  (`getWorkspacesQuery`).
- **App shell.** `AppContainer fallback` stays until the root doc arrives from
  the server. It is pulled first.
- **Doc page.** The skeleton stays until the doc record appears and access
  resolves. The owner flag is not cached yet, so the workspace access request
  (`workspace.access.get` over the socket's realtime channel) runs first.
- **Editor.**
  - `EditorLoading` stays until the doc's pull lands in local storage and is
    applied (priority 10).
  - "Longer loading" shows after 20 s.
  - A failed load is reported to telemetry after 60 s.
- **Everything else.** Meanwhile the peer pulls every other readable doc into
  IndexedDB.

So on first contact AFFiNE waits on the server at three levels: shell, page and
editor.

### 1.7 AFFiNE's server keeps no documents in memory

**Push.**

- `WorkspaceSyncAdapter.push` calls
  `PgWorkspaceDocStorageAdapter.pushDocUpdatesWithContract`
  (`packages/backend/server/src/core/doc/adapters/workspace.ts`).
- That validates the updates (`filterValidDocUpdates`) and appends them as rows,
  ten at a time (`appendWorkspaceDocUpdatesV1`).

**Load.**

- `DocStorageAdapter.getDoc` (`core/doc/storage/doc.ts`) reads the snapshot and
  its pending update rows, under a lock.
- `squashUpdatesToSnapshot` merges them, writes a new snapshot and records the
  old one as history.
- `getDocDiff` then diffs the result against the client's state vector.

**What stays in memory.** Nothing per doc outlives the request except
socket-membership maps. `DocReader` caches derived content only (`reader.ts`).

**Consequence.** An idle doc costs AFFiNE's server nothing. A lone user costs a
socket plus a few map entries, then CPU and database work per push and per load.

### 1.8 Canvas specifics

**An edgeless doc is one Y.Doc.** Its notes and its surface are blocks of that
doc.

**Other docs appear on a canvas as linked-doc cards or synced-doc embeds.**

- Each embedded doc is a separate Y.Doc, loaded when the embed renders.
- `EmbedSyncedDocBlockComponent._load()` calls `syncedDoc.load()` and waits for
  `rootAdded`
  (`blocksuite/affine/blocks/embed-doc/src/embed-synced-doc-block/embed-synced-doc-block.ts`).

**Rendering is viewport-aware** (`blocksuite/framework/std/src/gfx/viewport-element.ts`).

- `gfx-viewport` keeps off-screen blocks "idle": hidden, with their layout kept.
- It can park block views behind comment placeholders.
- During gestures at zoom 0.5 or lower (`LOW_ZOOM_BLOCK_SURVIVAL_THRESHOLD`) it
  keeps only selected and nearby blocks active.
- The data is still fully loaded.

**No size limit found.** I found none for documents in the sync gateway or the
doc storage code I read. The nbstore `OverSizeError` is about files. I found no
published AFFiNE guidance for large edgeless docs; search was unavailable
(**unverified** that none exists).

---

## 2. Other apps: how they open a doc and hide connection latency

| App | Opens from | Connects | Server holds the doc in memory | Offline |
| --- | --- | --- | --- | --- |
| AFFiNE | Local IndexedDB/SQLite replica | Always, at workspace open; background | No (Postgres, merge on read) | Whole workspace replicated |
| Excalidraw | localStorage + IndexedDB | Only in a live room | No (stateless relay; encrypted scene in Firebase) | Solo use is fully local |
| tldraw SDK | `persistenceKey`: IndexedDB. `useSync`: the server | `useSync`: before showing anything | Yes, one room per document | Local mode only |
| Figma | Server copy; client downloads the file | Always | Yes, one process per document, the full file | Open files and loaded pages; IndexedDB queue |
| Miro | **unverified** | | | |
| Linear | Local IndexedDB bootstrap | Delta stream after the local bootstrap | Server-ordered; deltas | Queued transactions in IndexedDB |
| Notion | API; SQLite cache races navigation | Always | n/a | Opt-in, recent and favorite pages |
| Google Docs | Server (cache when offline is on) | Always | n/a | Extension, recent plus chosen files |

**Excalidraw.**

- **Solo open.** The app opens from localStorage (elements and app state, via
  `importFromLocalStorage` in `excalidraw-app/data/localStorage.ts`) and keeps
  files in IndexedDB (`excalidraw-app/data/LocalData.ts`). There is no server
  round trip.
- **Collaboration is on demand.** A `#room=` link or the live-collaboration
  button calls `Collab.startCollaboration` (`excalidraw-app/collab/Collab.tsx`).
  It lazy-imports `socket.io-client` and only then connects.
- **The server is a stateless relay.** `excalidraw-room` is a 153-line socket.io
  relay with join-room, first-in-room and encrypted broadcasts
  (`excalidraw-room/src/index.ts`). The scene is stored encrypted in Firebase
  (`saveToFirebase`).
- **Joining a room does wait.** Joining an existing room resets the scene and
  waits for a peer to send its scene. After 5 s it falls back to Firebase
  (`INITIAL_SCENE_UPDATE_TIMEOUT` in `excalidraw-app/app_constants.ts`). The
  first person in a room loads from Firebase.

**tldraw.**

- **Two separate modes.**
  - `persistenceKey` keeps the document and its assets in IndexedDB and syncs
    across tabs (tldraw.dev/docs/persistence).
  - `useSync` (`packages/sync/src/useSync.ts`) is `loading` while it connects
    and loads the initial state. Its result type excludes the local-only states,
    and its own documentation example renders a "connecting" message.
- **The server.** It is one `TLSocketRoom` per document holding the
  authoritative copy. The Cloudflare template gives each room a Durable Object
  with SQLite storage (tldraw.dev/docs/sync).
- **Limits.** By default 4,000 shapes per page and 40 pages
  (`defaultTldrawOptions` in `packages/editor/src/lib/options.ts`).

**Figma.**

- **Multiplayer**
  (figma.com/blog/how-figmas-multiplayer-technology-works):
  - the client downloads the file;
  - property changes apply locally at once;
  - each multiplayer document gets its own server process;
  - offline edits are reapplied on reconnect.
- **The Rust rewrite** (figma.com/blog/rust-in-production-at-figma): a child
  process per document became affordable through low memory use, and each
  document lives on one worker.
- **Dynamic page loading**
  (figma.com/blog/speeding-up-file-load-times-one-page-at-a-time):
  - only the selected page and its dependencies load first;
  - the multiplayer server still decodes the file and holds the full file plus
    its QueryGraph in memory;
  - the savings are on the client: 70% fewer nodes in client memory, 33% fewer
    out-of-memory errors, 33% faster for the slowest 5% of loads.
- **Offline** ("What can I do offline in Figma?",
  help.figma.com/hc/en-us/articles/360040328553):
  - you can keep working in open files and in pages already loaded;
  - changes go to the browser's IndexedDB and survive closing the tab;
  - they are kept up to 30 days (7 on Safari).

**Miro: unverified.** help.miro.com answered 403 to every fetch, and search was
unavailable. I have no reliable board object limit.

**Linear.** The main source is wzhudev's reverse-engineering write-up,
`github.com/wzhudev/reverse-linear-sync-engine`, which Linear's CTO endorsed
publicly. The official talk page (linear.app/now/scaling-the-linear-sync-engine)
holds no details.

- There are three bootstrap kinds: full, partial and local. The client builds
  and fills an IndexedDB database.
- Each model has a load strategy: `instant`, `lazy`, `partial` (for example
  document content), `explicitlyRequested` or `local`.
- The server orders all transactions and broadcasts delta packets carrying sync
  ids. A client compares its `lastSyncId` with the server's.
- Offline transactions are cached in IndexedDB and resent.

**Notion.**

- **The cache**
  (notion.com/blog/how-we-sped-up-notion-in-the-browser-with-wasm-sqlite):
  - a browser SQLite database (WASM on OPFS);
  - one active tab chosen through a SharedWorker, with Web Locks;
  - it races navigation reads against the API: navigation about 20% faster, more
    in slow regions;
  - the initial page load is seldom served from SQLite.
- **Offline mode** (notion.com/blog/how-we-made-notion-available-offline):
  - the cache became a persistent layer that records which pages are offline
    and why: chosen, visited recently, favorites, or inherited (a database keeps
    up to 50 pages of its view);
  - updates are pushed on per-page channels;
  - a reconnect compares timestamps;
  - offline pages move to a CRDT model.

**Google Docs** (support.google.com/docs/answer/6388102).

- It needs Chrome or Edge, the Docs Offline extension, and the setting turned on
  in Drive.
- Some recent files go offline automatically; others are chosen per file.
- Files too large to sync should be split.

**What they have in common:**

- Every app that shows no "connecting" state opens from a local copy: AFFiNE,
  Excalidraw solo, Figma's open files, Linear, Notion's navigation.
- Those that open from the server show a state: tldraw sync, Excalidraw joining
  a room, AFFiNE on a new device.
- Servers that keep documents in memory do it per document and bound the size
  per document: Figma's per-file process and 2 GB tab limit; tldraw's room and
  shape caps. AFFiNE avoids server memory altogether.

---

## 3. Scale of "one canvas = one room"

### 3.1 Published limits and guidance

| Product | Unit of memory | Limit or guidance | Source |
| --- | --- | --- | --- |
| Figma | One file (server process; browser tab) | 2 GB memory per tab; red alert at 90%, file locked at 100%; split large files | help.figma.com/hc/en-us/articles/360040528173 |
| tldraw | One room per document | 4,000 shapes per page, 40 pages (defaults) | `packages/editor/src/lib/options.ts` |
| Miro | Board | **unverified** (help center 403) | — |
| AFFiNE | One Y.Doc per doc; synced docs are separate Y.Docs loaded on demand | No size limit found in sync/storage code; viewport idles off-screen blocks | §1.8 |
| Heptabase | Cards are separate entities | Cards live in the Card Library; whiteboards hold references and do not own cards; one card can sit on several whiteboards | wiki.heptabase.com/fundamental-elements |
| Google Docs | One file | Split a file too large to sync offline | support.google.com/docs/answer/6388102 |

**Our own bounds:**

- **A material:** 2 MiB of normalized JSON, 10,000 nodes, depth 16
  (`openwiki/backend-storage-quota.md`, "Material bytes vs plan quota"). They
  gate writes only.
- **A note room's Yjs history** is not capped; heavy editing costs load time and
  memory (same doc, "Yjs storage growth").
- **A sync message:** at most 4 MiB (`NOTE_MAX_SYNC_BYTES`,
  `collaboration-rs/crates/server/src/room.rs`).
- **Awareness:** at most 4 KiB per state and 256 client ids per room
  (`room.rs`).

**Measured cost per room (near-limit note, about 2 MB and 7.4k nodes):**

| Measure | Plate | Blocks | Source |
| --- | --- | --- | --- |
| Heap held while idle | 7.0 MiB | 13.0 MiB (15.9 before the trimmed format) | `todo-blocksuite-spike.md:932`, `:942-946` |
| Peak during a full check (before the bound) | — | about 41 MiB | `todo-blocksuite-spike.md:528` |
| Room load | 71 ms | 560 ms | `todo-blocksuite-spike.md:450` |
| A joiner's step-1 answer | 5 ms | 9 ms | `todo-blocksuite-spike.md:450` |

- **Laptop RSS:** 20 idle near-limit blocks rooms peaked at 0.7 GiB RSS on the
  laptop with macOS malloc (`bench/collaboration/scripts/layout-box/README.md`).
  The box rerun is pending.
- **Per idle connection:** about 128 KiB
  (`bench/collaboration/reports/2026-10-11-prod-capacity-rust.md:201`).
- **The box:** 4 vCPU and 7.6 GiB RAM
  (`bench/gateway/reports/2026-10-24-gateway-capacity.md:74`). Collaboration is
  pinned to cores 2-3 and has no memory limit (`openwiki/deployment-runbook.md:707`).
- **Browser, near-limit note** (GHA, third tuning round,
  `todo-blocksuite-spike.md:428-436`):
  - JS heap after open: BlockSuite 273 MB, Plate 336 MB;
  - open: about 13 s.
  - An embedded quiz island adds about 6 MB once loaded and about 80 KB off
    screen (`todo-blocksuite-spike.md:262-265`).

### 3.2 Architectures

**A. One Y.Doc for the whole canvas.** Every note, quiz and card sits as blocks
in one document (AFFiNE's own edgeless model, applied to a whole workspace).

- **Server.** The room holds the entire canvas, on every open, for as long as
  anyone is joined. It unloads only when empty and stored (`Room::unloadable`).
  The editor's tab sleeps after 60 minutes without input (`src/features/collaboration/idle.ts`).
- **Every join.** Each fresh joiner's step 1 is answered with the whole state.
  That is charged to the user's open budget: 80 MiB, refilling over 300 s, about
  0.27 MiB/s (`collaboration-rs/crates/server/src/rate.rs`).
- **Every edit.** The full room check, the projection after 30 s idle, and
  folds and collection all scale with the whole canvas.
- **Bounds.** Either the 2 MiB / 10,000-node bound applies to the canvas, so the
  whole workspace fits in one near-limit note's worth of content. Or the bounds
  must grow, and memory grows with them.
- **Undo.** One history covers the canvas. Cross-card steps (move a card, edit
  its text) are natural. BlockSuite's history captures the client id at
  construction (`todo-blocksuite-spike.md`, "Client ids").
- **Search and retrieval.** Indexing is per material today
  (`openwiki/agentic-retrieval.md`). A one-material canvas needs splitting by
  block for chunks and citations. Each projection walks the whole canvas.
- **Permissions.** One ACL covers everything. One note cannot be shared alone.
  A quiz's answer keys already live in a separate keys document so that readers
  cannot see them (`ItemRoomOptions.document = 'keys'` in `itemRoom.ts`), so
  quizzes cannot fully live in the canvas doc anyway.
- **Offline.** One replica: simple, but all or nothing, and large.
- **Client.** One store holds every note's model. One near-limit note already
  takes about 273 MB of heap, and that multiplies with N unless the editor loads
  lazily.

**B. A small canvas doc plus per-card docs, lazily loaded over one connection.**
The canvas doc holds positions, sizes, z-order, frames, connectors and a
reference to each card's material. Each note, quiz or set stays its own doc and
room, joined only when needed.

How the existing systems do this:

- **Yjs subdocuments** (docs.yjs.dev/api/subdocuments):
  - a subdoc is empty until `load()`;
  - providers must sync subdocs themselves and may use the guid as a room name;
  - the docs note that not every provider supports them;
  - the vendored yrs has subdoc APIs (`SubdocsEvent`, `subdocs()` in
    `vendor/betteroffice/third_party/yrs/src`), but our protocol and rooms do
    not use them.
- **Hocuspocus:**
  - one `HocuspocusProviderWebsocket` can be shared by many documents' providers
    (tiptap.dev/docs/hocuspocus/provider/configuration);
  - Yjs subdocuments are not supported (tiptap.dev/docs/hocuspocus/guides/multi-subdocuments);
  - so it amounts to many docs over one socket, each with its own name and auth.
- **AFFiNE:**
  - many docs on one socket;
  - `space:join-batch` authorizes up to 100 docs at once, with a per-doc
    permission check;
  - a workspace-level invalidation plus per-doc update streams.
- **A BlockSuite workspace with many docs:** the canvas is one doc, and cards are
  synced-doc embeds of other docs (§1.8).
- **Ours today:**
  - embedded quizzes and sets join inside their note's channel through
    `NoteSeat` (`src/features/collaboration/noteSeat.ts`);
  - only within about a viewport of the screen, lingering 30 s
    (`useNearScreen.ts`);
  - they do not count toward the user's 22 joined documents;
  - a note holds at most 64 of them (`EMBEDS_PER_NOTE` in
    `collaboration-rs/crates/server/src/socket.rs`).

The trade-offs:

- **Server.** The cost is the canvas room plus the rooms joined right now, not
  the sum of the canvas.
- **Undo.** Each doc keeps its own history. A step that spans docs needs a
  canvas-level coordinator. There is a precedent: an agent step spanning a
  quiz's content and keys document ends as a whole (`plate-editor.md`, "Agent
  holds").
- **Search.** Per material, as today.
- **Permissions.** Per doc. A note can be shared alone, keys stay separate, and a
  card the viewer cannot read shows as locked.
- **Offline.** Replicate the canvas plus a chosen set of docs (recent and pinned,
  as Notion and Google Docs do) or all of them (as AFFiNE does).

**C. Viewport-based loading.** Join a card's room only while the card is on or
near screen (`useNearScreen`: `rootMargin` 100%, a 30 s linger).

- **Server.** This cuts cost only in B. In A the server still holds the whole
  doc, and a viewport only trims client rendering. Figma's dynamic loading shows
  this: its server still holds the full file.
- **The risk.** A zoomed-out view of 40 cards joins 40 rooms: about 520 MiB if
  they are near-limit notes. It also hits the 64-embed cap, eight pending joins
  per socket, and one token request per card.

**D. Level of detail.**

- **Below a zoom threshold, or off focus,** a card renders from what is already
  stored, with no room joined:
  - the material's projection or its `preview` JSON;
  - its thumbnail (`openwiki/thumbnails.md`);
  - the replica (§4.4).
- **A room joins** when the card is opened, focused, or readable on screen, up
  to a small cap (for example three to eight).
- **BlockSuite already does the rendering side:** idle and parked off-screen
  blocks, and fewer active blocks at zoom 0.5 or lower (§1.8).
- **The result.** Server cost follows what people actually read and edit, not
  canvas size.

**E. A stateless document server, AFFiNE-style.** No in-memory document per
room: append updates, merge on read, fan out.

- **Memory.** An idle doc costs about nothing.
- **The catch.** Our admission needs the document in memory. That covers
  structural and limit checks, the blocks bound, client ids, sessions and held
  deletions, in-place collection, markers and projection. This would be a
  redesign of `room.rs`, not a tweak.
- **A smaller step, for the Rust harness to judge (unverified feasibility):**
  - joins for View mode load nothing; a Plate note's View already requests no
    token (`plate-editor.md:202`);
  - a room with one idle member unloads after a few quiet minutes and reloads on
    its next message.

### 3.3 The architectures side by side

| | A: one Y.Doc | B: canvas plus card docs | B + C + D | E: stateless server |
| --- | --- | --- | --- | --- |
| Server RAM per open canvas | Sum of all cards | Canvas plus joined cards | Canvas plus 1-3 cards | About 0 when idle |
| First answer to a joiner | Whole canvas | Canvas plus each joined card | Canvas plus focused card | Diff from Postgres |
| Undo | One history | Per doc plus a coordinator | Same | Same as the doc model |
| Search and agents | Split the canvas by block | Per material, as today | Same | Same |
| Permissions | One ACL; keys docs stay separate anyway | Per doc | Same | Same |
| Offline | One replica | Canvas plus chosen docs | Previews plus chosen docs | Same as B |
| Work | Raise bounds, whole-canvas checks | Child joins, batch tokens, cross-doc undo | Plus previews and zoom rules | Rewrite admission |

---

## 4. Our code

### 4.1 What the BlockSuite note's loader waits on

The files are `src/features/notes/blocksuite/BlockSuiteNote.tsx` and
`blocksRoom.ts`, plus `src/features/collaboration/itemRoom.ts`,
`roomProvider.ts` and `socket.ts`.

1. **The account id.** `useBlocksRooms` creates no room until `useMe()` gives
   `actorId`, since drafts are kept per account. `FileLoading` shows meanwhile.
   `/me` is a persisted query, so this is usually instant.
2. **The token.** `ItemRoom.start()` calls `getMaterialCollaborationToken`: one
   HTTP request to Go.
   - Go's `createMaterialCollaborationToken`
     (`server/internal/httpapi/huma_collaboration.go`) runs about seven store
     reads: role, owner access, account access, storage, me, room and parent.
   - It mints a JWT carrying the room, the access and a fresh client id. A
     `previousToken` re-grants the same id (Q236).
   - The 30 s join clock starts here (`reconnector.started()`).
3. **The drafts.** `ItemRoom.restore()` reads the stored drafts from IndexedDB
   through the drafts worker (`readDrafts`). It groups them (`draftGroups`),
   applies this lineage's rows (`applyDrafts`), and starts recording
   (`recordDrafts`). Other lineages and refused rows open as copy-only recovery.
4. **The socket and the JOIN.**
   - `RoomProvider.connect()` waits first on `beforeJoin`, the draft send of
     never-accepted steps, if there are any.
   - It joins on the tab's `CollabSocket.for(url)`, opening the WebSocket if no
     room holds it. `IDLE_CLOSE_MS` closes it 5 s after the last room leaves.
     `CollabSocket.warm` is used only by Office sources
     (`src/features/files/sourceProvider.ts:77`).
   - On the server the JOIN checks the token and access, takes the user's seat,
     and loads the room from Postgres if it is cold: base plus log rows, then a
     replay (blocks, near-limit: about 560 ms on the laptop).
5. **Sync.**
   - `joined()` sends step 1 with the doc's state vector. A fresh doc has an
     empty vector, so the server sends everything.
   - Step 2 arrives. A large answer waits behind a spent open budget
     (`onSlowed`: "slowed").
   - `sync()` marks the room synced on the first step 2, and `onSynced` sets
     `synced: true`.
6. **The editor.** `RoomView` now mounts `BlocksEditor`:
   - `loadPageEditor()` loads the lazy chunk, already started when the room was
     created;
   - `mountNoteEditor` builds the page;
   - the first paint follows.

   The code comment explains why it waits: writing before the token's client id
   is adopted would be refused as `unassigned` (Q213).

**Failure paths.**

- A token that fails offline or with a 5xx calls `startLater()`: offline, then
  start again on `online` or `visibilitychange`, with no retry loop.
- No sync within 30 s of the token request means the room goes offline.

### 4.2 What the Plate note's loader waits on

Files: `src/features/notes/NoteEditor.tsx` and `NoteEditorCore.tsx`.

- **First** `FileLoading` shows while `meIsPending`, `discussionsIsPending` or
  `collaborationTokenIsPending` hold.
- **Then** it shows again until this mount's drafts are read (`ready` and
  `swap.shown`).
- **Inside the core,** `FileLoading` with the connecting message shows while
  `handshaking`, until the first sync. The editor binds to the room's document
  only at that sync (`roomBinding.ts`; Plate's init binds after at most 5 s).
- **Why the projection isn't painted first.** The comment in `NoteEditorCore`
  says the room replaces that copy at sync, so a near-limit note would render
  twice. The projection, or "saved copy", is shown only when the join ran out or
  the device is offline (`plate-editor.md`, "Connection lifetime and refusals").
- **View mode** requests no token at all.

### 4.3 Local persistence today

- **Edit drafts** (`src/lib/editDrafts.ts`, `src/lib/draftStore.ts`,
  `draftStore.worker.ts`; IndexedDB `capy-edit-drafts`):
  - only unsaved work, in `update` rows per session (merged every 64);
  - one `state` row per offline episode, written at unmount or `pagehide` with
    unsaved work and after a failed write;
  - Plate's `copy` rows;
  - deleted by checkpoint receipts, expiring after 7 days, bounded at 2 MiB
    offline;
  - shared by Plate notes, item rooms and blocks notes (`ItemRoom`'s `drafts`
    option);
  - restored before the JOIN when the lineage matches.
- **Persisted query cache** (`src/api/queryPersistence.ts`, `keyval-store` /
  `capy-query-cache`):
  - holds lists and metadata;
  - never note, quiz or card bodies, and never tokens
    (`openwiki/frontend/error-handling.md`, "Persisted query cache").
- **Source bytes** (`src/lib/sourceCache.ts`, Cache Storage `capy-source-bytes`):
  - Office and text base bytes, about 200 MB, least recently opened first out;
  - owned by one account and wiped on sign-out;
  - drafts take priority in the quota.

  This is the precedent for a replica cache.
- **No service worker:** the app itself does not load offline (same doc).

So nothing keeps a full note Y.Doc across sessions. Each open starts from an
empty doc plus unsaved drafts.

### 4.4 Rendering from local state first and connecting in the background

**1. A replica store, per material.**

- It holds the room's Y.Doc: a state row plus a log of updates, folded by size.
- Beside it: the lineage (the room name with its schema), the stored version the
  doc holds, the last token's client ids, and the last access.
- The drafts worker writes it on applied updates, both local and remote, at a
  throttled rate.
- It is bounded and wiped like `sourceCache`: least recently opened first out,
  one account, cleared on sign-out, drafts first in the quota.
- **Needs Epo's sign-off:** note bodies would be stored on the device, which is
  "never stored" today.

**2. The open path.**

- Read the replica, apply it to the Y.Doc, and mount BlockSuite at once.
- Fetch the token and JOIN in the background.
- The JOIN names the replica's stored version, and step 1 carries its state
  vector, so the server answers only the diff.
- A diff under 256 KiB skips the open budget's wait (`SMALL_ANSWER`, `rate.rs`).
- BlockSuite binds straight to the Y.Doc, so applying the diff re-renders only
  the touched blocks. Plate's double render (§4.2) does not apply.

**3. Client ids.**

- Tokens mint the ids (Q213). Updates under any other id are refused as
  `unassigned`, and BlockSuite's history captures the id at construction.
- Two options:
  - paint read-only, and allow editing once the token's id is adopted (about one
    round trip);
  - or persist the last token and use the regrant (Q236), so the id stays the
    same and editing starts at once.

**4. Lineage and late joins.**

- A replica of another lineage is dropped, or opened copy-only.
- A replica below the collection window gets `collaboration-late`. It then needs
  the late merge, which is on hold for blocks. Alternatively, when it holds no
  unsent edits, drop it and load fresh. (Collection is still off in
  deployments.)

**5. Access before the token.**

- Show the replica only to the account that wrote it.
- Drop it on a 403 or 404, as drafts are dropped now.
- AFFiNE gates rendering for non-owners on a permission fetch instead (§1.4).

**6. Server memory is unchanged.** The room still loads the document for every
JOIN. Only latency and bandwidth improve. Cutting server cost needs §3: B, D or
E.

**7. Offline-ready.** Being offline-ready beyond reconnects also needs:

- a service worker for the shell;
- prefetching replicas;
- a rule for what is offline: Notion- and Google-style reasons, or AFFiNE's
  everything.

### 4.5 How collaboration-rs maps connections to rooms

**There is one socket per tab, not one per room.**

- Each tab holds one WebSocket per collaboration URL (`CollabSocket.for`).
- capy-sync 1 frames carry `varuint channel`, `u8 kind`, a length and a payload,
  several messages to a WebSocket frame (`src/features/collaboration/protocol.ts`,
  `collaboration-rs/crates/server/src/protocol.rs`).
- Each channel is one room. Its JOIN names the room, the token, the client
  protocol, the client id, the stored version, an optional note channel and the
  session id (`joinPayload`).

**Server side:**

- one task per socket (`socket.rs`);
- one task per loaded room, owning its yrs `Doc` (`room.rs`);
- a registry of loaded rooms by name (`app.rs`);
- a room unloads once it has no members and nothing left to store
  (`Room::unloadable`).

**Caps:**

- 8 pending joins per socket (`MAX_PENDING_JOINS`);
- a socket must join a room within 10 s (`JOIN_DEADLINE`);
- 22 joined documents per user (`JOINED_PER_USER`);
- 4 channels per user per document (`CONNECTIONS_PER_DOCUMENT`);
- 500 sockets per address (`SOCKETS_PER_ADDRESS`), all in `seats.rs`;
- 64 embed channels inside one note channel, which do not count toward the 22
  (`EMBEDS_PER_NOTE`, `socket.rs`);
- a ping every 30 s, and a close after 60 s of silence.

### 4.6 Serving several docs over one socket

**It already does.** Many rooms share one socket, and embeds join inside their
note's channel, near the viewport only.

**What is missing for a cheap canvas:**

- **One authorization for many docs.** Today every room needs its own token,
  which is one HTTP request to Go per card. AFFiNE batches up to 100 docs per
  `space:join-batch`, with a per-doc check on the server. A batch token endpoint,
  or a canvas token that authorizes its children with a per-child access check
  in Rust, would cover this.
- **Not loading every joined doc into memory.** This is §3, option E, or the
  smaller idle-unload step.
- **Optionally, sub-documents on one channel.** This is a protocol change.
  Child channels inside a canvas channel, as `NoteSeat` does today, get most of
  the benefit without it.

### 4.7 Cost of a workspace canvas holding N notes

**Assumptions:**

- A near-limit blocks room holds R = 13.0 MiB of heap (laptop, counted by the
  allocator; production RSS is higher, and the box rerun will say how much).
- Memory scales roughly with content: about 6.5 MiB per MB of note JSON. This is
  a linear extrapolation, **unverified**; the fixed per-room overhead is not
  measured.
- A "typical" note is 100 KB of JSON. This is an assumption.

| Scenario | A: one Y.Doc | B: per-card rooms, viewport joins only | B + level of detail (focused card, at most 3) |
| --- | --- | --- | --- |
| 10 near-limit notes | ≈130 MiB per open canvas; cold room load ≈5.6 s (10 × 560 ms, laptop); first answer ≈ the whole canvas | Up to ≈130 MiB if all are on screen | Canvas plus ≤39 MiB |
| 50 near-limit notes | ≈650 MiB; cold room load ≈28 s; first answer larger than the 80 MiB open budget (if the state is about the size of its JSON, **unverified**), so slowed opens | Up to 64 joined (the cap), ≈830 MiB at worst | Canvas plus ≤39 MiB |
| 200 typical notes (≈20 MB of JSON) | ≈130 MiB plus overhead; projection and checks on 20 MB | Tens of rooms when zoomed out | Canvas plus a few MiB |
| One user, idle, canvas open | Holds all of the above until the tab sleeps (60 min) or leaves | Holds the joined rooms | Holds the canvas plus the focused card |

**What one box holds.** The production box has 7.6 GiB for everything: Postgres,
gateway, retrieval, Office engines and collaboration. Under A, about ten open
50-note canvases would fill the whole box. The canvas doc in B is small: a few
hundred cards of positions and references is likely tens to hundreds of KB of
state. That is **unmeasured**.

---

## 5. Options for Epo

**1. One editor and one connection over many docs (my pick).**

- The canvas is a small doc with one BlockSuite host.
- Notes, quizzes and sets stay their own materials and rooms. They join inside
  the canvas's channel when a card is focused or readable on screen, up to a
  cap, and are previews otherwise.
- Tokens come in batches.
- Each doc gets a local replica, so cards and the canvas paint before any
  connection.
- To the user it is one editor and one room. To the server it is the canvas plus
  whatever is being worked on.

**2. One Y.Doc with a hard total bound.**

- Simplest editor and undo.
- Every open costs the whole canvas, and the bound limits how much a workspace
  can hold.
- Quiz keys and single-note sharing still need separate docs.

**3. Server rooms without in-memory documents (AFFiNE).** The lowest idle cost,
but a rewrite of admission. Long term at best.

**Decisions this needs:**

1. Does "one room" mean one editor and one connection for the user, or one Y.Doc
   in storage?
2. May note bodies be stored on the device as replicas? With what eviction, and
   wiped at sign-out?
3. What is available offline: recent and pinned docs, the whole workspace, or
   only what is open?
4. Before the token arrives, may the user edit (persisted client id via the
   regrant) or only read?

---

## 6. Not verified, or still to measure

- **Miro's board limits:** not fetched (403).
- **A published AFFiNE limit for big edgeless docs:** none found, and search was
  unavailable.
- **AFFiNE's offline skeleton for non-admin members:** read from the source, not
  run.
- **Room cost:**
  - production RSS per blocks room: the box rerun is pending;
  - the fixed per-room overhead;
  - how state size compares with JSON size for a near-limit blocks note;
  - how much memory a canvas doc of hundreds of cards needs.
- **Open latency:** the token, JOIN and step-2 times were not measured
  separately from editor render time. A near-limit open (about 13 s) is mostly
  render.

## 7. Sources

**AFFiNE**, canary `8cef09e1dd62`, at github.com/toeverything/AFFiNE:

- nbstore:
  - `packages/common/nbstore/src/frontend/doc.ts`
  - `packages/common/nbstore/src/frontend/awareness.ts`
  - `packages/common/nbstore/src/sync/index.ts`
  - `packages/common/nbstore/src/sync/doc/index.ts`
  - `packages/common/nbstore/src/sync/doc/peer.ts`
  - `packages/common/nbstore/src/sync/awareness/index.ts`
  - `packages/common/nbstore/src/impls/cloud/doc.ts`
  - `packages/common/nbstore/src/impls/cloud/socket.ts`
  - `packages/common/nbstore/src/impls/cloud/awareness.ts`
  - `packages/common/nbstore/src/impls/idb/schema.ts`
  - `packages/common/nbstore/src/impls/idb/db.ts`
  - `packages/common/nbstore/src/storage/doc.ts`
  - `packages/common/nbstore/src/worker/store.ts`
  - `packages/common/nbstore/src/connection/connection.ts`
- Web app: `packages/frontend/apps/web/src/app.tsx`,
  `packages/frontend/apps/web/src/nbstore.worker.ts`.
- Workspace and doc modules:
  - `packages/frontend/core/src/modules/workspace/entities/engine.ts`
  - `packages/frontend/core/src/modules/workspace/entities/workspace.ts`
  - `packages/frontend/core/src/modules/workspace/impls/doc.ts`
  - `packages/frontend/core/src/modules/workspace/impls/storage.ts`
  - `packages/frontend/core/src/modules/workspace-engine/impls/cloud.ts`
  - `packages/frontend/core/src/modules/doc/services/docs.ts`
  - `packages/frontend/core/src/modules/doc/stores/docs.ts`
- Permissions:
  - `packages/frontend/core/src/modules/permissions/services/guard.ts`
  - `packages/frontend/core/src/modules/permissions/stores/guard.ts`
  - `packages/frontend/core/src/modules/permissions/entities/permission.ts`
  - `packages/frontend/core/src/modules/permissions/stores/permission.ts`
  - `packages/frontend/core/src/components/guard/use-guard.tsx`
- Pages and editor:
  - `packages/frontend/core/src/desktop/pages/workspace/index.tsx`
  - `packages/frontend/core/src/desktop/pages/workspace/detail-page/detail-page.tsx`
  - `packages/frontend/core/src/desktop/pages/workspace/detail-page/detail-page-wrapper.tsx`
  - `packages/frontend/core/src/blocksuite/block-suite-editor/blocksuite-editor.tsx`
- Server:
  - `packages/backend/server/src/core/sync/gateway.ts`
  - `packages/backend/server/src/core/doc/storage/doc.ts`
  - `packages/backend/server/src/core/doc/adapters/workspace.ts`
  - `packages/backend/server/src/core/doc/reader.ts`
- BlockSuite:
  - `blocksuite/affine/blocks/embed-doc/src/embed-synced-doc-block/embed-synced-doc-block.ts`
  - `blocksuite/framework/std/src/gfx/viewport-element.ts`

**Other apps:**

- Excalidraw (github.com/excalidraw/excalidraw, master):
  - `excalidraw-app/App.tsx`
  - `excalidraw-app/collab/Collab.tsx`
  - `excalidraw-app/collab/Portal.tsx`
  - `excalidraw-app/data/localStorage.ts`
  - `excalidraw-app/data/LocalData.ts`
  - `excalidraw-app/app_constants.ts`
  - `excalidraw-room/src/index.ts`
- tldraw (github.com/tldraw/tldraw, main):
  - `packages/sync/src/useSync.ts`
  - `packages/editor/src/lib/options.ts`
  - tldraw.dev/docs/persistence
  - tldraw.dev/docs/sync
- Figma:
  - figma.com/blog/how-figmas-multiplayer-technology-works
  - figma.com/blog/rust-in-production-at-figma
  - figma.com/blog/speeding-up-file-load-times-one-page-at-a-time
  - help.figma.com/hc/en-us/articles/360040328553 (offline)
  - help.figma.com/hc/en-us/articles/360040528173 (memory)
- Linear:
  - github.com/wzhudev/reverse-linear-sync-engine (README)
  - linear.app/now/scaling-the-linear-sync-engine
- Notion:
  - notion.com/blog/how-we-made-notion-available-offline
  - notion.com/blog/how-we-sped-up-notion-in-the-browser-with-wasm-sqlite
- Google: support.google.com/docs/answer/6388102
- Heptabase: wiki.heptabase.com/fundamental-elements
- Yjs and Hocuspocus:
  - docs.yjs.dev/api/subdocuments
  - tiptap.dev/docs/hocuspocus/provider/configuration
  - tiptap.dev/docs/hocuspocus/guides/multi-subdocuments
- y-protocols 1.0.7: `node_modules/y-protocols/awareness.js`

**Ours:**

- BlockSuite note and rooms:
  - `src/features/notes/blocksuite/BlockSuiteNote.tsx`
  - `src/features/notes/blocksuite/blocksRoom.ts`
  - `src/features/collaboration/itemRoom.ts`
  - `src/features/collaboration/roomProvider.ts`
  - `src/features/collaboration/socket.ts`
  - `src/features/collaboration/protocol.ts`
  - `src/features/collaboration/noteSeat.ts`
  - `src/features/collaboration/useNearScreen.ts`
  - `src/features/collaboration/idle.ts`
- Plate note and loaders:
  - `src/features/notes/NoteEditor.tsx`
  - `src/features/notes/NoteEditorCore.tsx`
  - `src/features/files/FileStates.tsx`
  - `src/components/ui/feedback.tsx`
- Local storage:
  - `src/lib/editDrafts.ts`
  - `src/lib/draftStore.ts`
  - `src/lib/sourceCache.ts`
- Go: `server/internal/httpapi/huma_collaboration.go`
- collaboration-rs:
  - `collaboration-rs/crates/server/src/socket.rs`
  - `collaboration-rs/crates/server/src/room.rs`
  - `collaboration-rs/crates/server/src/seats.rs`
  - `collaboration-rs/crates/server/src/rate.rs`
  - `collaboration-rs/crates/server/src/app.rs`
- openwiki:
  - `openwiki/frontend/plate-editor.md`
  - `openwiki/backend-storage-quota.md`
  - `openwiki/frontend/error-handling.md`
  - `openwiki/frontend/office-files.md`
  - `openwiki/deployment-runbook.md`
- Notes and benchmarks:
  - `todo-blocksuite-spike.md`
  - `bench/collaboration/scripts/layout-box/README.md`
  - `bench/collaboration/reports/2026-10-11-prod-capacity-rust.md`
  - `bench/gateway/reports/2026-10-24-gateway-capacity.md`
