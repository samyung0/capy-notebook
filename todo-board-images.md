# Images on the drawing board

Status: built 2026-11-10: the blob source (§1), the workspace canvas half
(`boardBlobs.ts`, `boardImages.ts`, `assetImages` in `boardAsset.ts`,
`WorkspaceCanvas.tsx`), answer-board pictures stored with the drawing (§2, migration
0165 `drawing_pictures`, `drawings.go`, `DrawingBoardScreen.tsx`, `drawingValue.ts`)
and the catalog limits (§5, `BOARD_IMAGE_MAX`, `BOARD_IMAGES_MAX`). Not built: the
sample-answer board's images (§3).

## The problem

A pasted or uploaded image on the drawing board (both the quiz answer board and the
workspace canvas) goes into BlockSuite's in-memory file store (`TestWorkspace`'s
`MemoryBlobSource`). The saved board keeps only the image block's `sourceId`, a hash of
the file. Nothing uploads the file, so after a reload, or when a teacher opens a stored
answer, the image is gone and only an empty frame is left. The marking image taken at
Done does include it, so the AI and the teacher see it once. The planned blob source
for images was in the held-back BlockSuite note plan (`todo-blocksuite-spike.md`, D13
on `blocksuite-notes`), never on the board.

## What already exists

- **Plate (notes):** an image uploads in the browser through `uploadEditorAsset`
  (compressed off the main thread by `fitImageOffThread`, refused past the plan's image
  cap). The note stores only the `assetId`, and the asset belongs to a material and is
  billed to whoever uploaded it (M16). Pasted `<img>` URLs are fetched by the browser,
  then uploaded (`pastedImages.ts`, Epo 2026-10-10).
- **Drawing answers:** the board (gzipped, at most 250 KiB before gzip) and a marking
  image (at most 300 KiB, kept until marked) are stored under `drawings/<attempt or
  user>/`. They are billed to the person attempting (Epo 2026-11-06), read by the drawer
  and the class's staff (`ReadableDrawing`), deleted from Files › Canvas, and go with
  the assignment. An assignment's save never refuses for storage (Epo 2026-11-08), while
  a practice Check is refused when storage is full (Q694).
- **Drafts:** the board is kept in the browser (IndexedDB `drawingDrafts`) until Done,
  and stored on the server only at Done or Check (Epo 2026-11-06).
- **A teacher's drawn sample answer** is already a quiz editor asset (`board` purpose).

## The plan

### 1. A board blob source, on both boards

Replace the in-memory file store with our own `BlobSource` (BlockSuite lets the
workspace take one). Adding an image compresses it first, with `fitImageOffThread` as
notes do. The image block's `sourceId` stays BlockSuite's content hash. Reading looks
locally first, then asks the server for a link. The marking image keeps drawing images
from the same source, as it does now.

### 2. Quiz answer boards: images go with the drawing

- **While drawing:** the image's bytes sit in the IndexedDB draft beside the board, under
  the draft's key. A reload keeps them, and nothing is uploaded yet, as the board isn't.
- **At Done (assignment) or Check (practice):** the board's images are sent with the
  board and stored under the same `drawings/<folder>/` as `img-<sourceId>.webp`. The
  drawing row lists them (bytes per image), they count in `drawings_storage_after` and
  are billed to the person attempting, and they follow the drawing's existing read,
  delete and storage-full rules.
- **Reading:** `GET /api/drawings/{id}` also returns a link per image (`sourceId` → link),
  under the same access rule as the board. A teacher's view and a reopened answer then
  show the images.
- **Checks:** the browser's load check takes an `affine:image` whose `sourceId` is a
  BlockSuite hash. The server refuses images over the per-image cap, past the image
  count, or not WebP/JPEG/PNG (`imagecheck`), and an image block whose file wasn't sent
  is left as an empty frame.

### 3. A teacher's sample-answer board: images are quiz editor assets

That board is already a quiz `board` editor asset, so its images are quiz `image`
editor assets through `uploadEditorAsset`, billed to the uploader as in notes. The
`sourceId` is the asset id.

### 4. The workspace canvas: waits for its server storage

It is saved only in the browser on a dev page today (`DevWorkspaceCanvas`, not in
deployed builds). Its images follow the same blob source once the canvas is stored on
the server. Until then they stay in the browser with the canvas (IndexedDB rather than
localStorage, which holds about 5 MB). Its storage design also needs the size cap and
warning the quiz board has, and saving the cleaned-up copy (`save()`, not
`snapshot()`).

### 5. Limits in the board catalog

New catalog limits, generated to every layer like the others: images per board, bytes
per image after compression, and a board total across its images. The answer flow
refuses past them on Done with a message, as it does for the board's 250 KiB.

