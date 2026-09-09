# Capy Notebook

Study workspace: notes, sources, quizzes, flashcards, schedule, and AI retrieval.

## Parts

- **Web app** (`src/`) — React/Vite SPA. Plate notes editor, file viewers, workspace chat/generate, quizzes, flashcards, schedule, tasks, Excalidraw canvas, Explore, billing. Clerk auth. Paraglide i18n (`messages/`).
- **Site Worker** (`workers/site/`) serves the static app and `/w/{workspaceId}` summaries fetched live from Go. Full workspace content requires sign-in. Vite uses the same summary handler during local development.
- **API** (`server/`) — Go HTTP gateway (`/api`, `:8080`). Workspaces, materials, files, comments, sharing, quota, billing, jobs, notifications. Owns Postgres migrations. Support CLIs live here too (`cmd/cancel-deletion`, `cmd/reconcile`).
- **Ops dashboard** (`ops/` + `server/cmd/ops`). Separate operator SPA and Go origin (`:8082`) with overview, health, user lookup, usage explorer, append-only operator audit history, permission-gated model-registry writes, and a dedicated storage/Stripe reconciliation page. Every mounted database read refreshes every 30 seconds, and the global refresh button refetches all active Ops reads without calling providers or starting jobs. It is not on the product OpenAPI contract (`/api/ops`). Clerk provides identity, and production also requires Cloudflare Access on `ops.capynotebook.com`. Membership is the `operators` table, with no grant API. `ops_permissions` maps `viewer`/`admin` to tokens (`read_all`, `write_registry`, `execute_reconciliation_job`). A read/auth pool and a shared admin-actions pool stay off note bodies, file bytes, prompts, responses, and email payloads; workspace-record metadata is visible.
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

- Install Node.js
- Install pnpm@11.20.0
- Install Rust (cargo, rustup)
  - **macOS:** `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`
  - **Windows:** run `rustup-init.exe` from [rustup.rs](https://rustup.rs), which
    also prompts for the Visual Studio C++ build tools
- Install Bun
- Install **Binaryen**
   **Windows:** [Binaryen 132 release](https://github.com/WebAssembly/binaryen/releases/tag/version_132):
   `binaryen-version_132-x86_64-windows.tar.gz` for Intel/AMD PCs, or
   `binaryen-version_132-arm64-windows.tar.gz` for Windows on ARM. Add `bin` directory to your user
   PATH.

   **macOS:** `brew install binaryen`
- Copy `deploy/.env.example` to `deploy/.env`.

Then run:
```sh
# office setup
git config push.recurseSubmodules check
git config submodule.recurse true
git submodule update --init vendor/betteroffice
rustup target add wasm32-unknown-unknown
cargo install wasm-pack --version 0.15.0 --locked

# UI Local - UAT api
# Mac / Windows
brew install caddy | choco install caddy
pnpm run dev:hosts

pnpm install --frozen-lockfile
pnpm run office:prepare
```

### Local UI:

Very happy, very demure.

If you don't need UAT data or backend (pure UI):
- `VITE_USE_MSW=true`
- `pnpm run dev`
- Open `https://localhost:5173`

Otherwise:

 - `VITE_USE_MSW=false`
 - `VITE_API_URL=https://uat-api.capynotebook.com`
 - `VITE_CLERK_PUBLISHABLE_KEY=pk_live_Y2xlcmsudWF0LmNhcHlub3RlYm9vay5jb20k`
 - `pnpm dev:https` and `pnpm dev:uat` in separate terminals
 - Open `https://local.uat.capynotebook.com`.

No Cloudflare tunnel. The host is needed for collab server and clerk auth.

### Full Stack

Everything local, on the Clerk development instance (UAT). 

 - `VITE_USE_MSW=false`
 - `VITE_API_URL=http://localhost:8080`
 - `VITE_CLERK_PUBLISHABLE_KEY=pk_test_ZGlyZWN0LWdlbGRpbmctMTM1NS5jbGVyay5hY2NvdW50cy5kZXYk`
 - `CLERK_SECRET_KEY` set to the `sk_test` (UAT development instance)
 - `CLERK_WEBHOOK_SECRET` set to your endpoint's `whsec_`, or random value if you dont care about webhook events.
 - `docker compose -f deploy/docker-compose.yml up --build`
 - `pnpm dev`
 - Open `https://localhost:5173`

 - **Clerk Webhook Events**:

  - Set `CLERK_WEBHOOK_HOST=dev-<yourname>.uat.capynotebook.com`
  - Give `dev-<yourname>.uat.capynotebook.com/webhooks/clerk` to Epo, ask the big bro to add a webhook in clerk uat development instance with that url. Subscribed to `user.created`, `user.deleted`, `user.updated`.
  - update `CLERK_WEBHOOK_SECRET` with the webhook secret

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
pnpm --filter @capy-notebook/ops dev

# Standalone Maily editor on http://127.0.0.1:3000
pnpm email:dev

# Regenerate server/internal/mail/templates/*.gohtml and *.txt
pnpm email:build
```

The Go binary and the Python worker do not auto-load `deploy/.env`. Export it
first: `set -a; . deploy/.env; set +a`.

## Developing betteroffice

- Branch off from `capy-ci` and pin the betteroffice using commits from `capi-ci`
- If you dont know git submodules like me, you can change the "pin" (which is just which commit capy uses) by cd into `vendor/betteroffice`, check out any commit from `capi-ci` branch, at capy-notebook root do `git add vendor/betteroffice`, then commit and push.

## Deployment configuration

GitHub environments hold UAT and production variables/secrets. Each manual
app or ingest deployment applies that configuration. Copy the matching complete
`deploy/.env.uat.example` or `.env.prod.example`, fill it, and use:

```sh
pnpm env:check --file deploy/.env.uat
pnpm env:push --file deploy/.env.uat --environment uat --repo samyung0/capy-notebook
```

Use **Deploy UAT** for the coordinated release, or **Deploy ingest** against an
already matching backend revision. The first release requires the explicit
bootstrap option. See [deployment runbook](openwiki/deployment-runbook.md) for
provisioning, Worker domain cutover and recovery.
