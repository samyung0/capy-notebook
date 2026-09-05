# Capy Notebook — Gateway (Go)

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
set -a; . ../deploy/.env; set +a   # the binary does not auto-load env files
go mod tidy                        # resolve deps + write go.sum (first run)
go run ./cmd/api
```

## Test

From the repository root:

```bash
pnpm test:go
```

The command starts one disposable `pgvector/pgvector:pg16` container on a
random loopback port, applies migrations and test fixtures, runs every Go
package serially, and removes the container. Docker is the only database test
dependency. The test suite does not accept an existing database URL.

### OpenAPI reference

From the repository root, run:

```bash
pnpm api:docs
```

This serves the checked-in `openapi.yaml` at `http://localhost:3000`, so it does
not require Go. When Go is available and the contract needs regeneration, use
`pnpm api:docs:generate` instead.

`pnpm gen:api:full` regenerates OpenAPI, the Python `Surface` enum, and the
Orval TypeScript bindings. Frontend code imports generated contracts through
`src/api/types.ts`; the Ops API module is its equivalent boundary for the
separate dashboard bundle.

Backblaze B2 is required. Set every `B2_*` variable in `deploy/.env`; startup
verifies bucket access and exits if those credentials are invalid.

With `MIGRATE=true` (local default), the server applies the migration plan once
and records actual executed files and SHA-256 checksums in `public.schema_migrations`.
An empty database starts from the newest optional `Bnnnn_name.sql` snapshot,
then applies numbered files above that version. Existing databases continue
through their numbered history and never apply a new snapshot. Without a
snapshot, initialization still starts at `0001_init.sql`. `dev_seed.sql` loads
separately when `APP_ENV=development`. Production should run `cmd/migrate` from the same
image, then start the API with `MIGRATE=false`.

### Bucket configuration

Apply `../deploy/b2-lifecycle.prod.json` (or `b2-lifecycle.uat.json` for the
UAT bucket, which local development shares) to the bucket. Two things depend on
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

The API requires `CLERK_SECRET_KEY` at startup unless an explicit local/test
bypass is enabled. Local single-user development must set
`APP_ENV=development AUTH_DISABLED=true`; a missing Clerk secret by itself never
enables the development identity. All identity modes still read account
lifecycle state and fail closed with 503 if that state cannot be loaded.

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

Owned workspaces are hidden from members and link/public visitors while the
request is pending, but their membership and sharing records remain intact.
Successful cancellation restores listing, access, editing, invitations, and
cloning. After the 30-day deadline, purge permanently deletes every owned
workspace, including shared workspaces, and their share links and content.

## Layout

- `cmd/api` — entrypoint (config, optional migrate, serve, graceful shutdown).
- `cmd/migrate` — apply-once runner for an explicit deploy step. Same embed as
  the API. `-status` prints pending files; `-seed` loads the local demo rows.
- `cmd/cancel-deletion` — support tool to reactivate a deletion-pending account.
- `internal/store` — pgx pool, models (mirror `src/api/types.ts`), queries.
- `internal/httpapi` — chi router + handlers (mirror `src/mocks/handlers.ts`).
- `migrations` — numbered `NNNN_*.sql` files (schema + product catalog) plus
  `dev_seed.sql` (local demo rows). `0001_init.sql` owns the retrieval index
  (`rag_*`), so it needs the `vector` extension and must run against
  `pgvector/pgvector:pg16` rather than stock Postgres.

## Connect the frontend

From the repo root:

```bash
# point the SPA at the real gateway instead of MSW
VITE_USE_MSW=false pnpm dev
```

Vite proxies `/api` → `http://localhost:8080` (see `vite.config.ts`).

## Notes / next

- Streaming workspace chat and `/generate` are wired to the Python retrieval
  service; the old non-streaming chat endpoint has been removed.
- File uploads currently land `status='ready'`; Phase 2 switches to multipart +
  `status='processing'` + an `ingest` job on the Postgres-backed `jobs` queue.


### Publishing future migration baselines

See [the deployment runbook](../openwiki/deployment-runbook.md#database-migration-baselines)
for snapshot contents, checksum rules and retained upgrade history. The existing
`0001_init.sql` remains the initial schema; no duplicate snapshot is needed yet.
`pnpm test:go` compares every future embedded baseline with the numbered path,
including schema, catalog rows and sequence state, in the harness's one
Postgres container.
