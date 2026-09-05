# Plan: Capy Notebook rename · public workspace summary · env sync

Living plan. Updated by Claude during the work; the **Decision log** is the
authoritative record of what Sam decided and when. Everything else is the
current state of the inventory and the steps, and gets rewritten as work lands.

Last updated: 2026-09-04

Tracks, in the order they will be done:

1. **A — Rename** Evo Notes → Capy Notebook (repo, second repo, GitHub, Coolify, both VMs, Cloudflare)
2. **B — Public workspace summary page** (server-rendered, R2-backed) and the frontend hosting move it implies
3. **C — Env sync** local → GitHub environment → Coolify + ingest host (designed earlier, paused until A and B land)

---

## Decision log

Status: `decided` = Sam said so · `proposed` = Claude's recommendation awaiting a yes/no · `open` = needs Sam's input.

| # | Date | Decision | Status |
|---|---|---|---|
| D1 | 2026-09-04 | Runtime env source of truth is the **GitHub environment** (`uat`, later `production`), not a local file. Local `deploy/.env.<env>` is only a convenience for uploading. Environment protection (required reviewers, branch = `main`) is the authorization gate. | decided |
| D2 | 2026-09-04 | Routine deploys run env-sync in `--check` mode and **fail on drift**; only an explicit dispatch with `sync_env=true` applies. | proposed |
| D3 | 2026-09-04 | Rename scope: all tiers T1–T5 (see A4), because nothing is deployed and no data exists, so this is the cheapest it will ever be. Exclusions listed in A7. | proposed |
| D4 | 2026-09-04 | New identifier scheme (see A4 table). | open |
| D5 | 2026-09-04 | Frontend hosting: **one Cloudflare Worker with static assets** replaces the Pages project. It serves the SPA and owns `/w/*` (summary page). Not Vercel. Alternative considered: keep Pages + a Pages Function; rejected because the rename forces a new Pages project anyway and Workers is where Cloudflare puts new capability. | proposed |
| D6 | 2026-09-04 | Summary data store is **R2 (JSON per workspace), not KV**. KV is eventually consistent (~60 s propagation, colo-local reads), which contradicts "visibility change is instant". R2 is strongly consistent; delete = gone. | proposed |
| D7 | 2026-09-04 | Invalidation: **visibility change renders/deletes inline** in the request; **content edits** (workspace name/description/tags/color, chapter CRUD, file/material name/move/delete) enqueue one coalesced `summary_render` job per workspace. Missing object on read → render on demand and store. | proposed |
| D8 | 2026-09-04 | Anonymous readers get **only** the summary. File/material/chapter content routes require a session. This removes today's "share link = anonymous PDF access" behaviour. | proposed (Sam: "rest should not be on a public endpoint") |
| D9 | 2026-09-04 | Summary URL is `/w/{slug}` with an owner-editable slug, not the UUID. Link-shared workspaces keep an unguessable token URL and are `noindex`. | open |
| D10 | 2026-09-04 | Work order: A → B → C. | proposed |
| D11 | 2026-09-04 | zh-locale product name and the zh term for "credits" ("Evo 额度"). | open |
| D12 | 2026-09-04 | Support email address shown in the app (`hello@evonotes.app` today). | open |

---

## Track A — Rename Evo Notes → Capy Notebook

### A1 Inventory outside the repository (mapped 2026-09-04, read-only)

