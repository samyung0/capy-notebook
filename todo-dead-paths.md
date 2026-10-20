# Dead conflict paths

From the 2026-10-19 review of which error toasts users can actually reach.
"Someone else changed this" (`revision_conflict`) and "This request was
already handled" (`operation_conflict`) come mostly from code the web app
never runs. Nothing below is decided; each item waits for a go-ahead.

What stays reachable for "Someone else changed this": question bank saves
(`bank.go` Save on `updated_at`), the generic `store.ErrConflict` races
(upload batch, Stripe and subscription compensation), and the frontend's own
`staleMark` in `usePdfAnnotations.ts`.

## 1. PDF annotation source identity

A file's `revision` only moves on an Office export
(`office_maintenance.go:376`) or a source refresh of an editable text or
Office source (`source_refresh.go:416`). A PDF goes through neither, so it
stays at `revision:1` and the identity check can never fail. Annotations are
per account as well.

- Server: the check in `server/internal/store/pdf_annotations.go:179`, the
  `revision:N` string `annotationLock` builds for it (line 117), the
  `SourceIdentity` field (line 30), the list filter (line 147) and the insert
  (line 195).
- Database: drop `pdf_annotations.source_identity` in a migration (no legacy
  data).
- Frontend: `sourceIdentity` built in
  `src/features/files/PdfAnnotations.tsx:52` and passed through
  (lines 64, 135, 259, 406), sent in `usePdfAnnotations.ts:28` and filtered at
  line 145.
- MSW: `src/mocks/handlers.ts:237`, `src/mocks/scenarioFixtures.ts:302`.
- Keep `staleMark` (`usePdfAnnotations.ts:18`, used at 72 and 80): undo after
  the same account deleted the mark in another tab still reaches it. Fix its
  comment, which says "another tab or person"; only another tab applies.

## 2. UpdateMaterial content path

Every production caller passes metadata only: `PATCH /materials/{id}`
(`huma_materials.go:337`), standalone privacy (`share.go:277`), flashcard set
name and colour (`share.go:2206`), quiz metadata (`queries.go:1940`). Content
goes through Yjs, so the content branch runs only in Go tests.

- `ExpectedRevision` on `MaterialPatch` (`server/internal/store/queries.go:1544`)
  and its check at 1593.
- The `p.Content` branch: `applyAuthoritativeContentCommand` (1596), the SQL
  content write after it, and the conflict at 1766 (only when content is set).
- `expectedRevision` in `store/collaboration_commands.go` (lines 76, 102,
  125). If UpdateMaterial is its only caller after this, the whole
  `applyAuthoritativeContentCommand` goes.
- Fix the `MaterialPatch` comment, which still lists content edits.
- Tests that write content through `UpdateMaterial` need another way to seed
  it: `embedded_test.go`, `note_index_test.go`, `material_preview_test.go`,
  `editor_assets_test.go`.
- Keep the owner check at 1743 (ownership transfer racing a metadata edit).

## 3. Material id conflicts

Public creates get a server id (`uid("mat")`, `queries.go:1132`); clients
cannot choose one. Only the internal chat endpoints use deterministic ids
(`ChatMaterialID`, `internal_materials.go:321`, `internal_documents.go:609`),
and their conflicts go back to the agent, not to a toast.

- `ErrMaterialConflict` (`server/internal/store/store.go:120`) is never
  returned; remove it and its check in `httpapi/server.go:349`.
- Fix the `ErrMaterialIDTaken` comment (`store.go:116`), which says the caller
  looks up the row and may return `ErrMaterialConflict`; nothing does.

## 4. Trash `requestId`

Restore and purge accept a `requestId` (`httpapi/huma_trash.go:37`, used at
79 and 93 through `clientOperationID`), but the frontend never sends one, so
there is no replay and no `operation_conflict` from the web app.

- Open question: does anything else (chat tools, a future client) need replay
  on trash? If not, remove `requestId`, `clientOperationID` and the
  `operation_conflict` branch in `trashError`.
- Chat agent operation ids (`ChatOperationID`) stay.

## 5. Frontend copy

Once 3 and 4 land, no web request returns `operation_conflict`.

- Remove the `operation_conflict` case in `src/lib/errors.ts:206` and the
  `error_operation_conflict_title`/`_body` messages, or keep the case mapped
  to the generic copy if the API stays public. Its current copy ("Reload the
  page to see the current state") misdescribes a reused id anyway.
- Update `openwiki/frontend/error-handling.md` and `test-catalog.md` for
  whatever is removed.
