# Thumbnails and list previews

List cards (Files, Create, Trash, the dashboard's recents) show what an item
looks like without opening it. A source file gets a small image of page 1, or
for a text source its opening characters. A material (note, quiz, flashcards,
mindmap, diagram) gets a live preview drawn in the browser from a small JSON
summary of its content. Decisions: `human/authorization-permissions-lifecycles.md`
and `human/backend-storage-quota.md` (2026-10-11).

Ingest renders file thumbnails (phase 1). Edited Office files are captured in
the browser and posted to Go ([Browser captures](#browser-captures): PPTX and
XLSX in phase 2a, DOCX in phase 2b). Agent-edit captures come later (see the
end).

## Storage and lifecycle

Each file keeps one thumbnail, the latest capture, at a content-addressed key:

```
thumbs/{file id}/{sha256 of the WebP}.webp
```

- `files.thumbnail_key` names it (migration 0073). It is a counted blob
  reference like `blob_path`: the `files_blob_refs_after` trigger runs
  `account_blob_refs('blob_path', 'thumbnail_key')`, so a new key references
  the new object and releases the old one through `blob_unref` and the
  `pending_blob_deletions` outbox. Clearing the key, purging the file, deleting
  its workspace and purging the account release it the same way (the cascades
  fire the row trigger).
- A trashed file keeps its thumbnail until the 30-day purge.
- A key names its file, and a file id leads to the file's workspace (a link
  workspace's id is its share link), so the file id in a key's path is always
  a file of the same workspace as the row holding it:
  - A clone never shares a key: a workspace clone (the owner's own included; a
    link workspace cloned into a public one would show the source ids) or a
    single file clone (`POST /api/files/{id}/clone`, into the same workspace or
    another). The clone leaves `thumbnail_key` empty, and after it commits the gateway copies
    the object inside the bucket (`blob.Copy`, S3 CopyObject) to
    `thumbs/{clone file id}/{same hash}.webp` and records it
    (`SetCloneThumbnail`; a file gone or captured meanwhile takes nothing and
    the copy is queued for deletion). A failed copy leaves the file without a
    thumbnail until its next capture: logged, never retried. The copies run in
    the clone request, one CopyObject per thumbnail.
  - Only a reuse within one workspace shares a key (below); the reaper
    re-checks references before every delete, so the sharing file keeps the
    object alive after the original goes.
- An unchanged capture (same key) skips the upload and the update.
- Thumbnails are a platform cost: no storage quota, no reservation, and
  `size_bytes` and the storage triggers ignore them (about 1-8 KB each).
- The monthly orphan sweep lists `thumbs/` too; live keys are known through the
  `blobs` table (`KnownObjectPaths`).
- A thumbnail change raises the workspace tree event (`files_tree_notify_after`
  now watches `thumbnail_key` and `preview`), so open lists refetch and show it.
  Material previews ride content writes, which stay silent by decision; lists
  see a new material preview on their next fetch.

Sources: [migration](../server/migrations/0073_thumbnails.sql),
[reference-count test](../server/internal/store/blobs_test.go)
(`TestThumbnailKeyIsACountedReference`),
[clone copies](../server/internal/httpapi/huma_share.go)
(`TestCloneCopiesThumbnails`, a security regression test).

## Links and access

List rows carry `thumbnailUrl`, an hour-stable presigned GET
(`blob.PresignStableGet`): the v4 signing time is truncated to the UTC hour and
the link lasts two hours from it (`StableLinkTTL`), so every list fetch within
an hour gets the byte-identical URL and the browser serves the image from its
cache. The object is stored with `Cache-Control: public, max-age=31536000,
immutable`; the next hour's URL is a new cache entry.

- Signed in the handler for every row of the owned file list
  (`GET /api/files`), the workspace file list (`GET /api/workspaces/{id}/files`,
  members and link/public readers alike) and trash rows of kind `source_file`
  (`GET /api/trash`). Single-file responses carry no link.
- The rule is that the link follows the file's read access. Handlers sign only
  rows their access-scoped queries already returned for the caller, so a link
  is never minted for a file the caller cannot read
  (`TestListThumbnailsFollowReadAccess`, a security regression test).
- Signing is local: one SHA-256 of the canonical request and one HMAC with the
  cached signing key, about 15 µs per row; no database call per row. It signs
  outside the S3 SDK's presign stack, which measured about 130 µs per URL.
  Memory and disk blob stores (E2E) return a constant URL per key.
- The anonymous workspace summary still lists files as name, size and date
  only (its 2026 decision), so it carries no thumbnails.

Sources: [presign](../server/internal/blob/s3.go),
[handlers](../server/internal/httpapi/huma_content.go),
[access test](../server/internal/httpapi/thumbnails_test.go).

## Ingest render

A successful ingest captures before the local source is cleaned up, after the
job committed (`_capture_thumbnail` in the worker, `pipeline/ingest/thumbnail.py`):
the donor-reuse, content-reuse and indexed exits all reach it.

| Route | Thumbnail |
| ----- | --------- |
| PDF and Office (`document_parse`) | the bundle's `page1.png`: the parse job renders page 1 of the PDF it holds, in its bounded child (the font-repaired bytes when there are any, an Office file's LibreOffice conversion; `odl.capture.page_thumbnail`, 200 px wide, cut at 400 px), and the ingest encodes it as WebP after checking from its header that it is a PNG of at most 200 x 400. The worker never renders a document (no PyMuPDF in it for thumbnails) and never calls `/capture_page` for them (chat keeps using it). A bundle without the image (an older parser, a failed render) means no thumbnail |
| Image (`image_caption`) | Pillow: first frame, EXIF orientation, shrunk to 200 px wide and cut at 400 px before it is converted and flattened on white; refused over `CAPY_IMAGE_MAX_PIXELS` or Pillow's decompression-bomb limit; SVG gets none (no rasterizer), HEIC only with a Pillow plugin |
| Text (`raw_text`) and CSV/TSV (`delimited_text`) | no image: `files.preview = {"text": ...}`, the first 600 characters of the source (a text-mode read, never cut mid-character; NUL removed). Cards draw text and code as monospace lines, and a CSV or TSV (kind `sheet`) as a small table: its first 8 rows and 5 columns, the first row the header, tab-separated when the first line has a tab, quoted cells kept whole |
| Store-only, audio | none |

- The image is WebP, quality 60, 200 px wide (narrower images are not
  enlarged), cut at 400 px tall from the top: cards crop pages from the top.
- The update is fenced to the bytes rendered: `UPDATE files SET thumbnail_key
  ... WHERE source_sha256 = <rendered bytes> AND trashed_at IS NULL`. A file
  replaced, trashed or deleted meanwhile takes nothing, and the new key is
  queued for deletion at once (`blob_enqueue_deletion`), as it is when the
  update fails after the B2 write.
- A source refresh (an edited text or Office source) publishes and ingests
  again, so the new bytes replace the thumbnail or text preview, unless an
  editor's browser has captured the file
  ([Ingest after a capture](#browser-captures)).
- A PDF or Office file the parse job reused from identical indexed bytes (the
  donor path, `_reuse_donor` called from the parse job in
  `pipeline/ingest/worker.py`) has no bundle, so it takes the thumbnail key of
  a live file holding the same bytes in the same workspace
  (`db.share_file_thumbnail`). A file in any other workspace never lends its
  key, the same owner's included
  (`test_a_reuse_never_shares_a_key_from_another_workspace`, a security
  regression test). The shared key outlives the original while the copy
  references it. Text sources need no copy: their preview is read from the
  reused bytes, which are identical.
- The parser's page render is optional too: a failure prints `page thumbnail
  skipped` and the parse goes on without `page1.png`. Its time is the
  `thumbnail` phase of the parse receipt. The worker's bundle check refuses a
  `page1.png` over 1 MiB.
- Failure policy: any error is logged (`thumbnail capture failed`, structured,
  with the trace id) and dropped. No retry, the job is already committed, and
  the card keeps its icon or its previous thumbnail until the next capture.

Measured on the developer PC (2026-10-11, three runs, median): the parse-side
page render adds 3.4-37 ms to a PDF parse (a 27 MB textbook 21.5 ms) and
1.7-20 ms to an Office parse (the `thumbnail` phase of a real parse: 2-23 ms;
the LibreOffice conversion it reuses takes 2.2-28 s); the ingest's PNG to WebP
step takes 4-28 ms and a 12 MP JPEG photo 132 ms. A second conversion through
`/capture_page`, the first version of this, took 3.2-8 s per small Office
document and 28.5 s for a 24 MB deck.

## Material previews

Every Go writer of `materials.content` stores `materials.preview` in the same
statement: `createMaterialTx`, `UpdateMaterial`, `ProjectMaterialContent` (the
Yjs projection) and the workspace and material clones (recomputed, since a
clone drops media it could not copy). `materialdoc.Preview` derives it; it is
answer-free and about 1 KB at most. `MaterialListItem` and trash rows return it
as `preview`; the client types the union by hand. The workspace tree's
`MaterialRef` carries none (nothing there draws it, and the tree refetches
often). Materials written before migration 0073 get theirs from the one-shot,
idempotent `previewbackfill` (rows still NULL, in batches, so an interrupted
run is simply rerun; run by hand, never at startup), or from their next
content write. The server image carries it:
`docker exec server-<resource-uuid> /app/previewbackfill` (the container
already has `DATABASE_URL`).

| Kind | Preview |
| ---- | ------- |
| `note` | `{kind, blocks}`: up to 8 blocks and 600 characters of text in total. Blocks: `{t:'h', text, level}`, `{t:'p', text}`, `{t:'ul', items}` (consecutive list items of any bullet style), `{t:'todo', items:[{done, text}]}`, `{t:'table', rows}` (4 x 4 at most; a row without cells is `[]`, never null), `{t:'math', tex}`, `{t:'code', text, lang?}` (6 lines at most), `{t:'quote', text}`, `{t:'image'}` (a marker). Callouts, columns and toggles are read through; dividers, tables of contents, media, embeds, diagrams, charts and study blocks are skipped. An empty note has `blocks: []`. |
| `quiz` | `{kind, questionCount, first?}` with `first = {type, stem, options?, prompts?, itemCount?, hasChart?}`: `type` is the first question's first part answer type; `stem` is that part's text, or the question stem when the part has none, cut to 200 characters (a gaps blank becomes `\u0001`); mcq and multi `options` keep their stored order (they carry no key); `hasChart` when the stem or the part holds a chart or graph. Readers of a list never get quiz keys, so a matching question shows only its left-hand `prompts` (stored order) and an ordering question only its `itemCount`: the right-hand values with any pairing, and the items in any order, could be the answer. Epo approved this rule on 2026-10-11 (`TestPreviewHidesTheAnswerKey`, a security regression test). Options and prompts keep at most 4 entries of 60 characters. |
| `flashcards` | `{kind, cardCount, first?: {front, hasImage}}`, the front clipped to 200 characters |
| `mindmap`, `diagram` | `{kind, source}`, the Mermaid source cut to 1 KB on a line boundary |

Editor assets have no small variant (the stored object is the uploaded image,
up to the plan image cap), so `{t:'image'}` and `hasImage` are markers only:
cards draw a tinted frame with the image glyph where the image is (a note that
is only an image fills its page with it; under a long flashcard front the frame
shrinks and the front keeps at most three lines). Epo kept the marker over
small copies on 2026-10-11.

Sources: [extractor](../server/internal/materialdoc/preview.go),
[table test](../server/internal/materialdoc/preview_test.go),
[writers test](../server/internal/store/material_preview_test.go).

## Browser captures

An edit frame of a DOCX, PPTX or XLSX file redraws the file's thumbnail as it is
edited and Capy posts it to Go, which writes it to B2 itself (no upload
session, no quota).

**Endpoint.** `POST /api/files/{id}/thumbnail`, raw body `image/webp`, `204` on
success ([handler](../server/internal/httpapi/huma_thumbnails.go)):

- Edit role only (`assertFileEditor`; anyone else gets `404`), and only for
  files that open in an Office editor (`store.SourceEditFormat` is docx, xlsx
  or pptx; anything else `422`).
- At most 64 KB (`413` past it). The body must be one RIFF WebP whose RIFF size
  equals its length and whose chunks are one image and nothing else: a lone
  `VP8 ` or `VP8L` chunk, or `VP8X` with only its alpha flag, an optional
  `ALPH` and then the image chunk, which ends exactly at the RIFF end (no
  `JUNK`, metadata, ICC profile, animation, second image or stray bytes). The
  image is at most 200 x 400 by its header and must decode in full with
  `golang.org/x/image/webp` (pure Go; the header's size is checked first and
  x/image holds the frame to it). Otherwise `422`.
- The key is `thumbs/{file id}/{sha256}.webp`. The current key answers `204`
  and writes nothing.
- One accepted capture per file per 60 s: `files.thumbnail_captured_at`
  (migration 0074) is claimed by one conditional update, so racing captures
  cannot both pass; a capture inside the interval gets `429`
  (`thumbnail_too_soon`) before anything is written. Per user, 60 captures an
  hour through the Redis limiter (`ratelimit` class `thumbnail`, Epo's number).
- Then the B2 put (`Cache-Control: public, max-age=31536000, immutable`,
  `blob.Store.PutObjectOnce`) and `SetFileThumbnail`: the key change releases the
  old key through the phase 1 triggers; a file trashed or deleted meanwhile
  takes nothing and the new key is queued for deletion at once, as it is when
  the update fails (an enqueue that fails too leaves it to the orphan sweep).
- Nothing retries: the put is one request (`blob.Store.PutObjectOnce`, the S3
  client's retryer limited to one attempt for this call only; the shared
  client keeps its retries elsewhere), and a failed put is a `503`. A put that
  failed may still have written the object, so its key is queued for deletion
  too; these enqueues run past the request's cancellation
  (`EnqueueBlobDeletion`, `context.WithoutCancel`).

**Browser** ([scheduler](../src/features/files/thumbnailCapture.ts), wired in
`useOfficeRuntime`):

- Only in an edit frame, and only where a canvas encodes WebP
  (`OffscreenCanvas.convertToBlob` answers `image/webp`; Safari answers PNG and
  captures nothing).
- A local edit (the runtime's `update`) starts a cycle. 5 s after the last
  edit Capy asks the runtime for the capture (`render` {kind: 'thumbnail'},
  `rendered` with one WebP page, none when there is nothing to capture) and
  keeps the bytes. 60 s after the last edit, or 10 minutes after the cycle's
  first edit while editing goes on, it uploads them (drawing again first when
  edits came after the drawing). `pagehide`, or the page turning hidden,
  uploads what was drawn with `fetch(…, {keepalive: true})`, sent at once with
  the auth headers fetched when it was drawn (any other upload fetches fresh
  ones).
- A capture of 65,535 bytes or more is never sent: Go refuses a 64 KiB body
  and keepalive uploads share a 64 KiB budget.
- An upload needs the room to have every edit (the session reads `saved`) and
  the user to be able to edit (not paused, handoff, recovery or offline at its
  bound). Remote edits start nothing: the peer who edits captures.
- An upload due while the room is still saving (or editing is paused) waits:
  the 60-second upload stays pending when the 10-minute mark finds the room
  saving.
- Failures are logged once (`Thumbnail capture failed`) and never retried: a
  failed drawing ends its cycle. A refused upload (a `429` included) is not
  sent again by itself, but its edits stay uncaptured, so the next upload (the
  one still due 60 s after the last edit, the next edit's, leaving) carries
  them. The card keeps its image until then.
- Leaving the file inside the app (View, another file, another page) uploads
  what was drawn the same way, from the capture's effect cleanup.

**Drawing** ([runtime](../src/office-runtime/thumbnail.ts)): in the runtime
frame, when its main thread is next idle (`requestIdleCallback`), never on the
keystroke or save path, from what the engine holds (pending input is not
flushed). 200 px wide, cut at 400 px tall, on white, WebP at quality 60
(`OffscreenCanvas.convertToBlob`); the canvas is released after encoding.
Chrome writes an sRGB ICC profile before the image (`VP8X` with the ICC flag,
`ICCP`), which Go refuses and browsers assume anyway, so the runtime keeps the
image chunk alone (`imageOnlyWebP`; 464 bytes smaller).

- DOCX (phase 2b): page 1 whole, as ingest stores it (a Letter or A4 page is
  200 x 259 or 200 x 283), from Print's raster of it: the editor's
  `renderPages` draws the page at twice its CSS size on the main thread, where
  the document's fonts are, from the display list the frames keep current, and
  the capture draws it down to 200 px (`imageSmoothingQuality: 'high'`; the
  default smoothing aliases text badly). `renderPages` draws every page, so the
  capture ends its loop after page 1 (`pageThumbnail`): no later page is
  rastered. Host only, no fork change: the layout worker, its `relayout`
  request and frame queue are untouched.
- PPTX: slide 1 (`layoutSlide(0)` and `paintSlide`, as Print, with its
  pictures decoded once for the drawing), on the main thread, where the
  slide's fonts are.
- XLSX: the first sheet's top-left 800 x 550 sheet px at a quarter scale
  (200 x 138, the cards' 16:11 panel: cards crop pages from the top, and
  painting cells is the main cost). The workbook worker builds the display
  list and a thumbnail worker of its own (`thumbnail.worker.ts`, ended with the
  capture, or on an error, an unreadable message or 30 s) paints and encodes
  it, with the system fonts it falls back to (the same at that scale). The engine draws only the active sheet, so the request
  names the first sheet (`onSheet`).
- XLSX edits count only on the first sheet (Epo, 2026-10-11: the card is the
  first sheet, which is stable for the user's visual memory). The runtime's
  `update` message says whether the edit may change the capture
  (`capture`, from the host's `OfficeCaptureScope`; always true for DOCX
  and PPTX), and only those start a capture cycle. The engine draws only the
  active sheet, so a click on a sheet tab while first-sheet edits are not
  drawn yet draws them before the switch, and a capture on another sheet sends
  that drawing. Leaving the first sheet any other way within 5 s of an edit
  ends that cycle with nothing; formulas on the first sheet that change with
  other sheets wait for its next edit.

Main-thread cost of one capture (production build, developer PC, 2026-10-11,
three runs): XLSX at most about 1 ms in one task (the worker's own paint and
encode take about 350 ms of wall time); PPTX `lecture.pptx` 2-3 ms; slide 1 of
`jp_llm2.pptx` (Japanese text) one task of 19-23 ms, the canvas
rasterizing its glyphs at the new size when it is encoded. Painted on the main
thread, the XLSX cells were one 40-55 ms task. DOCX (phase 2b, the same
setup): page 1 of `exchange-plan.docx` (a title page) one task of 14-20 ms, of
`long-handbook.docx` (a full page of text) one of 37-39 ms: the page raster at
twice its size is most of it, the high-quality downscale about 10 ms (the
default smoothing took 10 and 29 ms, unreadable). Captures are 2.5 and 7.1 KB.

The new key raises the tree event like any thumbnail change, so open lists
refetch and show it.

**Ingest after a capture.** Once a file has a browser capture
(`thumbnail_captured_at` is set), the browser owns its thumbnail: an ingest
refresh neither writes its page-1 key (`set_file_thumbnail`) nor shares a
reused file's key (`share_file_thumbnail`), and the key it rendered is queued
for deletion like any capture no row takes (decided 2026-10-11, review T3 S4).

Sources: [endpoint test](../server/internal/httpapi/thumbnail_capture_test.go),
[store test](../server/internal/store/thumbnail_capture_test.go),
[scheduler test](../src/features/files/thumbnailCapture.test.ts),
[runtime test](../src/office-runtime/thumbnail.test.ts),
[e2e](../e2e/editor/thumbnail-capture.spec.ts).

## Phase 2

- Captures after an agent's `edit_document` on Office files: queued
  2026-10-11 to the Rust harness session, which implements them and checks
  their cost in its performance round. Epo's design: once per finished agent
  response (Go's `FinalizeAssistantMessage` has the turn's edited files),
  only when page 1 may have changed (XLSX a cell in the first sheet's capture
  area, PPTX slide 1, DOCX always), export the live state and render page 1 on
  the ingest host, whether or not the file is open in a browser.
- Text previews after edits in a workspace with auto-process off: the preview
  is written by ingest, so it waits for the next refresh. Queued with the
  above: the source checkpoint save carries the opening text and Go writes
  `files.preview`, as materials do on every write.