## How Plate handles an image (the model for the workspace canvas)

- **Upload at once.** A pasted, dropped or picked image becomes an upload placeholder in
  the note straight away and uploads in the browser (`uploadEditorAsset`). The
  placeholder shows the local file while it uploads; when the upload completes, the node
  takes the asset id (`setNodes({assetId, ...})`) and the placeholder goes. Quizzes and
  flashcard sets do the same (`quizImageUpload`, `CardDialog`).
- **Owner and payer.** The asset names the material (`editor_assets.material_id`, and its
  workspace) and is billed to whoever uploaded it (M16).
- **Caps.** Compressed first (`fitImage`: long side within the image limit, WebP at 0.85),
  then the uploader's plan image cap, 2 MiB on every plan (migration 0114). Over it after
  shrinking, the placeholder says the file is too large and nothing is sent.
- **Storage full.** The upload's reservation is refused (`storage_quota_exceeded`) and
  the placeholder shows the error; nothing is stored.
- **Animated GIFs.** Kept as they are, frames and all, when within the side limit and the
  cap; refused past either, since a canvas would keep one frame. (The earlier draft of
  this plan said compression keeps one frame: wrong.)
- **Seen in Files.** Every image a person pays for is listed on the Files page's Embeds
  tab (`GET /api/editor-assets`), named by its note, with kind, size and workspace.
- **Removed images.** Content a material saves without an asset trashes that asset a
  minute later (`pruneMaterialAssetsTx`), and the trash sweep deletes it a day after.

## Workspace canvas, the Plate way (proposed)

1. Pasting, dropping or picking an image adds the `affine:image` block with the local
   file shown at once (the blob source holds it under BlockSuite's hash), and uploads it
   through `uploadEditorAsset` right away.
2. When the upload completes, the block's `sourceId` becomes the asset id (an
   `updateBlock`, as Plate's `setNodes`), and the blob source keeps the file under that id
   for this session. A board saved mid-upload keeps the hash, and that block shows an
   empty frame elsewhere, as D13 had for notes.
3. The asset is listed on Files › Embeds, named by the canvas, and a removed image is
   trashed by the canvas's save the way a note's is.
4. This needs the canvas stored on the server first: an asset has to name what it belongs
   to, and the canvas today lives only in the browser on a dev page. The canvas's own
   storage (where its document lives, its size cap and warning) is its own piece of work.

## Decided (Epo 2026-11-09)

1. Images on answer boards: yes, stored with the drawing.
2. The person attempting pays for them.
3. Answer-board images upload with the board at Done or Check.
4. Answer boards: at most 10 images, and a full storage handled as the drawing's
   (an assignment never refused, practice refused). The workspace canvas follows Plate's
   asset rules: the plan image cap per image, refused when storage is full.
5. The workspace canvas's owner pays for its images (no collaboration yet).

## Decided later (Epo 2026-11-09)

6. Workspace canvas images upload at once as editor assets and list on Files › Embeds,
   as Plate's do.
7. An answer-board image is at most 1 MiB after compression (the catalog's
   `BOARD_IMAGE_MAX`, with `BOARD_IMAGES_MAX` 10).
8. Animated GIFs follow Plate: kept moving within the side limit and the cap, refused
   past them.

Earlier decision this plan builds on: Epo (2026-11-06) allowed image upload on the drawing
board as notes do (a placeholder while it uploads, the file in the bucket, the browser
fetching its link, never embedded in the document). Decision 3 above amends its timing
for answer boards only: their images go up with the board at Done or Check, since the
board itself reaches the server only then. The workspace canvas keeps the 2026-11-06
timing (upload at once).

## Still open

- **How an answer board's pictures travel: built as §2 says, in the board's own
  request, for Epo to confirm.** Each is base64 inside the JSON of Done or Check. An
  assignment's Done may reach about 14 MB; a practice check's cap rose from 4 MiB to
  about 17 MiB (`checkMaxBytes`: its answers plus one board's pictures at their
  most), shared by the quiz, review and bank check routes. A question whose drawing
  parts together hold more than about 10 MiB of pictures is refused as too large,
  with the page's general error. Typical pictures are a few hundred KB after
  compression, so the worst case needs ten photos near the cap. The alternative is
  one upload per picture before Done or Check, which needs a place to hold a
  practice picture before its attempt exists.
- **A sample-answer board's images (§3)** need the quiz's document to name them, as
  the canvas block names its images, or the pruner trashes them a minute after the
  quiz's next save.
- **Picking a file on an answer board.** The workspace canvas has Misc's Image tile
  (Epo 2026-11-10); an answer board has no Misc panel, so there a paste, a drop and a
  note's slash menu are still the only ways in.
