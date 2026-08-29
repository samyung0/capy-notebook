# Evo Notes

Study workspace: notes, sources, quizzes, flashcards, schedule, and AI retrieval.

## Parts

- **Web app** (`src/`) — React/Vite SPA. Plate notes editor, file viewers, workspace chat/generate, quizzes, flashcards, schedule, tasks, Excalidraw canvas, Explore, billing. Clerk auth. Paraglide i18n (`messages/`).
- **API** (`server/`) — Go HTTP gateway (`/api`, `:8080`). Workspaces, materials, files, comments, sharing, quota, billing, jobs, notifications. Owns Postgres migrations. Support CLIs live here too (`cmd/cancel-deletion`, `cmd/reconcile`).
- **Ops dashboard** (`ops/` + `server/cmd/ops`). Separate operator SPA and Go origin (`:8082`) with overview, health, user lookup, usage explorer, append-only operator audit history, permission-gated model-registry writes, and a dedicated storage/Stripe reconciliation page. Every mounted database read refreshes every 30 seconds, and the global refresh button refetches all active Ops reads without calling providers or starting jobs. It is not on the product OpenAPI contract (`/api/ops`). Clerk provides identity, and production also requires Cloudflare Access on `ops.evonotes.com`. Membership is the `operators` table, with no grant API. `ops_permissions` maps `viewer`/`admin` to tokens (`read_all`, `write_registry`, `execute_reconciliation_job`). A read/auth pool and a shared admin-actions pool stay off note bodies, file bytes, prompts, responses, and email payloads; workspace-record metadata is visible.
- **Collaboration** (`collaboration/`) — Hocuspocus/Yjs sidecar. Authoritative live document state for materials.
- **Pipeline** (`pipeline/`) — Python ingest worker (parse, chunk, embed, summarize) and FastAPI retrieval service (chat, generate).
- **Parser VM** (`parser-vm/`) — persistent CPU Marker + RapidOCR service with dedicated digital and OCR lanes.
- **Postgres** — App data plus `pgvector` retrieval index.
- **Redis** — Pub/sub and collaboration replica sync.
- **Object storage** — Backblaze B2 for uploads, parse artifacts, and editor assets.
- **Emails** (`emails/`) — React Email templates (invites, billing, account lifecycle).
- **Contract** (`openapi.yaml`) — Product OpenAPI spec; Orval generates the frontend client.
- **Deploy** (`deploy/`) — Docker Compose for the backend stack. `ops` and `reconcile` are opt-in profiles.
- **Docs** (`openwiki/`) — Authz, quota, retrieval, editor, observability/metering (operator access), deployment runbook, tests.
- **Tests** — Vitest (`src/`, `ops/`, `collaboration/`), Go (`server/`), pytest (`pipeline/`), Playwright (`e2e/`).

## Local

```bash
# SPA — MSW on by default; VITE_USE_MSW=false talks to the gateway
pnpm dev

# Gateway :8080, collab :1234, retrieval 127.0.0.1:8001, ingest worker
docker compose -f deploy/docker-compose.yml up --build

# Operator dashboard :8082 (opt-in profile)
docker compose -f deploy/docker-compose.yml --profile ops up --build ops

# Ops UI only, proxies /api → :8082
pnpm --filter @evo-notes/ops dev
```

Copy `deploy/.env.example` to `deploy/.env` for the compose stack. Ops auth is fail-closed: local owner DSNs or skipped Access/Clerk need `APP_ENV=development`, `OPS_UNSAFE_DEVELOPMENT=true`, and the matching bypass flags. Grant an operator by inserting into `operators` after they already have a product user id.

Hostnames, Access, and Postgres role grants: [`openwiki/deployment-runbook.md`](openwiki/deployment-runbook.md). Operator access model: [`openwiki/observability-metering.md`](openwiki/observability-metering.md) §7.
