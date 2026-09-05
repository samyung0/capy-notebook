# Evo Notes

Study workspace: notes, sources, quizzes, flashcards, schedule, and AI retrieval.

## Parts

- **Web app** (`src/`) — React/Vite SPA. Plate notes editor, file viewers, workspace chat/generate, quizzes, flashcards, schedule, tasks, Excalidraw canvas, Explore, billing. Clerk auth. Paraglide i18n (`messages/`).
- **API** (`server/`) — Go HTTP gateway (`/api`, `:8080`). Workspaces, materials, files, comments, sharing, quota, billing, jobs, notifications. Owns Postgres migrations. Support CLIs live here too (`cmd/cancel-deletion`, `cmd/reconcile`).
- **Ops dashboard** (`ops/` + `server/cmd/ops`). Separate operator SPA and Go origin (`:8082`) with overview, health, user lookup, usage explorer, append-only operator audit history, permission-gated model-registry writes, and a dedicated storage/Stripe reconciliation page. Every mounted database read refreshes every 30 seconds, and the global refresh button refetches all active Ops reads without calling providers or starting jobs. It is not on the product OpenAPI contract (`/api/ops`). Clerk provides identity, and production also requires Cloudflare Access on `ops.evonotes.com`. Membership is the `operators` table, with no grant API. `ops_permissions` maps `viewer`/`admin` to tokens (`read_all`, `write_registry`, `execute_reconciliation_job`). A read/auth pool and a shared admin-actions pool stay off note bodies, file bytes, prompts, responses, and email payloads; workspace-record metadata is visible.
- **Collaboration** (`collaboration/`) — Hocuspocus/Yjs sidecar. Authoritative live document state for materials.
- **Pipeline** (`pipeline/`) — Python ingest worker (parse, chunk, embed, summarize) and FastAPI retrieval service (chat, generate).
- **Parser** (`parser/`) — persistent CPU MinerU service with bounded document and page-slice concurrency.
- **Postgres** — App data plus `pgvector` retrieval index.
- **Redis** — Pub/sub and collaboration replica sync.
- **Object storage** — Backblaze B2 for uploads, parse artifacts, and editor assets.
- **Emails** (`emails/`) — Locale-specific Maily sources for invites, billing, and account lifecycle emails. The build emits embedded Go HTML and text templates.
- **Contract** (`openapi.yaml`) — Product OpenAPI spec; Orval generates the frontend client.
- **Deploy** (`deploy/`) — Docker Compose for the backend stack. `ops` and `reconcile` are opt-in profiles.
- **Docs** (`openwiki/`) — Authz, quota, retrieval, editor, observability/metering (operator access), deployment runbook, tests.
- **Tests** — Vitest (`src/`, `ops/`, `collaboration/`), Go (`server/`), pytest (`pipeline/`), Playwright (`e2e/`).
- **Office engines** (`vendor/betteroffice/`) — pinned fork used for lazy XLSX/PPTX viewing, analysis, editing, and save round-trips.

## Get Restarted

- Clone and initialized Office-engine fork with pinned version (requires Bun and Rust):

```bash
git submodule update --init vendor/betteroffice
```

See [`openwiki/frontend/office-files.md`](openwiki/frontend/office-files.md).

- Copy `deploy/.env.example` to `deploy/.env`.

### UI/Frontend Only:

Very happy, very demure.

If you don't need UAT data or backend (pure UI):
- `VITE_USE_MSW=true`
- `pnpm run dev`

Otherwise:

 - `VITE_USE_MSW=false`
 - `VITE_API_URL=https://uat-api.capynotebook.com`
 - `VITE_CLERK_PUBLISHABLE_KEY=pk_live_Y2xlcmsudWF0LmNhcHlub3RlYm9vay5jb20k`
 - `VITE_DEV_HOST=dev-<yourname>.uat.capynotebook.com` (pick a funny name)
 - `pnpm dev:tunnel` and `pnpm dev:public` in separate terminal

Ask for your origin to be added to `COLLABORATION_ALLOWED_ORIGINS`, or
notes will not connect.

**Full Stack**

Everything local, on the Clerk development instance (UAT). 

- Webhook events are sent to your machine via your endpoint in clerk (ask Epo to help create/manage).
  Deliveries ride your own tunnel, so `pnpm dev:tunnel` has to be up to receive them.

```bash
docker compose -f deploy/docker-compose.yml up --build
pnpm dev
```

 - `VITE_USE_MSW=false`
 - `VITE_API_URL=http://localhost:8080`
 - `VITE_CLERK_PUBLISHABLE_KEY=pk_test_ZGlyZWN0LWdlbGRpbmctMTM1NS5jbGVyay5hY2NvdW50cy5kZXYk`
 - `CLERK_SECRET_KEY` set to the `sk_test`
 - `CLERK_WEBHOOK_SECRET` set to your endpoint's `whsec_`, or random value if you dont care about webhook events.

 - **Email**:

  Email only logs when running stack locally. We don't support sending Dev Email right now.

 - **Stripe**

  Local uses the *Stable Studio Dev* sandbox. UAT uses the *Stable Studio UAT* sandbox.

  - `stripe login --new-session` allows you to include both sandboxes.
  - `stripe switch context` allows you to switch between sandboxes.

  Running locally requires these values:

  - `STRIPE_SECRET_KEY`
  - `STRIPE_PRICE_PRO=price_1UC8wXFKth3QfmPWxTiKOqC1`
  - `STRIPE_WEBHOOK_SECRET` from running `stripe listen --forward-to localhost:8080/webhooks/stripe`
  
  No tunnel needed like the one for clerk.

### Everything else

```bash
# Operator dashboard :8082 (opt-in profile)
docker compose -f deploy/docker-compose.yml --profile ops up --build ops

# Ops UI only, proxies /api → :8082
pnpm --filter @evo-notes/ops dev

# Standalone Maily editor on http://127.0.0.1:3000
pnpm email:dev

# Regenerate server/internal/mail/templates/*.gohtml and *.txt
pnpm email:build
```

The Go binary and the Python worker do not auto-load `deploy/.env`. Export it
first: `set -a; . deploy/.env; set +a`.
