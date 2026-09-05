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

### Office engine setup

Run these steps from the Capy Notebook repository root. A submodule checkout
provides the source; the JavaScript entry files and WASM binaries are generated
locally and are not committed.

1. Install Node.js and the pnpm version listed in `package.json`, plus Bun and
   Rust via rustup. On Windows, Rust also needs the Visual Studio C++ build tools
   and Windows SDK. Make sure `pnpm`, `bun`, `cargo`, and `rustup` are on PATH.
2. Initialize the pinned fork and install the WASM build tools:

   ```sh
   git submodule update --init vendor/betteroffice
   rustup target add wasm32-unknown-unknown
   cargo install wasm-pack --version 0.15.0 --locked
   ```

   The fork checks for exactly `wasm-pack 0.15.0`.

3. Install **Binaryen**, which supplies `wasm-opt`. CI uses version 132.

   **Windows:** download the archive for your architecture from the
   [Binaryen 132 release](https://github.com/WebAssembly/binaryen/releases/tag/version_132):
   `binaryen-version_132-x86_64-windows.tar.gz` for Intel/AMD PCs, or
   `binaryen-version_132-arm64-windows.tar.gz` for Windows on ARM. Extract it
   with `tar -xzf <archive>` or an archive manager. Keep the extracted directory
   intact and add its `bin` directory, containing `wasm-opt.exe`, to your user
   PATH using **Edit environment variables for your account > Path > New**.
   Reopen the terminal and restart your IDE so they pick up the updated PATH.

   **macOS:** `brew install binaryen`.

   **Ubuntu/Debian:** `sudo apt-get update` then `sudo apt-get install binaryen`.

   Package-manager versions may differ from CI. To match CI, use the version
   132 release archive for your OS and architecture and add its `bin` to PATH.

4. Verify the tools, install app dependencies, and generate the Office assets:

   ```sh
   bun --version
   rustc --version
   wasm-pack --version
   wasm-opt --version
   pnpm install --frozen-lockfile
   pnpm run office:prepare
   ```

   `office:prepare` installs the fork's dependencies with
   `bun install --frozen-lockfile` and runs the DOCX, XLSX, and PPTX WASM builds
   for engines with missing entry files. The first build downloads dependencies
   and compiles Rust, so allow several minutes. A successful build produces
   these entry files under `vendor/betteroffice/`, together with their WASM
   binaries and supporting modules:

   ```text
   packages/docx/src/wasm/generated/edit/docx_edit.js
   packages/docx/src/wasm/generated/viewer/docx_view_wasm.js
   packages/xlsx/src/wasm/generated/xlsx_wasm.js
   packages/xlsx/src/wasm/generated/viewer/xlsx_view_wasm.js
   packages/pptx/src/wasm/generated/pptx_wasm.js
   packages/pptx/src/wasm/generated/viewer/pptx_view_wasm.js
   ```

`pnpm dev`, `pnpm build`, `pnpm typecheck`, and `pnpm test` also run
`office:prepare` through their pre-scripts. It skips preparation when all six
entry files exist. If it reports `wasm-opt is required`, check that
`wasm-opt --version` works in the same terminal before retrying.

See [`openwiki/frontend/office-files.md`](openwiki/frontend/office-files.md)
for the Office runtime integration.

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
pnpm --filter @capy-notebook/ops dev

# Standalone Maily editor on http://127.0.0.1:3000
pnpm email:dev

# Regenerate server/internal/mail/templates/*.gohtml and *.txt
pnpm email:build
```

The Go binary and the Python worker do not auto-load `deploy/.env`. Export it
first: `set -a; . deploy/.env; set +a`.

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
