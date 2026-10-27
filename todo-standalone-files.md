# Standalone files: uploads with no workspace

Status 2026-10-27, branch `wip/mac-ui-2026-10-27`, nothing committed.
Built: migration (file `0122_standalone_files.sql`), Go uploads/imports,
access, listing, Recent, search, trash, clone; pipeline scope, fence,
progress, thumbnails, owner-scoped rag SQL in `retrieval/store.py` (cleared
by the Rust harness session); frontend Add file, chooser, dialog, filters, events.
Left:
- Sources crate and Go source-session/publication (Office/text view and edit
  of standalone files): base on `train/2026-10-27-release` or wait for main.
- Renumber the migration at landing: the release takes 0122-0124 (Epo Q438),
  so this becomes the next free number (0125 once the train is on main). It
  stays 0122 here because the migrator refuses gaps.
- Deviation: a clone into or out of standalone re-ingests in its own scope
  instead of copying the index (same-owner donors spare the parse).
- Move built 2026-10-27 (dialog B, Clone to…, Your files, isPayer) and the
  review's R1-R12 fixed with tests (report in the session scratchpad).
  Standalone Office/text open read-only until the train. The UAT journey
  `e2e/uat/journeys/standaloneFiles.spec.ts` has not run (needs a UAT deploy).
- Open: may a payer who lost access move the file, and may a source owner
  move a member's file where that payer cannot open it.

## Goal

- The Files tab gets an Add file button. It opens a small destination chooser
  (No workspace, or one of the workspaces), then the existing Add file dialog
  aimed at that destination.
- A file with no workspace belongs to its uploader alone. It is never shared on
  its own: there is no file share link, no public file and no Explore entry.
- Lifecycle (trash, purge, account deletion, suspension, quota) works for these
  files the way it works for standalone materials.

## Today

- `files.workspace_id` is `NOT NULL ... ON DELETE CASCADE` (`0001_init.sql:236`).
  The payer is already independent of the workspace: `files.user_id =
  COALESCE(user_id, created_by)`, set at insert (`0095_uploader_pays.sql`). The
  comment at `0001:237` about a workspace trigger is stale.
- Go scans `workspace_id` into a `string` (`store/queries.go:973`, `FileWorkspaceID`
  in `store/share.go:339`), so a NULL row makes most file endpoints return 500.
- Every file read or write resolves file → workspace → role (`fileRead` and
  `assertFileEditor` in `huma_share.go:68-92`, `getFileLinks`, `getSourceSession`,
  undo, opens). There are no file-level roles.
- The index is per workspace (`rag_*` tables, the workspace embedding pin in
  `worker.py:2103`, progress events on `ingest:{workspaceId}`). Standalone notes
  are never indexed (`agentic-retrieval.md` ~5207).
- Standalone materials already have the rules to copy: owner-only, payer is the
  creator, lifecycle checked against the owner's own account
  (`COALESCE(w.user_id, m.owner_user_id)` in `share.go:215-260`), trash branch
  in `trashMaterialTx` (`trash.go:192`), Member listing scope adds the caller's
  standalone rows.
- Frontend: `/files/$fileId` already opens a file outside its workspace
  (`src/routes/MaterialOpen.tsx`), but `readOnly` comes from the workspace's
  `canEdit`. `AddSourceDialog` (`src/features/workspace/AddSourceDialog.tsx`)
  takes a required `workspaceId` and uses it for upload policy, chapters,
  workspace file room, in-flight counts, imports, cloud-connect resume and
  retry. The Blocks tab's New block (`MaterialsTab.tsx:343`) is the toolbar
  precedent: `ListToolbar`'s `action` slot, moved into the page header on
  phones. The sidebar's Last opened dialog (`RecentQuickOpen.tsx`) is the
  dialog to copy: compact, no close button, a centred card on phones.

## Decisions

Recorded 2026-10-27 (`human/authorization-permissions-lifecycles.md`,
`human/backend-storage-quota.md`, `human/frontend/office-files.md`):

- A file clone may land in No workspace too. This replaces the 2026-10-11 line
  that kept `files.workspace_id` NOT NULL.
