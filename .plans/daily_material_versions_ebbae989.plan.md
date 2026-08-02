---
name: Daily Material Versions
overview: Keep `materials.content` as the live overwrite target and replace per-save revision inserts with one coalesced UTC-day snapshot per material. Retain the latest 7 changed-day versions for free owners and 30 for Pro/Team owners, covering direct edits and every suggestion mutation path.
todos:
  - id: update-daily-version-schema
    content: Update the baseline schema for one UTC version per material/day
    status: completed
  - id: centralize-version-writes
    content: Implement daily upsert/prune helpers and route edit/suggestion/clone writes through them
    status: completed
  - id: enforce-retention
    content: Cap revision reads and add startup/daily cleanup for downgrades
    status: completed
  - id: verify-document
    content: Update integration tests, run server checks, and document the versioning semantics
    status: completed
isProject: false
---

# Daily Material Versioning

The live JSON is already overwritten in `materials.content`; the storage growth comes from a new `material_revisions` row on every save. The frontend’s five-second autosave and full-document request remain unchanged—this is a server persistence change.

## Schema
- Because there are no deployed databases or existing data to preserve, update the baseline definition in [`server/migrations/0001_init.sql`](server/migrations/0001_init.sql) directly instead of adding compatibility/backfill SQL.
- Append a UTC `version_date` to `material_revisions` and enforce one row per `(material_id, version_date)`. Destructive schema reshaping is acceptable if it makes the daily-version contract cleaner; no legacy compaction path is needed.
- Continue treating `materials.revision` as the monotonic optimistic-concurrency counter; backup rows may therefore have gaps between their revision numbers.

## Central daily upsert and retention
- Add a shared transaction helper in [`server/internal/store/material_revisions.go`](server/internal/store/material_revisions.go) that upserts the latest title/content/metadata into today’s UTC row instead of inserting another copy, updating its revision and save timestamp on each write.
- Have the same helper prune rows beyond the material owner’s allowance: 7 for `free`, 30 for `pro`/`team`. Shared editors/commenters use the owner’s tier.
- Add a global prune method and invoke it at API startup and on a daily ticker in [`server/cmd/api/main.go`](server/cmd/api/main.go), so plan downgrades and legacy/external data are physically reduced even when a material is not edited. Also cap [`ListMaterialRevisions`](server/internal/store/collaboration.go) by the owner-tier limit as defense in depth.

## Apply to every content write
- Replace direct revision inserts in [`server/internal/store/queries.go`](server/internal/store/queries.go) for create/edit and in [`server/internal/store/revision_collaboration.go`](server/internal/store/revision_collaboration.go) for suggestion submit, accept, reject, and withdrawal with the shared daily upsert, inside each existing transaction.
- Update [`server/internal/store/share.go`](server/internal/store/share.go) to copy only retained daily snapshots, preserve each UTC version date while rewriting flashcard IDs, and prune cloned history to the new owner’s tier.
- Keep the existing revision API shape and frontend hooks unchanged; each returned item now represents the final saved state of one changed UTC day, with `createdAt` reflecting that day’s latest save.

## Tests and documentation
- Add a dedicated store test file for same-day overwrite/latest-content behavior, UTC day rollover, exact 7/30-version limits, owner-tier behavior for shared edits, and downgrade cleanup. Add suggestion submit/review coverage in [`server/internal/store/workspace_sharing_test.go`](server/internal/store/workspace_sharing_test.go), clone retention/flashcard rewrite coverage in [`server/internal/store/share_test.go`](server/internal/store/share_test.go), and an HTTP test that the revision endpoint never exposes more than the owner’s allowance.
- Update existing per-event revision assertions to daily-coalescing semantics and verify failed/conflicting writes do not alter the current daily backup.
- Run all Go server tests (including DB-backed tests with `TEST_DATABASE_URL`); frontend tests are only needed if the unchanged OpenAPI contract regenerates differently.
- Update the save/revision section of [`openwiki/frontend/plate-editor.md`](openwiki/frontend/plate-editor.md) to document the live-head versus daily-backup distinction, UTC bucketing, tier ownership, and the fact that collaboration revision IDs are concurrency markers rather than guaranteed per-event snapshots.