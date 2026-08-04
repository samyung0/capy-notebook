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

Backblaze B2 is required. Set every `B2_*` variable in `.env`; startup verifies
bucket access and exits if those credentials are invalid.

The server applies the embedded `migrations/0001_init.sql` development baseline
(schema + seed) on startup; it is idempotent.

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

## Layout

- `cmd/api` — entrypoint (config, migrate, serve, graceful shutdown).
- `internal/store` — pgx pool, models (mirror `src/api/types.ts`), queries.
- `internal/httpapi` — chi router + handlers (mirror `src/mocks/handlers.ts`).
- `migrations` — `0001_init.sql` (complete schema and development seed). It needs
  no extensions, so it applies to a stock Postgres; pgvector and Apache AGE are
  provisioned by `deploy/postgres` for LightRAG.

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