- Standalone files are ingested exactly like workspace files (parse, chunking,
  embeddings, summary, thumbnails, normal credits), so a later cross-workspace
  search tool can read them. Their index rows are owner-scoped, with no
  workspace. The embedding model is the retrieval default at upload, recorded
  on the content row. That is the same model as the owner's workspaces while
  the default stands; there is no reindex job, so a moved default splits
  spaces here as it already does between workspaces. Donor reuse stays within
  the owner's standalone files.
- No file-count cap for now. Revisit when the agent's list tools search across
  workspaces.
- View and edit work as they do for workspace files, through the same source
  room, with access owner-only when there is no workspace. View never joins a
  room for any kind; every Office/text save goes through it.
- Saved edits always auto-publish (the Auto process schedule) and re-ingest as
  a workspace file's publication does.
- Thumbnails need nothing new: the upload's ingest draws the first, the
  owner's edit room redraws Office files (5 s after the last edit, at most one
  per file a minute, once on open when stale), and each publication
  re-ingests.

Approved 2026-10-27:

- **P1, status.** A standalone file's progress is the existing `ingest` event
  published on its owner's always-on `notif:{userId}` channel, with no
  workspace id (`progress.py:35`). The tab's ingest handler patches the owned
  files list for it and refetches on ready, which brings the thumbnail (tree
  events need a workspace).
- **P2, the dialog's tabs for No workspace.** Upload and Import, with Create
  hidden (Blocks' New block already makes standalone notes, quizzes and sets;
  blank Office files go through the workspace-scoped `/files/blank`). A
  workspace destination keeps all tabs.
- **P3, the destination list.** No workspace first, then the workspaces the
  caller can edit, most recently opened first, with icon and name as in Last
  opened. A frozen or over-quota account sees the rows disabled with the
  reason.
- **P4, Recent and search.** Standalone files show in dashboard Recent, the
  quick open and search, opening at `/files/$fileId`.

## Sequencing (Rust harness session, 2026-10-27)

- Migration `0122` is reserved for this work. The release train's three
  migrations become 0123 to 0125 when it lands, and the migrator refuses gaps
  and out-of-order files, so 0122 reaches main before or inside the train.
  Never push to main directly: message the Rust harness session, which folds
  this branch into the train if it is ready first.
- The release branches (`editor/effects-on-read`, `editor/agent-edits-room`)
  already change the sources crate (`gateway.rs`, `store.rs`, `refresh.rs`,
  `edit.rs` and more), `source_documents.go`, `source_refresh.go`,
  `office_maintenance.go` and `retrieval/store.py`. Not touched there:
  `crates/server/src/access.rs`, `pipeline/store/db.py` and the rag tables.
- Order: the migration, pipeline/rag, Go upload/listing/trash/clone and
  frontend now; the sources crate and Go source-session/publication edits only
  once the train is on main (or on `train/2026-10-27-release`, when that
  session says it exists), branching from it.

## Work

### Schema (`0122`)

- `files.workspace_id` drops `NOT NULL`. A CHECK keeps `chapter_id` empty
  without a workspace. Fix the stale payer comment at `0001:237`.
- Index tables (`0001:1197-1330`, `0024`): `rag_contents`,
  `rag_file_contents`, `rag_chunks`, `rag_chunk_vectors_*` and
  `rag_content_summaries` take a nullable `workspace_id` plus the owner
  (`user_id`, `ON DELETE CASCADE`), exactly one of the two set. `UNIQUE
  (workspace_id, content_hash)` gets a partial twin on `(user_id,
  content_hash) WHERE workspace_id IS NULL`, and the donor index likewise.
  Trap: the composite FKs `(file_id, workspace_id)` and `(content_id,
  workspace_id)` are MATCH SIMPLE, so a NULL workspace skips the check and its
  cascade. Add single-column FKs (`file_id → files`, `content_id →
  rag_contents`, `ON DELETE CASCADE`) so a purged standalone file drops its
  index.
- `upload_sessions_scope_check` (`0048`): a `source` target may have no
  workspace.
- `source_batches.workspace_id` (`0061`) becomes nullable, and the settle
  notification (`0107`) links to `/files` when there is none. Or standalone
  uploads take no batch, if the upload code folds that way more simply.