**GitHub**
- Repo `samyung0/evo-notes` (public, default `main`, no description/homepage). Second repo `samyung0/betteroffice` keeps its name (upstream project name); only its evo-specific bits change.
- Deploy key `evo-uat-coolify` (read-only).
- Environment `uat` vars: `CLOUDFLARE_PAGES_PROJECT=evo-notes-uat`, `COOLIFY_RESOURCE_UUID=9kx3durs3sxyfotgy20scemv`, `COOLIFY_API_URL`, `DEPLOYMENT_*_URL`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_PAGES_BRANCH`. **No environment secrets exist yet.**
- Repo vars `UAT_*` (hostnames, `UAT_DEPLOYMENT_ENABLED=false`, `UAT_TARGET_AUTHORIZED=true`). Repo secret `OPENROUTER_API_KEY`.
- GitHub Projects: token lacks `read:project`; if a Projects board named Evo exists, Sam renames it.

**Coolify (UAT VM 159.195.250.206, `uat-coolify.capynotebook.com`)**
- Project `evo-notes` (uuid `6rvj8jyuu2ddbzva8pc2yauz`, description "Evo Notes UAT"), environment `uat`.
- Application `evo-notes-uat` (uuid `9kx3durs3sxyfotgy20scemv`, description "Evo Notes UAT backend (pinned by promote/deploy workflows)"), repo `git@github.com:samyung0/evo-notes.git`, branch `main`, compose `/deploy/docker-compose.prod.yml`.
- Private key `evo-uat-coolify-deploy`. Source: Public GitHub.
- ~60 env keys already created on the app; the `EVO_*` ones present: `EVO_PARSER`, `EVO_ENGINE`, `EVO_CAPTION_CACHE_TTL_DAYS`, `EVO_QUERY_MODEL`, `EVO_PRIVATE_BIND_ADDRESS`. None are `is_shown_once`; all `is_literal=false` (must become true during env-sync).
- No evo-named containers, volumes, networks or images (nothing deployed).

**UAT VM host (Debian, hostname `v2202609406448511476`)**
- systemd `evo-uat-origin-lockdown.service` → `/usr/local/sbin/evo-uat-origin-lockdown.sh`.
- `/root/.ssh/evo-uat-deploy{,.pub}` (the GitHub deploy key); `authorized_keys` comments `coolify`, `evo-uat`.
- `/etc/wireguard/wg0.conf` peer comment `# evo-ingest-1 (Netcup ingest host)`.
- Cloudflared runs from a token (tunnel name lives in Cloudflare, see below).

**Ingest VM host (`evo-ingest-1`, 159.195.61.195)**
- Hostname `evo-ingest-1`; unix user `evo-ingest` (uid 1001, docker group, home `/home/evo-ingest`).
- systemd `evo-ingest.service` (disabled): `User=evo-ingest`, `WorkingDirectory=/opt/evo-ingest/app`, `COMPOSE_PROJECT_NAME=evo-ingest`, env files `/etc/evo-ingest/ingest.env` + `/opt/evo-ingest/release.env`.
- Dirs: `/opt/evo-ingest` (only stress leftovers: `benchmarks/`, `stress-*`, `worker-stress-20260831`; **no `app/` checkout, no env files**), `/etc/evo-ingest` (empty), `/opt/evo-parser-bench`, `/opt/evo-rag-lab` (running compose project `evo-rag-lab`, 10 containers, network `evo-rag-lab_default`, volumes `evo-rag-lab_*`).
- `/etc/wireguard/wg0.conf` peer comment `# evo-uat (Netcup UAT VM, Coolify)`; `authorized_keys` comment `evo-parser-netcup`.
- Docker: 27 images (7.3 GB reclaimable) + 1.9 GB build cache, all lab/stress. `/tmp/evo-ingest-1-stress-results-20260831.tar.gz`.

