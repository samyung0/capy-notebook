# Images on the drawing board

Status: plan only (2026-11-09). Nothing built. Decisions for Epo are at the end.

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

## Decisions for Epo

1. **Answer-board images at all?** (a) Allowed, stored with the drawing as above
   (recommended). (b) Turn off pasting and uploading images on answer boards.
2. **Who pays for answer-board images?** The person attempting, like the board itself
   (recommended, as you said). The alternative, the quiz owner, would split one
   drawing's bytes between two payers.
3. **When they upload:** with the board at Done or Check (recommended, matching
   2026-11-06's "server on Done"), or as soon as they're pasted (faster Done, but stores
   images for answers never handed in).
4. **Caps:** images per answer board (suggest 10), bytes per image after compression
   (suggest 300 KiB, the marking image's cap, or the plan's note image cap), and whether
   a full storage blocks them like practice boards or never blocks, as assignments
   don't (suggest: the board's rules).
5. **Uploaded GIFs:** compressing keeps one frame of an animated GIF (`fitImage`). Keep
   them still on the board (recommended; KLIPY covers moving GIFs on the workspace
   canvas), or keep the original GIF within the cap.
6. **Workspace canvas:** who pays for its images once it's stored: whoever uploads them,
   as in notes (M16), or the workspace owner. And is this plan's step 4 (wait for the
   canvas's server storage) the right order?