- `cancel_user_async_work` (`0087:79`): find pending upload sessions by
  `created_by` without the workspaces join. This already misses standalone
  material editor-asset reservations today.
- `user_acl_eviction_trigger` (`0090:62`): also evict the rooms of standalone
  files on their payer's lock.

### Go

- File scans: `workspace_id` becomes `*string` in `scanFile`, `FileWorkspaceID`
  and the API model (`workspaceId` optional, `api/types.ts` re-export).
- Access: one helper. A workspace file goes through the workspace role. A
  standalone file is owner-only (`f.user_id = caller`), refused while the
  owner is deletion-pending or suspended, and never readable through a share
  link (`redeemShareLink`, `linkReachSQL`) or anonymously. Used by `fileRead`,
  `assertFileEditor`, `getFileLinks`, opens, undo and the thumbnail POST.
- Upload: the upload, ticket, import and import-inspect routes accept no
  workspace (new unscoped routes or an optional workspace, whichever the
  handlers fold into with less branching). Reservation is on the uploader,
  with the storage gate and no file-count gate. Finalize takes the owner's
  lock instead of the workspace editor lock, inserts with no chapter, and
  queues the normal ingest job without a workspace. The upload policy
  answers for the caller's plan. `RetryFileProcessing` (`jobs.go:261`) gets the same branch.
- Source sessions (`source_documents.go`): `sourceLockTx` (211, 217 payer from
  `files.user_id`), `sourceActorsAllowed` (261, owner branch), `canEdit` (336),
  `CheckSourceAccess` (408, `LEFT JOIN` + `COALESCE(w.user_id, f.user_id)`),
  `readSourceSession` (436), `commitSourceOperationTx` (592), publication (670
  treats no workspace as auto process, 747 spend, 764 payload), plus
  `office_maintenance.go:73` and `source_refresh.go:296, 366, 418, 526`
  (publication writes the owner-scoped index). The pattern is
  standalone notes in `collaboration-rs/crates/server/src/access.rs:192`.
- Trash: `trashFileTx` gets the standalone branch from `trashMaterialTx`.
  `ListTrash`'s file branch becomes `LEFT JOIN` + `COALESCE`. Restore, purge
  and sweep are already NULL-ready.
- Listings: `ListOwnedFiles` (`listing.go:424`) becomes a `LEFT JOIN` with a
  `location` filter like `materialLocations`. Member scope adds
  `workspace_id IS NULL AND user_id = caller`. `RecentOpens`,
  `RecordItemOpen` and search (`queries.go:117`) get the same, with the href
  `/files/{id}` (P4).
- Clone: `cloneFileOnce` takes a standalone source (owner-only, no index copy)
  and a No workspace destination (no file gate; the index copies when the
  embedding spaces match, else re-ingests paid by the cloner, as today).
  `apimodel/requests.go:25` drops `minLength:1`. A standalone file cloned into
  a workspace follows the same rule against that workspace's pin.

### collaboration-rs (`crates/sources`)

- `gateway.rs:80` `SourceSession.workspace_id` becomes `Option<String>`.
  `store.rs:245, 1510` (`ResolveInput` and its comparison), `store.rs:1390`
  `owner()` (`LEFT JOIN` + `COALESCE`), `refresh.rs:29, 36` refresh candidates
  (no workspace means auto process). Room auth already goes through Go's
  bootstrap and access calls.

### Pipeline

- Scope instead of workspace: the ingest payload carries `workspaceId` or
  nothing (`worker.py:117`, the required strings), and the worker passes one
  scope (workspace, or the owner) to every index read and write:
  `attach_file_content`, `index_file`, `_fill_summary` (`worker.py:2630-2710,
  843`), the donor lookup (`find_ready_donor`, 2480), `share_file_thumbnail`
  (`db.py:1589`, the owner's standalone files only).
- Embedding space: `workspace_embedding_pin` (`retrieval/store.py:92`) and
  `_workspace_embedding_spec` (`worker.py:1914, 2103`). With no workspace, a
  first ingest takes the current retrieval default and records it on
  `rag_contents`; a re-ingest of the same file reuses the space its content row
  holds.
- `_pipeline_source_cancellation` (`store/db.py:657-780`): with no workspace,
  the actor must be `files.user_id`.
- `caption_cache._RESOURCES` (`caption_cache.py:21`): standalone files may
  reuse captions of the owner's own standalone files, or none (safe either
  way; pick the smaller change).
