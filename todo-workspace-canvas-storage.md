# The workspace canvas stored on the server

Status: steps 1 and 2 built 2026-11-09 (server: migration 0164, kind, catalog block, routes; browser: `WorkspaceCanvas.tsx` opens, autosaves, keeps a device copy; the Canvas tab ships); step 3 built 2026-11-10 (images upload at once as the canvas's image assets, `boardBlobs.ts`, `assetImages`). Step 4 built 2026-11-10: the Files page lists a member's canvas with their blocks (`items.go`, under the workspace it is the Canvas tab of, with its board's size), its card draws the saved board (`canvasPreview.ts`, from the stored preview's `boardAssetId`), its menu is Open and Delete, and Trash shows it with the canvas icon. Epo 2026-11-10: the canvas got its own account-level page instead (`/canvas`, mock B: the page is a board of the person's own in no workspace, migration 0167, with a panel listing every canvas), and the Files rows are gone. Decided by Epo 2026-11-09 (human/frontend/
plate-editor.md): the canvas is **personal**: one per member per workspace, seen by its
owner alone, no sharing, no view or preview mode, one BlockSuite editor over the whole
canvas with no collaboration room, so BlockSuite's room data model is not needed
(collaboration would mean resuming the held `todo-canvas-workspace.md`). It is stored
as a material of a new kind `canvas` whose saved board is the material's own `board`
editor asset (gzipped in the bucket, as a drawn sample answer's is); the saved copy is
the cleaned-up one (no history), at most 2 MiB, with the answer board's too-big
message; it ships behind the answer flow's gate, which has landed.

## Today

- `DevWorkspaceCanvas.tsx` mounts the board with `board: 'workspace'` and saves
  `snapshot()` (the live document with its history) to localStorage,
  `capy.workspace.canvas.<workspaceId>`, 500 ms after a change. No cap, no warning, no
  owner, dev builds only (`MSW_ENTRIES` stubs it out). Nothing opens a room.
- A drawing answer's board is stored under `drawings/` with the attempter as payer
  (`drawings.go`); a teacher's drawn sample answer is a quiz `board` editor asset
  (`DrawnSample.tsx`: gzip in the browser, `uploadEditorAsset(quizId, …, 'board')`,
  read back through `assetLink` and `DecompressionStream`).
- A material is `kind IN ('mindmap','diagram','quiz','flashcards','note')`
  (`materials_kind_check`, 0001), created by `POST /api/workspaces/{id}/materials` with
  `content` a document the embed catalog validates (`materialdoc.ValidateKind`). Every
  content write trashes the material's ready assets the content no longer names
  (`pruneMaterialAssetsTx` on `Envelope.EditorAssetIDs`), a minute after they completed.
- **Visibility:** a workspace material's read access always follows the workspace (its
  privacy is forced to `private`; the only narrowing is Hidden from members, to editors).
  A **standalone** material (no workspace) is its owner's alone when private, with
  owner-only trash, restore and purge, and takes editor assets.

## The plan

### 1. A standalone material linked to the workspace

- The canvas is a standalone material (`workspace_id` null, privacy `private`) of kind
  `canvas`, owned and paid for by the member who draws it, so the existing owner-only
  rules apply with no new authorization path. A new nullable column
  `materials.canvas_workspace_id` (FK to workspaces, cascade) says which workspace's
  Canvas tab it is, with a unique index on `(owner_user_id, canvas_workspace_id)`.
- Migration: `canvas` joins `materials_kind_check`; `store.MaterialCanvas`;
  `embeds.Canvas` in the embed catalog with one allowed block, `canvas_board` (below),
  generated to every layer as the other kinds are.
- `GET /api/workspaces/{id}/canvas` answers the caller's canvas for that workspace,
  creating it on first open (title: the workspace's name; the caller must be a member).
  Leaving the workspace, or its deletion, cascades the canvas (its assets with it).
- Files lists it under the owner's materials with a canvas icon; owner-only Trash,
  Restore and Delete as for any standalone material. Clone, Share and Hidden from
  members are not offered for a canvas (a check as for workspace materials' privacy).
- **Alternative, not chosen:** a workspace material with a new owner-only rule in every
  material read and list path.

### 2. The content and the board asset

- `content` is a one-block document: `canvas_board { boardAssetId, version, bytes,
  imageAssetIds }`. Naming the board asset and every image asset keeps them past the
  pruner; an image removed from the canvas leaves the list at the next save and is
  trashed a minute later, as in notes.
- The board asset is the cleaned-up `save()` document, gzipped in the browser, uploaded
  as `canvas.ydoc.gz` with purpose `board`, under a new catalog cap `CANVAS_BOARD_MAX` =
  2 MiB before gzip (`editorAssetMaxBytes` returns it for a canvas material instead of
  the drawing's 250 KiB; `editor_assets_size_check` takes it by the material's kind).
  The server reads the gzip header and size only; the browser's
  `checkSavedBoard(…, 'workspace')` is the content check, as for drawings.
- Opening: the canvas endpoint gives the block; the board asset's link (`assetLink`) is
  fetched and inflated as `DrawnSample.tsx` does, then
  `mountDrawingBoard(host, { board: 'workspace', saved })`. No asset yet: an empty board.

### 3. Saving

- Autosave: `onChange` debounced (2 s idle, and on leave with `keepalive`): gzip
  `save()`, upload the new board asset, then `PATCH` the material's content with the
  new asset id, `version + 1` and the image asset ids. The pruner trashes the old board
  asset. The PATCH carries the version it read; a 409 (the same person's other tab or
  device saved first) shows "This canvas changed in another tab. Reload to keep
  drawing." and stops saving.
- Over the cap: `save().bytes > CANVAS_BOARD_MAX` shows the too-big message and the
  last good save stays; nothing is uploaded.
- Offline or failing: the last unsaved copy stays on the device in IndexedDB
  (`drawingDrafts`, keyed by the material id) and the next successful save clears it,
  so a reload keeps unsaved strokes. The localStorage key goes.

### 4. Images on the canvas

As `todo-board-images.md` decides: an image uploads at once as an `image` editor asset
of the canvas material (the owner pays), the block's `sourceId` becomes the asset id,
and `imageAssetIds` keeps it alive. The Files page lists them under the canvas.

### 5. Quiz and flashcard cards

A card holds a workspace material's id; double-click opens it in the workspace as
today (`WorkspaceLinks.open`), where that material's own access applies. A card whose
material the member can no longer open shows "can't be opened", as now.

### 6. Order

1. Migration (kind, `canvas_workspace_id`, unique index), store, embed-catalog block,
   the canvas endpoint, limits (Go tests).
2. Browser: open, autosave with the version check, cap message, IndexedDB copy; the
   Canvas tab calls the endpoint; `DevWorkspaceCanvas` becomes `WorkspaceCanvas` and
   leaves dev-only.
3. Images (the board-images plan, workspace half).
4. Files and Trash rows; preview (`drawBoardPreview(…, 'workspace')`) for the Files card.
5. openwiki: plate-editor.md's board section, backend-storage-quota.md (the new cap and
   the canvas's assets), authorization (a canvas is a standalone material linked to a
   workspace), test-catalog.

Decided (Epo 2026-11-09): a member's canvas and its images go with their membership
when they leave the workspace, as a leaver's marked drawings go (the leave path deletes
the member's canvas material; the cascade takes its assets).

Decided (Epo 2026-11-09): autosave 2 s after the last change and on leaving the page.

## Decisions still open

None.
