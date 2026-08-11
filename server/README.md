# Evo Notes — Gateway (Go)

Thin HTTP gateway implementing the frontend's `/api` contract (see
`src/mocks/handlers.ts`) against Postgres. Heavy ML (parsing, RAG) lives in the
Python `pipeline/` service and is reached via an async job queue + HTTP.

## Run

With Docker (recommended — brings up Postgres + pgvector too):

```bash
docker compose -f ../deploy/docker-compose.yml up --build
# gateway on http://localhost:8080, e.g. GET /api/me
```

Standalone (needs a Postgres reachable at `DATABASE_URL`):

```bash
cp .env.example .env          # adjust DATABASE_URL if needed
go mod tidy                   # resolve deps + write go.sum (first run)
go run ./cmd/api
```

### OpenAPI reference

From the repository root, run:

```bash
pnpm api:docs
```

This serves the checked-in `openapi.yaml` at `http://localhost:3000`, so it does
not require Go. When Go is available and the contract needs regeneration, use
`pnpm api:docs:generate` instead.

Backblaze B2 is required. Set every `B2_*` variable in `.env`; startup verifies
bucket access and exits if those credentials are invalid.

The server applies the embedded `migrations/0001_init.sql` development baseline
(schema + seed) on startup; it is idempotent.

### Bucket configuration

Apply `../deploy/b2-lifecycle.example.json` to the bucket. Two things depend on
it:

- The `incoming/` and `editor-assets/incoming/` prefixes expire after a day. A
  presigned PUT that is never completed is then free, with no code involved, and
  the orphan sweep can skip those prefixes entirely.
- Keeping only the last file version stops hidden objects billing forever. B2
  hides rather than deletes by default, so without a `daysFromHidingToDeleting`
  rule every object the reaper "deletes" is still charged for.

### Object lifecycle

Bucket objects are deleted in exactly one place: the reaper in
`cmd/api/blob_workers.go`, draining `pending_blob_deletions`. Nothing in a request
handler deletes an object.

Rows land in that queue from refcount triggers on `files`, `editor_assets` and
`upload_sessions`. Because those are row-level `AFTER DELETE` triggers, they fire
on FK cascades too — which is the point, since deleting a workspace or purging an
account never runs handler code for the files inside. `blobs.ref_count` is what
lets a cloned workspace share a source object safely: the object goes only when
its last holder does.

A monthly report-only sweep lists the bucket and logs keys with no database
reference. That is the backstop for objects written without a row at all, and it
deletes nothing.

## Collaboration authority

The Hocuspocus service in `../collaboration` is authoritative for initialized
material content. Configure the gateway with:

```text
COLLABORATION_SECRET=<same long random value as the sidecar>
COLLABORATION_URL=ws://localhost:1234
COLLABORATION_INTERNAL_URL=http://localhost:1234
```

`COLLABORATION_URL` is returned to browsers in short-lived room tokens.
`COLLABORATION_INTERNAL_URL` is server-to-sidecar only and carries headless
quiz/flashcard commands. Content mutations fail with 503 when an initialized
Y.Doc cannot be reached; they never fall back to SQL.

`material_yjs_documents.state` is the durable content authority.
`materials.content` is an asynchronously checkpointed read projection used by
static/study views, exports, and domain reads. The internal projection endpoint
is authenticated with `X-Collaboration-Secret`, validates the Plate envelope,
locks the material, rejects stale versions, advances the material revision, and
reconciles flashcard stats.

Comments remain relational. Their anchors are paired encoded Yjs relative
positions plus stable block ID/version/quote fallback. Comment mutations publish
Redis invalidations. Membership changes and deletions publish room eviction
events.

## Support: cancel a scheduled account deletion

Users cannot undo account deletion themselves. After they confirm, sessions are
revoked and auth returns `account_deletion_pending` until purge. To reactivate
an account still inside the grace window:

```bash
DATABASE_URL=... go run ./cmd/cancel-deletion -user <user_id>
DATABASE_URL=... go run ./cmd/cancel-deletion -email user@example.com
# optional: also send the deletion-cancelled email + in-app notice
DATABASE_URL=... go run ./cmd/cancel-deletion -email user@example.com -notify
```

## Layout

- `cmd/api` — entrypoint (config, migrate, serve, graceful shutdown).
- `cmd/cancel-deletion` — support tool to reactivate a deletion-pending account.
- `internal/store` — pgx pool, models (mirror `src/api/types.ts`), queries.
- `internal/httpapi` — chi router + handlers (mirror `src/mocks/handlers.ts`).
- `migrations` — `0001_init.sql` (complete schema and development seed). It owns
  the retrieval index (`rag_*`) as well, so it needs the `vector` extension and
  must run against `pgvector/pgvector:pg16` rather than stock Postgres.

## Connect the frontend

From the repo root:

```bash
# point the SPA at the real gateway instead of MSW
VITE_USE_MSW=false pnpm dev
```

Vite proxies `/api` → `http://localhost:8080` (see `vite.config.ts`).

## Notes / next

- `POST /workspaces/:id/chat` and `/generate` are Phase-1 placeholders returning
  the same shapes as the mock; Phase 3 wires them to the Python retrieval service.
- File uploads currently land `status='ready'`; Phase 2 switches to multipart +
  `status='processing'` + an `ingest` job on the Postgres-backed `jobs` queue.
