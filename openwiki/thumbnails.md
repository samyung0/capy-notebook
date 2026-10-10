# Thumbnails and list previews

List cards (Files, Create, Trash, the dashboard's recents) show what an item
looks like without opening it. A source file gets a small image of page 1, or
for a text source its opening characters. A material (note, quiz, flashcards,
mindmap, diagram) gets a live preview drawn in the browser from a small JSON
summary of its content. Decisions: `human/authorization-permissions-lifecycles.md`
and `human/backend-storage-quota.md` (2026-10-11).

Phase 1 (this page) renders file thumbnails at ingest only. Browser captures of
edited Office files and agent-edit captures are phase 2 (see the end).

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
- A workspace clone copies `thumbnail_key` and shares the object; the reaper
  re-checks references before every delete, so the clone keeps it alive after
  the original goes. A later capture of the clone writes under the clone's own
  file id and releases the shared key.
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
(`TestThumbnailKeyIsACountedReference`).

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
| PDF (`document_parse`) | PyMuPDF page 1, from the bundle's font-repaired `parsed.pdf` when present, else the spooled source |
| Office (docx, pptx, xlsx) | the bundle's `page1.png`: the parse job renders page 1 of the PDF its LibreOffice conversion already produced (`odl.capture.page_thumbnail`, 200 px wide, cut at 400 px) and the ingest encodes it as WebP. A bundle without one (from an older parser, or a failed render) means no thumbnail; ingest never calls `/capture_page` for thumbnails (chat keeps using it) |
| Image (`image_caption`) | Pillow: first frame, EXIF orientation, transparency flattened on white; refused over `CAPY_IMAGE_MAX_PIXELS` or Pillow's decompression-bomb limit; SVG gets none (no rasterizer), HEIC only with a Pillow plugin |
| Text (`raw_text`) | no image: `files.preview = {"text": ...}`, the first 600 characters (a text-mode read, never cut mid-character; NUL removed) |
| Store-only, audio, delimited text | none |

- The image is WebP, quality 60, 200 px wide (narrower images are not
  enlarged), cut at 400 px tall from the top: cards crop pages from the top.
- The update is fenced to the bytes rendered: `UPDATE files SET thumbnail_key
  ... WHERE source_sha256 = <rendered bytes> AND trashed_at IS NULL`. A file
  replaced, trashed or deleted meanwhile takes nothing, and the new key is
  queued for deletion at once (`blob_enqueue_deletion`), as it is when the
  update fails after the B2 write.
- A source refresh (an edited text or Office source) publishes and ingests
  again, so the new bytes replace the thumbnail or text preview.
- An Office file the parse job reused from identical indexed bytes (the
  donor path, `_reuse_donor` called from the parse job in
  `pipeline/ingest/worker.py`) has no bundle to render from, so it takes the
  thumbnail key of a live file holding the same bytes
  (`db.share_file_thumbnail`): one in the same workspace first, else one in a
  link or public workspace, the files donor reuse itself may read, so a key
  never points into a private workspace. The key is shared like a clone's and
  outlives the original while the copy references it. Text sources need no
  copy: their preview is read from the reused bytes, which are identical.
- The parser's page render is optional too: a failure prints `page thumbnail
  skipped` and the parse goes on without `page1.png`. Its time is the
  `thumbnail` phase of the parse receipt. The worker accepts a `page1.png` of
  at most 1 MiB and checks it is a PNG.
- Failure policy: any error is logged (`thumbnail capture failed`, structured,
  with the trace id) and dropped. No retry, the job is already committed, and
  the card keeps its icon or its previous thumbnail until the next capture.

Measured on the developer PC (2026-10-11, three runs, median): PDF page 1
12-58 ms (a 27 MB textbook 41 ms; the first call in a process also pays about
2.8 s of PyMuPDF start-up), a 12 MP JPEG 132 ms. Office: the page render adds
1.7-20 ms to the parse (the `thumbnail` phase of a real parse: 2-23 ms; the
LibreOffice conversion it reuses takes 2.2-28 s) and the ingest's PNG to WebP
step 4-28 ms. A second conversion through `/capture_page`, the first version
of this, took 3.2-8 s per small document and 28.5 s for a 24 MB deck. Raw
numbers: `C:/WEB/capy-harness/2026-10-11-thumbnails/t1-bench/`.

## Material previews

Every Go writer of `materials.content` stores `materials.preview` in the same
statement: `createMaterialTx`, `UpdateMaterial`, `ProjectMaterialContent` (the
Yjs projection) and the workspace and material clones (recomputed, since a
clone drops media it could not copy). `materialdoc.Preview` derives it; it is
answer-free and about 1 KB at most. `MaterialListItem`, `MaterialRef` and trash
rows return it as `preview`; the client types the union by hand.

| Kind | Preview |
| ---- | ------- |
| `note` | `{kind, blocks}`: up to 8 blocks and 600 characters of text in total. Blocks: `{t:'h', text, level}`, `{t:'p', text}`, `{t:'ul', items}` (consecutive list items of any bullet style), `{t:'todo', items:[{done, text}]}`, `{t:'table', rows}` (4 x 4 at most), `{t:'math', tex}`, `{t:'code', text, lang?}` (6 lines at most), `{t:'quote', text}`, `{t:'image'}` (a marker). Callouts, columns and toggles are read through; dividers, tables of contents, media, embeds, diagrams, charts and study blocks are skipped. An empty note has `blocks: []`. |
| `quiz` | `{kind, questionCount, first?}` with `first = {type, stem, options?, pairs?, items?, hasChart?}` (orchestrator decision 2026-10-11): `type` is the first question's first part answer type; `stem` is that part's text, or the question stem when the part has none, cut to 200 characters (a gaps blank becomes `\u0001`); mcq and multi `options` keep their stored order; `hasChart` when the stem or the part holds a chart or graph. The stored order of matching pairs and ordering items is the answer key, which readers never get: matching `pairs` puts the left items and the options side by side with each column sorted alphabetically on its own (rows are not matches), ordering `items` are sorted alphabetically. Options, pairs and items keep at most 4 entries of 60 characters. |
| `flashcards` | `{kind, cardCount, first?: {front, hasImage}}`, the front clipped to 200 characters |
| `mindmap`, `diagram` | `{kind, source}`, the Mermaid source cut to 1 KB on a line boundary |

Editor assets have no small variant (the stored object is the uploaded image,
up to the plan image cap), so `{t:'image'}` and `hasImage` are markers only.

Sources: [extractor](../server/internal/materialdoc/preview.go),
[table test](../server/internal/materialdoc/preview_test.go),
[writers test](../server/internal/store/material_preview_test.go).

## Phase 2

- `POST` capture endpoint in Go for browser captures: WebP only, about 64 KB,
  editors only, a minimum interval per item, the same key, hash skip and outbox
  on failure; PPTX and XLSX captured in the browser, DOCX after the lean
  editing work lands.
- Captures after an agent's `edit_document` on Office files need an export of
  the current Office state; an open design question.
- Note preview images and flashcard image fronts need a small copy of editor
  assets.
