# Storage and upload lifecycle: open work

Open items from the 2026-10-06 audit of interrupted flows (tab closed, network
lost, crash between two requests) that leave stored bytes or charged rows
behind. Decisions live in `human/authorization-permissions-lifecycles.md`,
`human/backend-storage-quota.md` and `human/decks.md`; current behaviour in
`openwiki/backend-storage-quota.md` and
`openwiki/authorization-permissions-lifecycles.md`. Each item needs a decision
from Epo, recorded in `human/` before it is built (`human` skill). The file
references come from the audit and are unverified.

Landed from the audit: every child of a material follows the parent's save
(369ad5db: embedded quiz and flashcard rows are trashed like images are
deleted, once unreferenced and over 60 s old; `reference_seen_at` dropped by
0064), and a deck PPTX whose row insert fails is deleted on an uncancelled
context (dbf26afc). The AI-edit Undo storage item is in `todo-office.md`.

## Open

- **A pasted block or image left pointing at another note's material.** When
  a paste's id swap never lands (the tab closes after the adopt response, or
  the editor unmounts, the `disposed` checks in
  `src/features/notes/noteAssets.ts`), the note keeps the other note's id. An
  image keeps rendering the other note's asset until that note's save deletes
  it, then breaks. A quiz or flashcards block shows the other note's material
  and lets the user edit it: `MaterialRefCard` loads by `materialId`, the edit
  navigation in `src/features/notes/blocks/elements.tsx` (`MaterialRefElement`)
  checks nothing, and `reconcileEmbeddedTx` ignores rows under other notes.
  Options to put to Epo: the editor re-adopts foreign references when a note
  opens, or the server or renderer refuses a reference that is not the note's
  own.
- **Presigned PUTs do not bind the byte size.** Source uploads
  (`server/internal/httpapi/huma_sources.go` ~262) and editor assets
  (`server/internal/httpapi/editor_assets.go` ~191) sign bucket, key and
  Content-Type only (`server/internal/blob/s3.go` ~142-155). The declared size
  is reserved, but a client can PUT far more. A source upload's oversize
  object is deleted only if the client calls complete (`huma_sources.go`
  ~321-323); otherwise it sits uncharged under `incoming/` until the bucket
  rule removes it (about 1-2 days, `deploy/b2-lifecycle.prod.json`). Check
  whether B2's S3 API honours a signed Content-Length; its single-PUT ceiling
  (about 5 GB) is unconfirmed.
- **Failed source files stay charged.** A file whose ingest failed keeps
  `size_bytes` and its blob (`pipeline/pipeline/store/db.py` ~815-822), and
  storage counts every file whatever its status
  (`server/internal/store/storage.go` ~587). It stays until the user trashes
  it, the workspace is deleted or the account is purged. The user sees the
  file and can delete it, so ask Epo whether that is intended, or whether a
  failed file should stop counting or be cleaned up.

## Accepted (2026-10-06)

- A material never saved again keeps its unreferenced children (images,
  embedded rows) until it is purged.
- A deck PPTX orphaned by a crash between the bucket write and the row insert
  stays; the monthly blob sweep reports it and deletes nothing.
