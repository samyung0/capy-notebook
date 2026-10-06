# Storage and upload lifecycle: open work

Items from the 2026-10-06 audit of interrupted flows (tab closed, network
lost, crash between two requests) that leave stored bytes or charged rows
behind, and the decisions Epo made on them the same day. Decisions live in
`human/authorization-permissions-lifecycles.md`,
`human/backend-storage-quota.md`, `human/agentic-retrieval.md`,
`human/study-progress.md` and `human/decks.md`; current behaviour in
`openwiki/backend-storage-quota.md` and
`openwiki/authorization-permissions-lifecycles.md`.

Landed from the audit: every child of a material follows the parent's save
(369ad5db: embedded quiz and flashcard rows are trashed like images are
deleted, once unreferenced and over 60 s old; `reference_seen_at` dropped by
0064), and a deck PPTX whose row insert fails is deleted on an uncancelled
context (dbf26afc). The AI-edit Undo storage item is in `todo-office.md`.

## Built 2026-10-06 (uncommitted), to verify on UAT

- **Pastes and removed children on the server.** The collaboration service's
  children pass (`collaboration/src/children.ts`) makes the ids a writer's
  update or an AI edit/Undo wrote the note's own through
  `POST /internal/collaboration/materials/{id}/children`; a removed child sits
  in a hidden trash for a day (`editor_assets.trashed_at`, migration 0065;
  embedded rows `unreferencedRetention`); the browser's adopt calls, id swaps
  and kept bytes are gone (`noteAssets.ts` deleted, `capy-local` IndexedDB v3
  drops `keptAssets`). Run the UAT note journey (`pnpm e2e:uat:journeys`,
  `note.spec.ts`), whose image and quiz steps now expect the trash and the
  pass, after deploying.
- **Embedded quizzes and flashcards record nothing.** No attempt row, no
  rating (422 if sent); the result lives on the page.
- **Presigned PUTs bind the byte size.** B2 answered 403 for a 10- or 4-byte
  body against a signed 5 on the UAT bucket (probe object deleted). A declared
  empty source file stays unbound: the S3 SDK cannot sign a zero length, and
  finalize still refuses a mismatch.
- **Retry processing for failed files.** File menu and Indexing tab, the upload
  dialog's retry mode, `POST /api/files/{id}/retry-processing`; automatic
  processing skips failed files.

## Accepted (2026-10-06)

- A material never saved again keeps its unreferenced children (images,
  embedded rows) until it is purged.
- A deck PPTX orphaned by a crash between the bucket write and the row insert
  stays; the monthly blob sweep reports it and deletes nothing.
- A source file whose processing failed stays charged (viewable and
  reprocessable); recorded in `human/backend-storage-quota.md`.