- Progress (`progress.py:35`): with no workspace, publish to
  `notif:{ownerId}` (P1).
- Chat and generate stay workspace-scoped: their queries filter by
  `workspace_id = X`, which a NULL row never matches.

### Frontend

- `Files.tsx` `ActiveFiles`: an Add file button in `ListToolbar`'s `action`
  slot, left of the grid/list toggle. On phones it moves to the page header
  slot, like New block. The workspace filter gains No workspace, and the list's
  Workspace column shows a dash for a standalone file.
- `src/features/files/AddFileDestinationDialog.tsx`: a compact dialog with no
  close button, built from `RecentQuickOpen`'s structure. Picking a row closes
  it and opens `AddSourceDialog` with that destination.
- `AddSourceDialog`: `workspaceId: string | null`. Without one it skips
  chapters, workspace room and Create (P2), keeps the parse picker and the
  credit estimate, and checks only per-request and storage limits.
  `useUploadSource`, `useImportSources`, `useInspectSourceImports`,
  `useSourceUploadPolicy` and the transfer store's `workspaceId` accept null.
  Cloud-connect resume saves a null destination.
- `applyIngestEvent` (`api/hooks.ts:1803`): an event without a workspace
  patches the owned files list; ready refetches it (P1).
- `MaterialOpen.tsx`, `FileViewer.tsx:189, 244`, `prefetchOfficeFile.ts:48`:
  edit rights for a standalone file come from ownership, not the workspace.
- `ContentActions` on a standalone file: rename, download, clone, trash. No
  Share and no Move.
- MSW: standalone file fixtures in the Files list, Recent, trash and a source
  session.

### Docs and tests

- openwiki: `authorization-permissions-lifecycles.md` (standalone files, and
  fix the clone line ~735, which still says the workspace owner pays where code
  and the quota doc say the cloner), `backend-storage-quota.md` (no count
  cap), `agentic-retrieval.md` (owner-scoped index, the embedding space),
  `thumbnails.md` (owner-only key reuse), `frontend/office-files.md` (owner-only rooms,
  auto-publish).
- `human/`: the P answers, then code references on the 2026-10-27 lines.
- Go store tests: a standalone upload is reserved and charged to the uploader;
  owner-only reads, sessions and rooms with another user refused; trash,
  restore and purge; account deletion cancels a pending standalone session;
  Files listing with the No workspace filter; clone both ways; purging a
  standalone file drops its index rows.
- Pipeline tests: a standalone ingest writes owner-scoped rows in the
  default space with a thumbnail and summary; donor reuse never crosses
  owners or reaches into a workspace.
- Rust: a standalone source room opens for its owner only.
- Vitest: the destination dialog passes its pick to `AddSourceDialog`; no
  workspace hides chapters, room and Create.
- e2e (MSW): Files → Add file → No workspace → upload → the file opens at
  `/files/$id` and edits. Then `test-catalog.md`.

## Move into a workspace (decided 2026-10-27, mocks first)

- Into a workspace only: a standalone file by its owner, a workspace file by
  the source workspace's owner or its payer; the mover edits the target. The
  payer stays. The old workspace's study progress and plan steps for it are
  dropped, with a confirmation only when someone's progress would go.
- Entry points: Files page item menu, workspace file list item menu (Move
  to… replaces the chapter-only Move), and a Your files tab in the workspace
  Add file dialog (search, shared file cards with their workspace).
- Mocks: https://claude.ai/artifact/URRY6nLu3ZuPwVUN8waMgf (dialog A pick
  then chapter, B two dropdowns; confirmation; Your files desktop and 360).
- Index: same embedding space re-scopes the content (copy as
  `cloneRetrievalIndex` does, then drop the old alias), else re-ingest.