**Cloudflare (account `79cb1b9d…`, zone `capynotebook.com`)**
- Pages project `evo-notes-uat` (`evo-notes-uat.pages.dev`, custom domain `uat.capynotebook.com`). Pages projects cannot be renamed → replaced under Track B.
- Workers: `evo-mineru-relay` (not in this repo; bindings `B2_HOST`, `MINERU_UPLOAD_HOSTS`, `RELAY_TOKEN`… — parser-bench era? **ask Sam**), plus unrelated `stablestudio`, `private-gallery-b2-proxy`.
- Tunnels: `evo-uat` (`3abcfdb8…`, serves `uat-api`, `uat-collab`, `uat-coolify`, `uat-ops`), `evo-dev-sam` (`89d328e2…`, `dev-sam.uat.capynotebook.com`).
- DNS: `uat.capynotebook.com` CNAME → `evo-notes-uat.pages.dev`; the four tunnel CNAMEs point at tunnel ids (no rename needed); Clerk and Resend records untouched.
- No KV namespaces, R2 buckets or Queues visible to the token (the relay's `evo-drive-imports` queues are not created yet, or the token lacks scope).
- The `CLOUDFLARE_API_TOKEN` in `deploy/.env.uat` fails `/user/tokens/verify` but works on account/zone endpoints — check its scopes before relying on it in CI.

**Local machine**
- `~/web/evo-notes`, `~/web/evo-office`; `~/.ssh/id_ed25519_evo_{uat,ingest,coolify}`; Claude memory notes reference these paths.

### A2 Inventory inside `evo-notes` (repo, mapped 2026-09-04)

≈1,730 real hits across ≈520 files after dropping English words (`revoke`, `evolution`…). Excluded from counts: `node_modules`, `dist`, `.pnpm-store`, `.cursor-export/` (untracked Cursor transcripts, ignore), lockfiles (regenerate).

**T1 user-facing (≈84 source lines; generated mirrors excluded)**
- `messages/en.json` / `zh.json` (9 each): `app_name` ("Evo Notes" / "Evo 笔记"), error titles, `support_email_body` → `hello@evonotes.app`, and zh "Evo 额度" (Evo credits — a product term, needs a zh decision).
- `emails/templates/*.{en,zh}.json` (56 lines, 10 templates), `index.html` + `ops/index.html` titles, ops UI strings (`ops/src/router.tsx`, `app-shell.tsx`, `pages/costs.tsx`), email editor titles, `EMAIL_FROM=Evo Notes <…>` in env examples and runbook, `server/migrations/dev_seed.sql` seed emails `@evonotes.app`.

**T2 external ids (≈45 lines)**
- `package.json` names: root `evo-notes`; `@evo-notes/{ops,collaboration,emails-editor}`; 21 `@evo-notes/` filter/import references (root scripts, `ci.yml`, `deploy-environment.yml`, `ops/Dockerfile`, `collaboration/Dockerfile`, READMEs, `scripts/review/run-local-tests.sh`).
- Pages project `evo-notes-uat` in `scripts/dev/tunnel.sh:186`, `openwiki/uat-activation-checklist.md`.
- `INGEST_HOST_USER || 'evo-ingest'` defaults in `deploy-environment.yml` (3×).
- Image names in the two ingest compose files + `bench/parsers/dockerfile` (`evo-parse-bench`).
- Stale hostname `ops.evonotes.com` (env examples, README, runbook ×11, observability wiki, architecture artifacts) — the rest of the stack is already on `capynotebook.com`.
- Go module `github.com/evonotes/server` (`go.mod:1`; 263 import lines / 125 files).
- Test bucket literal `"evo-notes"` in `server/internal/blob/blob_test.go`.

**T3 infra ids**
- Compose projects `evo-ingest` (ansible unit templates), `evo-ingest-nonprod` (compose `name:`); named volumes `evo_pgdata`, `evo_e2e_pgdata`, `evo-ingest_parser_models`, `evo-ingest_parse_spool`, `evo-ingest_nonprod_parse_spool` (no data anywhere yet → plain rename is safe now, never again).
- `deploy/ansible/ingest-host/`: `playbook.yml` (`ingest_service_user: evo-ingest`, `/opt/evo-ingest`, `/etc/evo-ingest`), templates `evo-ingest.service.j2`, `evo-ingest-watchdog.service.j2`, `files/evo_ingest_watchdog.py`.
- `scripts/deploy/ingest-host-remote-release.sh` defaults (`/opt/evo-ingest/app`, `/etc/evo-ingest/ingest.env`…), `ingest-host-release.sh` user default.
- `EVO_INGEST_HOST_ID` values are `netcup-ingest-*` (no evo) — only the var name changes.
- `bench/parsers/results/evo-ingest-1-netcup-rs-2000-g12-2026-08-31/` — historical, keep as is.

**T4 code ids**
- `EVO_*` env vars: **112 distinct names** (full list in the inventory transcript; defined across `deploy/*`, `pipeline/pipeline/config.py`, `parser/*.py`, `server/cmd/api/main.go`, `scripts/dev/tunnel.sh`, `server/internal/testdb`). Five already exist as Coolify env keys.
- Python: distribution `evo-pipeline` + entry point `evo-worker` in `pyproject.toml`; importable module is `pipeline` (unchanged). Delete both `evo_pipeline.egg-info/` dirs.
- Postgres: role/db `evo`; roles `evo_ops`, `evo_ops_admin` (env examples, runbook, `ops/config_test.go`).
- Redis prefixes: `evo:collaboration:*` (8 keys/channels in `collaboration/src/server.ts`, `server/cmd/api/collaboration_eviction_worker.go`, `huma_collaboration.go`), `evo:rl:` (`ratelimit.go`), `evo:parse:slots:` (`pipeline/parse/slots.py`). **`0001_init.sql:432-433,3375,3529` has a CHECK constraint on `collaboration_eviction_outbox.channel` hard-coding `evo:collaboration:evict|user-evict`** — edit 0001 destructively (AGENTS.md rule), no new migration.
- JWT contract `iss`/`aud` = `evo-api` / `evo-collaboration` (`collaboration/src/auth.ts` + Go minting side) — change both sides in one commit.
- Browser storage keys (12): `evo.style`, `evo.theme`, `evo-notes-editor-e2e-state-v1`, `evo-stable-element-ids`, `evo-save-shortcut`, `evo-autoformat`, `evo-code-block-list-cleanup`, `evo-note-editor-prefs`, `evo_remote_cursor`, `evo_comment_highlight`, `evo-discussions`, `evo_cloud_connect_dismissed`.
- Drag MIME types `application/x-evo-{material,file}` (`WorkspaceOpen.tsx`); header `X-Evo-Release` (set in `httpapi/server.go`, read by `verify-release.sh`, `strix-scan.sh`, tests); meta `evo-release` (`index.html`); metrics `evo_collaboration_*` (6); VCR matcher `evo_json_body`; tmp prefixes `evo_office_`, `evo_worker_bench_`; Huma title `"Evo Notes API"` (`huma_register.go:19`) → `openapi.yaml` → 179 generated headers in `src/api/gen/**`; review schema `$id` `https://evo-notes.local/…`.

**T5 docs (≈187 lines)**: `openwiki/deployment-runbook.md` (106), `agentic-retrieval.md` (16), `frontend/plate-editor.md` (9), `authorization-permissions-lifecycles.md` (8), `observability-metering.md` (6), `test-catalog.md`, `office-files.md`, `review-automation.md`, `uat-activation-checklist.md`; `human/*.md`; `AGENTS.md` (3), `README.md` (3), `SECURITY.md`, `HANDOFF-rag-concepts.md`, `review/*`, `server/README.md`, `collaboration/README.md`, `emails/editor/readme.md`, `0001_init.sql:1` comment.

**Generated — regenerate, never hand-edit**: `src/api/gen/**` + `ops/src/api-gen/slot.ts` (`pnpm gen:api:full`), `openapi.yaml` (`pnpm gen:openapi`), paraglide output under `src/i18n/paraglide/`, `server/internal/mail/copy_gen.go` + `templates/*` (`pnpm email:build`), egg-info (delete), `artifacts/architecture/evo-notes-system.*` (regenerate or delete — tool unknown).

### A3 Inventory inside `evo-office` (done)

Small and contained: everything is under `poc/` plus the branch name.
- Branch `codex/evo-integration` (the branch `.gitmodules` tracks). Local checkout is on `codex/browser-poc`.
- `poc/README.md` ("Evo Office browser proof", "before Evo Notes commits…"), `poc/fixtures/README.md`.
- Test markers in `poc/scripts/{generate_docx_fixture.py,generate_artifact_fixture.mjs,run-roundtrip.ts}`: `EVO_EDIT_MARKER_{DOCX,XLSX,PPTX}`, `EVO_EDITED_{XLSX,PPTX}`, `EVO_TABLE_MERGE_SENTINEL`, `EVO_SECTION_SENTINEL`, header text "EVO OFFICE · ROUND-TRIP PROOF".
- No package/crate/workflow names contain evo. The parent repo depends on `vendor/betteroffice/.github/actions/wasm-toolchain`, `packages/*/src/wasm/generated/*`, and `@betteroffice/*` aliases — none of these change.

### A4 Proposed identifier scheme (D4 — needs Sam's yes)

Convention kept from today: hyphenated slug for resource names, no hyphen where the current name has none.

| Kind | Old | New |
|---|---|---|
| Display name | Evo Notes | Capy Notebook |
| Slug (repo, packages, Coolify, Cloudflare resources) | `evo-notes` | `capy-notebook` |
| GitHub repo | `samyung0/evo-notes` | `samyung0/capy-notebook` (GitHub redirects old URLs) |
| npm scope | `@evo-notes/*` | `@capy-notebook/*` |
| Go module | `github.com/evonotes/server` | `github.com/capynotebook/server` |
| Python dist / package | `evo-pipeline` / `evo_pipeline` | `capy-pipeline` / `capy_pipeline` |
| Env var prefix | `EVO_*` | `CAPY_*` |
| Postgres role / db (compose, examples) | `evo` | `capy` |
| Ingest compose projects | `evo-ingest`, `evo-ingest-nonprod` | `capy-ingest`, `capy-ingest-nonprod` |
| Ingest images / volumes | `evo-ingest…` | `capy-ingest…` |
| Ingest host: hostname, user, paths, unit | `evo-ingest-1`, `evo-ingest`, `/opt/evo-ingest`, `/etc/evo-ingest`, `evo-ingest.service` | `capy-ingest-1`, `capy-ingest`, `/opt/capy-ingest`, `/etc/capy-ingest`, `capy-ingest.service` |
| UAT host unit + script | `evo-uat-origin-lockdown` | `capy-uat-origin-lockdown` |
| Coolify project / app / key | `evo-notes` / `evo-notes-uat` / `evo-uat-coolify-deploy` | `capy-notebook` / `capy-notebook-uat` / `capy-uat-coolify-deploy` |
| GitHub deploy key | `evo-uat-coolify` | `capy-uat-coolify` |
| Cloudflare tunnels | `evo-uat`, `evo-dev-sam` | `capy-uat`, `capy-dev-sam` (rename in place; ids and DNS unchanged) |
| Cloudflare site | Pages `evo-notes-uat` | Worker `capy-notebook-uat` (Track B); Pages project deleted after cutover |
| Relay Worker + queues | removed 2026-09-05 (imports run on the ingest host) | — |
| Submodule branch | `codex/evo-integration` | `codex/capy-integration` (+ `.gitmodules`) |
| Local dirs / ssh keys | `~/web/evo-notes`, `id_ed25519_evo_*` | Sam's choice; optional |

### A5 Steps

1. **Repo, on a branch** (both repos). Mechanical rename tier by tier (T1 strings → T2 external ids → T3 infra ids → T4 code ids incl. `EVO_*`→`CAPY_*` → T5 docs). Regenerate: `pnpm install` (lockfile), `uv lock`, `pnpm gen:openapi` / orval output, paraglide. `pnpm run fmt`, `pnpm run fix`, `pnpm run fmt:go`, `pnpm run fmt:py`. Run `pnpm test:go`, vitest, python tests. Grep gate: zero hits for the evo family outside an explicit allowlist (see A6).
2. **evo-office**: rename `poc/` strings and markers; push branch `codex/capy-integration`; update `.gitmodules` + submodule pointer in the main repo.
3. **GitHub**: rename repo; retitle deploy key; update `uat` env vars (`CLOUDFLARE_PAGES_PROJECT` → whatever Track B needs).
4. **Cloudflare**: rename tunnels; Worker/queue rename = deploy under the new name, delete the old; Pages replacement is Track B (DNS `uat` CNAME moves then).
5. **Coolify** (API): project name/description, app name/description, `git_repository` URL, private-key name. UUIDs unchanged, so `COOLIFY_RESOURCE_UUID` stays.
6. **UAT VM**: rename unit + script, WG comment, key file names, `authorized_keys` comments; `systemctl daemon-reload && systemctl enable --now` the new unit; disable the old.
7. **Ingest VM**: `hostnamectl set-hostname capy-ingest-1`; `usermod -l capy-ingest -d /home/capy-ingest -m evo-ingest` + `groupmod`; move `/opt/evo-ingest` → `/opt/capy-ingest` (stress leftovers can be deleted instead), `/etc/evo-ingest` → `/etc/capy-ingest`; rewrite + rename the unit; WG comment; `authorized_keys` comment. Leave `evo-rag-lab` and `evo-parser-bench` alone (disposable labs, see A7).
8. **Runbook/wiki**: `openwiki/deployment-runbook.md` and memory notes updated with the new names.

### A6 Verification

- `git grep -iE 'evo[-_ ]?notes|evonotes|@evo-notes|evo[-_]ingest|evo[-_]rag|EVO_' -- ':!pnpm-lock.yaml' ':!uv.lock'` returns only allowlisted hits (allowlist: none expected in `evo-notes`; in `evo-office` upstream words like "revoke"/"evolve").
- CI green on the branch; `docker compose -f deploy/docker-compose.prod.yml config` and the two ingest compose files validate with the example env files.
- Coolify: `GET /applications/{uuid}` shows the new repo URL; a deploy of the pinned SHA succeeds (first real deploy — needs env-sync or hand-filled secrets).
- Both VMs: `systemctl status` of the new units; `wg show`; `id capy-ingest`.

### A7 Excluded / left to Sam

- Clerk, Stripe, Resend, Sentry, PostHog names (Sam).
- `betteroffice` repo name (upstream name, keep).
- `evo-rag-lab`, `evo-parser-bench` on the ingest VM: disposable; delete when done rather than rename.
- `evo-mineru-relay` Worker: unknown owner/purpose — Sam to say keep/rename/delete.
- Local machine paths and ssh key file names: optional.

### A8 Open questions from the inventory

- zh locale: `app_name` "Evo 笔记" → ? ("Capy 笔记本"?) and the product term "Evo 额度" (credits) → ? (D11).
- Support address `hello@evonotes.app` in `messages/*.json` → real address on `capynotebook.com` (D12).
- `ops.evonotes.com` in docs → `uat-ops.capynotebook.com` / `ops.capynotebook.com` (already live) — just a doc fix, will do.
- `artifacts/architecture/evo-notes-system.*`: regenerate or delete?

---

## Track B — Public workspace summary page + frontend hosting

### B1 Sam's questions, answered

**Pages vs Vercel vs Workers.** Workers with static assets. Vercel would add a second platform for one route while cache, DNS, tunnel, R2 and Access all live in Cloudflare. Pages Functions could do it too, but Pages projects cannot be renamed (so a new project is needed anyway) and Cloudflare has stopped adding capability to Pages. One Worker `capy-notebook-<env>`: `assets.directory = dist`, `not_found_handling = single-page-application`, `run_worker_first = ["/w/*"]`, an R2 binding, per-environment blocks in `wrangler.jsonc`. Deploy is `wrangler deploy --env uat`. The drive-import relay Worker was removed on 2026-09-05; imports run on the ingest host.

**KV as the source.** KV propagation is up to ~60 s and reads are colo-cached, so a public→private flip stays readable for up to a minute. R2 is strongly consistent and the Worker reads it through a binding with no credentials. R2 read latency (tens of ms) is fine for a landing page; if traffic ever warrants it, add `s-maxage=60` at the edge later, not now.

**Cache invalidation.** Two classes (D7): visibility changes are inline in the request (to private = delete object; to link/public = render + put before responding, so the pasted link works immediately). Content edits enqueue one `summary_render` job per workspace, deduped by a partial unique index on `jobs (payload->>'workspaceId') WHERE type='summary_render' AND status='pending'` — same shape as the existing jobs table + claim/lease indexes. Render on read if the object is missing, so the job is an optimisation, not a correctness requirement. Owner display-name change dirties all of that owner's public workspaces (one job each). `clone_count`/last-accessed stay out of the summary so strangers' actions don't re-render it.

**Deploy shape for UAT after B.** Coolify (backend) + Worker `capy-notebook-uat` (SPA + `/w/*`) + ingest host. One workflow, three targets.

### B2 Design

- **Data.** Public summary JSON per workspace, written by Go to R2 key `summaries/{workspaceId}.json`: `slug, name, description, color, tags[], author{displayName}, updatedAt, visibility, chapters[{name, position, files[{name, kind}], materials[{name, type}]}]`. No ids, blob keys, URLs, member emails, extracted text, RAG summaries.
- **Schema (destructive edit of `0001_init.sql`).** `workspaces.description text` (capped), `workspaces.slug text` unique among non-private rows (D9), `workspaces.updated_at` maintained by trigger for `lastmod`. Tags already exist via `entity_tags`.
- **Go.** `internal/summary`: `Build(ctx, wsID) (Summary, error)` (one nested query) and `Publish/Delete`. Store client: reuse `internal/blob` S3 client with an R2 endpoint (needs a second config; `NewB2` currently rejects non-B2 endpoints — relax by config, not by default). Hooks in workspace/chapter/file/material mutations + privacy handler. `GET /api/public/workspaces/{slug}` returns the same JSON (for render-on-read and the SPA island), no session, `PublicReadPrefix` narrowed to it.
- **Worker.** `GET /w/:slug`: R2 get → 404 (private/unknown) or template → HTML. Template is the Vite-built `summary.html` entry (hashed CSS/JS, fonts), read at build time; Worker injects `<title>`, meta/og, JSON-LD, and the outline into placeholders. `link` visibility → `X-Robots-Tag: noindex, nofollow`. Response `Cache-Control: no-store` initially.
- **Island.** `summary.html` mounts a small React entry: `TopInsetBar` in logged-in/out mode via Clerk client-side, "Open workspace" CTA → sign-in → `/workspaces/{id}` (id fetched from the public endpoint after auth? no: the CTA links `/workspaces/by-slug/{slug}` which resolves server-side under session). Reserve layout space so hydration doesn't shift.
- **Authz (D8).** Anonymous `GET` on `/api/workspaces/*`, `/api/files/*`, `/api/materials/*`, `/api/editor-assets/*`, `/api/quizzes/*`, `/api/decks/*` → 401. `WorkspaceAccess` stops treating empty user + link/public as reader. Same for `/share/quizzes`, `/share/flashcards`. e2e sharing specs rewritten around "summary without login, open with login".
- **Router.** `/w/$slug` is a real navigation to the Worker, not a SPA route. `/share/workspaces/$id` → 301 to `/w/{slug}` if public, else the noindex summary; Explore cards → `/w/{slug}`; dashboard cards stay `/workspaces/{id}`.
- **SEO extras.** `robots.txt`, sitemap of `privacy='public'` slugs (Worker route reading a list object Go maintains, or a Go endpoint), `hreflang` deferred.

### B3 Steps

1. Wrangler config for the site Worker (assets + env blocks + R2 binding), replace `wrangler pages deploy` in `deploy-environment.yml`, move `uat` DNS to the Worker custom domain, delete Pages project. (Ship this before any summary code — it is the platform move.)
2. Schema: description/slug/updated_at; API + SPA for editing description and slug.
3. Authz narrowing + public endpoint + tests.
4. Go summary builder, R2 store, mutation hooks, `summary_render` job.
5. `summary.html` Vite entry + island; Worker `/w/*` handler + tests (Vitest with `@cloudflare/vitest-pool-workers`).
6. Router changes, Explore/share links, robots/sitemap.
7. Runbook + `openwiki/agentic-retrieval.md`/authorization wiki updates, test-catalog.

### B4 Open

- D9 slugs. - Description length cap. - Whether materials appear in the outline (proposal: names only, yes). - Whether `link` workspaces get a summary at all or only `public` (proposal: yes, noindex).

---

## Track C — Env sync (paused; design captured 2026-09-04)

- Manifest tags every key in `deploy/.env.example` family: `pages-var | coolify | ingest-uat | ci-only` (multi-tag allowed; untagged key fails the push).
- `pnpm env:push <env>` wraps `gh variable set --env <env> -f` and `gh secret set --env <env> -f` split by manifest.
- `scripts/deploy/env-sync.sh <env> --check|--apply` runs inside the deploy job, reads `toJSON(secrets)` / `toJSON(vars)`, filters by manifest, fingerprints (sha256[:8]) and diffs against Coolify (`applications/{uuid}/envs`, bulk; `is_preview:false`, `is_literal:true`, never `is_shown_once`) and the ingest host (`uat.queue.env` rendered from the same secrets, `DATABASE_URL` at WireGuard `10.77.0.3`). Never prints values. Runs before `coolify-deploy.sh` (Coolify re-parses compose on deploy).
- Ingest host release: `nonprod` mode in `ingest-host-remote-release.sh` (project `…-nonprod`, `--profile uat`, `*-uat` services, `…-nonprod-*` images), first-run clone, post-activate prune scoped to the project's image repos (keep active + previous SHA) + `docker builder prune --filter until=168h`. `INGEST_HOST` + SSH secrets added to the `uat` environment; production-only gates removed.
- Open: which GitHub accounts get environment-secrets write; confirm D2.
