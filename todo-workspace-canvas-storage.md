# The workspace canvas stored on the server

Status: plan only (2026-11-09). Nothing built. Decided by Epo 2026-11-09 (human/frontend/
plate-editor.md): the canvas is a workspace material of a new kind `canvas`, one per
workspace keyed by its own material id; its saved board is the material's own `board`
editor asset, gzipped in the bucket, as a drawn sample answer's is; the saved copy is
the cleaned-up one (no history) and at most 2 MiB; it ships behind the answer flow's
gate, which has landed. The canvas-mode hold (2026-11-02) stays for everything else
in `todo-canvas-workspace.md`.

## Today

- `DevWorkspaceCanvas.tsx` mounts the board with `board: 'workspace'` and saves
  `snapshot()` (the live document with its history) to localStorage,
  `capy.workspace.canvas.<workspaceId>`, 500 ms after a change. No cap, no warning, no
  owner, dev builds only (`MSW_ENTRIES` stubs it out).
- A drawing answer's board is stored under `drawings/` with the attempter as payer
  (`drawings.go`); a teacher's drawn sample answer is a quiz `board` editor asset
  (`DrawnSample.tsx`: gzip in the browser, `uploadEditorAsset(quizId, …, 'board')`,
  read back through `assetLink` and `DecompressionStream`).
- A material is `kind IN ('mindmap','diagram','quiz','flashcards','note')`
  (`materials_kind_check`, 0001), created by `POST /api/workspaces/{id}/materials` with a
  kind from that list, with `content` a document the embed catalog validates
  (`materialdoc.ValidateKind`). Every content write trashes the material's ready assets
  the content no longer names (`pruneMaterialAssetsTx` on
  `Envelope.EditorAssetIDs`), a minute after they completed.

## The plan

### 1. The kind

- Migration: `canvas` joins `materials_kind_check`; `store.MaterialCanvas`;
  `embeds.Canvas` in the embed catalog with one allowed block, `canvas_board` (below),
  generated to every layer as the other kinds are. `createMaterial` takes `canvas`.
- One per workspace: a partial unique index on `(workspace_id) WHERE kind = 'canvas'
  AND trashed_at IS NULL`; `createMaterial` answers the existing one (200, not 201) when
  it exists. Keyed by the material id, so pages can come later.
- Title: the workspace's name plus "canvas" by default, hidden from the title field for
  now (the Canvas tab is the one way in). Files lists it under Materials with a canvas
  icon; Trash, Restore, Clone and Delete work as for any material (clone copies the board
  asset as it copies a quiz's `board` asset).

### 2. The content and the board asset

- `content` is a one-block document: `canvas_board { boardAssetId, version, bytes }`.
  The block names the board asset and every image asset on the canvas
  (`imageAssetIds`), so `EditorAssetIDs` sees them and the pruner keeps them; an image
  removed from the canvas leaves the list at the next save and is trashed a minute
  later, as in notes.
- The board asset is the cleaned-up `save()` document, gzipped in the browser, uploaded
  as `canvas.ydoc.gz` with purpose `board`, under a new cap `CANVAS_BOARD_MAX` = 2 MiB
  before gzip (the board catalog; `editorAssetMaxBytes` returns it for the canvas
  material instead of the drawing's 250 KiB; `editor_assets_size_check` takes it by the
  material's kind). The server reads the gzip header and size only; the browser's
  `checkSavedBoard(…, 'workspace')` is the content check, as for drawings.
- Opening: `GET /api/materials/{id}` gives the block; the board asset's link
  (`assetLink`) is fetched and inflated as `DrawnSample.tsx` does, then
  `mountDrawingBoard(host, { board: 'workspace', saved })`. A canvas with no asset yet
  mounts empty.

### 3. Saving

- Autosave: `onChange` debounced (2 s idle, and on leave with `keepalive`), the
  browser gzips `save()`, uploads the new board asset, then `PATCH`es the material's
  content with the new asset id, `version + 1` and the image asset ids. The old board
  asset is trashed by the pruner. One writer for now: the PATCH carries the version it
  read and gets 409 when the server has moved on, which the canvas shows as "This canvas
  changed elsewhere. Reload to keep drawing." and stops saving.
- Over the cap: `save().bytes > CANVAS_BOARD_MAX` shows the answer board's message
  ("too big to save", `drawing_answer_too_big` reworded for the canvas) and the last
  good save stays; nothing is uploaded.
- While offline or failing: the last saved copy stays on the device in IndexedDB
  (`drawingDrafts`, keyed by the material id), and the next successful save replaces
  it, so a reload keeps unsaved strokes. (The localStorage key goes.)
- Real collaboration later is the blocks room from `todo-blocksuite-spike.md` (option B
  in `todo-canvas-workspace.md` §1.8); this autosave is what it replaces.

### 4. Images on the canvas

As `todo-board-images.md` decides: an image uploads at once as an `image` editor asset
of the canvas material (the owner pays), the block's `sourceId` becomes the asset id,
and the canvas block's `imageAssetIds` keeps it alive. Files › Embeds lists them under
the canvas.

### 5. Access

Material permissions as they stand: workspace editors edit, viewers open read-only
(`readOnly: true` mount), outsiders 404. The payer is `materials.owner_user_id`, the
canvas's creator (the first editor who opens the Canvas tab makes it), so quota and
storage-full follow a material's rules.

### 6. Order

1. Migration, kind, embed-catalog block, `createMaterial`, one-per-workspace, limits
   (Go tests).
2. Browser: open, autosave with version check, cap message, IndexedDB copy; the Canvas
   tab creates or opens the material; `DevWorkspaceCanvas` becomes `WorkspaceCanvas` and
   leaves dev-only.
3. Images (the board-images plan, workspace half).
4. Files and Trash rows, clone of the board asset, preview (`drawBoardPreview(…,
   'workspace')`) for the Files card.
5. openwiki: plate-editor.md's board section, backend-storage-quota.md (the new cap and
   the canvas's assets), authorization (who opens a canvas), test-catalog.

## Decisions still open

1. **Who makes the canvas:** the first editor who opens the Canvas tab (proposed), or the
   workspace owner always, so one person pays for every workspace's canvas.
2. **Save cadence:** 2 s idle plus on leave (proposed), or the answer board's 500 ms.
3. **Viewers:** read-only canvas (proposed), or no Canvas tab for viewers.
4. **The hold:** this plan stores the canvas only. Cards opening notes in place, chapters
   as frames, presence and the rest of `todo-canvas-workspace.md` stay on hold.
